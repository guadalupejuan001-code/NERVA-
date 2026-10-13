/** Portable glTF 2.0 geometry, skeletal poses and LINEAR/STEP animation.
 * The supported, explicit subset is triangle meshes, untextured metallic/
 * roughness materials, one four-weight skin per primitive and TRS animation.
 * Buffers are copied into a directly uploadable 96-byte GPU vertex layout.
 */
export const GLTF_VERTEX_BYTES = 96;
export const MAX_GLTF_JOINTS = 256;

const COMPONENTS = { 5120: [1, 'getInt8'], 5121: [1, 'getUint8'],
  5122: [2, 'getInt16'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'],
  5126: [4, 'getFloat32'] };
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value;
}
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${name} must be an integer >= ${minimum}`);
  return value;
}
function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw new TypeError(`${name} must be a finite Float32 number`);
  return value;
}
function vector(value, size, fallback, name) {
  value ??= fallback;
  if (!Array.isArray(value) || value.length !== size) throw new TypeError(`${name} must have ${size} numbers`);
  return value.map((number, axis) => finite(number, `${name}[${axis}]`));
}
function index(array, value, name) {
  integer(value, name);
  if (value >= array.length) throw new RangeError(`${name} is out of range`);
  return array[value];
}
function unit(value, name) {
  finite(value, name);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return value;
}
function normalizeQuaternion(rotation, name) {
  const length = Math.hypot(...rotation);
  if (length < 1e-8) throw new RangeError(`${name} must not be zero`);
  return rotation.map(value => value / length);
}
function multiply(a, b, out = new Float32Array(16)) {
  // Inputs and output must be distinct, which callers guarantee.
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}
function inverse(a, out = new Float32Array(16)) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(determinant) || determinant === 0) throw new RangeError('mesh node transform must be invertible');
  const d = 1 / determinant;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(out[i])) throw new RangeError('inverse mesh transform exceeds Float32 range');
  return out;
}
function compose(translation, rotation, scale, out) {
  const [x, y, z, w] = rotation, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2;
  const yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - yy - zz) * scale[0]; out[1] = (xy + wz) * scale[0]; out[2] = (xz - wy) * scale[0]; out[3] = 0;
  out[4] = (xy - wz) * scale[1]; out[5] = (1 - xx - zz) * scale[1]; out[6] = (yz + wx) * scale[1]; out[7] = 0;
  out[8] = (xz + wy) * scale[2]; out[9] = (yz - wx) * scale[2]; out[10] = (1 - xx - yy) * scale[2]; out[11] = 0;
  out[12] = translation[0]; out[13] = translation[1]; out[14] = translation[2]; out[15] = 1;
}

function readAccessors(document, buffers) {
  const definitions = document.accessors ?? [], views = document.bufferViews ?? [];
  const bufferDefinitions = document.buffers ?? [];
  if (!Array.isArray(buffers) || buffers.length !== bufferDefinitions.length)
    throw new TypeError('buffers must contain one ArrayBuffer per glTF buffer');
  for (let i = 0; i < buffers.length; i++) {
    if (!(buffers[i] instanceof ArrayBuffer)) throw new TypeError(`buffers[${i}] must be an ArrayBuffer`);
    const length = integer(bufferDefinitions[i].byteLength, `buffers[${i}].byteLength`, 1);
    if (buffers[i].byteLength < length) throw new RangeError(`buffers[${i}] is truncated`);
  }
  return definitions.map((definition, accessorIndex) => {
    const name = `accessors[${accessorIndex}]`;
    object(definition, name);
    if (definition.sparse) throw new TypeError(`${name}: sparse accessors are unsupported`);
    const component = COMPONENTS[definition.componentType], components = TYPE_SIZE[definition.type];
    if (!component || !components) throw new TypeError(`${name}: unsupported accessor type`);
    if (definition.type === 'MAT4' && definition.componentType !== 5126)
      throw new TypeError(`${name}: only Float32 MAT4 is supported`);
    if (definition.normalized !== undefined && typeof definition.normalized !== 'boolean')
      throw new TypeError(`${name}.normalized must be boolean`);
    if (definition.normalized && ![5120, 5121, 5122, 5123].includes(definition.componentType))
      throw new TypeError(`${name}: normalization requires an 8/16-bit integer type`);
    const count = integer(definition.count, `${name}.count`, 1);
    const view = index(views, definition.bufferView, `${name}.bufferView`);
    object(view, `${name}.bufferView`);
    const buffer = index(buffers, view.buffer, `${name}.buffer`);
    const viewOffset = integer(view.byteOffset ?? 0, `${name}.view.byteOffset`);
    const viewLength = integer(view.byteLength, `${name}.view.byteLength`, 1);
    if (viewOffset + viewLength > bufferDefinitions[view.buffer].byteLength)
      throw new RangeError(`${name}: bufferView exceeds declared buffer bounds`);
    const accessorOffset = integer(definition.byteOffset ?? 0, `${name}.byteOffset`);
    const elementBytes = component[0] * components;
    const stride = integer(view.byteStride ?? elementBytes, `${name}.byteStride`, elementBytes);
    if (view.byteStride !== undefined && (stride % 4 !== 0 || stride > 252))
      throw new RangeError(`${name}: byteStride must be a multiple of 4 <= 252`);
    if (accessorOffset % component[0] !== 0 || (viewOffset + accessorOffset) % component[0] !== 0)
      throw new RangeError(`${name}: misaligned accessor`);
    if (accessorOffset + (count - 1) * stride + elementBytes > viewLength)
      throw new RangeError(`${name}: accessor exceeds bufferView bounds`);
    const data = new Float64Array(count * components), reader = new DataView(buffer);
    for (let element = 0; element < count; element++) {
      for (let axis = 0; axis < components; axis++) {
        const byte = viewOffset + accessorOffset + element * stride + axis * component[0];
        let value = reader[component[1]](byte, true);
        if (definition.normalized) {
          if (definition.componentType === 5120) value = Math.max(value / 127, -1);
          if (definition.componentType === 5121) value /= 255;
          if (definition.componentType === 5122) value = Math.max(value / 32767, -1);
          if (definition.componentType === 5123) value /= 65535;
        }
        data[element * components + axis] = finite(value, `${name}[${element},${axis}]`);
      }
    }
    return { ...definition, components, count, data };
  });
}

function accessor(accessors, reference, name, type, componentTypes, count) {
  const value = index(accessors, reference, name);
  if (value.type !== type || !componentTypes.includes(value.componentType))
    throw new TypeError(`${name} must use ${type} with component type ${componentTypes.join('/')}`);
  if (count !== undefined && value.count !== count) throw new RangeError(`${name} count differs from POSITION`);
  return value;
}
function material(definition = {}) {
  object(definition, 'material');
  const pbr = object(definition.pbrMetallicRoughness ?? {}, 'material.pbrMetallicRoughness');
  if (definition.normalTexture || definition.occlusionTexture || definition.emissiveTexture ||
      pbr.baseColorTexture || pbr.metallicRoughnessTexture)
    throw new TypeError('textured glTF materials are unsupported; use material factors');
  if (definition.extensions && Object.keys(definition.extensions).length)
    throw new TypeError('glTF material extensions are unsupported');
  if ((definition.alphaMode ?? 'OPAQUE') !== 'OPAQUE') throw new TypeError('only OPAQUE glTF materials are supported');
  const color = vector(pbr.baseColorFactor, 4, [1, 1, 1, 1], 'material.baseColorFactor');
  color.forEach((value, axis) => unit(value, `material.baseColorFactor[${axis}]`));
  const emission = vector(definition.emissiveFactor, 3, [0, 0, 0], 'material.emissiveFactor');
  if (emission.some(value => value < 0)) throw new RangeError('emissiveFactor must be nonnegative');
  const pattern = integer(definition.extras?.nervaPattern ?? 0, 'material.extras.nervaPattern');
  const reflection = unit(definition.extras?.nervaReflection ?? 0, 'material.extras.nervaReflection');
  return { name: definition.name ?? '', color, roughness: unit(pbr.roughnessFactor ?? 1, 'material.roughnessFactor'),
    metallic: unit(pbr.metallicFactor ?? 1, 'material.metallicFactor'),
    emission: Math.max(...emission), pattern, reflection, doubleSided: definition.doubleSided ?? false };
}

/** Parse explicit glTF JSON plus its binary buffers, with no network/file APIs. */
export function parseGLTF(document, buffers) {
  object(document, 'document');
  if (document.asset?.version !== '2.0') throw new TypeError('only glTF 2.0 is supported');
  if (document.extensionsRequired?.length) throw new TypeError(`required glTF extensions are unsupported: ${document.extensionsRequired.join(', ')}`);
  for (const name of ['buffers', 'bufferViews', 'accessors', 'nodes', 'meshes', 'skins', 'animations', 'materials'])
    if (document[name] !== undefined && !Array.isArray(document[name])) throw new TypeError(`${name} must be an array`);
  const accessors = readAccessors(document, buffers);
  const nodes = (document.nodes ?? []).map((node, nodeIndex) => {
    object(node, `nodes[${nodeIndex}]`);
    if (node.matrix && (node.translation || node.rotation || node.scale))
      throw new TypeError(`nodes[${nodeIndex}] cannot combine matrix and TRS`);
    const translation = vector(node.translation, 3, [0, 0, 0], `nodes[${nodeIndex}].translation`);
    const rotation = normalizeQuaternion(vector(node.rotation, 4, [0, 0, 0, 1], `nodes[${nodeIndex}].rotation`), `nodes[${nodeIndex}].rotation`);
    const scale = vector(node.scale, 3, [1, 1, 1], `nodes[${nodeIndex}].scale`);
    if (scale.some(value => value === 0)) throw new RangeError(`nodes[${nodeIndex}].scale must be nonzero`);
    if (node.children !== undefined && !Array.isArray(node.children)) throw new TypeError(`nodes[${nodeIndex}].children must be an array`);
    const matrix = node.matrix ? new Float32Array(vector(node.matrix, 16, IDENTITY, `nodes[${nodeIndex}].matrix`)) : null;
    if (matrix && (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1))
      throw new TypeError(`nodes[${nodeIndex}].matrix must be affine`);
    return { name: node.name ?? `node-${nodeIndex}`, parent: -1, children: [...(node.children ?? [])],
      translation, rotation, scale, matrix,
      mesh: node.mesh ?? null, skin: node.skin ?? null };
  });
  for (let parent = 0; parent < nodes.length; parent++) {
    for (const child of nodes[parent].children) {
      const node = index(nodes, child, `nodes[${parent}].children`);
      if (node.parent !== -1) throw new TypeError(`node ${child} has multiple parents`);
      node.parent = parent;
    }
  }
  const order = [], visited = new Uint8Array(nodes.length);
  function visit(nodeIndex) {
    if (visited[nodeIndex] === 1) throw new TypeError('glTF node hierarchy contains a cycle');
    if (visited[nodeIndex] === 2) return;
    visited[nodeIndex] = 1;
    if (nodes[nodeIndex].parent !== -1) visit(nodes[nodeIndex].parent);
    visited[nodeIndex] = 2;
    order.push(nodeIndex);
  }
  for (let node = 0; node < nodes.length; node++) visit(node);
  const skins = (document.skins ?? []).map((skin, skinIndex) => {
    object(skin, `skins[${skinIndex}]`);
    if (!Array.isArray(skin.joints) || skin.joints.length < 1 || skin.joints.length > MAX_GLTF_JOINTS)
      throw new RangeError(`skins[${skinIndex}] requires 1..${MAX_GLTF_JOINTS} joints`);
    const joints = skin.joints.map(value => { index(nodes, value, 'skin.joints'); return value; });
    if (new Set(joints).size !== joints.length) throw new TypeError('skin.joints must be unique');
    if (skin.skeleton !== undefined) index(nodes, skin.skeleton, 'skin.skeleton');
    const inverseBind = new Float32Array(joints.length * 16);
    if (skin.inverseBindMatrices !== undefined) {
      const data = accessor(accessors, skin.inverseBindMatrices, 'inverseBindMatrices', 'MAT4', [5126], joints.length);
      inverseBind.set(data.data);
    } else for (let i = 0; i < joints.length; i++) inverseBind.set(IDENTITY, i * 16);
    return { name: skin.name ?? `skin-${skinIndex}`, joints, jointCount: joints.length,
      inverseBind, skeleton: skin.skeleton ?? null, meshNodes: [] };
  });
  const primitives = [], bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const baseLocals = nodes.map(node => { const result = new Float32Array(16); node.matrix ? result.set(node.matrix) : compose(node.translation, node.rotation, node.scale, result); return result; });
  const baseWorlds = nodes.map(() => new Float32Array(16));
  for (const n of order) nodes[n].parent === -1 ? baseWorlds[n].set(baseLocals[n]) : multiply(baseWorlds[nodes[n].parent], baseLocals[n], baseWorlds[n]);
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    if (node.mesh === null) { if (node.skin !== null) throw new TypeError('skin requires a mesh node'); continue; }
    const mesh = index(document.meshes ?? [], node.mesh, `nodes[${nodeIndex}].mesh`);
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length) throw new TypeError('mesh.primitives must be nonempty');
    const skin = node.skin === null ? null : index(skins, node.skin, `nodes[${nodeIndex}].skin`);
    if (skin) skin.meshNodes.push(nodeIndex);
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4) throw new TypeError('only TRIANGLES glTF primitives are supported');
      if (primitive.targets?.length) throw new TypeError('morph targets are unsupported');
      if (primitive.extensions && Object.keys(primitive.extensions).length) throw new TypeError('compressed/extended primitives are unsupported');
      const attributes = object(primitive.attributes, 'primitive.attributes');
      if (attributes.JOINTS_1 !== undefined || attributes.WEIGHTS_1 !== undefined) throw new TypeError('only four skin weights per vertex are supported');
      const positions = accessor(accessors, attributes.POSITION, 'POSITION', 'VEC3', [5126]);
      const count = positions.count;
      const normals = accessor(accessors, attributes.NORMAL, 'NORMAL', 'VEC3', [5126], count);
      const uv = attributes.TEXCOORD_0 === undefined ? null : accessor(accessors, attributes.TEXCOORD_0, 'TEXCOORD_0', 'VEC2', [5126, 5121, 5123], count);
      if (uv && uv.componentType !== 5126 && !uv.normalized) throw new TypeError('integer TEXCOORD_0 must be normalized');
      const joints = skin ? accessor(accessors, attributes.JOINTS_0, 'JOINTS_0', 'VEC4', [5121, 5123], count) : null;
      const weights = skin ? accessor(accessors, attributes.WEIGHTS_0, 'WEIGHTS_0', 'VEC4', [5126, 5121, 5123], count) : null;
      if (!skin && (attributes.JOINTS_0 !== undefined || attributes.WEIGHTS_0 !== undefined)) throw new TypeError('joint attributes require a skin');
      if (joints?.normalized) throw new TypeError('JOINTS_0 must not be normalized');
      if (weights && weights.componentType !== 5126 && !weights.normalized) throw new TypeError('integer WEIGHTS_0 must be normalized');
      const vertexColor = attributes.COLOR_0 === undefined ? null : index(accessors, attributes.COLOR_0, 'COLOR_0');
      if (vertexColor && (!['VEC3', 'VEC4'].includes(vertexColor.type) || ![5126, 5121, 5123].includes(vertexColor.componentType) || vertexColor.count !== count || (vertexColor.componentType !== 5126 && !vertexColor.normalized)))
        throw new TypeError('COLOR_0 must be a normalized RGB/RGBA accessor matching POSITION');
      const info = material(primitive.material === undefined ? undefined : index(document.materials ?? [], primitive.material, 'primitive.material'));
      let indices;
      if (primitive.indices === undefined) indices = Uint32Array.from({ length: count }, (_, i) => i);
      else {
        const source = accessor(accessors, primitive.indices, 'indices', 'SCALAR', [5121, 5123, 5125]);
        if (source.normalized) throw new TypeError('indices must not be normalized');
        indices = Uint32Array.from(source.data);
      }
      if (indices.length % 3 !== 0) throw new RangeError('triangle indices count must be divisible by 3');
      if (indices.some(value => value >= count)) throw new RangeError('triangle index exceeds vertex count');
      const vertices = new Uint8Array(count * GLTF_VERTEX_BYTES), writer = new DataView(vertices.buffer);
      for (let vertex = 0; vertex < count; vertex++) {
        const offset = vertex * GLTF_VERTEX_BYTES;
        for (let axis = 0; axis < 3; axis++) writer.setFloat32(offset + axis * 4, positions.data[vertex * 3 + axis], true);
        const nx = normals.data[vertex * 3], ny = normals.data[vertex * 3 + 1], nz = normals.data[vertex * 3 + 2], length = Math.hypot(nx, ny, nz);
        if (length < 1e-8) throw new RangeError('NORMAL must be nonzero');
        for (let axis = 0; axis < 3; axis++) writer.setFloat32(offset + 12 + axis * 4, normals.data[vertex * 3 + axis] / length, true);
        for (let axis = 0; axis < 2; axis++) writer.setFloat32(offset + 24 + axis * 4, uv?.data[vertex * 2 + axis] ?? 0, true);
        let weightSum = 0;
        for (let axis = 0; axis < 4; axis++) {
          const joint = joints?.data[vertex * 4 + axis] ?? 0, weight = weights?.data[vertex * 4 + axis] ?? (axis === 0 ? 1 : 0);
          if (joint >= (skin?.jointCount ?? 1)) throw new RangeError('JOINTS_0 references a joint outside the skin');
          if (weight < 0 || weight > 1) throw new RangeError('WEIGHTS_0 must be between 0 and 1');
          writer.setUint16(offset + 32 + axis * 2, joint, true);
          weightSum += weight;
        }
        if (weightSum <= 1e-8) throw new RangeError('WEIGHTS_0 must have positive total weight');
        for (let axis = 0; axis < 4; axis++) writer.setFloat32(offset + 40 + axis * 4, (weights?.data[vertex * 4 + axis] ?? (axis === 0 ? 1 : 0)) / weightSum, true);
        for (let axis = 0; axis < 3; axis++) {
          const color = vertexColor ? unit(vertexColor.data[vertex * vertexColor.components + axis], 'COLOR_0') : 1;
          writer.setFloat32(offset + 56 + axis * 4, info.color[axis] * color, true);
        }
        writer.setFloat32(offset + 68, info.roughness, true);
        writer.setFloat32(offset + 72, info.metallic, true);
        writer.setFloat32(offset + 76, info.emission, true);
        writer.setFloat32(offset + 80, info.pattern, true);
        writer.setFloat32(offset + 84, info.reflection, true);
        const p = positions.data, x = p[vertex * 3], y = p[vertex * 3 + 1], z = p[vertex * 3 + 2], world = baseWorlds[nodeIndex];
        for (let axis = 0; axis < 3; axis++) {
          const coordinate = world[axis] * x + world[4 + axis] * y + world[8 + axis] * z + world[12 + axis];
          bounds.min[axis] = Math.min(bounds.min[axis], coordinate);
          bounds.max[axis] = Math.max(bounds.max[axis], coordinate);
        }
      }
      primitives.push({ vertices, indices, vertexCount: count, indexCount: indices.length,
        material: info, nodeIndex, skinIndex: node.skin, meshWorld: new Float32Array(baseWorlds[nodeIndex]) });
    }
  }
  if (!primitives.length) throw new TypeError('glTF must contain a triangle mesh node');
  const animations = (document.animations ?? []).map((animation, animationIndex) => {
    if (!Array.isArray(animation.samplers) || !Array.isArray(animation.channels)) throw new TypeError('animation requires samplers and channels');
    const occupied = new Set();
    let start = Infinity, end = -Infinity;
    const channels = animation.channels.map(channel => {
      const sampler = index(animation.samplers, channel.sampler, 'animation.channel.sampler');
      const interpolation = sampler.interpolation ?? 'LINEAR';
      if (!['LINEAR', 'STEP'].includes(interpolation)) throw new TypeError(`unsupported animation interpolation ${interpolation}; export LINEAR or STEP`);
      const target = object(channel.target, 'animation.channel.target');
      const node = index(nodes, target.node, 'animation.target.node');
      if (!['translation', 'rotation', 'scale'].includes(target.path)) throw new TypeError(`unsupported animation path ${target.path}`);
      if (node.matrix) throw new TypeError('TRS animation cannot target a matrix node');
      const key = `${target.node}:${target.path}`;
      if (occupied.has(key)) throw new TypeError('duplicate animation channel for node/path');
      occupied.add(key);
      const input = accessor(accessors, sampler.input, 'animation.input', 'SCALAR', [5126]);
      if (input.data[0] < 0) throw new RangeError('animation key times must be nonnegative');
      for (let i = 1; i < input.count; i++) if (input.data[i] <= input.data[i - 1]) throw new RangeError('animation key times must increase strictly');
      const output = accessor(accessors, sampler.output, 'animation.output', target.path === 'rotation' ? 'VEC4' : 'VEC3', [5126], input.count);
      const values = new Float32Array(output.data);
      if (target.path === 'rotation') for (let frame = 0; frame < input.count; frame++) values.set(normalizeQuaternion([...values.subarray(frame * 4, frame * 4 + 4)], 'animation rotation'), frame * 4);
      if (target.path === 'scale' && values.some(value => value === 0)) throw new RangeError('animated scales must be nonzero');
      start = Math.min(start, input.data[0]); end = Math.max(end, input.data[input.count - 1]);
      return { node: target.node, path: target.path, interpolation, times: new Float32Array(input.data), values, components: output.components };
    });
    return { name: animation.name ?? `animation-${animationIndex}`, channels,
      start: channels.length ? start : 0, end: channels.length ? end : 0, duration: channels.length ? end - start : 0 };
  });
  const asset = { primitives, nodes, skins, animations, bounds, order,
    jointCount: skins[0]?.jointCount ?? 0, meshWorld: new Float32Array(primitives[0].meshWorld),
    byteLength: primitives.reduce((sum, primitive) => sum + primitive.vertices.byteLength + primitive.indices.byteLength, 0),
    skeleton: skins.map(skin => skin.joints.map((nodeIndex, jointIndex) => ({ jointIndex, nodeIndex, name: nodes[nodeIndex].name,
      parentJoint: skin.joints.indexOf(nodes[nodeIndex].parent), bindWorld: new Float32Array(baseWorlds[nodeIndex]),
      inverseBind: skin.inverseBind.slice(jointIndex * 16, jointIndex * 16 + 16) }))) };
  asset.bindPose = sampleGLTFAnimation(asset, { animation: null, time: 0 });
  return asset;
}

function animationByName(asset, selection) {
  if (selection === null || selection === undefined) return null;
  if (typeof selection === 'number') return index(asset.animations, selection, 'animation');
  if (typeof selection !== 'string') throw new TypeError('animation must be a name, index or null');
  const found = asset.animations.find(animation => animation.name.toLowerCase() === selection.toLowerCase());
  if (!found) throw new RangeError(`animation ${selection} was not found`);
  return found;
}
function scratch(asset, skinIndex, meshNode) {
  const skin = asset.skins[skinIndex];
  const count = skin?.jointCount ?? 0;
  const result = { palette: new Float32Array(count * 16), jointWorld: new Float32Array(count * 16),
    meshWorld: new Float32Array(16), animation: null, time: 0,
    _locals: asset.nodes.map(() => new Float32Array(16)), _worlds: asset.nodes.map(() => new Float32Array(16)),
    _translations: asset.nodes.map(node => [...node.translation]),
    _rotations: asset.nodes.map(node => [...node.rotation]), _scales: asset.nodes.map(node => [...node.scale]),
    _inverseMesh: new Float32Array(16), _jointScratch: new Float32Array(16),
    _skinIndex: skinIndex, _meshNode: meshNode, _asset: asset };
  return result;
}
function interpolate(channel, time, destination) {
  const { times, values, components, interpolation, path } = channel;
  let low = 0, high = times.length - 1;
  if (time <= times[0]) high = 0;
  else if (time >= times[high]) low = high;
  else {
    while (high - low > 1) { const middle = (low + high) >>> 1; if (times[middle] <= time) low = middle; else high = middle; }
  }
  const alpha = high === low || interpolation === 'STEP' ? 0 : (time - times[low]) / (times[high] - times[low]);
  if (path !== 'rotation' || alpha === 0) {
    for (let axis = 0; axis < components; axis++) destination[axis] = values[low * components + axis] * (1 - alpha) + values[high * components + axis] * alpha;
    return;
  }
  let dot = 0;
  for (let axis = 0; axis < 4; axis++) dot += values[low * 4 + axis] * values[high * 4 + axis];
  const sign = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.abs(dot));
  let first = 1 - alpha, second = alpha;
  if (dot < 0.9995) { const angle = Math.acos(dot), denominator = Math.sin(angle); first = Math.sin((1 - alpha) * angle) / denominator; second = Math.sin(alpha * angle) / denominator; }
  let lengthSquared = 0;
  for (let axis = 0; axis < 4; axis++) { destination[axis] = values[low * 4 + axis] * first + values[high * 4 + axis] * second * sign; lengthSquared += destination[axis] ** 2; }
  const reciprocal = 1 / Math.sqrt(lengthSquared);
  for (let axis = 0; axis < 4; axis++) destination[axis] *= reciprocal;
}

/** Return a mesh-local joint palette; apply result.meshWorld before placement.
 * Supplying a previous result as `out` keeps all arrays stable across frames.
 */
export function sampleGLTFAnimation(asset, { animation = null, time = 0, loop = true,
  skin = 0, meshNode = asset.skins[skin]?.meshNodes[0] ?? asset.primitives[0].nodeIndex, out } = {}) {
  finite(time, 'time');
  if (typeof loop !== 'boolean') throw new TypeError('loop must be boolean');
  if (asset.skins.length) index(asset.skins, skin, 'skin');
  index(asset.nodes, meshNode, 'meshNode');
  if (asset.skins[skin] && !asset.skins[skin].meshNodes.includes(meshNode)) throw new TypeError('meshNode does not use the selected skin');
  const selected = animationByName(asset, animation);
  const result = out ?? scratch(asset, skin, meshNode);
  if (result._asset !== asset || result._skinIndex !== skin || result._meshNode !== meshNode)
    throw new TypeError('out must be a pose sampled for this asset, skin and mesh node');
  let sampleTime = time;
  if (selected) {
    sampleTime = selected.duration === 0 ? selected.start : loop ?
      selected.start + ((time - selected.start) % selected.duration + selected.duration) % selected.duration :
      Math.max(selected.start, Math.min(selected.end, time));
  }
  for (let node = 0; node < asset.nodes.length; node++) {
    const base = asset.nodes[node];
    for (let axis = 0; axis < 3; axis++) { result._translations[node][axis] = base.translation[axis]; result._scales[node][axis] = base.scale[axis]; }
    for (let axis = 0; axis < 4; axis++) result._rotations[node][axis] = base.rotation[axis];
  }
  if (selected) for (const channel of selected.channels) {
    const targets = channel.path === 'translation' ? result._translations : channel.path === 'rotation' ? result._rotations : result._scales;
    interpolate(channel, sampleTime, targets[channel.node]);
  }
  for (const nodeIndex of asset.order) {
    const node = asset.nodes[nodeIndex], local = result._locals[nodeIndex], world = result._worlds[nodeIndex];
    if (node.matrix) local.set(node.matrix); else compose(result._translations[nodeIndex], result._rotations[nodeIndex], result._scales[nodeIndex], local);
    node.parent === -1 ? world.set(local) : multiply(result._worlds[node.parent], local, world);
    for (let component = 0; component < 16; component++)
      if (!Number.isFinite(world[component])) throw new RangeError('animated transform exceeds Float32 range');
  }
  result.meshWorld.set(result._worlds[meshNode]);
  inverse(result.meshWorld, result._inverseMesh);
  const selectedSkin = asset.skins[skin];
  if (selectedSkin) for (let joint = 0; joint < selectedSkin.jointCount; joint++) {
    const jointWorld = result._worlds[selectedSkin.joints[joint]];
    result.jointWorld.set(jointWorld, joint * 16);
    multiply(result._inverseMesh, jointWorld, result._jointScratch);
    // subarray views are allocated here; createGLTFAnimator caches them below.
    const target = result._paletteViews?.[joint] ?? result.palette.subarray(joint * 16, joint * 16 + 16);
    const bind = result._bindViews?.[joint] ?? selectedSkin.inverseBind.subarray(joint * 16, joint * 16 + 16);
    multiply(result._jointScratch, bind, target);
    for (let component = 0; component < 16; component++)
      if (!Number.isFinite(target[component])) throw new RangeError('joint palette exceeds Float32 range');
  }
  result.animation = selected?.name ?? null; result.time = sampleTime;
  return result;
}

/** Reuse CPU pose scratch arrays and GPU palette storage for each frame. */
export function createGLTFAnimator(asset, { animation = null, loop = true, skin = 0, meshNode } = {}) {
  const result = sampleGLTFAnimation(asset, { animation, time: 0, loop, skin, meshNode });
  const selectedSkin = asset.skins[skin];
  result._paletteViews = Array.from({ length: selectedSkin?.jointCount ?? 0 }, (_, joint) => result.palette.subarray(joint * 16, joint * 16 + 16));
  result._bindViews = Array.from({ length: selectedSkin?.jointCount ?? 0 }, (_, joint) => selectedSkin.inverseBind.subarray(joint * 16, joint * 16 + 16));
  return { pose: result, sample(time, options = {}) {
    return sampleGLTFAnimation(asset, { animation: options.animation === undefined ? animation : options.animation,
      time, loop: options.loop ?? loop, skin, meshNode, out: result });
  } };
}

function decodeDataURI(uri) {
  const match = /^data:(?:application\/octet-stream|application\/gltf-buffer);base64,([A-Za-z0-9+/=\s]+)$/.exec(uri);
  if (!match) throw new TypeError('only base64 binary data URI buffers are supported');
  const binary = globalThis.atob(match[1]);
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) output[i] = binary.charCodeAt(i);
  return output.buffer;
}

/** Load .gltf and its buffers through an injectable browser-compatible fetch. */
export async function loadGLTF(url, { fetch: fetchFunction = globalThis.fetch } = {}) {
  if (typeof fetchFunction !== 'function') throw new TypeError('fetch must be a function');
  const target = new URL(url, globalThis.location?.href);
  const response = await fetchFunction(target.href);
  if (!response.ok) throw new Error(`glTF request failed (${response.status}): ${target.href}`);
  const document = await response.json();
  if (!Array.isArray(document.buffers)) throw new TypeError('glTF buffers must be an array');
  const buffers = await Promise.all(document.buffers.map(async (buffer, i) => {
    if (typeof buffer.uri !== 'string' || !buffer.uri) throw new TypeError(`buffers[${i}] requires a URI; GLB is unsupported`);
    if (buffer.uri.startsWith('data:')) return decodeDataURI(buffer.uri);
    const binaryURL = new URL(buffer.uri, target);
    const binaryResponse = await fetchFunction(binaryURL.href);
    if (!binaryResponse.ok) throw new Error(`glTF buffer request failed (${binaryResponse.status}): ${binaryURL.href}`);
    return binaryResponse.arrayBuffer();
  }));
  return parseGLTF(document, buffers);
}
