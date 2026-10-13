// Browser-compatible WGSL sources. This renderer implements a deliberately small
// material subset: one directional light, dielectric GGX, ambient and tone mapping.
// It does not claim Filament's full material system, shadows or image-based lighting.
const cameraStruct = /* wgsl */ `
struct Camera {
  position: vec4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
  projection: vec4<f32>, // tanX, tanY, near, far
  viewport: vec4<f32>, // width, height, distance0 squared, distance1 squared
  info: vec4<u32>, // object count, visible-list capacity, reserved, reserved
  reserved: vec4<f32>, // reciprocal X/Y side-plane lengths, reserved, reserved
};
fn toView(world: vec3<f32>) -> vec3<f32> {
  let relative = world - camera.position.xyz;
  return vec3<f32>(dot(relative, camera.right.xyz),
    dot(relative, camera.up.xyz), dot(relative, camera.forward.xyz));
}
`;

export const cullWGSL = /* wgsl */ `
${cameraStruct}
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> visible: array<u32>;
// Three tightly packed DrawIndexedIndirect records, five u32 per record.
// Only instanceCount (word 1) is atomic; the CPU initializes the other words.
@group(0) @binding(3) var<storage, read_write> arguments: array<atomic<u32>>;

@compute @workgroup_size(128)
fn cull(@builtin(global_invocation_id) global: vec3<u32>) {
  let id = global.x;
  if (id >= camera.info.x) { return; }
  let sphere = positions[id];
  let p = toView(sphere.xyz);
  let radius = sphere.w;
  let tanX = camera.projection.x;
  let tanY = camera.projection.y;
  let inverseNormX = camera.reserved.x;
  let inverseNormY = camera.reserved.y;
  if (p.z - camera.projection.z < -radius ||
      camera.projection.w - p.z < -radius ||
      (p.z * tanX + p.x) * inverseNormX < -radius ||
      (p.z * tanX - p.x) * inverseNormX < -radius ||
      (p.z * tanY + p.y) * inverseNormY < -radius ||
      (p.z * tanY - p.y) * inverseNormY < -radius) { return; }
  let distance2 = dot(p, p);
  var lod = 2u;
  if (distance2 < camera.viewport.z) { lod = 0u; }
  else if (distance2 < camera.viewport.w) { lod = 1u; }
  let slot = atomicAdd(&arguments[lod * 5u + 1u], 1u);
  visible[lod * camera.info.y + slot] = id;
}
`;

export const drawWGSL = /* wgsl */ `
${cameraStruct}
struct Lod { index: u32, reserved0: u32, reserved1: u32, reserved2: u32 };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> colors: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> visible: array<u32>;
@group(1) @binding(0) var<uniform> lod: Lod;

struct VertexOutput {
  @builtin(position) clip: vec4<f32>,
  @location(0) viewPosition: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) material: vec4<f32>,
};
@vertex
fn vertexMain(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>,
              @builtin(instance_index) instance: u32) -> VertexOutput {
  let id = visible[lod.index * camera.info.y + instance];
  let sphere = positions[id];
  let p = toView(sphere.xyz + position * sphere.w);
  let near = camera.projection.z;
  let far = camera.projection.w;
  var result: VertexOutput;
  // Left-handed view space (+Z forward), WebGPU clip depth [0, 1]. Scale
  // every homogeneous component by 1/far: the projected point is unchanged,
  // while large-world clip.w cannot overflow perspective interpolation.
  result.clip = vec4<f32>((p.x / camera.projection.x) / far,
    (p.y / camera.projection.y) / far, (p.z - near) / (far - near), p.z / far);
  result.viewPosition = p;
  result.normal = vec3<f32>(dot(normal, camera.right.xyz), dot(normal, camera.up.xyz),
    dot(normal, camera.forward.xyz));
  result.material = colors[id];
  return result;
}

fn distributionGGX(nDotH: f32, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  return alpha2 / max(3.14159265 * denominator * denominator, 0.000001);
}
fn geometrySchlick(nDot: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = r * r / 8.0;
  return nDot / max(nDot * (1.0 - k) + k, 0.000001);
}
fn safeDirection(vector: vec3<f32>) -> vec3<f32> {
  let magnitude = max(max(abs(vector.x), abs(vector.y)), abs(vector.z));
  if (magnitude == 0.0) { return vec3<f32>(0.0, 0.0, -1.0); }
  // Scaling before the squared length avoids overflow/underflow for finite
  // Float32 view coordinates at extremely large or small world scales.
  return normalize(vector / magnitude);
}
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let normal = safeDirection(input.normal);
  let view = safeDirection(-input.viewPosition);
  let light = normalize(vec3<f32>(-0.35, 0.7, -0.45));
  let halfVector = safeDirection(view + light);
  let roughness = clamp(input.material.w, 0.12, 1.0);
  let albedo = clamp(input.material.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  let nDotL = max(dot(normal, light), 0.0);
  let nDotV = max(dot(normal, view), 0.001);
  let nDotH = max(dot(normal, halfVector), 0.0);
  let vDotH = max(dot(view, halfVector), 0.0);
  let fresnel = vec3<f32>(0.04) + vec3<f32>(0.96) * pow(1.0 - vDotH, 5.0);
  let distribution = distributionGGX(nDotH, roughness);
  let geometry = geometrySchlick(nDotL, roughness) * geometrySchlick(nDotV, roughness);
  let specular = distribution * geometry * fresnel / max(4.0 * nDotL * nDotV, 0.001);
  var color = (albedo * (vec3<f32>(1.0) - fresnel) / 3.14159265 + specular) * nDotL * 2.5;
  color += albedo * 0.045;
  // ACES approximation, then gamma for an unorm (non-sRGB) render target.
  let mapped = clamp((color * (2.51 * color + 0.03)) /
    (color * (2.43 * color + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(pow(mapped, vec3<f32>(1.0 / 2.2)), 1.0);
}
`;
