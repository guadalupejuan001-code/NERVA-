/** WGSL for the FPS renderer. Lighting is raster PBR with analytic environment
 * approximations; the planar reflection, shadow map and depth AO are separate
 * measured passes, not ray tracing or global illumination. */
const globals = /* wgsl */ `
struct Globals {
  positionTime: vec4<f32>,
  cameraRight: vec4<f32>,
  cameraUp: vec4<f32>,
  cameraForward: vec4<f32>,
  projection: vec4<f32>,
  sunDirection: vec4<f32>,
  sunColor: vec4<f32>,
  atmosphere: vec4<f32>,
  viewport: vec4<f32>,
  info: vec4<u32>,
  lightVP: mat4x4<f32>,
  options: vec4<f32>,
  padding: vec4<f32>,
};
struct Instance {
  positionYaw: vec4<f32>,
  scaleKind: vec4<f32>,
  colorRoughness: vec4<f32>,
  materialParams: vec4<f32>,
};
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
fn yawRotate(v: vec3<f32>, angle: f32) -> vec3<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec3<f32>(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
fn instancePosition(localPosition: vec3<f32>, item: Instance) -> vec3<f32> {
  return item.positionYaw.xyz + yawRotate(localPosition * item.scaleKind.xyz, item.positionYaw.w);
}
`;

const sceneShader = (characterSurface = false) => globals + /* wgsl */ `
const characterSurface: bool = ${characterSurface ? 'true' : 'false'};
struct PointLight { positionRadius: vec4<f32>, colorIntensity: vec4<f32> };
@group(0) @binding(2) var<storage, read> lights: array<PointLight>;
@group(0) @binding(3) var shadowDepth: texture_depth_2d;
@group(0) @binding(4) var shadowSampler: sampler_comparison;
@group(0) @binding(5) var reflectionColor: texture_2d<f32>;
@group(0) @binding(6) var linearSampler: sampler;
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @builtin(instance_index) instanceIndex: u32,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) @interpolate(flat) instanceIndex: u32,
  @location(4) @interpolate(flat) colorRoughness: vec4<f32>,
  @location(5) @interpolate(flat) materialParams: vec4<f32>,
};
@vertex fn vsMain(input: VertexInput) -> VertexOutput {
  let item = instances[input.instanceIndex];
  let world = instancePosition(input.position, item);
  let relative = world - globals.positionTime.xyz;
  let view = vec3<f32>(dot(relative, globals.cameraRight.xyz),
    dot(relative, globals.cameraUp.xyz), dot(relative, globals.cameraForward.xyz));
  let nearPlane = globals.projection.z;
  let farPlane = globals.projection.w;
  let zCoefficient = farPlane / (farPlane - nearPlane);
  var output: VertexOutput;
  output.position = vec4<f32>(view.x / globals.projection.x,
    view.y / globals.projection.y, zCoefficient * view.z - nearPlane * zCoefficient, view.z);
  output.worldPosition = world;
  output.normal = normalize(yawRotate(input.normal / max(abs(item.scaleKind.xyz), vec3<f32>(0.0001)), item.positionYaw.w));
  output.uv = input.uv;
  output.instanceIndex = input.instanceIndex;
  output.colorRoughness = item.colorRoughness;
  output.materialParams = item.materialParams;
  return output;
}
fn noiseHash(p: vec3<f32>) -> f32 {
  let q = fract(p * vec3<f32>(0.1031, 0.11369, 0.13787));
  return fract((q.x + q.y) * (q.z + 19.19));
}
fn valueNoise(p: vec3<f32>) -> f32 {
  let cell = floor(p);
  let fractional = fract(p);
  let blend = fractional * fractional * (vec3<f32>(3.0) - 2.0 * fractional);
  let a = mix(noiseHash(cell), noiseHash(cell + vec3<f32>(1.0, 0.0, 0.0)), blend.x);
  let b = mix(noiseHash(cell + vec3<f32>(0.0, 1.0, 0.0)), noiseHash(cell + vec3<f32>(1.0, 1.0, 0.0)), blend.x);
  let c = mix(noiseHash(cell + vec3<f32>(0.0, 0.0, 1.0)), noiseHash(cell + vec3<f32>(1.0, 0.0, 1.0)), blend.x);
  let d = mix(noiseHash(cell + vec3<f32>(0.0, 1.0, 1.0)), noiseHash(cell + vec3<f32>(1.0, 1.0, 1.0)), blend.x);
  return mix(mix(a, b, blend.y), mix(c, d, blend.y), blend.z);
}
fn surfaceCoordinates(world: vec3<f32>, normal: vec3<f32>) -> vec2<f32> {
  let magnitude = abs(normal);
  if (magnitude.y > magnitude.x && magnitude.y > magnitude.z) { return world.xz; }
  if (magnitude.x > magnitude.z) { return world.zy; }
  return world.xy;
}
fn environment(direction: vec3<f32>) -> vec3<f32> {
  let upper = pow(clamp(direction.y * 0.5 + 0.5, 0.0, 1.0), 0.7);
  return mix(vec3<f32>(0.015, 0.022, 0.035), vec3<f32>(0.14, 0.20, 0.30), upper);
}
fn schlick(cosine: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosine, 0.0, 1.0), 5.0);
}
fn directBRDF(albedo: vec3<f32>, metallic: f32, roughness: f32, normal: vec3<f32>,
  viewDirection: vec3<f32>, lightDirection: vec3<f32>) -> vec3<f32> {
  let nDotL = max(dot(normal, lightDirection), 0.0);
  // Back-facing lights contribute exactly zero; avoid the GGX square roots,
  // half-vector normalization and Fresnel power for those fragments.
  if (nDotL <= 0.0) { return vec3<f32>(0.0); }
  let nDotV = max(dot(normal, viewDirection), 0.001);
  let halfVector = viewDirection + lightDirection;
  let halfDirection = halfVector / max(length(halfVector), 0.00001);
  let nDotH = max(dot(normal, halfDirection), 0.0);
  let vDotH = max(dot(viewDirection, halfDirection), 0.0);
  let alpha = max(roughness * roughness, 0.0036);
  let alphaSquared = alpha * alpha;
  let divisor = nDotH * nDotH * (alphaSquared - 1.0) + 1.0;
  let distribution = alphaSquared / max(3.14159265 * divisor * divisor, 0.000001);
  let gv = nDotL * sqrt(nDotV * nDotV * (1.0 - alphaSquared) + alphaSquared);
  let gl = nDotV * sqrt(nDotL * nDotL * (1.0 - alphaSquared) + alphaSquared);
  let visibility = 0.5 / max(gv + gl, 0.00001);
  let fresnel = schlick(vDotH, mix(vec3<f32>(0.04), albedo, metallic));
  let diffuse = (vec3<f32>(1.0) - fresnel) * (1.0 - metallic) * albedo / 3.14159265;
  return (diffuse + fresnel * distribution * visibility) * nDotL;
}
fn shadowVisibility(world: vec3<f32>, nDotL: f32) -> f32 {
  if (globals.options.y < 0.5) { return 1.0; }
  let lightPosition = globals.lightVP * vec4<f32>(world, 1.0);
  let projected = lightPosition.xyz / lightPosition.w;
  let uv = vec2<f32>(projected.x * 0.5 + 0.5, 0.5 - projected.y * 0.5);
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0)) || projected.z < 0.0 || projected.z > 1.0) { return 1.0; }
  let texel = vec2<f32>(1.0) / vec2<f32>(textureDimensions(shadowDepth));
  let bias = globals.options.x * (1.0 + 2.0 * (1.0 - nDotL));
  var visibility = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      visibility += textureSampleCompareLevel(shadowDepth, shadowSampler, uv + vec2<f32>(f32(x), f32(y)) * texel, projected.z - bias);
    }
  }
  return visibility / 9.0;
}
@fragment fn fsMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let world = input.worldPosition;
  let geometricNormal = normalize(input.normal);
  let coords = surfaceCoordinates(world, geometricNormal);
  // Derivatives precede the varying material/discard branches. The footprint
  // smooths sub-pixel procedural features rather than relying on geometry MSAA.
  let coordinateWidth = max(fwidth(coords), vec2<f32>(0.00001));
  let detailFade = 1.0 - smoothstep(0.8, 3.0, max(coordinateWidth.x, coordinateWidth.y) * 115.0);
  if (globals.info.y == 1u && (world.y < globals.atmosphere.z + 0.006 || input.materialParams.w > 0.0001)) { discard; }
  let pattern = u32(input.materialParams.z + 0.5);
  var grain = 0.5;
  var fineGrain = 0.5;
  if (!characterSurface) {
    grain = valueNoise(world * 4.7);
    fineGrain = mix(0.5, noiseHash(floor(world * 115.0)), detailFade);
  }
  var albedo = input.colorRoughness.rgb * select(0.89 + 0.16 * grain, 1.0, characterSurface);
  var roughness = clamp(input.colorRoughness.w + (grain - 0.5) * 0.09, 0.055, 1.0);
  let metallic = clamp(input.materialParams.x, 0.0, 1.0);
  var reflectionWeight = input.materialParams.w;
  if (pattern == 1u) {
    let panel = fract(coords / vec2<f32>(2.4, 1.6));
    let edge = min(min(panel.x, 1.0 - panel.x), min(panel.y, 1.0 - panel.y));
    let width = max(coordinateWidth.x / 2.4, coordinateWidth.y / 1.6);
    albedo *= mix(0.19, 1.0, smoothstep(0.006 - width, 0.016 + width, edge));
    let rivet = length(min(panel, vec2<f32>(1.0) - panel) - vec2<f32>(0.027));
    albedo *= mix(0.30, 1.0, smoothstep(0.002 - width, 0.008 + width, rivet));
  } else if (pattern == 2u) {
    let tile = fract(coords * 0.65);
    let edge = min(min(tile.x, 1.0 - tile.x), min(tile.y, 1.0 - tile.y));
    let width = max(coordinateWidth.x, coordinateWidth.y) * 0.65;
    albedo *= mix(0.23, 1.0, smoothstep(0.004 - width, 0.012 + width, edge));
    let wetness = smoothstep(0.30, 0.65, valueNoise(vec3<f32>(world.x * 0.48, 2.0, world.z * 0.48)));
    roughness = mix(roughness, 0.08, wetness * 0.85);
    reflectionWeight *= 0.45 + wetness * 0.55;
  } else if (pattern == 3u) {
    let bars = abs(fract(coords * 6.0) - vec2<f32>(0.5));
    let width = coordinateWidth * 6.0;
    let grate = max(smoothstep(0.34 - width.x, 0.43 + width.x, bars.x), smoothstep(0.34 - width.y, 0.43 + width.y, bars.y));
    albedo *= mix(0.10, 1.0, grate);
    roughness = mix(0.72, roughness, grate);
  } else if (pattern == 4u) {
    let width = max((coordinateWidth.x + coordinateWidth.y) * 2.25 * 6.283185, 0.015);
    let stripe = smoothstep(-width, width, -sin((coords.x + coords.y) * 2.25 * 6.283185));
    albedo = mix(vec3<f32>(0.015, 0.017, 0.019), vec3<f32>(0.85, 0.54, 0.045), stripe) * (0.75 + grain * 0.25);
  } else if (pattern == 5u) {
    // Brushed/painted metal uses restrained streaks and irregular staining,
    // rather than the repeated grid reserved for actual grate material (3).
    let brushFade = 1.0 - smoothstep(0.6, 3.0, coordinateWidth.y * 190.0);
    let brushing = sin(coords.y * 190.0 + grain * 0.35) * brushFade;
    let stain = sin(world.x * 0.31 + world.z * 0.27) * sin(world.y * 0.48 - world.z * 0.18);
    let scratch = 1.0 - smoothstep(0.0, 0.025, abs(sin(coords.y * 17.0 + sin(coords.x * 0.9) * 0.6)));
    albedo *= 0.975 + brushing * 0.012 + stain * 0.025 + scratch * 0.035;
    roughness = clamp(roughness + stain * 0.025 + brushing * 0.012, 0.055, 1.0);
  } else if (pattern == 6u) {
    let brickY = coords.y * 3.0;
    let brick = fract(vec2<f32>(coords.x * 1.7 + 0.5 * (floor(brickY) % 2.0), brickY));
    let edge = min(min(brick.x, 1.0 - brick.x), min(brick.y, 1.0 - brick.y));
    let width = max(coordinateWidth.x * 1.7, coordinateWidth.y * 3.0);
    albedo = mix(vec3<f32>(0.07, 0.065, 0.055), albedo, smoothstep(0.018 - width, 0.045 + width, edge));
  }
  let gradient = vec3<f32>(sin(world.x * 83.0 + world.z * 17.0), sin(world.y * 77.0 + world.x * 11.0), cos(world.z * 91.0 + world.y * 23.0));
  let tangentGradient = gradient - geometricNormal * dot(gradient, geometricNormal);
  let bump = select(select(0.018, 0.06, pattern == 6u) * detailFade, 0.0, characterSurface);
  let normal = normalize(geometricNormal + tangentGradient * bump);
  let viewDirection = normalize(globals.positionTime.xyz - world);
  let nDotV = max(dot(normal, viewDirection), 0.001);
  let sunDirection = normalize(globals.sunDirection.xyz);
  let nDotSun = max(dot(normal, sunDirection), 0.0);
  var sunVisibility = 1.0;
  if (nDotSun > 0.0 && globals.sunDirection.w > 0.0) {
    sunVisibility = shadowVisibility(world, nDotSun);
  }
  var radiance = directBRDF(albedo, metallic, roughness, normal, viewDirection, sunDirection)
    * globals.sunColor.rgb * globals.sunDirection.w * sunVisibility;
  for (var lightIndex = 0u; lightIndex < min(globals.info.x, 16u); lightIndex = lightIndex + 1u) {
    let light = lights[lightIndex];
    let toLight = light.positionRadius.xyz - world;
    let distanceSquared = max(dot(toLight, toLight), 0.001);
    let radius = max(light.positionRadius.w, 0.001);
    // The attenuation window is zero outside the light's support. Test squared
    // distance before sqrt/pow/BRDF, especially useful in long FPS corridors.
    if (distanceSquared >= radius * radius) { continue; }
    let distance = sqrt(distanceSquared);
    let window = max(1.0 - pow(distance / radius, 4.0), 0.0);
    let attenuation = window * window / (distanceSquared + 0.35);
    radiance += directBRDF(albedo, metallic, roughness, normal, viewDirection, toLight / distance)
      * light.colorIntensity.rgb * light.colorIntensity.w * attenuation;
  }
  let f0 = mix(vec3<f32>(0.04), albedo, metallic);
  let fresnel = schlick(nDotV, f0);
  let hemisphere = mix(vec3<f32>(0.045, 0.040, 0.034), vec3<f32>(0.20, 0.27, 0.36), normal.y * 0.5 + 0.5);
  radiance += (albedo * (1.0 - metallic) * hemisphere + environment(reflect(-viewDirection, normal)) * fresnel * (1.0 - roughness * 0.72)) * globals.sunColor.w;
  if (reflectionWeight > 0.0 && globals.info.y == 0u && globals.options.z > 0.5) {
    let screenUV = input.position.xy / globals.viewport.xy;
    let distortion = normal.xz * 0.004 * (1.0 - roughness);
    let reflected = textureSampleLevel(reflectionColor, linearSampler, clamp(screenUV + distortion, vec2<f32>(0.002), vec2<f32>(0.998)), 0.0).rgb;
    let coatingFresnel = 0.05 + 0.95 * pow(1.0 - nDotV, 5.0);
    let blend = clamp(reflectionWeight * globals.atmosphere.w * (0.25 + 0.75 * coatingFresnel) * (1.0 - roughness * 0.60), 0.0, 0.88);
    radiance = mix(radiance, reflected, blend);
  }
  radiance += albedo * input.materialParams.y;
  radiance *= 0.99 + fineGrain * 0.02;
  let distance = length(world - globals.positionTime.xyz);
  let heightDensity = exp(-max(world.y - globals.atmosphere.z, 0.0) * 0.23);
  let fogAmount = clamp(1.0 - exp(-distance * globals.atmosphere.x * (0.35 + 0.65 * heightDensity)), 0.0, 0.96);
  let fogColor = mix(vec3<f32>(0.035, 0.075, 0.11), vec3<f32>(0.10, 0.16, 0.22), max(dot(-viewDirection, sunDirection), 0.0) * 0.4);
  radiance = mix(radiance, fogColor * (0.70 + globals.sunColor.w), fogAmount);
  return vec4<f32>(max(radiance, vec3<f32>(0.0)), 1.0);
}
`;

export const sceneWGSL = sceneShader();

const skinning = /* wgsl */ `
struct RootTransform { matrix: mat4x4<f32> };
@group(1) @binding(0) var<storage, read> bonePalette: array<mat4x4<f32>>;
@group(1) @binding(1) var<uniform> rootTransform: RootTransform;
struct SkinInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) joints: vec4<u32>,
  @location(4) weights: vec4<f32>,
  @location(5) colorRoughness: vec4<f32>,
  @location(6) materialParams: vec4<f32>,
};
fn skinMatrix(joints: vec4<u32>, sourceWeights: vec4<f32>) -> mat4x4<f32> {
  let weights = sourceWeights / max(dot(sourceWeights, vec4<f32>(1.0)), 0.000001);
  return bonePalette[joints.x] * weights.x + bonePalette[joints.y] * weights.y
    + bonePalette[joints.z] * weights.z + bonePalette[joints.w] * weights.w;
}
fn transformedNormal(matrix: mat4x4<f32>, normal: vec3<f32>) -> vec3<f32> {
  let a = matrix[0].xyz;
  let b = matrix[1].xyz;
  let c = matrix[2].xyz;
  let determinant = dot(a, cross(b, c));
  let cofactorNormal = cross(b, c) * normal.x + cross(c, a) * normal.y + cross(a, b) * normal.z;
  let corrected = cofactorNormal * select(-1.0, 1.0, determinant >= 0.0);
  return corrected / max(length(corrected), 0.000001);
}
`;

/** Palette transforms mesh-local vertices. The host root matrix is
 * placement * meshNodeWorld, so the glTF node transform is applied once. */
export const skinSceneWGSL = sceneShader(true) + skinning + /* wgsl */ `
@vertex fn vsSkin(input: SkinInput) -> VertexOutput {
  let matrix = rootTransform.matrix * skinMatrix(input.joints, input.weights);
  let world = (matrix * vec4<f32>(input.position, 1.0)).xyz;
  let relative = world - globals.positionTime.xyz;
  let view = vec3<f32>(dot(relative, globals.cameraRight.xyz),
    dot(relative, globals.cameraUp.xyz), dot(relative, globals.cameraForward.xyz));
  let coefficient = globals.projection.w / (globals.projection.w - globals.projection.z);
  var output: VertexOutput;
  output.position = vec4<f32>(view.x / globals.projection.x, view.y / globals.projection.y,
    coefficient * view.z - globals.projection.z * coefficient, view.z);
  output.worldPosition = world;
  output.normal = transformedNormal(matrix, input.normal);
  output.uv = input.uv;
  output.instanceIndex = 0u;
  output.colorRoughness = input.colorRoughness;
  output.materialParams = input.materialParams;
  return output;
}
`;

export const shadowWGSL = globals + /* wgsl */ `
struct ShadowInput {
  @location(0) position: vec3<f32>,
  @builtin(instance_index) instanceIndex: u32,
};
@vertex fn vsShadow(input: ShadowInput) -> @builtin(position) vec4<f32> {
  return globals.lightVP * vec4<f32>(instancePosition(input.position, instances[input.instanceIndex]), 1.0);
}
`;

export const skinShadowWGSL = globals + skinning + /* wgsl */ `
@vertex fn vsSkinShadow(input: SkinInput) -> @builtin(position) vec4<f32> {
  let matrix = rootTransform.matrix * skinMatrix(input.joints, input.weights);
  return globals.lightVP * matrix * vec4<f32>(input.position, 1.0);
}
`;

const fullscreen = /* wgsl */ `
struct FullscreenOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex fn vsFull(@builtin(vertex_index) vertexIndex: u32) -> FullscreenOutput {
  let uv = vec2<f32>(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var output: FullscreenOutput;
  output.position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
  output.uv = uv;
  return output;
}
`;

/** Resolve the nearest covered sample, retaining silhouettes in the single
 * sample depth texture consumed by AO. This is a depth resolve, not color AA. */
export const depthResolveWGSL = fullscreen + /* wgsl */ `
@group(0) @binding(0) var sourceDepth: texture_depth_multisampled_2d;
@fragment fn fsDepthResolved(input: FullscreenOutput) -> @builtin(frag_depth) f32 {
  let dimensions = vec2<i32>(textureDimensions(sourceDepth));
  let pixel = clamp(vec2<i32>(input.position.xy), vec2<i32>(0), dimensions - vec2<i32>(1));
  var depth = 1.0;
  for (var index = 0; index < 4; index = index + 1) {
    depth = min(depth, textureLoad(sourceDepth, pixel, index));
  }
  return depth;
}
`;

export const bloomWGSL = fullscreen + /* wgsl */ `
@group(0) @binding(0) var<uniform> parameters: vec4<f32>;
@group(0) @binding(1) var sourceColor: texture_2d<f32>;
@group(0) @binding(2) var colorSampler: sampler;
@fragment fn fsBloom(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let texel = vec2<f32>(1.0) / vec2<f32>(textureDimensions(sourceColor));
  var color = vec3<f32>(0.0);
  if (parameters.w < 0.5) {
    color = (textureSampleLevel(sourceColor, colorSampler, input.uv + texel * vec2<f32>(-0.75, -0.75), 0.0).rgb
      + textureSampleLevel(sourceColor, colorSampler, input.uv + texel * vec2<f32>(0.75, -0.75), 0.0).rgb
      + textureSampleLevel(sourceColor, colorSampler, input.uv + texel * vec2<f32>(-0.75, 0.75), 0.0).rgb
      + textureSampleLevel(sourceColor, colorSampler, input.uv + texel * vec2<f32>(0.75, 0.75), 0.0).rgb) * 0.25;
    let brightness = max(color.r, max(color.g, color.b));
    color *= max(brightness - parameters.z, 0.0) / max(brightness, 0.0001);
  } else {
    let delta = parameters.xy * texel;
    color = textureSampleLevel(sourceColor, colorSampler, input.uv, 0.0).rgb * 0.227027;
    color += (textureSampleLevel(sourceColor, colorSampler, input.uv + delta * 1.384615, 0.0).rgb
      + textureSampleLevel(sourceColor, colorSampler, input.uv - delta * 1.384615, 0.0).rgb) * 0.316216;
    color += (textureSampleLevel(sourceColor, colorSampler, input.uv + delta * 3.230769, 0.0).rgb
      + textureSampleLevel(sourceColor, colorSampler, input.uv - delta * 3.230769, 0.0).rgb) * 0.070270;
  }
  return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
}
`;

// The post shader deliberately has its own bindings: unused scene storage and
// samplers do not inflate the post bind group or device requirements.
export const postWGSL = globals.slice(0, globals.indexOf('@group(0) @binding(1)')) + fullscreen + /* wgsl */ `
@group(0) @binding(1) var hdrColor: texture_2d<f32>;
@group(0) @binding(2) var sceneDepth: texture_depth_2d;
@group(0) @binding(3) var bloomColor: texture_2d<f32>;
@group(0) @binding(4) var colorSampler: sampler;
fn viewPosition(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let nearPlane = globals.projection.z;
  let farPlane = globals.projection.w;
  let z = nearPlane * farPlane / max(farPlane - depth * (farPlane - nearPlane), 0.00001);
  return vec3<f32>((uv.x * 2.0 - 1.0) * z * globals.projection.x,
    (1.0 - uv.y * 2.0) * z * globals.projection.y, z);
}
fn acesApprox(color: vec3<f32>) -> vec3<f32> {
  return clamp((color * (2.51 * color + vec3<f32>(0.03))) /
    (color * (2.43 * color + vec3<f32>(0.59)) + vec3<f32>(0.14)), vec3<f32>(0.0), vec3<f32>(1.0));
}
fn perceptualLuma(hdr: vec3<f32>) -> f32 {
  return dot(acesApprox(hdr * globals.atmosphere.y), vec3<f32>(0.299, 0.587, 0.114));
}
fn edgeFilteredHDR(uv: vec2<f32>, centerColor: vec3<f32>) -> vec3<f32> {
  let texel = vec2<f32>(1.0) / globals.viewport.xy;
  let northWest = textureSampleLevel(hdrColor, colorSampler, uv + texel * vec2<f32>(-1.0, -1.0), 0.0).rgb;
  let northEast = textureSampleLevel(hdrColor, colorSampler, uv + texel * vec2<f32>(1.0, -1.0), 0.0).rgb;
  let southWest = textureSampleLevel(hdrColor, colorSampler, uv + texel * vec2<f32>(-1.0, 1.0), 0.0).rgb;
  let southEast = textureSampleLevel(hdrColor, colorSampler, uv + texel * vec2<f32>(1.0, 1.0), 0.0).rgb;
  let centerLuma = perceptualLuma(centerColor);
  let nw = perceptualLuma(northWest);
  let ne = perceptualLuma(northEast);
  let sw = perceptualLuma(southWest);
  let se = perceptualLuma(southEast);
  let minimumLuma = min(centerLuma, min(min(nw, ne), min(sw, se)));
  let maximumLuma = max(centerLuma, max(max(nw, ne), max(sw, se)));
  // Flat regions return their original HDR value. Only a high-contrast edge
  // receives the short directional filter; skin and broad surfaces stay sharp.
  if (maximumLuma - minimumLuma < max(0.045, maximumLuma * 0.16)) { return centerColor; }
  var direction = vec2<f32>(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  let reduce = max((nw + ne + sw + se) * 0.03125, 0.0078125);
  direction = clamp(direction / (min(abs(direction.x), abs(direction.y)) + reduce), vec2<f32>(-4.0), vec2<f32>(4.0)) * texel;
  let inner = (textureSampleLevel(hdrColor, colorSampler, uv - direction / 6.0, 0.0).rgb
    + textureSampleLevel(hdrColor, colorSampler, uv + direction / 6.0, 0.0).rgb) * 0.5;
  let outer = inner * 0.5 + (textureSampleLevel(hdrColor, colorSampler, uv - direction * 0.5, 0.0).rgb
    + textureSampleLevel(hdrColor, colorSampler, uv + direction * 0.5, 0.0).rgb) * 0.25;
  let outerLuma = perceptualLuma(outer);
  let filtered = select(outer, inner, outerLuma < minimumLuma || outerLuma > maximumLuma);
  return mix(centerColor, filtered, 0.75);
}
fn ambientOcclusion(uv: vec2<f32>, pixelPosition: vec2<f32>) -> f32 {
  let dimensions = vec2<i32>(textureDimensions(sceneDepth));
  let pixel = clamp(vec2<i32>(pixelPosition), vec2<i32>(0), dimensions - vec2<i32>(1));
  let centerDepth = textureLoad(sceneDepth, pixel, 0);
  let center = viewPosition(uv, centerDepth);
  let deltaX = dpdx(center);
  let deltaY = dpdy(center);
  let surfaceNormal = normalize(cross(deltaX, deltaY));
  let offsets = array<vec2<f32>, 8>(vec2<f32>(1.0, 0.0), vec2<f32>(0.707, 0.707),
    vec2<f32>(0.0, 1.0), vec2<f32>(-0.707, 0.707), vec2<f32>(-1.0, 0.0),
    vec2<f32>(-0.707, -0.707), vec2<f32>(0.0, -1.0), vec2<f32>(0.707, -0.707));
  let radiusPixels = clamp(f32(dimensions.y) * 0.32 / max(center.z * globals.projection.y * 2.0, 0.1), 2.0, 24.0);
  var occlusion = 0.0;
  if (centerDepth < 0.999999) {
    for (var index = 0u; index < 8u; index = index + 1u) {
      let neighborPixel = clamp(pixel + vec2<i32>(offsets[index] * radiusPixels), vec2<i32>(0), dimensions - vec2<i32>(1));
      let neighborDepth = textureLoad(sceneDepth, neighborPixel, 0);
      let neighborUV = (vec2<f32>(neighborPixel) + vec2<f32>(0.5)) / vec2<f32>(dimensions);
      let delta = viewPosition(neighborUV, neighborDepth) - center;
      let distance = max(length(delta), 0.0001);
      let angular = max(dot(surfaceNormal, delta / distance) - 0.08, 0.0);
      let falloff = max(1.0 - distance / 0.80, 0.0);
      occlusion += angular * falloff * select(0.0, 1.0, neighborDepth < 0.999999);
    }
  }
  return select(1.0, clamp(1.0 - occlusion * globals.viewport.w / 5.0, 0.35, 1.0), centerDepth < 0.999999);
}
@fragment fn fsPost(input: FullscreenOutput) -> @location(0) vec4<f32> {
  var ao = 1.0;
  // Uniform quality selection bypasses all depth loads, reconstruction and the
  // eight neighbor samples when AO is disabled; derivatives stay in a uniform
  // call site when it is enabled.
  if (globals.viewport.w > 0.0) {
    ao = ambientOcclusion(input.uv, input.position.xy);
  }
  var sourceHDR = textureSampleLevel(hdrColor, colorSampler, input.uv, 0.0).rgb;
  if (globals.padding.x > 0.5) {
    sourceHDR = edgeFilteredHDR(input.uv, sourceHDR);
  }
  var hdr = sourceHDR * ao;
  hdr += textureSampleLevel(bloomColor, colorSampler, input.uv, 0.0).rgb * globals.viewport.z;
  var mapped = acesApprox(hdr * globals.atmosphere.y);
  mapped = pow(mapped, vec3<f32>(1.0 / 2.2));
  let screen = input.uv * 2.0 - vec2<f32>(1.0);
  let vignette = 1.0 - 0.16 * pow(clamp(dot(screen, screen) * 0.5, 0.0, 1.0), 1.3);
  let dither = fract(dot(input.position.xy, vec2<f32>(0.754877666, 0.569840296))) / 255.0 - 0.5 / 255.0;
  mapped = clamp(mapped * vignette + vec3<f32>(dither), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(mapped, 1.0);
}
`;
