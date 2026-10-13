/** Persistent instance data shared by the CPU reference and the GPU renderer.
 * Each vec4 array is tightly packed and can be uploaded without JSON conversion.
 */
export const MAX_SCENE_INSTANCES = 1_000_000;
const INSTANCE_BYTES = 8 * Float32Array.BYTES_PER_ELEMENT;

function validateCount(count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_SCENE_INSTANCES)
    throw new RangeError(`count must be an integer between 0 and ${MAX_SCENE_INSTANCES}`);
  return count;
}

function finiteFloat(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw new TypeError(`${name} must be a finite Float32 number`);
  return Math.fround(value);
}

function positiveFloat(value, name) {
  const result = finiteFloat(value, name);
  if (result <= 0) throw new RangeError(`${name} must be positive`);
  return result;
}

function unitFloat(value, name) {
  const result = finiteFloat(value, name);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return result;
}

function vector3(value, name, component = finiteFloat) {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value)) || value.length !== 3)
    throw new TypeError(`${name} must contain exactly three numbers`);
  return [component(value[0], `${name}[0]`), component(value[1], `${name}[1]`), component(value[2], `${name}[2]`)];
}

// Mulberry32 has a valid state for seed zero as well as all other uint32 seeds.
function randomGenerator(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function mergeRanges(left, right) {
  const merged = [];
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    const next = j === right.length || (i < left.length && left[i].first <= right[j].first)
      ? left[i++] : right[j++];
    const previous = merged[merged.length - 1];
    if (previous && next.first <= previous.first + previous.count) {
      previous.count = Math.max(previous.first + previous.count, next.first + next.count) - previous.first;
    } else {
      merged.push({ first: next.first, count: next.count });
    }
  }
  return merged;
}

/** createScene stores 32 bytes per instance; buffers never change identity.
 * Direct typed-array writes bypass dirty tracking: use updateInstances for edits.
 */
export function createScene({ count, seed = 1, spread = 100 } = {}) {
  validateCount(count);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError('seed must be a uint32 integer');
  spread = positiveFloat(spread, 'spread');
  finiteFloat(2 + spread * 3, 'spread depth');
  const positions = new Float32Array(count * 4);
  const colors = new Float32Array(count * 4);
  const random = randomGenerator(seed);
  for (let index = 0; index < count; index++) {
    const offset = index * 4;
    positions[offset] = (random() * 2 - 1) * spread;
    positions[offset + 1] = (random() * 2 - 1) * spread;
    positions[offset + 2] = 2 + random() * spread * 3;
    positions[offset + 3] = 0.3 + random() * 1.2;
    colors[offset] = 0.15 + random() * 0.85;
    colors[offset + 1] = 0.15 + random() * 0.85;
    colors[offset + 2] = 0.15 + random() * 0.85;
    colors[offset + 3] = 0.2 + random() * 0.7;
  }
  let revision = 0;
  let dirty = count === 0 ? [] : [{ first: 0, count }];
  return Object.freeze({
    count,
    positions,
    colors,
    get revision() { return revision; },
    get byteLength() { return positions.byteLength + colors.byteLength; },
    /** Validates the entire batch before any persistent state is changed. */
    updateInstances(updates) {
      if (!Array.isArray(updates)) throw new TypeError('updates must be an array');
      if (updates.length === 0) return revision;
      if (updates.length > MAX_SCENE_INSTANCES)
        throw new RangeError(`updates must contain at most ${MAX_SCENE_INSTANCES} entries`);
      if (revision === Number.MAX_SAFE_INTEGER) throw new RangeError('scene revision is exhausted');
      const validated = Array.from(updates, (update, row) => {
        if (!update || typeof update !== 'object' || Array.isArray(update))
          throw new TypeError(`updates[${row}] must be an object`);
        const { index } = update;
        if (!Number.isSafeInteger(index) || index < 0 || index >= count)
          throw new RangeError(`updates[${row}].index is outside the scene`);
        const patch = { index };
        if (update.position !== undefined) patch.position = vector3(update.position, `updates[${row}].position`);
        if (update.radius !== undefined) patch.radius = positiveFloat(update.radius, `updates[${row}].radius`);
        if (update.color !== undefined) patch.color = vector3(update.color, `updates[${row}].color`, unitFloat);
        if (update.roughness !== undefined) patch.roughness = unitFloat(update.roughness, `updates[${row}].roughness`);
        if (Object.keys(patch).length === 1) throw new TypeError(`updates[${row}] does not contain an instance change`);
        return patch;
      });
      const indices = [...new Set(validated.map(update => update.index))].sort((a, b) => a - b);
      const changedRanges = [];
      for (const index of indices) {
        const previous = changedRanges[changedRanges.length - 1];
        if (previous && previous.first + previous.count === index) previous.count++;
        else changedRanges.push({ first: index, count: 1 });
      }
      const nextDirty = mergeRanges(dirty, changedRanges);
      for (const patch of validated) {
        const offset = patch.index * 4;
        if (patch.position) positions.set(patch.position, offset);
        if (patch.radius !== undefined) positions[offset + 3] = patch.radius;
        if (patch.color) colors.set(patch.color, offset);
        if (patch.roughness !== undefined) colors[offset + 3] = patch.roughness;
      }
      dirty = nextDirty;
      return ++revision;
    },
    /** Consuming ranges acknowledges uploads; unchanged frames upload zero bytes. */
    consumeDirtyRanges() {
      const ranges = dirty;
      dirty = [];
      const bytes = ranges.reduce((total, range) => total + range.count * INSTANCE_BYTES, 0);
      return { revision, ranges, bytes };
    },
  });
}

/** Returns actual allocated scene-buffer bytes, excluding renderer scratch buffers. */
export function getSceneMemory(scene) {
  validateScene(scene);
  return {
    positionsBytes: scene.positions.byteLength,
    colorsBytes: scene.colors.byteLength,
    totalBytes: scene.positions.byteLength + scene.colors.byteLength,
    bytesPerInstance: INSTANCE_BYTES,
  };
}

function validateScene(scene) {
  if (!scene || typeof scene !== 'object') throw new TypeError('scene must be an object');
  validateCount(scene.count);
  if (!(scene.positions instanceof Float32Array) || scene.positions.length !== scene.count * 4 ||
      !(scene.colors instanceof Float32Array) || scene.colors.length !== scene.count * 4)
    throw new TypeError('scene buffers must be Float32Array values with four components per instance');
}

/** The prototype camera looks along +Z; rotation is deliberately not implied. */
export function defaultCamera(overrides = {}) {
  return {
    position: [0, 0, 0], near: 1, far: 500,
    fovY: Math.PI / 3, aspect: 4 / 3, lodDistances: [40, 100],
    ...overrides,
  };
}

/** Use these same f32 values when packing GPU camera uniforms. */
export function cameraParameters(camera = defaultCamera()) {
  if (!camera || typeof camera !== 'object' || Array.isArray(camera))
    throw new TypeError('camera must be an object');
  const position = vector3(camera.position ?? [0, 0, 0], 'camera.position');
  const near = positiveFloat(camera.near ?? 1, 'camera.near');
  const far = positiveFloat(camera.far ?? 500, 'camera.far');
  if (far <= near) throw new RangeError('camera.far must exceed camera.near');
  const fovY = camera.fovY ?? Math.PI / 3;
  if (typeof fovY !== 'number' || !Number.isFinite(fovY) || fovY <= 0 || fovY >= Math.PI)
    throw new RangeError('camera.fovY must be between 0 and PI');
  const aspect = positiveFloat(camera.aspect ?? 4 / 3, 'camera.aspect');
  const tanY = positiveFloat(Math.tan(fovY / 2), 'camera.tanY');
  const tanX = positiveFloat(tanY * aspect, 'camera.tanX');
  const inputDistances = camera.lodDistances ?? [40, 100];
  if (!(Array.isArray(inputDistances) || ArrayBuffer.isView(inputDistances)) || inputDistances.length !== 2)
    throw new TypeError('camera.lodDistances must contain exactly two distances');
  const lodDistances = [positiveFloat(inputDistances[0], 'camera.lodDistances[0]'),
    positiveFloat(inputDistances[1], 'camera.lodDistances[1]')];
  if (lodDistances[1] <= lodDistances[0]) throw new RangeError('camera.lodDistances must be strictly increasing');
  return { position, tanX, tanY, near, far, lodDistances };
}

/** CPU reference: six normalized frustum planes against instance bounding spheres.
 * LODs parallel visible IDs. Values at a plane/LOD boundary may differ from a GPU
 * by f32 rounding; scene and camera inputs themselves are normalized to f32.
 */
export function cullScene(scene, camera = defaultCamera()) {
  validateScene(scene);
  const { position, tanX, tanY, near, far, lodDistances } = cameraParameters(camera);
  const visible = new Uint32Array(scene.count);
  const lods = new Uint32Array(scene.count);
  const counts = [0, 0, 0];
  const sideX = Math.sqrt(1 + tanX * tanX);
  const sideY = Math.sqrt(1 + tanY * tanY);
  const nearLOD = lodDistances[0] * lodDistances[0];
  const farLOD = lodDistances[1] * lodDistances[1];
  const data = scene.positions;
  let length = 0;
  for (let index = 0; index < scene.count; index++) {
    const offset = index * 4;
    const x = data[offset] - position[0];
    const y = data[offset + 1] - position[1];
    const z = data[offset + 2] - position[2];
    const radius = data[offset + 3];
    if (z - near < -radius || far - z < -radius ||
        (z * tanX + x) / sideX < -radius || (z * tanX - x) / sideX < -radius ||
        (z * tanY + y) / sideY < -radius || (z * tanY - y) / sideY < -radius) continue;
    const distanceSquared = x * x + y * y + z * z;
    const lod = distanceSquared < nearLOD ? 0 : distanceSquared < farLOD ? 1 : 2;
    visible[length] = index;
    lods[length++] = lod;
    counts[lod]++;
  }
  return { visible: visible.subarray(0, length), lods: lods.subarray(0, length), counts };
}
