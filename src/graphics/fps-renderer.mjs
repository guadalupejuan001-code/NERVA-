import { cameraParameters } from './scene.mjs';
import { createFPSMeshes } from './world.mjs';
import { RenderGraph } from './graph.mjs';
import { sceneWGSL, shadowWGSL, bloomWGSL, postWGSL, skinSceneWGSL, skinShadowWGSL, depthResolveWGSL } from './fps-shaders.mjs';

// Numeric constants let the public graphics modules load on Node.js 18.
const B = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, QUERY_RESOLVE: 512 };
const T = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
const S = { VERTEX: 1, FRAGMENT: 2 };
const GLOBAL_BYTES = 256;
const PASS_NAMES = ['shadow', 'reflection', 'forward', 'depth-resolve', 'bloom-extract', 'bloom-horizontal', 'bloom-vertical', 'post'];
const initializations = new WeakMap();
const now = () => globalThis.performance?.now() ?? Date.now();

function dimension(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function finite(value, name, minimum = -Infinity, maximum = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || !Number.isFinite(Math.fround(value)))
    throw new RangeError(`${name} must be a finite number between ${minimum} and ${maximum}`);
  return value;
}

function vector(value, name, fallback) {
  value ??= fallback;
  if ((!Array.isArray(value) && !(value instanceof Float32Array)) || value.length !== 3) throw new TypeError(`${name} must have three components`);
  return [...value].map((item, index) => finite(item, `${name}[${index}]`));
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(value) {
  const length = Math.hypot(...value);
  if (length < 1e-8) throw new RangeError('Sun direction must be nonzero');
  return value.map(component => component / length);
}

function lightProjection(world, direction) {
  const min = vector(world.bounds?.min, 'world.bounds.min', [-20, -1, -10]);
  const max = vector(world.bounds?.max, 'world.bounds.max', [20, 15, 60]);
  if (min.some((value, axis) => value > max[axis])) throw new RangeError('World bounds must have min <= max');
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const radius = Math.max(1, Math.hypot(...max.map((value, axis) => value - min[axis])) / 2);
  const forward = direction.map(value => -value);
  const right = normalize(cross(Math.abs(forward[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0], forward));
  const up = cross(forward, right);
  const eye = center.map((value, axis) => value + direction[axis] * radius * 2);
  const extent = radius * 1.04, near = 0, far = radius * 4;
  // Column-major WebGPU orthographic projection, left-handed depth in [0,1].
  return new Float32Array([
    right[0] / extent, up[0] / extent, forward[0] / (far - near), 0,
    right[1] / extent, up[1] / extent, forward[1] / (far - near), 0,
    right[2] / extent, up[2] / extent, forward[2] / (far - near), 0,
    -dot(right, eye) / extent, -dot(up, eye) / extent, (-dot(forward, eye) - near) / (far - near), 1,
  ]);
}

async function checkedShader(device, code, label) {
  const module = device.createShaderModule({ code, label });
  if (typeof module.getCompilationInfo === 'function') {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(`${label}: ${errors.map(error => `${error.lineNum}:${error.linePos} ${error.message}`).join('\n')}`);
  }
  return module;
}

function validateWorld(world) {
  if (!world || !Number.isSafeInteger(world.count) || world.count < 0 || world.count > 100_000 ||
      !(world.instances instanceof Float32Array) || world.instances.length !== world.count * 16)
    throw new TypeError('world must have count <= 100000 and a Float32 instance buffer with 16 components per instance');
  if (!(world.pointLights instanceof Float32Array) || world.pointLights.length < 128 ||
      !Number.isSafeInteger(world.lightCount) || world.lightCount < 0 || world.lightCount > 16)
    throw new TypeError('world must have a 16-light Float32 buffer and lightCount between 0 and 16');
  if (!Array.isArray(world.batches)) throw new TypeError('world.batches must be an array');
  let expected = 0;
  for (const batch of world.batches) {
    if (!['box', 'cylinder', 'sphere', 'pipe'].includes(batch.kind) || batch.first !== expected ||
        !Number.isSafeInteger(batch.count) || batch.count < 0 || expected + batch.count > world.count)
      throw new TypeError('World batches must cover ordered, contiguous instance ranges');
    expected += batch.count;
  }
  if (expected !== world.count) throw new TypeError('World batches must cover every instance');
}

const identityMatrix = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function characterPalette(pose, jointCount) {
  const palette = pose instanceof Float32Array ? pose : pose?.palette;
  if (!(palette instanceof Float32Array) || palette.length !== jointCount * 16 || palette.some(value => !Number.isFinite(value)))
    throw new TypeError(`characterPose must have ${jointCount} finite Float32 joint matrices`);
  return palette;
}
function characterRoot(transform) {
  if (!(transform instanceof Float32Array) || transform.length !== 16 || transform.some(value => !Number.isFinite(value)))
    throw new TypeError('characterTransform must be a finite column-major Float32 matrix');
  if (transform[3] !== 0 || transform[7] !== 0 || transform[11] !== 0 || transform[15] !== 1)
    throw new TypeError('characterTransform must be affine');
  return transform;
}
function validateCharacter(asset) {
  if (!asset || !Number.isSafeInteger(asset.jointCount) || asset.jointCount < 1 || asset.jointCount > 256 ||
      !Array.isArray(asset.primitives) || asset.primitives.length === 0)
    throw new TypeError('characterAsset must have 1..256 joints and skinned mesh primitives');
  const firstPrimitive = asset.primitives[0];
  for (const primitive of asset.primitives) {
    if (primitive.skinIndex !== firstPrimitive.skinIndex || primitive.nodeIndex !== firstPrimitive.nodeIndex)
      throw new TypeError('Character primitives must share one skin and mesh node for a single bone palette');
    if (!(primitive.vertices instanceof Uint8Array) || primitive.vertices.byteLength === 0 || primitive.vertices.byteLength % 96 !== 0 ||
        !(primitive.indices instanceof Uint32Array) || primitive.indices.length === 0 || primitive.indices.length % 3 !== 0)
      throw new TypeError('Character primitives require packed 96-byte vertices and Uint32 triangle indices');
    const vertexCount = primitive.vertices.byteLength / 96;
    if (primitive.indices.some(index => index >= vertexCount)) throw new RangeError('Character mesh indices exceed vertex count');
  }
}

function mergeCharacterMeshes(primitives) {
  const vertices = new Uint8Array(primitives.reduce((sum, primitive) => sum + primitive.vertices.byteLength, 0));
  const indices = new Uint32Array(primitives.reduce((sum, primitive) => sum + primitive.indices.length, 0));
  let byteOffset = 0, indexOffset = 0;
  for (const primitive of primitives) {
    vertices.set(primitive.vertices, byteOffset);
    const firstVertex = byteOffset / 96;
    for (let index = 0; index < primitive.indices.length; index++) indices[indexOffset + index] = primitive.indices[index] + firstVertex;
    byteOffset += primitive.vertices.byteLength; indexOffset += primitive.indices.length;
  }
  return { vertices, indices };
}

/**
 * Resident first-person scene renderer. Geometry and lights upload once. A
 * character shares one skinned mesh node; its palette and world transform update
 * only when values change. The supplied characterTransform already includes the
 * glTF mesh-node transform: palette matrices use mesh-local coordinates.
 * Optional reflection/bloom are selected each frame; shadows cache the static
 * world/light and restore that cache before rendering a changed animated caster.
 * sampleCount=4 resolves HDR color and nearest covered depth before post effects;
 * fxaa optionally handles contrast edges in the resolved image.
 * This is a forward raster prototype, with no GI, ray tracing or
 * temporal reconstruction. CPU encoding time never represents GPU frame time.
 * A supplied device remains owned by its caller. render() calls must be awaited.
 */
export async function createFPSRenderer({ device, world, width = 960, height = 540, shadowSize = 1024, format = 'rgba8unorm', profile = false,
  characterAsset, characterPose, characterTransform, sampleCount = 1, fxaa = false } = {}) {
  validateWorld(world);
  dimension(width, 'width'); dimension(height, 'height'); dimension(shadowSize, 'shadowSize');
  if (typeof profile !== 'boolean') throw new TypeError('profile must be a boolean');
  if (![1, 4].includes(sampleCount)) throw new RangeError('sampleCount must be 1 or 4');
  if (typeof fxaa !== 'boolean') throw new TypeError('fxaa must be boolean');
  let palette, characterWorld;
  if (characterAsset !== undefined) {
    validateCharacter(characterAsset);
    palette = characterPalette(characterPose ?? characterAsset.bindPose, characterAsset.jointCount);
    characterWorld = characterRoot(characterTransform ?? identityMatrix());
  } else if (characterPose !== undefined || characterTransform !== undefined) throw new TypeError('Character pose and transform require characterAsset');
  if (!['rgba8unorm', 'bgra8unorm'].includes(format)) throw new RangeError('format must be rgba8unorm or bgra8unorm');
  const lighting = world.lighting ?? {};
  const sunDirection = normalize(vector(lighting.sunDirection, 'world.lighting.sunDirection', [-0.45, 0.8, -0.35]));
  const sunColor = vector(lighting.sunColor, 'world.lighting.sunColor', [1, 0.86, 0.67]);
  const floorY = finite(world.floorY ?? 0, 'world.floorY');
  const lightVP = lightProjection(world, sunDirection);
  const ownsDevice = !device;
  if (!device) {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) throw new Error('WebGPU is unavailable; supply a GPUDevice in a supported browser');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available');
    device = await adapter.requestDevice({ requiredFeatures: profile && adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
  }
  const failSetup = error => { if (ownsDevice) device.destroy(); throw error; };
  if (!device.queue || typeof device.createBuffer !== 'function') failSetup(new TypeError('device must be a GPUDevice'));
  const maxDimension = device.limits?.maxTextureDimension2D ?? 8192;
  if (Math.max(width, height, shadowSize) > maxDimension) failSetup(new RangeError('Render or shadow dimensions exceed device limits'));
  if (world.instances.byteLength > (device.limits?.maxStorageBufferBindingSize ?? Infinity)) failSetup(new RangeError('World exceeds device storage limits'));

  const resources = new Map();
  let resourceCreateCount = 0, bufferBytes = 0, textureBytesEstimate = 0, totalUploadBytes = 0;
  let frames = 0, disposed = false, busy = false, shadowCached = false, latest = null;
  let colorTexture, colorView, hdrTexture, hdrView, depthTexture, depthView, msaaColorTexture, msaaColorView, msaaDepthTexture, msaaDepthView;
  let reflectionTexture, reflectionView, reflectionDepthTexture, reflectionDepthView, reflectionWidth, reflectionHeight;
  let bloomTextures = [], bloomViews = [], bloomWidth, bloomHeight;
  let shadowTexture, shadowView, staticShadowTexture, staticShadowView, dummyTexture, dummyView;
  let captureBuffer, captureRowBytes = 0, querySet, queryResolve, queryReadback;
  let globalsBuffer, reflectionGlobalsBuffer, shadowGlobalsBuffer, instancesBuffer, lightsBuffer;
  let meshes, scenePipeline, reflectionPipeline, shadowPipeline, bloomPipeline, postPipeline, depthResolvePipeline;
  let characterMeshes, characterScenePipeline, characterReflectionPipeline, characterShadowPipeline, characterGroup, bonesBuffer, characterRootBuffer;
  let characterUploadedPalette, characterUploadedRoot;
  let characterRevision = 0, characterShadowRevision = -1;
  let mainGroup, reflectionGroup, shadowGroup, postGroup, bloomGroups;
  let sceneLayout, shadowLayout, bloomLayout, postLayout, compareSampler, linearSampler, characterLayout, depthResolveLayout, depthResolveGroup;
  let bloomUniforms = [];
  let frameGraph;

  const track = (resource, bytes = 0, kind = 'object') => {
    resources.set(resource, { bytes, kind }); resourceCreateCount++;
    if (kind === 'buffer') bufferBytes += bytes;
    if (kind === 'texture') textureBytesEstimate += bytes;
    return resource;
  };
  const release = resource => {
    if (!resource || !resources.has(resource)) return;
    const allocation = resources.get(resource); resource.destroy?.(); resources.delete(resource);
    if (allocation.kind === 'buffer') bufferBytes -= allocation.bytes;
    if (allocation.kind === 'texture') textureBytesEstimate -= allocation.bytes;
  };
  const buffer = (label, bytes, usage, data) => {
    const result = track(device.createBuffer({ label: `nerva/fps/${label}`, size: Math.max(4, bytes), usage, mappedAtCreation: Boolean(data) }), Math.max(4, bytes), 'buffer');
    if (data) { new Uint8Array(result.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); result.unmap(); totalUploadBytes += data.byteLength; }
    return result;
  };
  const texture = (label, w, h, textureFormat, usage, bytesPerPixel, samples = 1) => track(device.createTexture({ label: `nerva/fps/${label}`, size: [w, h], format: textureFormat, usage, sampleCount: samples }), w * h * bytesPerPixel * samples, 'texture');
  const view = resource => track(resource.createView());
  const bindGroup = (label, layout, entries) => track(device.createBindGroup({ label: `nerva/fps/${label}`, layout, entries }));
  const bufferEntry = (binding, resource) => ({ binding, resource: { buffer: resource } });
  const upload = (target, data) => { device.queue.writeBuffer(target, 0, data.buffer, data.byteOffset, data.byteLength); totalUploadBytes += data.byteLength; return data.byteLength; };
  const assertLive = () => { if (disposed) throw new Error('Renderer has been disposed'); };

  const globalsData = new ArrayBuffer(GLOBAL_BYTES), reflectionData = new ArrayBuffer(GLOBAL_BYTES);
  const globals = new Float32Array(globalsData), globalsInts = new Uint32Array(globalsData);
  const reflectionGlobals = new Float32Array(reflectionData), reflectionInts = new Uint32Array(reflectionData);
  function packGlobals(params, time, options) {
    globals.fill(0);
    globals.set([...params.position, time], 0);
    globals.set(params.right, 4); globals.set(params.up, 8); globals.set(params.forward, 12);
    globals.set([params.tanX, params.tanY, params.near, params.far], 16);
    globals.set([...sunDirection, finite(lighting.sunIntensity ?? 3.8, 'sunIntensity', 0, 100)], 20);
    globals.set([...sunColor, finite(lighting.ambient ?? 0.2, 'ambient', 0, 10)], 24);
    globals.set([options.fogDensity, options.exposure, floorY, options.reflectionStrength], 28);
    globals.set([width, height, options.bloomStrength, options.aoStrength], 32);
    globalsInts[36] = world.lightCount;
    globals.set(lightVP, 40);
    globals.set([0.0002, options.shadows ? 1 : 0, options.reflection ? 1 : 0, 0], 56);
    globals[60] = fxaa ? 1 : 0;
    reflectionGlobals.set(globals);
    reflectionGlobals[1] = floorY * 2 - params.position[1];
    for (const index of [5, 9, 13]) reflectionGlobals[index] = -reflectionGlobals[index];
    reflectionGlobals[32] = reflectionWidth; reflectionGlobals[33] = reflectionHeight;
    reflectionInts[37] = 1;
  }

  function createTargets() {
    reflectionWidth = Math.max(1, Math.ceil(width / 2)); reflectionHeight = Math.max(1, Math.ceil(height / 2));
    bloomWidth = Math.max(1, Math.ceil(width / 4)); bloomHeight = Math.max(1, Math.ceil(height / 4));
    colorTexture = texture('output', width, height, format, T.RENDER_ATTACHMENT | T.COPY_SRC, 4); colorView = view(colorTexture);
    hdrTexture = texture('hdr', width, height, 'rgba16float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING, 8); hdrView = view(hdrTexture);
    depthTexture = texture('depth', width, height, 'depth32float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING, 4); depthView = view(depthTexture);
    if (sampleCount === 4) {
      msaaColorTexture = texture('hdr-msaa', width, height, 'rgba16float', T.RENDER_ATTACHMENT, 8, 4); msaaColorView = view(msaaColorTexture);
      msaaDepthTexture = texture('depth-msaa', width, height, 'depth32float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING, 4, 4); msaaDepthView = view(msaaDepthTexture);
    }
    reflectionTexture = texture('reflection', reflectionWidth, reflectionHeight, 'rgba16float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING, 8); reflectionView = view(reflectionTexture);
    reflectionDepthTexture = texture('reflection-depth', reflectionWidth, reflectionHeight, 'depth32float', T.RENDER_ATTACHMENT, 4); reflectionDepthView = view(reflectionDepthTexture);
    bloomTextures = [0, 1, 2].map(index => texture(`bloom-${index}`, bloomWidth, bloomHeight, 'rgba16float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING, 8));
    bloomViews = bloomTextures.map(view);
  }

  function createTargetGroups() {
    const sceneEntries = (uniform, reflection) => [bufferEntry(0, uniform), bufferEntry(1, instancesBuffer), bufferEntry(2, lightsBuffer),
      { binding: 3, resource: shadowView }, { binding: 4, resource: compareSampler }, { binding: 5, resource: reflection }, { binding: 6, resource: linearSampler }];
    mainGroup = bindGroup('scene-group', sceneLayout, sceneEntries(globalsBuffer, reflectionView));
    reflectionGroup = bindGroup('reflection-group', sceneLayout, sceneEntries(reflectionGlobalsBuffer, dummyView));
    postGroup = bindGroup('post-group', postLayout, [bufferEntry(0, globalsBuffer), { binding: 1, resource: hdrView }, { binding: 2, resource: depthView }, { binding: 3, resource: bloomViews[2] }, { binding: 4, resource: linearSampler }]);
    bloomGroups = [hdrView, bloomViews[0], bloomViews[1]].map((source, index) => bindGroup(`bloom-group-${index}`, bloomLayout,
      [bufferEntry(0, bloomUniforms[index]), { binding: 1, resource: source }, { binding: 2, resource: linearSampler }]));
    if (sampleCount === 4) depthResolveGroup = bindGroup('depth-resolve-group', depthResolveLayout, [{ binding: 0, resource: msaaDepthView }]);
    [[0, 0, 1, 0], [1, 0, 0, 1], [0, 1, 0, 1]].forEach((values, index) => upload(bloomUniforms[index], new Float32Array(values)));
  }

  const previousInitialization = initializations.get(device) ?? Promise.resolve();
  let releaseInitialization;
  const initializationLock = new Promise(resolve => { releaseInitialization = resolve; });
  initializations.set(device, previousInitialization.then(() => initializationLock));
  await previousInitialization;
  device.pushErrorScope('validation');
  let startupFailure;
  try {
    globalsBuffer = buffer('globals', GLOBAL_BYTES, B.UNIFORM | B.COPY_DST);
    reflectionGlobalsBuffer = buffer('reflection-globals', GLOBAL_BYTES, B.UNIFORM | B.COPY_DST);
    shadowGlobalsBuffer = buffer('shadow-globals', GLOBAL_BYTES, B.UNIFORM | B.COPY_DST);
    instancesBuffer = buffer('instances', Math.max(64, world.instances.byteLength), B.STORAGE, world.instances);
    lightsBuffer = buffer('lights', 128 * 4, B.STORAGE, world.pointLights.subarray(0, 128));
    meshes = Object.fromEntries(Object.entries(createFPSMeshes()).map(([kind, mesh]) => [kind, {
      vertex: buffer(`${kind}-vertices`, mesh.vertices.byteLength, B.VERTEX, mesh.vertices),
      index: buffer(`${kind}-indices`, mesh.indices.byteLength, B.INDEX, mesh.indices),
      indexCount: mesh.indices.length, triangleCount: mesh.indices.length / 3,
    }]));
    shadowTexture = texture('shadow', shadowSize, shadowSize, 'depth32float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | (characterAsset ? T.COPY_DST : 0), 4); shadowView = view(shadowTexture);
    if (characterAsset) {
      staticShadowTexture = texture('static-shadow', shadowSize, shadowSize, 'depth32float', T.RENDER_ATTACHMENT | T.COPY_SRC, 4); staticShadowView = view(staticShadowTexture);
      bonesBuffer = buffer('character-bones', palette.byteLength, B.STORAGE | B.COPY_DST, palette);
      characterRootBuffer = buffer('character-transform', 64, B.UNIFORM | B.COPY_DST, characterWorld);
      characterUploadedPalette = palette.slice(); characterUploadedRoot = characterWorld.slice();
      // Material values already live in vertices. A single joined skin can
      // therefore draw all glTF material primitives with one GPU mesh/batch.
      characterMeshes = [mergeCharacterMeshes(characterAsset.primitives)].map((primitive, index) => ({
        vertex: buffer(`character-${index}-vertices`, primitive.vertices.byteLength, B.VERTEX, primitive.vertices),
        index: buffer(`character-${index}-indices`, primitive.indices.byteLength, B.INDEX, primitive.indices),
        indexCount: primitive.indices.length, triangleCount: primitive.indices.length / 3,
        vertexCount: primitive.vertices.byteLength / 96,
      }));
    }
    dummyTexture = texture('reflection-dummy', 1, 1, 'rgba16float', T.TEXTURE_BINDING | T.COPY_DST, 8); dummyView = view(dummyTexture);
    device.queue.writeTexture({ texture: dummyTexture }, new Uint16Array(4), { bytesPerRow: 8 }, [1, 1]); totalUploadBytes += 8;
    compareSampler = track(device.createSampler({ label: 'nerva/fps/shadow-comparison', compare: 'less-equal', minFilter: 'linear', magFilter: 'linear' }));
    linearSampler = track(device.createSampler({ label: 'nerva/fps/linear', minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }));
    const globalsEntry = { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform', minBindingSize: GLOBAL_BYTES } };
    const instancesEntry = { binding: 1, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'read-only-storage' } };
    sceneLayout = track(device.createBindGroupLayout({ entries: [globalsEntry, instancesEntry,
      { binding: 2, visibility: S.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 4, visibility: S.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 5, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 6, visibility: S.FRAGMENT, sampler: { type: 'filtering' } }] }));
    shadowLayout = track(device.createBindGroupLayout({ entries: [{ ...globalsEntry, visibility: S.VERTEX }, { ...instancesEntry, visibility: S.VERTEX }] }));
    bloomLayout = track(device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 16 } },
      { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'float' } }, { binding: 2, visibility: S.FRAGMENT, sampler: { type: 'filtering' } }] }));
    postLayout = track(device.createBindGroupLayout({ entries: [{ ...globalsEntry, visibility: S.FRAGMENT },
      { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'float' } }, { binding: 2, visibility: S.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: 'float' } }, { binding: 4, visibility: S.FRAGMENT, sampler: { type: 'filtering' } }] }));
    if (sampleCount === 4) depthResolveLayout = track(device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.FRAGMENT, texture: { sampleType: 'depth', multisampled: true } }] }));
    if (characterAsset) characterLayout = track(device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: characterAsset.jointCount * 64 } },
      { binding: 1, visibility: S.VERTEX, buffer: { type: 'uniform', minBindingSize: 64 } }] }));
    const modules = await Promise.all([sceneWGSL, shadowWGSL, bloomWGSL, postWGSL].map((source, index) => checkedShader(device, source, `nerva/fps/shader-${index}`)));
    modules.forEach(module => track(module));
    const vertexBuffers = [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }] }];
    const scenePipelineLayout = track(device.createPipelineLayout({ bindGroupLayouts: [sceneLayout] }));
    const sceneDescriptor = (frontFace, samples = sampleCount) => ({ layout: scenePipelineLayout, vertex: { module: modules[0], entryPoint: 'vsMain', buffers: vertexBuffers },
      fragment: { module: modules[0], entryPoint: 'fsMain', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace }, multisample: { count: samples }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' } });
    scenePipeline = track(await device.createRenderPipelineAsync({ ...sceneDescriptor('cw'), label: 'nerva/fps/forward' }));
    reflectionPipeline = track(await device.createRenderPipelineAsync({ ...sceneDescriptor('ccw', 1), label: 'nerva/fps/reflection' }));
    shadowPipeline = track(await device.createRenderPipelineAsync({ label: 'nerva/fps/shadow', layout: track(device.createPipelineLayout({ bindGroupLayouts: [shadowLayout] })),
      vertex: { module: modules[1], entryPoint: 'vsShadow', buffers: vertexBuffers }, primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'cw' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 1, depthBiasSlopeScale: 1 } }));
    bloomPipeline = track(await device.createRenderPipelineAsync({ label: 'nerva/fps/bloom', layout: track(device.createPipelineLayout({ bindGroupLayouts: [bloomLayout] })),
      vertex: { module: modules[2], entryPoint: 'vsFull' }, fragment: { module: modules[2], entryPoint: 'fsBloom', targets: [{ format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } }));
    postPipeline = track(await device.createRenderPipelineAsync({ label: 'nerva/fps/post', layout: track(device.createPipelineLayout({ bindGroupLayouts: [postLayout] })),
      vertex: { module: modules[3], entryPoint: 'vsFull' }, fragment: { module: modules[3], entryPoint: 'fsPost', targets: [{ format }] }, primitive: { topology: 'triangle-list' } }));
    if (sampleCount === 4) {
      const module = track(await checkedShader(device, depthResolveWGSL, 'nerva/fps/depth-resolve-shader'));
      depthResolvePipeline = track(await device.createRenderPipelineAsync({ label: 'nerva/fps/depth-resolve', layout: track(device.createPipelineLayout({ bindGroupLayouts: [depthResolveLayout] })),
        vertex: { module, entryPoint: 'vsFull' }, fragment: { module, entryPoint: 'fsDepthResolved', targets: [] }, primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' } }));
    }
    if (characterAsset) {
      const skinModule = track(await checkedShader(device, skinSceneWGSL, 'nerva/fps/skin-scene-shader'));
      const skinShadowModule = track(await checkedShader(device, skinShadowWGSL, 'nerva/fps/skin-shadow-shader'));
      const skinBuffers = [{ arrayStride: 96, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'uint16x4' },
        { shaderLocation: 4, offset: 40, format: 'float32x4' }, { shaderLocation: 5, offset: 56, format: 'float32x4' },
        { shaderLocation: 6, offset: 72, format: 'float32x4' }] }];
      const skinLayout = track(device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, characterLayout] }));
      const skinDescriptor = (frontFace, samples) => ({ ...sceneDescriptor(frontFace, samples), layout: skinLayout,
        vertex: { module: skinModule, entryPoint: 'vsSkin', buffers: skinBuffers }, fragment: { module: skinModule, entryPoint: 'fsMain', targets: [{ format: 'rgba16float' }] } });
      characterScenePipeline = track(await device.createRenderPipelineAsync({ ...skinDescriptor('cw', sampleCount), label: 'nerva/fps/character-forward' }));
      characterReflectionPipeline = track(await device.createRenderPipelineAsync({ ...skinDescriptor('ccw', 1), label: 'nerva/fps/character-reflection' }));
      characterShadowPipeline = track(await device.createRenderPipelineAsync({ label: 'nerva/fps/character-shadow', layout: track(device.createPipelineLayout({ bindGroupLayouts: [shadowLayout, characterLayout] })),
        vertex: { module: skinShadowModule, entryPoint: 'vsSkinShadow', buffers: skinBuffers }, primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'cw' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 1, depthBiasSlopeScale: 1 } }));
      characterGroup = bindGroup('character-group', characterLayout, [bufferEntry(0, bonesBuffer), bufferEntry(1, characterRootBuffer)]);
    }
    shadowGroup = bindGroup('shadow-group', shadowLayout, [bufferEntry(0, shadowGlobalsBuffer), bufferEntry(1, instancesBuffer)]);
    bloomUniforms = [0, 1, 2].map(index => buffer(`bloom-uniform-${index}`, 16, B.UNIFORM | B.COPY_DST));
    createTargets(); createTargetGroups();
    if (profile && device.features?.has('timestamp-query')) {
      querySet = track(device.createQuerySet({ label: 'nerva/fps/pass-timestamps', type: 'timestamp', count: PASS_NAMES.length * 2 }));
      // Each independently resolved pair starts at WebGPU's 256-byte query
      // alignment. The mapping buffer packs pairs into their stable pass slots.
      queryResolve = buffer('timestamp-resolve', PASS_NAMES.length * 256, B.QUERY_RESOLVE | B.COPY_SRC);
      queryReadback = buffer('timestamp-readback', PASS_NAMES.length * 16, B.COPY_DST | B.MAP_READ);
    }
    const initialCamera = cameraParameters({ position: world.spawn?.position ?? [0, 1.7, 0], aspect: width / height, near: 0.08, far: 200 });
    packGlobals(initialCamera, 0, effectOptions()); upload(shadowGlobalsBuffer, globals);
  } catch (error) { startupFailure = error; }
  let startupValidation;
  try { startupValidation = await device.popErrorScope(); } catch (error) { startupFailure ??= error; }
  releaseInitialization();
  if (startupFailure || startupValidation) {
    for (const resource of [...resources.keys()]) release(resource);
    if (ownsDevice) device.destroy();
    throw startupFailure ?? new Error(`WebGPU FPS initialization: ${startupValidation.message}`);
  }

  function effectOptions(effects = {}) {
    if (!effects || typeof effects !== 'object' || Array.isArray(effects)) throw new TypeError('effects must be an object');
    const bool = (key, fallback) => { const value = effects[key] ?? fallback; if (typeof value !== 'boolean') throw new TypeError(`effects.${key} must be boolean`); return value; };
    const bloom = bool('bloom', true), ao = bool('ao', true), reflection = bool('reflections', effects.reflection ?? true), shadows = bool('shadows', true);
    return { bloom, ao, reflection, shadows,
      bloomStrength: bloom ? finite(effects.bloomStrength ?? lighting.bloomStrength ?? 0.16, 'bloomStrength', 0, 2) : 0,
      aoStrength: ao ? finite(effects.aoStrength ?? lighting.aoStrength ?? 0.35, 'aoStrength', 0, 2) : 0,
      reflectionStrength: reflection ? finite(effects.reflectionStrength ?? lighting.reflectionStrength ?? 0.65, 'reflectionStrength', 0, 1) : 0,
      exposure: finite(effects.exposure ?? lighting.exposure ?? 1.1, 'exposure', 0.01, 20),
      fogDensity: finite(effects.fogDensity ?? lighting.fogDensity ?? 0.025, 'fogDensity', 0, 1),
    };
  }

  function timestamps(index, enabled) {
    return enabled ? { timestampWrites: { querySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 } } : {};
  }

  function drawWorld(pass) {
    for (const batch of world.batches) {
      if (!batch.count) continue;
      const mesh = meshes[batch.kind];
      pass.setVertexBuffer(0, mesh.vertex); pass.setIndexBuffer(mesh.index, 'uint32');
      pass.drawIndexed(mesh.indexCount, batch.count, 0, 0, batch.first);
    }
  }

  function drawCharacter(pass) {
    pass.setBindGroup(1, characterGroup);
    for (const mesh of characterMeshes) {
      pass.setVertexBuffer(0, mesh.vertex); pass.setIndexBuffer(mesh.index, 'uint32'); pass.drawIndexed(mesh.indexCount);
    }
  }

  function updateCharacter(nextPose, nextTransform) {
    if (!characterAsset) {
      if (nextPose !== undefined || nextTransform !== undefined) throw new TypeError('Character updates require characterAsset');
      return { boneUploadBytes: 0, characterTransformUploadBytes: 0 };
    }
    const validatedPalette = characterPalette(nextPose ?? palette, characterAsset.jointCount);
    const validatedRoot = characterRoot(nextTransform ?? characterWorld);
    palette = validatedPalette; characterWorld = validatedRoot;
    let boneUploadBytes = 0, characterTransformUploadBytes = 0;
    // Values, rather than object identity, detect edits to the animator's reused
    // Float32 palette. Merge adjacent dirty joints into small direct uploads.
    let firstDirty = -1;
    for (let joint = 0; joint <= characterAsset.jointCount; joint++) {
      let changed = false;
      if (joint < characterAsset.jointCount) for (let component = 0; component < 16; component++) {
        const index = joint * 16 + component;
        if (palette[index] !== characterUploadedPalette[index]) { changed = true; break; }
      }
      if (changed && firstDirty < 0) firstDirty = joint;
      if (!changed && firstDirty >= 0) {
        const start = firstDirty * 16, count = (joint - firstDirty) * 16, bytes = count * 4;
        device.queue.writeBuffer(bonesBuffer, start * 4, palette.buffer, palette.byteOffset + start * 4, bytes);
        characterUploadedPalette.set(palette.subarray(start, start + count), start);
        boneUploadBytes += bytes; totalUploadBytes += bytes; firstDirty = -1;
      }
    }
    if (characterWorld.some((value, index) => value !== characterUploadedRoot[index])) {
      characterTransformUploadBytes = upload(characterRootBuffer, characterWorld); characterUploadedRoot.set(characterWorld);
    }
    if (boneUploadBytes || characterTransformUploadBytes) characterRevision++;
    return { boneUploadBytes, characterTransformUploadBytes };
  }

  function encodeShadow(context) {
    if (!context.options.shadows || (shadowCached && (!characterAsset || characterShadowRevision === characterRevision))) return;
    const rebuildStatic = !shadowCached;
    if (rebuildStatic) {
      const writes = context.timestamps && characterAsset ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0 } } : timestamps(0, context.timestamps);
      const pass = context.encoder.beginRenderPass({ label: 'nerva/fps/static-shadow', ...writes, colorAttachments: [],
        depthStencilAttachment: { view: characterAsset ? staticShadowView : shadowView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
      pass.setPipeline(shadowPipeline); pass.setBindGroup(0, shadowGroup); drawWorld(pass); pass.end();
      context.staticDrawPasses++; shadowCached = true;
    }
    if (characterAsset) {
      // Restore the cached environment before adding the current animated
      // caster. Old NPC silhouettes never accumulate in the shadow map.
      context.encoder.copyTextureToTexture({ texture: staticShadowTexture, aspect: 'depth-only' }, { texture: shadowTexture, aspect: 'depth-only' }, [shadowSize, shadowSize]);
      const writes = context.timestamps && rebuildStatic ? { timestampWrites: { querySet, endOfPassWriteIndex: 1 } } : timestamps(0, context.timestamps);
      const pass = context.encoder.beginRenderPass({ label: 'nerva/fps/character-shadow', ...writes, colorAttachments: [],
        depthStencilAttachment: { view: shadowView, depthLoadOp: 'load', depthStoreOp: 'store' } });
      pass.setPipeline(characterShadowPipeline); pass.setBindGroup(0, shadowGroup); drawCharacter(pass); pass.end();
      context.characterDrawPasses++; context.npcShadowRendered = true; characterShadowRevision = characterRevision;
    }
    context.executed.push('shadow');
  }

  function encodeScene(context, reflection) {
    if (reflection && !context.options.reflection) return;
    const index = reflection ? 1 : 2, label = reflection ? 'reflection' : 'forward';
    const pass = context.encoder.beginRenderPass({ label: `nerva/fps/${label}`, ...timestamps(index, context.timestamps),
      colorAttachments: [{ view: reflection ? reflectionView : sampleCount === 4 ? msaaColorView : hdrView,
        ...(!reflection && sampleCount === 4 ? { resolveTarget: hdrView } : {}), loadOp: 'clear', storeOp: !reflection && sampleCount === 4 ? 'discard' : 'store', clearValue: { r: 0.075, g: 0.125, b: 0.16, a: 1 } }],
      depthStencilAttachment: { view: reflection ? reflectionDepthView : sampleCount === 4 ? msaaDepthView : depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
    pass.setPipeline(reflection ? reflectionPipeline : scenePipeline); pass.setBindGroup(0, reflection ? reflectionGroup : mainGroup); drawWorld(pass); context.staticDrawPasses++;
    if (characterAsset) { pass.setPipeline(reflection ? characterReflectionPipeline : characterScenePipeline); drawCharacter(pass); context.characterDrawPasses++; }
    pass.end();
    context.executed.push(label);
  }

  function encodeBloom(context, step) {
    if (!context.options.bloom) return;
    const pass = context.encoder.beginRenderPass({ label: `nerva/fps/${PASS_NAMES[step + 4]}`, ...timestamps(step + 4, context.timestamps),
      colorAttachments: [{ view: bloomViews[step], loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(bloomPipeline); pass.setBindGroup(0, bloomGroups[step]); pass.draw(3); pass.end();
    context.executed.push(PASS_NAMES[step + 4]);
  }

  function encodeDepthResolve(context) {
    if (sampleCount !== 4) return;
    const pass = context.encoder.beginRenderPass({ label: 'nerva/fps/depth-resolve', ...timestamps(3, context.timestamps), colorAttachments: [],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
    pass.setPipeline(depthResolvePipeline); pass.setBindGroup(0, depthResolveGroup); pass.draw(3); pass.end(); context.executed.push('depth-resolve');
  }

  function encodePost(context) {
    const pass = context.encoder.beginRenderPass({ label: 'nerva/fps/post', ...timestamps(7, context.timestamps),
      colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(postPipeline); pass.setBindGroup(0, postGroup); pass.draw(3); pass.end(); context.executed.push('post');
  }

  function compileFrameGraph() {
    const graph = new RenderGraph();
    graph.resource('scene', { size: Math.max(4, world.instances.byteLength + 512), external: true, persistent: true });
    graph.resource('shadow', { size: shadowSize * shadowSize * 4, persistent: true, kind: 'depth32float' });
    graph.resource('reflection', { size: reflectionWidth * reflectionHeight * 8, persistent: true, kind: 'rgba16float' });
    graph.resource('hdr', { size: width * height * 8, persistent: true, kind: 'rgba16float' });
    graph.resource('depth', { size: width * height * 4, persistent: true, kind: 'depth32float' });
    if (sampleCount === 4) {
      graph.resource('msaa-hdr', { size: width * height * 8 * 4, persistent: true, kind: 'rgba16float-msaa4' });
      graph.resource('msaa-depth', { size: width * height * 4 * 4, persistent: true, kind: 'depth32float-msaa4' });
    }
    if (characterAsset) {
      graph.resource('character', { size: characterMeshes.reduce((sum, mesh) => sum + mesh.vertex.size + mesh.index.size, bonesBuffer.size + 64), external: true, persistent: true });
      graph.resource('static-shadow', { size: shadowSize * shadowSize * 4, persistent: true, kind: 'depth32float' });
    }
    for (let index = 0; index < 3; index++) graph.resource(`bloom${index}`, { size: bloomWidth * bloomHeight * 8, persistent: true, kind: 'rgba16float' });
    graph.resource('output', { size: width * height * 4, persistent: true, kind: format });
    const geometry = characterAsset ? ['scene', 'character'] : ['scene'];
    graph.pass('shadow', { reads: geometry, writes: characterAsset ? ['shadow', 'static-shadow'] : ['shadow'], execute: encodeShadow });
    graph.pass('reflection', { reads: [...geometry, 'shadow'], writes: ['reflection'], execute: context => encodeScene(context, true) });
    graph.pass('forward', { reads: [...geometry, 'shadow', 'reflection'], writes: sampleCount === 4 ? ['hdr', 'msaa-hdr', 'msaa-depth'] : ['hdr', 'depth'], execute: context => encodeScene(context, false) });
    if (sampleCount === 4) graph.pass('depth-resolve', { reads: ['msaa-depth'], writes: ['depth'], execute: encodeDepthResolve });
    graph.pass('bloom-extract', { reads: ['hdr'], writes: ['bloom0'], execute: context => encodeBloom(context, 0) });
    graph.pass('bloom-horizontal', { reads: ['bloom0'], writes: ['bloom1'], execute: context => encodeBloom(context, 1) });
    graph.pass('bloom-vertical', { reads: ['bloom1'], writes: ['bloom2'], execute: context => encodeBloom(context, 2) });
    graph.pass('post', { reads: ['hdr', 'depth', 'bloom2'], writes: ['output'], execute: encodePost });
    return graph.compile();
  }
  frameGraph = compileFrameGraph();

  function ensureCapture() {
    if (captureBuffer) return;
    captureRowBytes = Math.ceil(width * 4 / 256) * 256;
    captureBuffer = buffer('capture', captureRowBytes * height, B.COPY_DST | B.MAP_READ);
  }

  async function captureRGBA() {
    let mapped = false;
    try {
      await captureBuffer.mapAsync(1); mapped = true;
      const source = new Uint8Array(captureBuffer.getMappedRange()), rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) rgba.set(source.subarray(y * captureRowBytes, y * captureRowBytes + width * 4), y * width * 4);
      if (format === 'bgra8unorm') for (let offset = 0; offset < rgba.length; offset += 4) { const red = rgba[offset]; rgba[offset] = rgba[offset + 2]; rgba[offset + 2] = red; }
      return rgba;
    } finally { if (mapped) captureBuffer.unmap(); }
  }

  async function collectTimestamps(executed) {
    let mapped = false;
    try {
      await queryReadback.mapAsync(1); mapped = true;
      const values = new BigUint64Array(queryReadback.getMappedRange());
      const gpuPassTimesMs = {};
      for (const name of executed) {
        const index = PASS_NAMES.indexOf(name);
        if (values[index * 2 + 1] < values[index * 2]) throw new Error('GPU returned non-monotonic FPS timestamps');
        gpuPassTimesMs[name] = Number(values[index * 2 + 1] - values[index * 2]) / 1e6;
      }
      return { gpuPassTimesMs, gpuTimeMs: Object.values(gpuPassTimesMs).reduce((sum, value) => sum + value, 0), gpuTimestampStatus: 'measured' };
    } finally { if (mapped) queryReadback.unmap(); }
  }

  async function render(camera, { capture = false, readback = false, time = 0, effects, characterPose: nextPose, characterTransform: nextTransform } = {}) {
    assertLive();
    if (busy) throw new Error('Await the current render before submitting another FPS frame');
    if (camera !== undefined && (!camera || typeof camera !== 'object' || Array.isArray(camera)))
      throw new TypeError('camera must be an object');
    if (typeof capture !== 'boolean' || typeof readback !== 'boolean') throw new TypeError('capture and readback must be boolean');
    finite(time, 'time', 0);
    const options = effectOptions(effects);
    const params = cameraParameters({ ...camera, aspect: camera?.aspect ?? width / height, near: camera?.near ?? 0.08, far: camera?.far ?? 200 });
    packGlobals(params, time, options);
    busy = true; device.pushErrorScope('validation');
    const started = now(), resourcesBefore = resourceCreateCount;
    let failure, validationPromise, result;
    try {
      const characterUploads = updateCharacter(nextPose, nextTransform);
      const uniformUploadBytes = upload(globalsBuffer, globals) + upload(reflectionGlobalsBuffer, reflectionGlobals);
      if (capture) ensureCapture();
      const encoder = device.createCommandEncoder({ label: `nerva/fps/frame-${frames}` });
      const useTimestamps = Boolean(querySet && readback), context = { encoder, options, timestamps: useTimestamps, executed: [], staticDrawPasses: 0, characterDrawPasses: 0, npcShadowRendered: false };
      frameGraph.execute(context);
      if (capture) encoder.copyTextureToBuffer({ texture: colorTexture }, { buffer: captureBuffer, bytesPerRow: captureRowBytes, rowsPerImage: height }, [width, height]);
      if (useTimestamps) {
        // Cached/disabled passes have no timestamps this frame. In particular,
        // an unprofiled preview can cache shadows before their first query ever
        // gets written; never resolve those unavailable or stale query slots.
        for (const name of context.executed) {
          const index = PASS_NAMES.indexOf(name);
          encoder.resolveQuerySet(querySet, index * 2, 2, queryResolve, index * 256);
          encoder.copyBufferToBuffer(queryResolve, index * 256, queryReadback, index * 16, 16);
        }
      }
      device.queue.submit([encoder.finish()]); validationPromise = device.popErrorScope();
      const drawCalls = world.batches.filter(batch => batch.count > 0).length * context.staticDrawPasses + (characterMeshes?.length ?? 0) * context.characterDrawPasses + context.executed.filter(name => name.startsWith('bloom') || name === 'post' || name === 'depth-resolve').length;
      const sceneTriangles = world.batches.reduce((sum, batch) => sum + batch.count * meshes[batch.kind].triangleCount, 0);
      const skinnedTriangles = characterMeshes?.reduce((sum, mesh) => sum + mesh.triangleCount, 0) ?? 0;
      result = { frame: ++frames, width, height, instanceCount: world.count, lightCount: world.lightCount, drawCalls, sceneTriangles,
        trianglesSubmitted: sceneTriangles * context.staticDrawPasses + skinnedTriangles * context.characterDrawPasses,
        sampleCount, fxaa, antialiasPixels: width * height * sampleCount,
        characterVertexCount: characterMeshes?.reduce((sum, mesh) => sum + mesh.vertexCount, 0) ?? 0,
        characterJointCount: characterAsset?.jointCount ?? 0, jointCount: characterAsset?.jointCount ?? 0, skinnedTriangles,
        characterDrawCalls: (characterMeshes?.length ?? 0) * context.characterDrawPasses, npcShadowRendered: context.npcShadowRendered,
        ...characterUploads,
        capture, readback, cpuEncodeMs: now() - started, gpuTimeMs: null, gpuPassTimesMs: null,
        gpuTimestampStatus: !profile ? 'disabled' : !querySet ? 'unavailable' : !readback ? 'not-requested-this-frame' : 'pending',
        timingScope: 'CPU encode and queue submission; excludes GPU completion', gpuTimingScope: 'GPU pass spans; character shadow span includes cached depth copy; excludes uploads, readbacks and CPU submission',
        sceneUploadBytes: 0, uniformUploadBytes, uploadBytesPerFrame: uniformUploadBytes + characterUploads.boneUploadBytes + characterUploads.characterTransformUploadBytes, totalUploadBytes,
        bufferBytes, textureBytesEstimate, allocatedBytesEstimate: bufferBytes + textureBytesEstimate,
        resourceCreateCount, resourceCreationsThisFrame: resourceCreateCount - resourcesBefore,
        renderGraphPasses: context.executed, renderGraphSchedule: frameGraph.order, renderGraphMemory: frameGraph.memory,
        shadowCached, effects: options, reflectionWidth, reflectionHeight, bloomWidth, bloomHeight };
      if (capture) result.rgba = await captureRGBA();
      if (useTimestamps) Object.assign(result, await collectTimestamps(context.executed));
      else if (readback && !capture) await device.queue.onSubmittedWorkDone();
    } catch (error) { failure = error; }
    let validation;
    try { validation = await (validationPromise ?? device.popErrorScope()); } catch (error) { failure ??= error; }
    busy = false;
    if (failure || validation) {
      shadowCached = false; characterShadowRevision = -1;
      throw failure ?? new Error(`WebGPU FPS frame validation: ${validation.message}`);
    }
    latest = result; return result;
  }

  function present(context) {
    assertLive();
    if (busy) throw new Error('Await the current render before presenting');
    if (!context || typeof context.getCurrentTexture !== 'function') throw new TypeError('context must be a configured GPUCanvasContext');
    const destination = context.getCurrentTexture();
    if (destination.width !== width || destination.height !== height || destination.format !== format)
      throw new RangeError('Canvas texture size and format must match the renderer');
    const encoder = device.createCommandEncoder({ label: 'nerva/fps/present' });
    encoder.copyTextureToTexture({ texture: colorTexture }, { texture: destination }, [width, height]);
    device.queue.submit([encoder.finish()]);
  }

  function destroyTargets() {
    [mainGroup, reflectionGroup, postGroup, depthResolveGroup, ...bloomGroups, colorView, hdrView, depthView, msaaColorView, msaaDepthView, reflectionView, reflectionDepthView, ...bloomViews,
      colorTexture, hdrTexture, depthTexture, msaaColorTexture, msaaDepthTexture, reflectionTexture, reflectionDepthTexture, ...bloomTextures, captureBuffer].forEach(release);
    captureBuffer = undefined; mainGroup = reflectionGroup = postGroup = undefined; bloomGroups = []; bloomViews = []; bloomTextures = [];
    depthResolveGroup = msaaColorTexture = msaaColorView = msaaDepthTexture = msaaDepthView = undefined;
  }

  function resize(nextWidth, nextHeight) {
    assertLive();
    if (busy) throw new Error('Await the current render before resizing');
    dimension(nextWidth, 'width'); dimension(nextHeight, 'height');
    if (Math.max(nextWidth, nextHeight) > maxDimension) throw new RangeError('Render dimensions exceed device limits');
    if (nextWidth === width && nextHeight === height) return;
    destroyTargets(); width = nextWidth; height = nextHeight; createTargets(); createTargetGroups(); frameGraph = compileFrameGraph();
  }

  function dispose() {
    if (disposed) return;
    if (busy) throw new Error('Await the current render before disposing');
    for (const resource of [...resources.keys()]) release(resource);
    meshes = scenePipeline = reflectionPipeline = shadowPipeline = bloomPipeline = postPipeline = depthResolvePipeline = undefined;
    characterMeshes = characterScenePipeline = characterReflectionPipeline = characterShadowPipeline = characterGroup = bonesBuffer = characterRootBuffer = undefined;
    characterUploadedPalette = characterUploadedRoot = palette = characterWorld = undefined;
    mainGroup = reflectionGroup = shadowGroup = postGroup = bloomGroups = undefined;
    globalsBuffer = reflectionGlobalsBuffer = shadowGlobalsBuffer = instancesBuffer = lightsBuffer = undefined;
    colorTexture = colorView = hdrTexture = hdrView = depthTexture = depthView = undefined;
    msaaColorTexture = msaaColorView = msaaDepthTexture = msaaDepthView = depthResolveGroup = undefined;
    reflectionTexture = reflectionView = reflectionDepthTexture = reflectionDepthView = shadowTexture = shadowView = dummyTexture = dummyView = undefined;
    staticShadowTexture = staticShadowView = undefined;
    bloomTextures = bloomViews = bloomUniforms = undefined; sceneLayout = shadowLayout = bloomLayout = postLayout = compareSampler = linearSampler = characterLayout = depthResolveLayout = undefined;
    captureBuffer = querySet = queryResolve = queryReadback = frameGraph = undefined;
    if (ownsDevice) device.destroy(); disposed = true;
  }

  return Object.freeze({ render, resize, dispose, present,
    get colorTexture() { assertLive(); return colorTexture; },
    get statistics() { return { ...latest, frames, width, height, shadowSize, sampleCount, fxaa, disposed, ownsDevice, bufferBytes, textureBytesEstimate,
      allocatedBytesEstimate: bufferBytes + textureBytesEstimate, resourceCreateCount, totalUploadBytes }; },
  });
}
