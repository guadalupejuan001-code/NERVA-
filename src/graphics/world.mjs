/** Static FPS geometry in an interleaved, directly uploadable GPU layout.
 * Mesh vertices use pos3/normal3/uv2. Instance vertices use four vec4 values:
 * position/yaw, full scale/kind, color/roughness, and metallic/emission/pattern/reflection.
 * Triangles wind counterclockwise around their outward normal. The +Z-forward
 * projection used by this engine therefore renders them with frontFace: 'cw'.
 */
export const MAX_FPS_OBJECTS = 100_000;
export const MAX_FPS_LIGHTS = 16;
export const FPS_INSTANCE_BYTES = 64;
export const FPS_MESH_KINDS = Object.freeze(['box', 'cylinder', 'sphere', 'pipe']);

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value))
    throw new TypeError(`${name} must be an object`);
  return value;
}

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw new TypeError(`${name} must be a finite Float32 number`);
  return Math.fround(value);
}

function positive(value, name) {
  const result = finite(value, name);
  if (result <= 0) throw new RangeError(`${name} must be positive`);
  return result;
}

function nonnegative(value, name) {
  const result = finite(value, name);
  if (value < 0) throw new RangeError(`${name} must be nonnegative`);
  return result;
}

function unit(value, name) {
  const result = finite(value, name);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return result;
}

function vector(value, name, component = finite) {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value)) || value.length !== 3)
    throw new TypeError(`${name} must contain exactly three numbers`);
  return [component(value[0], `${name}[0]`), component(value[1], `${name}[1]`),
    component(value[2], `${name}[2]`)];
}

function objectBounds(position, scale, yaw, name) {
  const cosine = Math.abs(Math.cos(yaw)), sine = Math.abs(Math.sin(yaw));
  const half = [cosine * scale[0] * 0.5 + sine * scale[2] * 0.5,
    scale[1] * 0.5, sine * scale[0] * 0.5 + cosine * scale[2] * 0.5];
  // Bounds stay as JS doubles so rounding cannot shrink the conservative box.
  const min = position.map((component, axis) => component - half[axis]);
  const max = position.map((component, axis) => component + half[axis]);
  for (let axis = 0; axis < 3; axis++) {
    finite(min[axis], `${name}.bounds.min[${axis}]`);
    finite(max[axis], `${name}.bounds.max[${axis}]`);
  }
  return Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) });
}

function validateObject(input, index) {
  const name = `objects[${index}]`;
  record(input, name);
  const kind = input.kind ?? 'box';
  const kindIndex = FPS_MESH_KINDS.indexOf(kind);
  if (kindIndex < 0) throw new TypeError(`${name}.kind must be box, cylinder, sphere or pipe`);
  const position = vector(input.position ?? [0, 0, 0], `${name}.position`);
  const scale = vector(input.scale ?? [1, 1, 1], `${name}.scale`, positive);
  const yaw = finite(input.yaw ?? 0, `${name}.yaw`);
  if (input.solid !== undefined && typeof input.solid !== 'boolean')
    throw new TypeError(`${name}.solid must be a boolean`);
  const material = record(input.material ?? {}, `${name}.material`);
  const color = vector(material.color ?? [0.65, 0.65, 0.65], `${name}.material.color`, unit);
  const roughness = unit(material.roughness ?? 0.5, `${name}.material.roughness`);
  const metallic = unit(material.metallic ?? 0, `${name}.material.metallic`);
  const emission = nonnegative(material.emission ?? 0, `${name}.material.emission`);
  const patternInput = material.pattern ?? 0;
  const pattern = nonnegative(patternInput, `${name}.material.pattern`);
  if (!Number.isInteger(patternInput)) throw new RangeError(`${name}.material.pattern must be an integer`);
  const reflection = unit(material.reflection ?? 0, `${name}.material.reflection`);
  const bounds = objectBounds(position, scale, yaw, name);
  return { kind, kindIndex, position, scale, yaw, color, roughness, metallic, emission,
    pattern, reflection, solid: input.solid ?? false, bounds };
}

function validateLight(input, index) {
  const name = `lights[${index}]`;
  record(input, name);
  return {
    position: vector(input.position ?? [0, 0, 0], `${name}.position`),
    radius: positive(input.radius ?? 10, `${name}.radius`),
    color: vector(input.color ?? [1, 1, 1], `${name}.color`, unit),
    intensity: nonnegative(input.intensity ?? 1, `${name}.intensity`),
  };
}

function validateLighting(input) {
  record(input, 'lighting');
  const direction = vector(input.sunDirection ?? [-0.45, 0.8, -0.35], 'lighting.sunDirection');
  const length = Math.hypot(...direction);
  if (length === 0) throw new RangeError('lighting.sunDirection must not be zero');
  return Object.freeze({
    // Direction points from a surface towards the sun, not along its rays.
    sunDirection: Object.freeze(direction.map(value => Math.fround(value / length))),
    sunColor: Object.freeze(vector(input.sunColor ?? [1, 0.86, 0.67], 'lighting.sunColor', unit)),
    sunIntensity: nonnegative(input.sunIntensity ?? 3.8, 'lighting.sunIntensity'),
    ambient: nonnegative(input.ambient ?? 0.2, 'lighting.ambient'),
    fogDensity: nonnegative(input.fogDensity ?? 0.025, 'lighting.fogDensity'),
    exposure: positive(input.exposure ?? 1.1, 'lighting.exposure'),
    reflectionStrength: unit(input.reflectionStrength ?? 0.65, 'lighting.reflectionStrength'),
    bloomStrength: unit(input.bloomStrength ?? 0.16, 'lighting.bloomStrength'),
    aoStrength: unit(input.aoStrength ?? 0.35, 'lighting.aoStrength'),
  });
}

/** Validate the complete description before constructing buffers or colliders.
 * This static world does not mutate the description. Grouping retains the input
 * order within each kind and limits drawing to at most four mesh batches.
 */
export function createFPSWorld(description = {}) {
  record(description, 'description');
  const objects = description.objects ?? [];
  const lights = description.lights ?? [];
  if (!Array.isArray(objects) || objects.length > MAX_FPS_OBJECTS)
    throw new RangeError(`objects must be an array with at most ${MAX_FPS_OBJECTS} entries`);
  if (!Array.isArray(lights) || lights.length > MAX_FPS_LIGHTS)
    throw new RangeError(`lights must be an array with at most ${MAX_FPS_LIGHTS} entries`);
  const validatedObjects = Array.from(objects, validateObject);
  const validatedLights = Array.from(lights, validateLight);
  const lighting = validateLighting(description.lighting ?? {});
  const floorY = finite(description.floorY ?? 0, 'floorY');
  const spawnInput = record(description.spawn ?? {}, 'spawn');
  const spawn = Object.freeze({
    position: Object.freeze(vector(spawnInput.position ?? [0, 1.7, -4], 'spawn.position')),
    yaw: finite(spawnInput.yaw ?? 0, 'spawn.yaw'),
    pitch: finite(spawnInput.pitch ?? 0, 'spawn.pitch'),
  });
  if (Math.abs(spawn.pitch) >= Math.PI / 2)
    throw new RangeError('spawn.pitch must be between -PI/2 and PI/2');

  const instances = new Float32Array(objects.length * 16);
  const batches = [];
  const colliders = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let first = 0;
  for (const kind of FPS_MESH_KINDS) {
    const batchFirst = first;
    for (const object of validatedObjects) {
      if (object.kind !== kind) continue;
      instances.set([...object.position, object.yaw, ...object.scale, object.kindIndex,
        ...object.color, object.roughness, object.metallic, object.emission,
        object.pattern, object.reflection], first++ * 16);
      if (object.solid) colliders.push(object.bounds);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], object.bounds.min[axis]);
        max[axis] = Math.max(max[axis], object.bounds.max[axis]);
      }
    }
    if (first > batchFirst) batches.push(Object.freeze({ kind, first: batchFirst, count: first - batchFirst }));
  }
  if (objects.length === 0) { min.splice(0, 3, 0, floorY, 0); max.splice(0, 3, 0, floorY, 0); }
  // Fixed-size light storage permits a stable bind group for every light count.
  const pointLights = new Float32Array(MAX_FPS_LIGHTS * 8);
  validatedLights.forEach((light, index) => pointLights.set([...light.position, light.radius,
    ...light.color, light.intensity], index * 8));
  return Object.freeze({
    count: objects.length, instances, batches: Object.freeze(batches),
    byteLength: instances.byteLength + pointLights.byteLength,
    instanceBytes: instances.byteLength, pointLights, lightCount: lights.length,
    colliders: Object.freeze(colliders), bounds: Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) }),
    spawn, floorY, lighting,
  });
}

function mesh(vertices, indices) {
  return Object.freeze({ vertices: new Float32Array(vertices), indices: new Uint32Array(indices) });
}

function boxMesh() {
  const vertices = [], indices = [];
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [normal, u, v] of faces) {
    const first = vertices.length / 8;
    for (const [s, t] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      const position = normal.map((n, axis) => n * 0.5 + u[axis] * s + v[axis] * t);
      vertices.push(...position, ...normal, s + 0.5, t + 0.5);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return mesh(vertices, indices);
}

function cylinderMesh(segments = 24) {
  const vertices = [], indices = [];
  for (let segment = 0; segment <= segments; segment++) {
    const angle = segment * Math.PI * 2 / segments;
    const x = Math.cos(angle), z = Math.sin(angle);
    vertices.push(x * 0.5, -0.5, z * 0.5, x, 0, z, segment / segments, 0);
    vertices.push(x * 0.5, 0.5, z * 0.5, x, 0, z, segment / segments, 1);
    if (segment < segments) {
      const first = segment * 2;
      indices.push(first, first + 1, first + 3, first, first + 3, first + 2);
    }
  }
  for (const sign of [-1, 1]) {
    const center = vertices.length / 8;
    vertices.push(0, sign * 0.5, 0, 0, sign, 0, 0.5, 0.5);
    for (let segment = 0; segment <= segments; segment++) {
      const angle = segment * Math.PI * 2 / segments;
      const x = Math.cos(angle) * 0.5, z = Math.sin(angle) * 0.5;
      vertices.push(x, sign * 0.5, z, 0, sign, 0, x + 0.5, z + 0.5);
      if (segment < segments) {
        const current = center + 1 + segment;
        if (sign > 0) indices.push(center, current + 1, current);
        else indices.push(center, current, current + 1);
      }
    }
  }
  return mesh(vertices, indices);
}

function sphereMesh(segments = 16, rings = 8) {
  const vertices = [], indices = [];
  for (let ring = 0; ring <= rings; ring++) {
    const theta = ring * Math.PI / rings;
    for (let segment = 0; segment <= segments; segment++) {
      const phi = segment * Math.PI * 2 / segments;
      const normal = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      vertices.push(...normal.map(value => value * 0.5), ...normal, segment / segments, ring / rings);
      if (ring < rings && segment < segments) {
        const a = ring * (segments + 1) + segment, b = a + 1;
        const d = a + segments + 1, c = d + 1;
        if (ring > 0) indices.push(a, b, d);
        if (ring < rings - 1) indices.push(b, c, d);
      }
    }
  }
  return mesh(vertices, indices);
}

/** Unit dimensions are one on every axis; cylinder is along Y, pipe along Z.
 * Meshes are created once by the renderer and scaled per persistent instance.
 */
export function createFPSMeshes() {
  const cylinder = cylinderMesh();
  const pipeVertices = cylinder.vertices.slice();
  for (let offset = 0; offset < pipeVertices.length; offset += 8) {
    const y = pipeVertices[offset + 1], z = pipeVertices[offset + 2];
    pipeVertices[offset + 1] = -z; pipeVertices[offset + 2] = y;
    const ny = pipeVertices[offset + 4], nz = pipeVertices[offset + 5];
    pipeVertices[offset + 4] = -nz; pipeVertices[offset + 5] = ny;
  }
  return Object.freeze({ box: boxMesh(), cylinder, sphere: sphereMesh(),
    pipe: Object.freeze({ vertices: pipeVertices, indices: cylinder.indices.slice() }) });
}
