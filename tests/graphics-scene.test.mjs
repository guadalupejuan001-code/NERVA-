import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, getSceneMemory, cameraParameters, defaultCamera, cullScene,
  MAX_SCENE_INSTANCES } from '../src/graphics/scene.mjs';

function fixture(positions) {
  const scene = createScene({ count: positions.length });
  scene.updateInstances(positions.map((position, index) => ({ index,
    position: position.slice(0, 3), radius: position[3] ?? 0.5 })));
  scene.consumeDirtyRanges();
  return scene;
}

test('persistent instance buffers are deterministic, bounded and precisely accounted', () => {
  const scene = createScene({ count: 100, seed: 0, spread: 30 });
  const same = createScene({ count: 100, seed: 0, spread: 30 });
  const different = createScene({ count: 100, seed: 1, spread: 30 });
  assert.deepEqual(scene.positions, same.positions);
  assert.deepEqual(scene.colors, same.colors);
  assert.notDeepEqual(scene.positions, different.positions);
  for (let index = 0; index < scene.count; index++) {
    const offset = index * 4;
    assert.ok(Math.abs(scene.positions[offset]) <= 30);
    assert.ok(Math.abs(scene.positions[offset + 1]) <= 30);
    assert.ok(scene.positions[offset + 2] >= 2 && scene.positions[offset + 2] <= 92);
    assert.ok(scene.positions[offset + 3] >= Math.fround(0.3) && scene.positions[offset + 3] <= 1.5);
    assert.ok(scene.colors.subarray(offset, offset + 4).every(value => value >= 0 && value <= 1));
  }
  assert.equal(scene.byteLength, 3200);
  assert.deepEqual(getSceneMemory(scene), { positionsBytes: 1600, colorsBytes: 1600,
    totalBytes: 3200, bytesPerInstance: 32 });
  assert.equal(MAX_SCENE_INSTANCES, 1_000_000);
});

test('initial upload is full and unchanged frames upload zero bytes', () => {
  const scene = createScene({ count: 6 });
  assert.deepEqual(scene.consumeDirtyRanges(), { revision: 0, ranges: [{ first: 0, count: 6 }], bytes: 192 });
  assert.deepEqual(scene.consumeDirtyRanges(), { revision: 0, ranges: [], bytes: 0 });
  assert.equal(scene.updateInstances([]), 0);
  const empty = createScene({ count: 0 });
  assert.deepEqual(empty.consumeDirtyRanges(), { revision: 0, ranges: [], bytes: 0 });
  assert.deepEqual(cullScene(empty).counts, [0, 0, 0]);
});

test('patches preserve buffer identity and merge only affected contiguous upload ranges', () => {
  const scene = createScene({ count: 10 });
  const positions = scene.positions, colors = scene.colors;
  scene.consumeDirtyRanges();
  scene.updateInstances([{ index: 3, position: [1, 2, 3] }, { index: 7, color: [0.1, 0.2, 0.3] },
    { index: 2, radius: 2 }, { index: 3, roughness: 0.75 }]);
  scene.updateInstances([{ index: 4, radius: 1 }, { index: 6, position: [0, 0, 6] }]);
  assert.equal(scene.revision, 2);
  assert.equal(scene.positions, positions);
  assert.equal(scene.colors, colors);
  assert.deepEqual([...positions.subarray(12, 15)], [1, 2, 3]);
  assert.equal(positions[11], 2);
  assert.equal(colors[15], 0.75);
  assert.deepEqual(scene.consumeDirtyRanges(), { revision: 2,
    ranges: [{ first: 2, count: 3 }, { first: 6, count: 2 }], bytes: 160 });
  assert.deepEqual(scene.consumeDirtyRanges(), { revision: 2, ranges: [], bytes: 0 });
});

test('duplicate patches apply in order and pending initial upload remains complete', () => {
  const scene = createScene({ count: 2 });
  scene.updateInstances([{ index: 0, position: [1, 1, 1] }, { index: 0, position: [2, 3, 4] }]);
  assert.deepEqual([...scene.positions.subarray(0, 3)], [2, 3, 4]);
  assert.deepEqual(scene.consumeDirtyRanges(), { revision: 1, ranges: [{ first: 0, count: 2 }], bytes: 64 });
});

test('an invalid later patch does not mutate arrays, revision or pending ranges', () => {
  const scene = createScene({ count: 3 });
  scene.consumeDirtyRanges();
  scene.updateInstances([{ index: 2, radius: 2 }]);
  const positions = scene.positions.slice(), colors = scene.colors.slice();
  for (const invalid of [{ index: 3, radius: 1 }, { index: 1, position: [0, NaN, 1] },
    { index: 1, radius: 0 }, { index: 1, color: [1, -0.1, 0] }, { index: 1, roughness: 1.1 },
    { index: 1 }, { index: 1, position: [0, 0, 1e40] }, { index: 1, radius: 1e-50 }]) {
    assert.throws(() => scene.updateInstances([{ index: 0, position: [5, 6, 7], color: [1, 0, 0] }, invalid]));
    assert.deepEqual(scene.positions, positions);
    assert.deepEqual(scene.colors, colors);
    assert.equal(scene.revision, 1);
  }
  const sparseBatch = [{ index: 0, position: [5, 6, 7] }];
  sparseBatch.length = 2;
  assert.throws(() => scene.updateInstances(sparseBatch));
  assert.deepEqual(scene.positions, positions);
  assert.deepEqual(scene.colors, colors);
  assert.equal(scene.revision, 1);
  assert.deepEqual(scene.consumeDirtyRanges(), { revision: 1, ranges: [{ first: 2, count: 1 }], bytes: 32 });
});

test('scene allocation rejects invalid budgets and unrepresentable data', () => {
  for (const count of [-1, 0.5, NaN, Infinity, 1_000_001, Number.MAX_SAFE_INTEGER])
    assert.throws(() => createScene({ count }));
  for (const seed of [-1, 0.1, 0x100000000, NaN]) assert.throws(() => createScene({ count: 1, seed }));
  for (const spread of [0, -1, Infinity, NaN, 1e40, 1e-50])
    assert.throws(() => createScene({ count: 1, spread }));
  assert.throws(() => createScene());
  assert.throws(() => getSceneMemory({ count: 1, positions: new Float32Array(4), colors: [] }));
});

test('camera parameters share f32 values and validate projection and LOD contracts', () => {
  const camera = cameraParameters(defaultCamera({ position: [0.1, 0.2, 0.3] }));
  assert.deepEqual(camera.position, [Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
  assert.equal(camera.tanY, Math.fround(Math.tan(Math.PI / 6)));
  assert.equal(camera.tanX, Math.fround(camera.tanY * Math.fround(4 / 3)));
  for (const patch of [{ near: 0 }, { far: 1 }, { fovY: 0 }, { fovY: Math.PI },
    { aspect: -1 }, { position: [1, 2] }, { lodDistances: [40, 40] },
    { lodDistances: [0, 1] }, { lodDistances: [1, Infinity] }, { far: 1e40 }])
    assert.throws(() => cameraParameters(defaultCamera(patch)));
  assert.throws(() => cameraParameters(null));
});

test('frustum reference checks center, all six planes and sphere-plane intersection', () => {
  const camera = defaultCamera({ near: 1, far: 50, fovY: Math.PI / 2, aspect: 1 });
  const scene = fixture([
    [0, 0, 10, 0.5], // Center visible.
    [11.5, 0, 10, 0.5], [-11.5, 0, 10, 0.5], // Outside right/left.
    [0, 11.5, 10, 0.5], [0, -11.5, 10, 0.5], // Outside top/bottom.
    [0, 0, -5, 0.5], [0, 0, 51, 0.5], // Behind and beyond far.
    [10.6, 0, 10, 0.5], [-10.6, 0, 10, 0.5], // Sphere intersects normalized side plane.
    [0, 10.6, 10, 0.5], [0, -10.6, 10, 0.5],
    [0, 0, 0.6, 0.5], [0, 0, 50.4, 0.5], // Sphere intersects near/far.
  ]);
  const culled = cullScene(scene, camera);
  assert.deepEqual([...culled.visible], [0, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual([...culled.lods], [0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(culled.counts, [6, 1, 0]);
});

test('camera translation is applied and LOD thresholds use Euclidean center distance', () => {
  const scene = fixture([[5, 6, 17, 0.5], [5, 6, 47, 0.5], [5, 6, 107, 0.5],
    [35, 6, 37, 0.5], [0, 0, -100, 0.5]]);
  const result = cullScene(scene, defaultCamera({ position: [5, 6, 7], fovY: Math.PI / 2, aspect: 2 }));
  assert.deepEqual([...result.visible], [0, 1, 2, 3]);
  assert.deepEqual([...result.lods], [0, 1, 2, 1]);
  assert.deepEqual(result.counts, [1, 2, 1]);
  assert.equal(result.visible.length, result.lods.length);
});
