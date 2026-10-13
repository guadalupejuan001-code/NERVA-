import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseGLTF, loadGLTF, sampleGLTFAnimation, createGLTFAnimator,
  GLTF_VERTEX_BYTES } from '../src/graphics/gltf.mjs';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function fixture({ normalizedWeights = false, stride = false, interpolation = 'LINEAR' } = {}) {
  const chunks = [], bufferViews = [], accessors = [];
  let byteLength = 0;
  function add(array, type, componentType, options = {}) {
    const padding = (4 - byteLength % 4) % 4;
    if (padding) { chunks.push(new Uint8Array(padding)); byteLength += padding; }
    const byteOffset = byteLength, bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    chunks.push(bytes); byteLength += bytes.byteLength;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, ...options.view });
    accessors.push({ bufferView: bufferViews.length - 1, componentType, type,
      count: options.count ?? array.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]),
      ...options.accessor });
    return accessors.length - 1;
  }
  const POSITION = add(new Float32Array(stride ? [0, 0, 0, 99, 1, 0, 0, 99, 0, 1, 0, 99] : [0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3', 5126,
    stride ? { count: 3, view: { byteStride: 16 } } : {});
  const NORMAL = add(new Float32Array([0, 0, 2, 0, 0, 2, 0, 0, 2]), 'VEC3', 5126);
  const TEXCOORD_0 = add(new Float32Array([0, 0, 1, 0, 0, 1]), 'VEC2', 5126);
  const JOINTS_0 = add(new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4', 5121);
  const WEIGHTS_0 = normalizedWeights ? add(new Uint8Array([128, 127, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]), 'VEC4', 5121, { accessor: { normalized: true } }) :
    add(new Float32Array([0.4, 0.4, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4', 5126);
  const indices = add(new Uint16Array([0, 1, 2]), 'SCALAR', 5123);
  const inverseChild = [...I]; inverseChild[13] = -1;
  const inverseBindMatrices = add(new Float32Array([...I, ...inverseChild]), 'MAT4', 5126);
  const time = add(new Float32Array([0, 2]), 'SCALAR', 5126);
  const translation = add(new Float32Array([0, 0, 0, 2, 0, 0]), 'VEC3', 5126);
  const rotation = add(new Float32Array([0, 0, 0, 1, 0, 0, 1, 0]), 'VEC4', 5126);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { buffers: [bytes.buffer], document: {
    asset: { version: '2.0' }, buffers: [{ byteLength, uri: 'rig.bin' }], bufferViews, accessors,
    nodes: [{ name: 'Root', translation: [5, 0, 0], children: [1, 3] },
      { name: 'Hip', children: [2] }, { name: 'Arm', translation: [0, 1, 0] }, { name: 'Mesh', mesh: 0, skin: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION, NORMAL, TEXCOORD_0, JOINTS_0, WEIGHTS_0 }, indices, material: 0 }] }],
    skins: [{ joints: [1, 2], inverseBindMatrices }],
    materials: [{ name: 'Cloth', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1], roughnessFactor: 0.8, metallicFactor: 0.1 } }],
    animations: [{ name: 'Walk', samplers: [{ input: time, output: translation, interpolation }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] },
      { name: 'Turn', samplers: [{ input: time, output: rotation, interpolation }], channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }] }],
  } };
}
function near(actual, expected, epsilon = 1e-5) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= epsilon, `component ${i}: ${value} != ${expected[i]}`));
}
function transform(matrix, point) {
  return [0, 1, 2].map(axis => matrix[axis] * point[0] + matrix[4 + axis] * point[1] + matrix[8 + axis] * point[2] + matrix[12 + axis]);
}

test('glTF interleaved geometry packs exact GPU skin layout and material factors', () => {
  const input = fixture({ stride: true });
  const asset = parseGLTF(input.document, input.buffers), primitive = asset.primitives[0];
  assert.equal(primitive.vertexCount, 3);
  assert.equal(primitive.vertices.byteLength, 3 * GLTF_VERTEX_BYTES);
  assert.deepEqual([...primitive.indices], [0, 1, 2]);
  const view = new DataView(primitive.vertices.buffer);
  near([view.getFloat32(96, true), view.getFloat32(100, true), view.getFloat32(104, true)], [1, 0, 0]);
  near([view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true)], [0, 0, 1]);
  assert.equal(view.getUint16(32, true), 0); assert.equal(view.getUint16(34, true), 1);
  near([view.getFloat32(40, true), view.getFloat32(44, true)], [0.5, 0.5]);
  near([view.getFloat32(56, true), view.getFloat32(60, true), view.getFloat32(64, true), view.getFloat32(68, true)], [0.2, 0.4, 0.6, 0.8]);
  near(asset.bounds.min, [5, 0, 0]); near(asset.bounds.max, [6, 1, 0]);
  assert.deepEqual(asset.skeleton[0].map(joint => [joint.name, joint.parentJoint]), [['Hip', -1], ['Arm', 0]]);
});

test('normalized integer weights remain normalized and preserve bone ratios', () => {
  const input = fixture({ normalizedWeights: true }), asset = parseGLTF(input.document, input.buffers);
  const view = new DataView(asset.primitives[0].vertices.buffer);
  near([view.getFloat32(40, true), view.getFloat32(44, true)], [128 / 255, 127 / 255]);
});

test('bind pose cancels parent mesh transforms and inverse bind matrices', () => {
  const input = fixture(), asset = parseGLTF(input.document, input.buffers);
  near([...asset.bindPose.palette], [...I, ...I]);
  near(transform(asset.bindPose.meshWorld, [0, 0, 0]), [5, 0, 0]);
  const pose = sampleGLTFAnimation(asset, { animation: 'walk', time: 1 });
  near(transform(pose.palette.subarray(0, 16), [0, 0, 0]), [1, 0, 0]);
  near(transform(pose.palette.subarray(16, 32), [0, 1, 0]), [1, 1, 0]);
  near(transform(pose.meshWorld, transform(pose.palette.subarray(16, 32), [0, 1, 0])), [6, 1, 0]);
});

test('quaternion animation rotates vertices around the bound bone pivot', () => {
  const input = fixture(), asset = parseGLTF(input.document, input.buffers);
  const pose = sampleGLTFAnimation(asset, { animation: 'Turn', time: 1, loop: false });
  // 90 degrees around +Z at the arm's pivot [0,1,0].
  near(transform(pose.palette.subarray(16, 32), [1, 1, 0]), [0, 2, 0]);
  near(transform(pose.palette.subarray(16, 32), [0, 1, 0]), [0, 1, 0]);
});

test('antipodal quaternion keys preserve orientation along the shortest path', () => {
  const input = fixture(), sampler = input.document.animations[1].samplers[0];
  const accessor = input.document.accessors[sampler.output], view = input.document.bufferViews[accessor.bufferView];
  new Float32Array(input.buffers[0], view.byteOffset, 8).set([0, 0, 0, 1, 0, 0, 0, -1]);
  const asset = parseGLTF(input.document, input.buffers);
  const pose = sampleGLTFAnimation(asset, { animation: 'Turn', time: 1 });
  near(transform(pose.palette.subarray(16, 32), [1, 1, 0]), [1, 1, 0]);
});

test('loop, negative time, endpoint clamps and STEP animation have defined timing', () => {
  const input = fixture(), asset = parseGLTF(input.document, input.buffers);
  assert.equal(sampleGLTFAnimation(asset, { animation: 'Walk', time: 2 }).palette[12], 0);
  assert.equal(sampleGLTFAnimation(asset, { animation: 'Walk', time: -1 }).palette[12], 1);
  assert.equal(sampleGLTFAnimation(asset, { animation: 'Walk', time: 20, loop: false }).palette[12], 2);
  const step = fixture({ interpolation: 'STEP' }), stepped = parseGLTF(step.document, step.buffers);
  assert.equal(sampleGLTFAnimation(stepped, { animation: 'Walk', time: 1, loop: false }).palette[12], 0);
  assert.equal(sampleGLTFAnimation(stepped, { animation: 'Walk', time: 2, loop: false }).palette[12], 2);
});

test('animator keeps palette, scratch transforms and result identity stable across clips', () => {
  const input = fixture(), asset = parseGLTF(input.document, input.buffers);
  const animator = createGLTFAnimator(asset, { animation: 'Walk' }), pose = animator.pose;
  const arrays = [pose.palette, pose.meshWorld, pose.jointWorld, ...pose._locals, ...pose._worlds];
  assert.equal(animator.sample(1), pose);
  assert.equal(animator.sample(1, { animation: 'Turn' }), pose);
  assert.deepEqual([pose.palette, pose.meshWorld, pose.jointWorld, ...pose._locals, ...pose._worlds], arrays);
  assert.throws(() => animator.sample(0, { animation: 'missing' }), /not found/);
});

test('loader resolves buffers relative to the glTF URL through an injected fetch', async () => {
  const input = fixture(), requested = [];
  const asset = await loadGLTF('https://example.test/models/rig.gltf', { fetch: async url => {
    requested.push(url);
    return url.endsWith('.gltf') ? { ok: true, json: async () => input.document } :
      { ok: true, arrayBuffer: async () => input.buffers[0] };
  } });
  assert.deepEqual(requested, ['https://example.test/models/rig.gltf', 'https://example.test/models/rig.bin']);
  assert.equal(asset.jointCount, 2);
  input.document.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(input.buffers[0]).toString('base64')}`;
  const inline = await loadGLTF('https://example.test/inline.gltf', { fetch: async () => ({ ok: true, json: async () => input.document }) });
  assert.equal(inline.primitives[0].vertexCount, 3);
});

test('malformed binary bounds, skin indices, weights and unsupported features fail explicitly', () => {
  const cases = [
    [input => { input.document.bufferViews[0].byteLength = 4; }, /bounds/],
    [input => { input.document.accessors[0].byteOffset = 2; }, /misaligned/],
    [input => { input.document.accessors[0].sparse = {}; }, /sparse/],
    [input => { input.document.nodes[2].children = [0]; }, /cycle/],
    [input => { input.document.meshes[0].primitives[0].mode = 1; }, /TRIANGLES/],
    [input => { input.document.animations[0].samplers[0].interpolation = 'CUBICSPLINE'; }, /CUBICSPLINE/],
    [input => { input.document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }; }, /textured/],
    [input => { const a = input.document.accessors[input.document.meshes[0].primitives[0].attributes.JOINTS_0]; const v = input.document.bufferViews[a.bufferView]; new Uint8Array(input.buffers[0])[v.byteOffset] = 2; }, /outside the skin/],
    [input => { const a = input.document.accessors[input.document.meshes[0].primitives[0].attributes.WEIGHTS_0]; const v = input.document.bufferViews[a.bufferView]; new Float32Array(input.buffers[0], v.byteOffset, 4).fill(0); }, /positive total/],
    [input => { const a = input.document.accessors[input.document.meshes[0].primitives[0].indices]; const v = input.document.bufferViews[a.bufferView]; new Uint16Array(input.buffers[0], v.byteOffset, 3)[0] = 3; }, /exceeds vertex/],
  ];
  for (const [mutate, error] of cases) { const input = fixture(); mutate(input); assert.throws(() => parseGLTF(input.document, input.buffers), error); }
});

test('original Iria glTF has a valid shared rig, identity bind pose and finite animated GPU palettes', async () => {
  const url = new URL('../assets/characters/iria.gltf', import.meta.url);
  const document = JSON.parse(await readFile(url, 'utf8'));
  const buffers = await Promise.all(document.buffers.map(async definition => {
    const bytes = await readFile(new URL(definition.uri, url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }));
  const asset = parseGLTF(document, buffers);
  assert.equal(asset.jointCount, 23);
  assert.equal(new Set(asset.primitives.map(primitive => primitive.nodeIndex)).size, 1);
  assert.equal(new Set(asset.primitives.map(primitive => primitive.skinIndex)).size, 1);
  assert.ok(asset.bounds.max[1] > 1.6 && asset.bounds.max[1] < 1.9);
  assert.ok(asset.primitives.reduce((sum, primitive) => sum + primitive.indexCount / 3, 0) < 20_000);
  for (let joint = 0; joint < asset.jointCount; joint++) near(asset.bindPose.palette.subarray(joint * 16, joint * 16 + 16), I);
  const animator = createGLTFAnimator(asset, { animation: 'idle' });
  const initialPalette = [...animator.sample(0).palette];
  const walk = animator.sample(0.275, { animation: 'walk' });
  assert.ok([...walk.palette].every(Number.isFinite));
  assert.ok([...walk.palette].some((value, i) => Math.abs(value - initialPalette[i]) > 0.01));
  assert.equal(walk.palette.byteLength, 23 * 64);
});
