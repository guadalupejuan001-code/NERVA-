import test from 'node:test';
import assert from 'node:assert/strict';
import { createFPSWorld, createFPSMeshes, MAX_FPS_OBJECTS, MAX_FPS_LIGHTS,
  FPS_INSTANCE_BYTES, FPS_MESH_KINDS } from '../src/graphics/world.mjs';

function close(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
}

test('FPS world packs persistent instances into at most four stable mesh batches', () => {
  const world = createFPSWorld({ objects: [
    { kind: 'sphere', position: [1, 2, 3] },
    { kind: 'box', position: [4, 5, 6], scale: [2, 3, 4], yaw: 0.7,
      material: { color: [0.2, 0.3, 0.4], roughness: 0.6, metallic: 0.8,
        emission: 2, pattern: 4, reflection: 0.5 } },
    { kind: 'pipe', position: [7, 8, 9] },
    { kind: 'box', position: [10, 11, 12] },
    { kind: 'cylinder', position: [13, 14, 15] },
  ] });
  assert.deepEqual(FPS_MESH_KINDS, ['box', 'cylinder', 'sphere', 'pipe']);
  assert.equal(world.count, 5);
  assert.equal(FPS_INSTANCE_BYTES, 64);
  assert.equal(world.instances.length, 80);
  assert.equal(world.instanceBytes, 320);
  assert.equal(world.byteLength, 320 + 512);
  assert.deepEqual(world.batches, [
    { kind: 'box', first: 0, count: 2 }, { kind: 'cylinder', first: 2, count: 1 },
    { kind: 'sphere', first: 3, count: 1 }, { kind: 'pipe', first: 4, count: 1 },
  ]);
  assert.deepEqual([...world.instances.slice(0, 3)], [4, 5, 6]);
  close(world.instances[3], 0.7);
  assert.deepEqual([...world.instances.slice(4, 8)], [2, 3, 4, 0]);
  [0.2, 0.3, 0.4, 0.6, 0.8, 2, 4, 0.5].forEach((expected, index) => close(world.instances[8 + index], expected));
  assert.deepEqual([...world.instances.slice(16, 19)], [10, 11, 12]);
  assert.equal(world.instances[39], 1);
  assert.equal(world.instances[55], 2);
  assert.equal(world.instances[71], 3);
});

test('FPS light storage has a fixed bind-group-compatible size and zeroes unused entries', () => {
  const world = createFPSWorld({ lights: [{ position: [2, 3, 4], radius: 8,
    color: [1, 0.5, 0.25], intensity: 12 }] });
  assert.equal(world.lightCount, 1);
  assert.equal(MAX_FPS_LIGHTS, 16);
  assert.deepEqual([...world.pointLights.slice(0, 8)], [2, 3, 4, 8, 1, 0.5, 0.25, 12]);
  assert.ok(world.pointLights.slice(8).every(value => value === 0));
  assert.equal(world.pointLights.byteLength, 512);
});

test('yaw-dependent collision AABBs conservatively contain transformed solid geometry', () => {
  const world = createFPSWorld({ objects: [
    { kind: 'box', position: [10, 2, 3], scale: [4, 2, 2], yaw: Math.PI / 2, solid: true },
    { kind: 'sphere', position: [-3, 1, 2], scale: [2, 2, 2] },
  ] });
  assert.equal(world.colliders.length, 1);
  const collider = world.colliders[0];
  close(collider.min[0], 9); close(collider.max[0], 11);
  close(collider.min[1], 1); close(collider.max[1], 3);
  close(collider.min[2], 1); close(collider.max[2], 5);
  const yaw = world.instances[3], cosine = Math.cos(yaw), sine = Math.sin(yaw);
  for (const x of [-2, 2]) for (const z of [-1, 1]) {
    const transformed = [10 + x * cosine + z * sine, 2, 3 - x * sine + z * cosine];
    transformed.forEach((value, axis) => assert.ok(value >= collider.min[axis] - 1e-12 && value <= collider.max[axis] + 1e-12));
  }
  close(world.bounds.min[0], -4); close(world.bounds.max[0], 11);
  assert.equal(world.bounds.max[1], 3);
});

test('world construction snapshots descriptions without mutating their objects', () => {
  const description = { objects: [{ position: [1, 2, 3], material: { color: [0.1, 0.2, 0.3] } }],
    spawn: { position: [0, 2, -5] }, lights: [{ position: [0, 4, 0] }] };
  const original = structuredClone(description);
  const world = createFPSWorld(description);
  assert.deepEqual(description, original);
  description.objects[0].position[0] = 99;
  description.spawn.position[1] = 99;
  description.lights[0].position[1] = 99;
  assert.equal(world.instances[0], 1);
  assert.deepEqual(world.spawn.position, [0, 2, -5]);
  assert.equal(world.pointLights[1], 4);
  assert.ok(Object.isFrozen(world));
  assert.ok(Object.isFrozen(world.colliders));
});

test('empty FPS worlds remain valid with finite bounds and default first-person spawn', () => {
  const world = createFPSWorld({ floorY: -2 });
  assert.equal(world.count, 0);
  assert.equal(world.instanceBytes, 0);
  assert.equal(world.byteLength, 512);
  assert.deepEqual(world.batches, []);
  assert.deepEqual(world.colliders, []);
  assert.deepEqual(world.bounds, { min: [0, -2, 0], max: [0, -2, 0] });
  assert.deepEqual(world.spawn, { position: [0, Math.fround(1.7), -4], yaw: 0, pitch: 0 });
});

test('lighting is a validated normalized snapshot with explicit towards-light direction', () => {
  const world = createFPSWorld({ lighting: { sunDirection: [0, 2, 0], sunIntensity: 5,
    sunColor: [0.9, 1, 0.7], ambient: 0.1, fogDensity: 0.02, exposure: 2,
    reflectionStrength: 0.7, bloomStrength: 0.2, aoStrength: 0.5 } });
  assert.deepEqual(world.lighting.sunDirection, [0, 1, 0]);
  assert.equal(world.lighting.sunIntensity, 5);
  assert.equal(world.lighting.exposure, 2);
  close(world.lighting.reflectionStrength, 0.7);
  close(Math.hypot(...createFPSWorld().lighting.sunDirection), 1);
  assert.ok(Object.isFrozen(world.lighting));
});

test('invalid descriptions fail before returning a partial world or changing inputs', () => {
  const invalidObjects = [
    { kind: 'unknown' }, { position: [0, 1] }, { position: [NaN, 0, 0] },
    { scale: [0, 1, 1] }, { scale: [-1, 1, 1] }, { yaw: Infinity }, { solid: 1 },
    { material: { color: [1.1, 0, 0] } }, { material: { roughness: -0.1 } },
    { material: { metallic: 2 } }, { material: { emission: -Number.MIN_VALUE } },
    { material: { reflection: 2 } }, { material: { pattern: 0.999999999 } },
    { position: [3.3e38, 0, 0], scale: [3.3e38, 1, 1] },
  ];
  for (const invalid of invalidObjects) {
    const description = { objects: [{ kind: 'box' }, invalid] };
    const snapshot = structuredClone(description);
    assert.throws(() => createFPSWorld(description));
    assert.deepEqual(description, snapshot);
  }
  assert.throws(() => createFPSWorld({ objects: new Array(1) }), /objects\[0\]/);
  assert.throws(() => createFPSWorld({ objects: { length: 1 } }), /objects/);
  assert.throws(() => createFPSWorld({ objects: new Array(MAX_FPS_OBJECTS + 1) }), /at most/);
  assert.throws(() => createFPSWorld({ lights: new Array(MAX_FPS_LIGHTS + 1) }), /at most/);
  assert.throws(() => createFPSWorld({ lights: [{ radius: 0 }] }), /radius/);
  assert.throws(() => createFPSWorld({ lights: [{ intensity: -1 }] }), /intensity/);
  assert.throws(() => createFPSWorld({ spawn: { pitch: Math.PI / 2 } }), /pitch/);
  assert.throws(() => createFPSWorld({ floorY: NaN }), /floorY/);
  assert.throws(() => createFPSWorld({ lighting: { sunDirection: [0, 0, 0] } }), /zero/);
  assert.throws(() => createFPSWorld({ lighting: { exposure: 0 } }), /exposure/);
  assert.throws(() => createFPSWorld({ lighting: { sunColor: [0, 0, 4] } }), /sunColor/);
  assert.throws(() => createFPSWorld({ lighting: { fogDensity: -1 } }), /fogDensity/);
});

test('unit meshes contain valid position-normal-UV vertices and outward nondegenerate triangles', () => {
  const meshes = createFPSMeshes();
  assert.deepEqual(Object.keys(meshes), FPS_MESH_KINDS);
  assert.equal(meshes.box.vertices.length / 8, 24);
  assert.equal(meshes.box.indices.length, 36);
  assert.equal(meshes.cylinder.indices.length, 24 * 12);
  assert.equal(meshes.sphere.indices.length, 16 * 7 * 6);
  for (const [kind, data] of Object.entries(meshes)) {
    assert.ok(data.vertices instanceof Float32Array);
    assert.ok(data.indices instanceof Uint32Array);
    assert.equal(data.vertices.length % 8, 0);
    assert.equal(data.indices.length % 3, 0);
    const vertexCount = data.vertices.length / 8;
    for (let offset = 0; offset < data.vertices.length; offset += 8) {
      const vertex = data.vertices.slice(offset, offset + 8);
      assert.ok(vertex.every(Number.isFinite));
      vertex.slice(0, 3).forEach(value => assert.ok(Math.abs(value) <= 0.5));
      close(Math.hypot(...vertex.slice(3, 6)), 1);
      vertex.slice(6, 8).forEach(value => assert.ok(value >= 0 && value <= 1));
    }
    for (let offset = 0; offset < data.indices.length; offset += 3) {
      const ids = [...data.indices.slice(offset, offset + 3)];
      ids.forEach(index => assert.ok(index < vertexCount));
      const vertices = ids.map(index => data.vertices.slice(index * 8, index * 8 + 8));
      const ab = [0, 1, 2].map(axis => vertices[1][axis] - vertices[0][axis]);
      const ac = [0, 1, 2].map(axis => vertices[2][axis] - vertices[0][axis]);
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const normal = [0, 1, 2].map(axis => vertices.reduce((sum, vertex) => sum + vertex[axis + 3], 0));
      const orientation = cross.reduce((sum, value, axis) => sum + value * normal[axis], 0);
      assert.ok(orientation > 1e-9, `${kind} triangle ${offset / 3} must face outwards with positive area`);
    }
  }
});

test('pipe is a proper rotation of the capped Y cylinder with independently owned buffers', () => {
  const meshes = createFPSMeshes();
  assert.notEqual(meshes.pipe.vertices, meshes.cylinder.vertices);
  assert.notEqual(meshes.pipe.indices, meshes.cylinder.indices);
  assert.deepEqual(meshes.pipe.indices, meshes.cylinder.indices);
  for (let offset = 0; offset < meshes.cylinder.vertices.length; offset += 8) {
    const cylinder = meshes.cylinder.vertices.slice(offset, offset + 8);
    const pipe = meshes.pipe.vertices.slice(offset, offset + 8);
    assert.deepEqual([...pipe], [cylinder[0], -cylinder[2], cylinder[1], cylinder[3],
      -cylinder[5], cylinder[4], cylinder[6], cylinder[7]]);
  }
});
