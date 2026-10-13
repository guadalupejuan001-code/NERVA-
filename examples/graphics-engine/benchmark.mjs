import { createScene, cullScene, defaultCamera, createWebGPURenderer } from '../../src/graphics/index.mjs';

const element = id => document.getElementById(id);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const number = value => value.toLocaleString('es');
const summarize = stats => {
  const { visibleIDs, visibleByLOD, visible, lods, rgba, ...small } = stats;
  return small;
};

function assertVisibility(scene, camera, actual) {
  const expected = cullScene(scene, camera);
  assert(expected.counts.every((value, lod) => value === actual.countsGPU[lod]), 'CPU/GPU LOD counts differ');
  assert(expected.visible.length === actual.visibleIDs.length, 'CPU/GPU visible lengths differ');
  const expectedLOD = new Map(Array.from(expected.visible, (id, index) => [id, expected.lods[index]]));
  const seen = new Set();
  for (let index = 0; index < actual.visibleIDs.length; index++) {
    const id = actual.visibleIDs[index];
    assert(!seen.has(id), `GPU emitted duplicate instance ${id}`);
    assert(expectedLOD.get(id) === actual.lods[index], `CPU/GPU visibility or LOD mismatch for ${id}`);
    seen.add(id);
  }
  return { verified: true, visibleCount: seen.size, lodCounts: expected.counts };
}

function showImage(stats) {
  assert(stats.rgba.length === stats.width * stats.height * 4, 'Incorrect capture dimensions');
  const canvas = element('scene');
  canvas.width = stats.width; canvas.height = stats.height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(stats.rgba), stats.width, stats.height), 0, 0);
}

async function run() {
  element('run').disabled = true;
  element('status').textContent = 'Validando shaders, visibilidad, persistencia y escenas exigentes…';
  const gpu = navigator.gpu;
  assert(gpu, 'WebGPU no está disponible en este navegador');
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  assert(adapter, 'No hay adaptador WebGPU');
  const rawInfo = adapter.info ?? {};
  const adapterInfo = Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter']
    .map(key => [key, rawInfo[key] ?? null]));
  const softwareAdapter = /swiftshader|llvmpipe|software/i.test(Object.values(adapterInfo).join(' '));
  element('adapter').textContent = `${adapterInfo.architecture || adapterInfo.description || adapterInfo.vendor || 'WebGPU'}${softwareAdapter ? ' · software' : ''}`;
  const timestampFeature = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestampFeature ? ['timestamp-query'] : [] });
  const uncapturedErrors = [];
  device.addEventListener('uncapturederror', event => uncapturedErrors.push(event.error.message));
  const active = new Set();
  const create = async options => {
    const renderer = await createWebGPURenderer({ device, profile: true, ...options });
    active.add(renderer);
    return renderer;
  };
  const dispose = renderer => { renderer.dispose(); active.delete(renderer); };
  const results = { adapter: adapterInfo, softwareAdapter, physicalGPUPerformanceValidated: false,
    timestampFeature,
    timingScope: 'CPU encoding/submission, validation wall time, and optional GPU pass timestamps are separate. GPU pass sum excludes upload/reset/readback; software adapter values do not establish physical GPU FPS.',
    frames: [], tests: {} };
  try {
    const response = await fetch('../../private/graphics-engine/commands.json');
    assert(response.ok, 'Faltan comandos: ejecuta npm run demo:engine');
    const trace = await response.json();
    assert(trace.format === 'nerva-graphics-commands' && trace.version === 1, 'Invalid command trace');
    const scenes = new Map();
    for (const command of trace.commands) {
      if (command.type === 'create_scene') {
        assert(!scenes.has(command.handle), 'Duplicate scene handle');
        const scene = createScene(command.options);
        const renderer = await create({ scene, width: trace.width, height: trace.height });
        scenes.set(command.handle, { scene, renderer });
      } else {
        const state = scenes.get(command.handle);
        assert(state, 'Unknown trace scene handle');
        if (command.type === 'update_instances') state.scene.updateInstances(command.patches);
        else if (command.type === 'render_scene') {
          const started = performance.now();
          const stats = await state.renderer.render(command.camera, { readback: true, capture: true });
          const validationWallMs = performance.now() - started;
          const parity = assertVisibility(state.scene, command.camera, stats);
          showImage(stats);
          results.frames.push({ ...summarize(stats), validationWallMs, parity });
        } else throw new Error(`Unknown command: ${command.type}`);
      }
    }
    assert(scenes.size === 1 && results.frames.length === 3, 'Expected one persistent scene and three NERVA frames');
    const state = [...scenes.values()][0];
    const [initial, edited, unchanged] = results.frames;
    assert(initial.sceneUploadBytes === 0 && edited.sceneUploadBytes === 64 && unchanged.sceneUploadBytes === 0,
      'Scene uploads must contain only the two edited instances');
    assert(unchanged.resourceCreationsThisFrame === 0, 'Static frame unexpectedly recreated GPU resources');
    if (timestampFeature) {
      assert(results.frames.every(frame => frame.gpuTimestampStatus === 'measured' && Number.isFinite(frame.gpuTimeMs) && frame.gpuTimeMs >= 0),
        'Enabled GPU timestamps were not measured correctly');
      results.tests.timestamps = { verified: true, passTimesMs: unchanged.gpuPassTimesMs, passSumMs: unchanged.gpuTimeMs };
    }
    assert(unchanged.drawCalls === 3, 'Draw calls must remain constant with instance count');
    assert(JSON.stringify(unchanged.renderGraphPasses) === JSON.stringify(['clear-counts', 'cull-and-lod', 'forward-opaque']), 'Render graph did not execute the GPU passes');
    const camera = trace.commands.filter(command => command.type === 'render_scene').at(-1).camera;
    const residentBytes = state.renderer.statistics.allocatedBytesEstimate;
    const steady = [];
    for (let index = 0; index < 3; index++) steady.push(summarize(await state.renderer.render(camera, { readback: false })));
    await device.queue.onSubmittedWorkDone();
    assert(steady.every(frame => frame.resourceCreationsThisFrame === 0 && frame.sceneUploadBytes === 0 && frame.uniformUploadBytes === 128 && frame.gpuTimeMs === null),
      'Steady frames must reuse resources and upload only camera uniforms');
    assert(state.renderer.statistics.allocatedBytesEstimate === residentBytes, 'GPU allocation grew in steady frames');
    results.tests.persistence = { verified: true, sceneCreations: scenes.size, changedInstanceBytes: edited.sceneUploadBytes,
      staticInstanceBytes: unchanged.sceneUploadBytes, uniformBytes: 128, steadyFrames: steady };
    element('instances').textContent = number(state.scene.count);
    element('visible').textContent = `${number(unchanged.visibleCount)} / ${unchanged.drawCalls}`;
    element('triangles').textContent = `${number(unchanged.triangleCount)} / ${number(unchanged.allHighDetailTriangleCount)}`;
    element('upload').textContent = '0 bytes · cámara: 128 bytes';
    dispose(state.renderer);

    // Independent plane and LOD fixtures, not only the procedural workload.
    const fixture = createScene({ count: 8, spread: 1 });
    fixture.updateInstances([
      { index: 0, position: [0, 0, 10], radius: 1 },
      { index: 1, position: [0, 0, 60], radius: 1 },
      { index: 2, position: [0, 0, 150], radius: 1 },
      { index: 3, position: [100, 0, 10], radius: 1 },
      { index: 4, position: [0, 0, -5], radius: 1 },
      { index: 5, position: [0, 0, 1000], radius: 1 },
      { index: 6, position: [9, 0, 10], radius: 2 },
      { index: 7, position: [0, 8, 10], radius: 2 },
    ]);
    const fixtureRenderer = await create({ scene: fixture, width: 64, height: 64 });
    let ownershipRejected = false;
    try { await create({ scene: fixture, width: 64, height: 64 }); }
    catch (error) { ownershipRejected = /already has a live/.test(error.message); }
    assert(ownershipRejected, 'Two renderers acquired the same dirty-tracked scene');
    const fixtureCamera = defaultCamera();
    const fixtureFrame = await fixtureRenderer.render(fixtureCamera, { readback: true, capture: true });
    results.tests.planesAndLOD = assertVisibility(fixture, fixtureCamera, fixtureFrame);
    assert(fixtureFrame.rgba.some((value, index) => index % 4 !== 3 && value > 20), 'Rendered fixture image is empty');
    fixtureRenderer.resize(257, 193);
    const resizedCamera = defaultCamera({ aspect: 257 / 193 });
    const resizedFrame = await fixtureRenderer.render(resizedCamera, { readback: true, capture: true });
    assertVisibility(fixture, resizedCamera, resizedFrame);
    assert(resizedFrame.rgba.length === 257 * 193 * 4, 'Padded capture rows were not unpacked correctly');
    results.tests.resizeAndCapture = { verified: true, width: 257, height: 193, rgbaBytes: resizedFrame.rgba.length };
    dispose(fixtureRenderer);
    assert(fixtureRenderer.statistics.bufferBytes === 0 && fixtureRenderer.statistics.textureBytesEstimate === 0, 'Dispose retained GPU allocations');
    const empty = createScene({ count: 0 });
    const emptyRenderer = await create({ scene: empty, width: 32, height: 32 });
    const emptyFrame = await emptyRenderer.render(defaultCamera(), { readback: true });
    assert(emptyFrame.visibleCount === 0, 'Empty scene rendered instances');
    dispose(emptyRenderer);
    results.tests.emptyAndDispose = { verified: true };

    // A shared device has one error-scope stack; independent renderers must
    // remain safe while startup and readback overlap.
    const twinScenes = [createScene({ count: 1 }), createScene({ count: 0 })];
    twinScenes[0].updateInstances([{ index: 0, position: [0, 0, 10] }]);
    const twins = await Promise.all(twinScenes.map(scene => create({ scene, width: 32, height: 32 })));
    const twinFrames = await Promise.all(twins.map(renderer => renderer.render(defaultCamera(), { readback: true, capture: true })));
    twinFrames.forEach((frame, index) => assertVisibility(twinScenes[index], defaultCamera(), frame));
    twins.forEach(renderer => {
      assert(renderer.statistics.ownsDevice === false, 'Shared device was marked as renderer-owned');
      dispose(renderer);
    });
    const reacquired = await create({ scene: twinScenes[0], width: 32, height: 32, profile: false });
    const unprofiled = await reacquired.render(defaultCamera(), { readback: true });
    assert(unprofiled.gpuTimeMs === null && unprofiled.gpuTimestampStatus === 'disabled', 'Disabled profiler returned timestamps');
    dispose(reacquired);
    results.tests.concurrentRenderersAndOwnership = { verified: true };

    // The adapter may offer timestamps even when this device did not enable
    // them: profiling must report that limitation rather than create invalid queries.
    const noQueryAdapter = await gpu.requestAdapter();
    assert(noQueryAdapter, 'No adapter for optional-feature validation');
    const noQueryDevice = await noQueryAdapter.requestDevice();
    try {
      const noQueryRenderer = await createWebGPURenderer({ device: noQueryDevice,
        scene: createScene({ count: 0 }), width: 32, height: 32, profile: true });
      active.add(noQueryRenderer);
      const noQueryFrame = await noQueryRenderer.render(defaultCamera(), { readback: true });
      assert(noQueryFrame.gpuTimestampStatus === 'unavailable' && noQueryFrame.gpuTimeMs === null,
        'Timestamp feature was used without device enablement');
      dispose(noQueryRenderer);
      results.tests.optionalTimestampFeature = { verified: true };
    } finally { noQueryDevice.destroy(); }

    // Stress actual compute and indirect drawing; software adapter timings are explicit.
    const stressScene = createScene({ count: 100_000, seed: 7, spread: 100 });
    const stressRenderer = await create({ scene: stressScene, width: 320, height: 180 });
    const stressCamera = defaultCamera({ aspect: 320 / 180 });
    const stressStart = performance.now();
    const stressFrame = await stressRenderer.render(stressCamera, { readback: true });
    results.tests.stress = { ...summarize(stressFrame), validationWallMs: performance.now() - stressStart,
      parity: assertVisibility(stressScene, stressCamera, stressFrame) };
    dispose(stressRenderer);
    assert(uncapturedErrors.length === 0, `Uncaptured GPU errors: ${uncapturedErrors.join('; ')}`);
    results.verified = true;
    element('validation').textContent = 'CPU/GPU coinciden · persistencia verificada';
    element('status').textContent = `${softwareAdapter ? 'Validación en GPU de software. ' : ''}100.000 instancias comprobadas. Para comparar FPS se necesita un benchmark en GPU física.`;
    element('details').textContent = JSON.stringify({ instancesStress: 100_000, visibleStress: results.tests.stress.visibleCount,
      gpuPassTimesMs: unchanged.gpuPassTimesMs, graph: unchanged.renderGraphPasses, interpreterSteps: trace.interpreterSteps }, null, 2);
    return results;
  } finally {
    for (const renderer of active) renderer.dispose();
    device.destroy();
    element('run').disabled = false;
  }
}

let running;
window.runEngineBenchmark = () => {
  if (!running) running = run().catch(error => {
    element('status').textContent = error.message;
    element('validation').textContent = 'Falló';
    throw error;
  }).finally(() => { running = undefined; });
  return running;
};
element('run').addEventListener('click', () => window.runEngineBenchmark().catch(() => {}));
