import { cameraParameters, MAX_SCENE_INSTANCES } from './scene.mjs';
import { cullWGSL, drawWGSL } from './shaders.mjs';
import { RenderGraph } from './graph.mjs';

// Numeric WebGPU constants keep importing this module safe on Node.js 18.
const B = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
const T = { COPY_SRC: 1, RENDER_ATTACHMENT: 16 };
const STAGE = { VERTEX: 1, COMPUTE: 4 };
const READ = 1;
const CAMERA_BYTES = 128;
const INDIRECT_BYTES = 3 * 5 * 4;
const LOD_SEGMENTS = [[16, 8], [8, 4], [4, 2]];
const sceneOwners = new WeakSet();
const deviceInitializations = new WeakMap();
const now = () => globalThis.performance?.now() ?? Date.now();

function dimension(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function validateScene(scene) {
  if (!scene || !Number.isSafeInteger(scene.count) || scene.count < 0 || scene.count > MAX_SCENE_INSTANCES)
    throw new RangeError(`scene.count must be between 0 and ${MAX_SCENE_INSTANCES}`);
  if (!(scene.positions instanceof Float32Array) || scene.positions.length !== scene.count * 4 ||
      !(scene.colors instanceof Float32Array) || scene.colors.length !== scene.count * 4 ||
      typeof scene.consumeDirtyRanges !== 'function')
    throw new TypeError('scene must provide Float32 position/color vec4 buffers and consumeDirtyRanges()');
}

function sphereMesh(longitudes, latitudes) {
  const vertices = new Float32Array((longitudes + 1) * (latitudes + 1) * 6);
  let offset = 0;
  for (let latitude = 0; latitude <= latitudes; latitude++) {
    const theta = latitude * Math.PI / latitudes;
    for (let longitude = 0; longitude <= longitudes; longitude++) {
      const phi = longitude * 2 * Math.PI / longitudes;
      const x = Math.sin(theta) * Math.cos(phi);
      const y = Math.cos(theta);
      const z = Math.sin(theta) * Math.sin(phi);
      vertices.set([x, y, z, x, y, z], offset);
      offset += 6;
    }
  }
  const indices = new Uint32Array(longitudes * (latitudes - 1) * 6);
  offset = 0;
  for (let latitude = 0; latitude < latitudes; latitude++) {
    for (let longitude = 0; longitude < longitudes; longitude++) {
      const a = latitude * (longitudes + 1) + longitude;
      const b = a + longitudes + 1;
      if (latitude !== 0) { indices.set([a, a + 1, b], offset); offset += 3; }
      if (latitude !== latitudes - 1) { indices.set([a + 1, b + 1, b], offset); offset += 3; }
    }
  }
  return { vertices, indices, triangleCount: indices.length / 3 };
}

async function checkedShader(device, code, label) {
  const module = device.createShaderModule({ code, label });
  if (typeof module.getCompilationInfo === 'function') {
    const info = await module.getCompilationInfo();
    const failures = info.messages.filter(message => message.type === 'error');
    if (failures.length) throw new Error(`${label}: ${failures.map(message => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n')}`);
  }
  return module;
}

/**
 * Resident, GPU-driven sphere renderer. NERVA produces commands/instance edits;
 * asynchronous GPU completion stays in this host module, outside its sync runtime.
 * readback=false measures CPU encoding/submission only, never GPU time or FPS.
 * readback=true is a validation path and deliberately copies visible IDs to CPU.
 * Dirty ranges have exactly one consumer: do not consume them from another host
 * while this renderer owns the scene. A scene cannot have two live renderers.
 * Resource counters cover buffers, textures, views, pipelines and binding objects;
 * per-frame command encoders/buffers are excluded. Texture sizes are estimates,
 * because WebGPU does not expose driver allocation sizes or depth24plus storage.
 * profile=true enables optional timestamp-query measurements on readback frames.
 * GPU durations cover compute/render passes, excluding uploads and readbacks.
 * dispose destroys a device created here; a supplied GPUDevice remains owned by
 * its host so other renderers can keep using it.
 */
export async function createWebGPURenderer({ device, scene, width = 640, height = 480, format = 'rgba8unorm', profile = false } = {}) {
  const ownsDevice = !device;
  validateScene(scene);
  dimension(width, 'width'); dimension(height, 'height');
  if (typeof profile !== 'boolean') throw new TypeError('profile must be a boolean');
  if (!['rgba8unorm', 'bgra8unorm'].includes(format))
    throw new RangeError('format must be rgba8unorm or bgra8unorm');
  if (!device) {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) throw new Error('WebGPU is unavailable; supply a GPUDevice in a supported browser');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available');
    device = await adapter.requestDevice({ requiredFeatures: profile && adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
  }
  if (typeof device.createBuffer !== 'function' || !device.queue)
    throw new TypeError('device must be a GPUDevice');
  const capacity = Math.max(1, scene.count);
  const largestBuffer = capacity * 16;
  const failDeviceSetup = error => { if (ownsDevice) device.destroy(); throw error; };
  if (largestBuffer > (device.limits?.maxStorageBufferBindingSize ?? Infinity) ||
      largestBuffer > (device.limits?.maxBufferSize ?? Infinity))
    failDeviceSetup(new RangeError('Scene exceeds this device\'s buffer limits'));
  const maxDimension = device.limits?.maxTextureDimension2D ?? 8192;
  if (width > maxDimension || height > maxDimension) failDeviceSetup(new RangeError('Render size exceeds device texture limits'));
  if (sceneOwners.has(scene)) failDeviceSetup(new Error('Scene already has a live WebGPU renderer; dirty ranges require one owner'));
  sceneOwners.add(scene);

  const resources = new Map();
  let resourceCreateCount = 0, bufferBytes = 0, textureBytesEstimate = 0;
  let totalUploadBytes = 0, sceneUploadBytesTotal = 0, pendingSceneBytes = 0;
  let frames = 0, disposed = false, busy = false;
  let uploadedRevision = -1;
  let colorTexture, depthTexture, colorView, depthView, captureBuffer, captureRowBytes = 0;
  let countsReadback, visibleReadback;
  let querySet, queryResolveBuffer, queryReadback;
  let latest = null;

  const track = (resource, bytes = 0, kind = 'object') => {
    resources.set(resource, { bytes, kind });
    resourceCreateCount++;
    if (kind === 'buffer') bufferBytes += bytes;
    if (kind === 'texture') textureBytesEstimate += bytes;
    return resource;
  };
  const release = resource => {
    if (!resource) return;
    const allocation = resources.get(resource);
    if (!allocation) return;
    resource.destroy?.();
    if (allocation.kind === 'buffer') bufferBytes -= allocation.bytes;
    if (allocation.kind === 'texture') textureBytesEstimate -= allocation.bytes;
    resources.delete(resource);
  };
  const buffer = (label, size, usage, contents) => {
    size = Math.max(4, size);
    const result = track(device.createBuffer({ label, size, usage, mappedAtCreation: Boolean(contents) }), size, 'buffer');
    if (contents) {
      new Uint8Array(result.getMappedRange()).set(new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength));
      result.unmap();
      totalUploadBytes += contents.byteLength;
    }
    return result;
  };
  const upload = (target, byteOffset, data, first = 0, count = data.length) => {
    const bytes = count * data.BYTES_PER_ELEMENT;
    if (bytes === 0) return 0;
    device.queue.writeBuffer(target, byteOffset, data.buffer, data.byteOffset + first * data.BYTES_PER_ELEMENT, bytes);
    totalUploadBytes += bytes;
    return bytes;
  };
  const assertLive = () => { if (disposed) throw new Error('Renderer has been disposed'); };
  const ensureReadback = () => {
    if (!countsReadback) countsReadback = buffer('nerva/counts-readback', INDIRECT_BYTES, B.COPY_DST | B.MAP_READ);
    if (!visibleReadback) visibleReadback = buffer('nerva/visible-readback', capacity * 3 * 4, B.COPY_DST | B.MAP_READ);
  };
  const ensureCapture = () => {
    if (!captureBuffer) {
      captureRowBytes = Math.ceil(width * 4 / 256) * 256;
      captureBuffer = buffer('nerva/rgba-readback', captureRowBytes * height, B.COPY_DST | B.MAP_READ);
    }
  };
  const createTargets = () => {
    colorTexture = track(device.createTexture({ label: 'nerva/color', size: [width, height], format,
      usage: T.RENDER_ATTACHMENT | T.COPY_SRC }), width * height * 4, 'texture');
    depthTexture = track(device.createTexture({ label: 'nerva/depth', size: [width, height], format: 'depth24plus',
      usage: T.RENDER_ATTACHMENT }), width * height * 4, 'texture');
    colorView = track(colorTexture.createView());
    depthView = track(depthTexture.createView());
  };

  // Device error scopes are a device-wide stack. Serialize async pipeline setup;
  // frame scopes below close synchronously before awaiting readback.
  const previousInitialization = deviceInitializations.get(device) ?? Promise.resolve();
  let releaseInitialization;
  const initializationLock = new Promise(resolve => { releaseInitialization = resolve; });
  deviceInitializations.set(device, previousInitialization.then(() => initializationLock));
  await previousInitialization;
  device.pushErrorScope('validation');
  let startupFailure;
  let positionBuffer, colorBuffer, visibleBuffer, indirectBuffer, cameraBuffer;
  let meshes, computePipeline, renderPipeline, computeBindGroup, renderBindGroup, lodBindGroups;
  try {
    positionBuffer = buffer('nerva/positions', capacity * 16, B.STORAGE | B.COPY_DST);
    colorBuffer = buffer('nerva/materials', capacity * 16, B.STORAGE | B.COPY_DST);
    visibleBuffer = buffer('nerva/visible-ids', capacity * 3 * 4, B.STORAGE | B.COPY_SRC);
    cameraBuffer = buffer('nerva/camera', CAMERA_BYTES, B.UNIFORM | B.COPY_DST);
    if (profile && device.features?.has('timestamp-query')) {
      querySet = track(device.createQuerySet({ label: 'nerva/pass-timestamps', type: 'timestamp', count: 4 }));
      queryResolveBuffer = buffer('nerva/timestamps-resolve', 32, B.QUERY_RESOLVE | B.COPY_SRC);
      queryReadback = buffer('nerva/timestamps-readback', 32, B.COPY_DST | B.MAP_READ);
    }
    meshes = LOD_SEGMENTS.map(([longitudes, latitudes], index) => {
      const mesh = sphereMesh(longitudes, latitudes);
      return { vertex: buffer(`nerva/lod${index}-vertices`, mesh.vertices.byteLength, B.VERTEX, mesh.vertices),
        index: buffer(`nerva/lod${index}-indices`, mesh.indices.byteLength, B.INDEX, mesh.indices),
        indexCount: mesh.indices.length, triangleCount: mesh.triangleCount };
    });
    const initialArguments = new Uint32Array(15);
    meshes.forEach((mesh, index) => { initialArguments[index * 5] = mesh.indexCount; });
    indirectBuffer = buffer('nerva/indirect-draws', INDIRECT_BYTES,
      B.STORAGE | B.INDIRECT | B.COPY_SRC | B.COPY_DST, initialArguments);
    const cameraBinding = { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'uniform', minBindingSize: CAMERA_BYTES } };
    const computeLayout = track(device.createBindGroupLayout({ label: 'nerva/cull-layout', entries: [cameraBinding,
      { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }] }));
    const drawLayout = track(device.createBindGroupLayout({ label: 'nerva/draw-layout', entries: [
      { ...cameraBinding, visibility: STAGE.VERTEX },
      ...[1, 2, 3].map(binding => ({ binding, visibility: STAGE.VERTEX, buffer: { type: 'read-only-storage' } }))] }));
    const lodLayout = track(device.createBindGroupLayout({ label: 'nerva/lod-layout', entries: [
      { binding: 0, visibility: STAGE.VERTEX, buffer: { type: 'uniform', minBindingSize: 16 } }] }));
    const computeModule = track(await checkedShader(device, cullWGSL, 'nerva/cull-shader'));
    const drawModule = track(await checkedShader(device, drawWGSL, 'nerva/draw-shader'));
    computePipeline = track(await device.createComputePipelineAsync({ label: 'nerva/cull-pipeline',
      layout: track(device.createPipelineLayout({ bindGroupLayouts: [computeLayout] })),
      compute: { module: computeModule, entryPoint: 'cull' } }));
    renderPipeline = track(await device.createRenderPipelineAsync({ label: 'nerva/draw-pipeline',
      layout: track(device.createPipelineLayout({ bindGroupLayouts: [drawLayout, lodLayout] })),
      vertex: { module: drawModule, entryPoint: 'vertexMain', buffers: [{ arrayStride: 24,
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }] },
      fragment: { module: drawModule, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list', frontFace: 'cw', cullMode: 'back' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' } }));
    const group = (label, layout, buffers) => track(device.createBindGroup({ label, layout,
      entries: buffers.map((resource, binding) => ({ binding, resource: { buffer: resource } })) }));
    computeBindGroup = group('nerva/cull-group', computeLayout, [cameraBuffer, positionBuffer, visibleBuffer, indirectBuffer]);
    renderBindGroup = group('nerva/draw-group', drawLayout, [cameraBuffer, positionBuffer, colorBuffer, visibleBuffer]);
    lodBindGroups = meshes.map((_, index) => group(`nerva/lod${index}-group`, lodLayout,
      [buffer(`nerva/lod${index}-uniform`, 16, B.UNIFORM, new Uint32Array([index, 0, 0, 0]))]));
    createTargets();
    const bytes = upload(positionBuffer, 0, scene.positions) + upload(colorBuffer, 0, scene.colors);
    sceneUploadBytesTotal += bytes;
    scene.consumeDirtyRanges();
    uploadedRevision = scene.revision;
  } catch (error) {
    startupFailure = error;
  }
  let startupValidation;
  try { startupValidation = await device.popErrorScope(); }
  catch (error) { startupFailure ??= error; }
  releaseInitialization();
  if (startupFailure || startupValidation) {
    for (const resource of [...resources.keys()]) release(resource);
    sceneOwners.delete(scene);
    if (ownsDevice) device.destroy();
    throw startupFailure ?? new Error(`WebGPU startup validation: ${startupValidation.message}`);
  }

  // Reuse uniform storage; the u32 count/capacity share an explicitly aligned block.
  const cameraData = new ArrayBuffer(CAMERA_BYTES);
  const cameraFloats = new Float32Array(cameraData);
  const cameraIntegers = new Uint32Array(cameraData);
  cameraFloats.set([1, 0, 0, 0], 4);
  cameraFloats.set([0, 1, 0, 0], 8);
  cameraFloats.set([0, 0, 1, 0], 12);
  cameraIntegers[24] = scene.count;
  cameraIntegers[25] = capacity;

  function updateScene() {
    assertLive();
    if (scene.revision === uploadedRevision) return { bytes: 0, ranges: [], revision: uploadedRevision };
    const changes = scene.consumeDirtyRanges();
    let bytes = 0;
    // Defensive fallback for an unexpectedly empty dirty list. This is not a
    // multi-consumer journal: outside consumption violates the ownership contract.
    const ranges = changes.ranges.length ? changes.ranges : (scene.count ? [{ first: 0, count: scene.count }] : []);
    for (const { first, count } of ranges) {
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 0 || first + count > scene.count)
        throw new RangeError('Invalid dirty instance range');
      bytes += upload(positionBuffer, first * 16, scene.positions, first * 4, count * 4);
      bytes += upload(colorBuffer, first * 16, scene.colors, first * 4, count * 4);
    }
    sceneUploadBytesTotal += bytes;
    pendingSceneBytes += bytes;
    uploadedRevision = scene.revision;
    return { bytes, ranges, revision: uploadedRevision };
  }

  function packCamera(camera) {
    if (camera !== undefined && (!camera || typeof camera !== 'object' || Array.isArray(camera)))
      throw new TypeError('camera must be an object');
    const params = cameraParameters({ ...camera, aspect: camera?.aspect ?? width / height });
    const distancesSquared = params.lodDistances.map(distance => Math.fround(distance * distance));
    const sideLengthSquaredX = Math.fround(1 + Math.fround(params.tanX * params.tanX));
    const sideLengthSquaredY = Math.fround(1 + Math.fround(params.tanY * params.tanY));
    const inverseNormX = Math.fround(1 / Math.fround(Math.sqrt(sideLengthSquaredX)));
    const inverseNormY = Math.fround(1 / Math.fround(Math.sqrt(sideLengthSquaredY)));
    const derived = [sideLengthSquaredX, sideLengthSquaredY, inverseNormX, inverseNormY,
      Math.fround(params.far / (params.far - params.near)), ...distancesSquared];
    if (derived.some(value => !Number.isFinite(value)))
      throw new RangeError('Camera projection and squared LOD distances must remain finite in Float32 GPU arithmetic');
    cameraFloats.set(params.position, 0);
    cameraFloats.set([params.tanX, params.tanY, params.near, params.far], 16);
    cameraFloats.set([width, height, ...distancesSquared], 20);
    // Normalize camera side planes once per frame, not once per GPU instance.
    cameraFloats[28] = inverseNormX;
    cameraFloats[29] = inverseNormY;
    return upload(cameraBuffer, 0, cameraFloats);
  }

  function encodeClear(encoder) {
    for (let lod = 0; lod < 3; lod++) encoder.clearBuffer(indirectBuffer, lod * 20 + 4, 4);
  }

  function encodeCull(encoder, timestamps) {
    if (scene.count === 0 && !timestamps) return;
    const pass = encoder.beginComputePass({ label: 'nerva/cull-and-lod',
      ...(timestamps ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}) });
    pass.setPipeline(computePipeline);
    pass.setBindGroup(0, computeBindGroup);
    if (scene.count) pass.dispatchWorkgroups(Math.ceil(scene.count / 128));
    pass.end();
  }

  function encodeDraw(encoder, timestamps) {
    const pass = encoder.beginRenderPass({ label: 'nerva/forward-opaque',
    ...(timestamps ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } } : {}),
    colorAttachments: [{
      view: colorView, loadOp: 'clear', storeOp: 'store',
      clearValue: { r: 0.015, g: 0.025, b: 0.045, a: 1 } }],
    depthStencilAttachment: { view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
    pass.setPipeline(renderPipeline);
    pass.setBindGroup(0, renderBindGroup);
    for (let lod = 0; lod < meshes.length; lod++) {
      pass.setBindGroup(1, lodBindGroups[lod]);
      pass.setVertexBuffer(0, meshes[lod].vertex);
      pass.setIndexBuffer(meshes[lod].index, 'uint32');
      pass.drawIndexedIndirect(indirectBuffer, lod * 20);
    }
    pass.end();
  }

  function compileFrameGraph() {
    // The planner schedules the actual GPU encoding callbacks. These allocations
    // are resident; graph allocation IDs are metadata, not physical GPU aliasing.
    const graph = new RenderGraph();
    graph.resource('camera', { size: CAMERA_BYTES, persistent: true, external: true });
    graph.resource('positions', { size: capacity * 16, persistent: true, external: true });
    graph.resource('materials', { size: capacity * 16, persistent: true, external: true });
    graph.resource('meshes', { size: meshes.reduce((sum, mesh) => sum + mesh.vertex.size + mesh.index.size, 0),
      persistent: true, external: true });
    graph.resource('indirect', { size: INDIRECT_BYTES, persistent: true });
    graph.resource('visible', { size: capacity * 12, persistent: true });
    graph.resource('color', { size: width * height * 4, persistent: true, kind: format });
    graph.resource('depth', { size: width * height * 4, persistent: true, kind: 'depth24plus-estimate' });
    graph.pass('clear-counts', { writes: ['indirect'], execute: ({ encoder }) => encodeClear(encoder) });
    graph.pass('cull-and-lod', { reads: ['camera', 'positions', 'indirect'], writes: ['indirect', 'visible'],
      execute: ({ encoder, timestamps }) => encodeCull(encoder, timestamps) });
    graph.pass('forward-opaque', { reads: ['camera', 'positions', 'materials', 'meshes', 'indirect', 'visible'],
      writes: ['color', 'depth'], execute: ({ encoder, timestamps }) => encodeDraw(encoder, timestamps) });
    return graph.compile();
  }
  let frameGraph = compileFrameGraph();

  async function collectVisibility() {
    let countsMapped = false, visibleMapped = false;
    try {
      await countsReadback.mapAsync(READ); countsMapped = true;
      const args = new Uint32Array(countsReadback.getMappedRange());
      const counts = [args[1], args[6], args[11]];
      if (counts.some(count => count > scene.count) || counts.reduce((sum, count) => sum + count, 0) > scene.count)
        throw new Error('GPU returned an invalid visible count');
      await visibleReadback.mapAsync(READ); visibleMapped = true;
      const visibleData = new Uint32Array(visibleReadback.getMappedRange());
      const visibleByLOD = counts.map((count, lod) => visibleData.slice(lod * capacity, lod * capacity + count));
      const visibleIDs = new Uint32Array(counts.reduce((sum, count) => sum + count, 0));
      const lods = new Uint32Array(visibleIDs.length);
      let offset = 0;
      visibleByLOD.forEach((ids, lod) => { visibleIDs.set(ids, offset); lods.fill(lod, offset, offset + ids.length); offset += ids.length; });
      return { counts, countsGPU: counts, visibleIDs, visibleByLOD, visible: visibleIDs, lods,
        visibleCount: visibleIDs.length,
        triangleCount: counts.reduce((sum, count, lod) => sum + count * meshes[lod].triangleCount, 0),
        allHighDetailTriangleCount: visibleIDs.length * meshes[0].triangleCount };
    } finally {
      if (countsMapped) countsReadback.unmap();
      if (visibleMapped) visibleReadback.unmap();
    }
  }

  async function collectCapture() {
    let mapped = false;
    try {
      await captureBuffer.mapAsync(READ); mapped = true;
      const source = new Uint8Array(captureBuffer.getMappedRange());
      const rgba = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row++) rgba.set(source.subarray(row * captureRowBytes, row * captureRowBytes + width * 4), row * width * 4);
      if (format === 'bgra8unorm') for (let offset = 0; offset < rgba.length; offset += 4) {
        const red = rgba[offset]; rgba[offset] = rgba[offset + 2]; rgba[offset + 2] = red;
      }
      return rgba;
    } finally { if (mapped) captureBuffer.unmap(); }
  }

  async function collectTimestamps() {
    let mapped = false;
    try {
      await queryReadback.mapAsync(READ); mapped = true;
      const timestamps = new BigUint64Array(queryReadback.getMappedRange());
      if (timestamps[1] < timestamps[0] || timestamps[3] < timestamps[2] || timestamps[3] < timestamps[0])
        throw new Error('GPU returned non-monotonic pass timestamps');
      // The WebGPU timestamp-query result is expressed in nanoseconds. Browser
      // security quantization can make very short pass durations read as zero.
      const gpuPassTimesMs = {
        cullAndLOD: Number(timestamps[1] - timestamps[0]) / 1e6,
        forwardOpaque: Number(timestamps[3] - timestamps[2]) / 1e6,
      };
      return { gpuPassTimesMs, gpuTimeMs: gpuPassTimesMs.cullAndLOD + gpuPassTimesMs.forwardOpaque,
        gpuMeasuredSpanMs: Number(timestamps[3] - timestamps[0]) / 1e6, gpuTimestampStatus: 'measured' };
    } finally { if (mapped) queryReadback.unmap(); }
  }

  async function render(camera, { readback = true, capture = false } = {}) {
    assertLive();
    if (typeof readback !== 'boolean' || typeof capture !== 'boolean')
      throw new TypeError('readback and capture must be booleans');
    if (busy) throw new Error('Await the current render before submitting another frame');
    busy = true;
    device.pushErrorScope('validation');
    let failure, result, validationPromise;
    const started = now();
    const resourcesBefore = resourceCreateCount;
    try {
      updateScene();
      const uniformUploadBytes = packCamera(camera);
      if (readback) ensureReadback();
      if (capture) ensureCapture();
      const encoder = device.createCommandEncoder({ label: `nerva/frame${frames}` });
      const timestamps = Boolean(querySet && readback);
      const renderGraphPasses = frameGraph.execute({ encoder, timestamps });
      if (readback) {
        encoder.copyBufferToBuffer(indirectBuffer, 0, countsReadback, 0, INDIRECT_BYTES);
        encoder.copyBufferToBuffer(visibleBuffer, 0, visibleReadback, 0, capacity * 3 * 4);
      }
      if (capture) encoder.copyTextureToBuffer({ texture: colorTexture },
        { buffer: captureBuffer, bytesPerRow: captureRowBytes, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
      if (timestamps) {
        encoder.resolveQuerySet(querySet, 0, 4, queryResolveBuffer, 0);
        encoder.copyBufferToBuffer(queryResolveBuffer, 0, queryReadback, 0, 32);
      }
      device.queue.submit([encoder.finish()]);
      // Pop before the first await: concurrent renderers cannot cross their
      // device-wide scope stack while their own buffers are being mapped.
      validationPromise = device.popErrorScope();
      const cpuEncodeMs = now() - started;
      result = { frame: ++frames, width, height, instanceCount: scene.count, drawCalls: 3, readback, capture,
        cpuEncodeMs, gpuTimeMs: null, gpuPassTimesMs: null, gpuMeasuredSpanMs: null,
        gpuTimestampStatus: !profile ? 'disabled' : !querySet ? 'unavailable' : !readback ? 'not-requested-this-frame' : 'pending',
        timingScope: 'CPU encode and queue submission; excludes GPU completion',
        gpuTimingScope: 'GPU compute and render pass sum; excludes uploads, count reset, readbacks and CPU submission',
        sceneUploadBytes: pendingSceneBytes, uniformUploadBytes,
        uploadsBytesPerFrame: pendingSceneBytes + uniformUploadBytes,
        uploadBytesPerFrame: pendingSceneBytes + uniformUploadBytes,
        totalUploadBytes, sceneUploadBytesTotal, bufferBytes, textureBytesEstimate,
        allocatedBytesEstimate: bufferBytes + textureBytesEstimate,
        resourceCreateCount, resourceCreationsThisFrame: resourceCreateCount - resourcesBefore,
        renderGraphPasses, renderGraphMemory: frameGraph.memory,
        lodTriangleCounts: meshes.map(mesh => mesh.triangleCount),
        counts: null, countsGPU: null, visibleCount: null, triangleCount: null, allHighDetailTriangleCount: null };
      pendingSceneBytes = 0;
      if (readback) Object.assign(result, await collectVisibility());
      if (capture) result.rgba = await collectCapture();
      if (timestamps) Object.assign(result, await collectTimestamps());
    } catch (error) { failure = error; }
    let validation;
    try { validation = await (validationPromise ?? device.popErrorScope()); }
    catch (error) { failure ??= error; }
    busy = false;
    if (failure) throw failure;
    if (validation) throw new Error(`WebGPU frame validation: ${validation.message}`);
    latest = result;
    return result;
  }

  function resize(nextWidth, nextHeight) {
    assertLive();
    if (busy) throw new Error('Await the current render before resizing');
    dimension(nextWidth, 'width'); dimension(nextHeight, 'height');
    if (nextWidth > maxDimension || nextHeight > maxDimension) throw new RangeError('Render size exceeds device texture limits');
    if (nextWidth === width && nextHeight === height) return;
    release(colorView); release(depthView); release(colorTexture); release(depthTexture); release(captureBuffer);
    captureBuffer = undefined;
    width = nextWidth; height = nextHeight;
    createTargets();
    frameGraph = compileFrameGraph();
  }

  function dispose() {
    if (disposed) return;
    if (busy) throw new Error('Await the current render before disposing');
    for (const resource of [...resources.keys()]) release(resource);
    sceneOwners.delete(scene);
    // Pipelines/bind groups have no explicit WebGPU destroy method; remove our
    // references so retaining a disposed renderer cannot keep them alive.
    meshes = computePipeline = renderPipeline = computeBindGroup = renderBindGroup = lodBindGroups = undefined;
    positionBuffer = colorBuffer = visibleBuffer = indirectBuffer = cameraBuffer = undefined;
    colorTexture = depthTexture = colorView = depthView = captureBuffer = undefined;
    countsReadback = visibleReadback = querySet = queryResolveBuffer = queryReadback = undefined;
    frameGraph = undefined;
    if (ownsDevice) device.destroy();
    disposed = true;
  }

  return Object.freeze({ render, updateScene, resize, dispose,
    get statistics() { return { ...latest, frames, width, height, instanceCount: scene.count, disposed, ownsDevice,
      totalUploadBytes, sceneUploadBytesTotal, bufferBytes, textureBytesEstimate,
      allocatedBytesEstimate: bufferBytes + textureBytesEstimate, resourceCreateCount }; },
    // Exposed for host canvas presentation, not transferred through NERVA's JSON API.
    get colorTexture() { assertLive(); return colorTexture; },
  });
}
