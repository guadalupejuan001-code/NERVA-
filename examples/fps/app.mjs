import { prepareProgram, VERSION } from '../../src/runtime.mjs';
import { createFirstPersonController } from '../../src/graphics/camera.mjs';
import { createFPSRenderer } from '../../src/graphics/fps-renderer.mjs';
import { loadGLTF, createGLTFAnimator } from '../../src/graphics/gltf.mjs';
import { buildFPSDescription, createNPCState } from './author.mjs';
import { FPS_QUALITY_PRESETS as presets, fpsRenderSettings } from './quality.mjs';

const byId = id => document.getElementById(id);
const canvas = byId('scene'), keys = new Set();
const assert = (value, message) => { if (!value) throw new Error(message); };
let quality = new URLSearchParams(location.search).get('quality') ?? 'high';
if (!presets[quality]) quality = 'high';
byId('quality').value = quality;
let device, renderer, controller, controlProgram, description, world, context;
let characterAsset, characterAnimator;
const characterPlacement = new Float32Array(16), characterTransform = new Float32Array(16);
let characterPose, resizeRequest;
let mission = { scanned: false }, playing = false, frameCount = 0, pointerLocked = false;
let lookDX = 0, lookDY = 0, interact = false, effectsActive = true, lastStats, runningFrame;
let adapterInfo, softwareAdapter = false, timestampFeature = false;
let logicSteps = 0, lastFrameTime = 0, benchmarkRunning = false;
let readyForInput = false, uiActions = Promise.resolve(), uiActionCount = 0;
let frameQueue = Promise.resolve(), animationGeneration = 0, animationRequest;
let deviceLost = null;
const gpuUncapturedErrors = [];

function refreshControls() {
  const disabled = !readyForInput || uiActionCount > 0 || benchmarkRunning || Boolean(deviceLost);
  for (const id of ['enter', 'effects', 'quality', 'character']) if (byId(id)) byId(id).disabled = disabled;
}
refreshControls();

const summarize = stats => {
  const { rgba, ...small } = stats;
  return small;
};
const effects = () => effectsActive ? { shadows: true, reflections: true, bloom: true, ao: true }
  : { shadows: false, reflections: false, bloom: false, ao: false };
const camera = () => ({ ...controller.camera, aspect: canvas.width / canvas.height, fovY: 1.15, far: 100 });

function characterFrame(time) {
  const npc = mission.npc;
  const pose = characterAnimator.sample(time, { animation: npc.state === 'walking' ? 'walk' : 'idle', loop: true });
  const cosine = Math.cos(npc.yaw), sine = Math.sin(npc.yaw);
  characterPlacement.fill(0);
  characterPlacement[0] = cosine; characterPlacement[2] = -sine;
  characterPlacement[5] = 1; characterPlacement[8] = sine; characterPlacement[10] = cosine;
  characterPlacement[12] = npc.position[0]; characterPlacement[13] = npc.position[1];
  characterPlacement[14] = npc.position[2]; characterPlacement[15] = 1;
  // glTF matrices and GPU uniforms are column-major. Keep the mesh-node
  // transform separate from the palette, which is already mesh-local.
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let value = 0;
    for (let inner = 0; inner < 4; inner++) value += characterPlacement[inner * 4 + row] * pose.meshWorld[column * 4 + inner];
    characterTransform[column * 4 + row] = value;
  }
  characterPose = pose.palette;
  return { characterPose, characterTransform };
}

const renderSettings = () => fpsRenderSettings(quality, { width: canvas.clientWidth || innerWidth,
  height: canvas.clientHeight || innerHeight, devicePixelRatio: window.devicePixelRatio || 1 });

function mutateRenderer(action) {
  const task = frameQueue.then(action);
  frameQueue = task.catch(() => {});
  return task;
}

function input() {
  const value = { forward: Number(keys.has('KeyW')) - Number(keys.has('KeyS')),
    strafe: Number(keys.has('KeyD')) - Number(keys.has('KeyA')), sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    jump: keys.has('Space'), lookDX, lookDY, interact };
  lookDX = lookDY = 0; interact = false;
  return value;
}

function runLogic(control, dt) {
  const start = performance.now();
  const result = controlProgram.run({ inputs: { control, dt, mission }, captureGlobals: false,
    host: { move: (movement, elapsed) => controller.step(movement, elapsed),
      status: value => { mission = value; byId('objective').textContent = value.message; return null; } } });
  logicSteps += result.steps;
  updateNPCBlocker();
  return { steps: result.steps, cpuLogicMs: performance.now() - start };
}

function updateNPCBlocker() {
  const [x, y, z] = mission.npc.position;
  controller.setDynamicColliders([{ min: [x - 0.35, y, z - 0.3], max: [x + 0.35, y + 1.8, z + 0.3] }]);
}

function renderFrame({ capture = false, readback = false, time = mission.npc?.elapsed ?? 0, selectedEffects = effects() } = {}) {
  const task = frameQueue.then(async () => {
    const animationStart = performance.now();
    const characterOptions = characterFrame(time);
    const cpuAnimationMs = performance.now() - animationStart;
    const stats = await renderer.render(camera(), { capture, readback, time, effects: selectedEffects, ...characterOptions });
    stats.cpuAnimationMs = cpuAnimationMs;
    renderer.present(context);
    lastStats = stats;
    frameCount++;
    if (!byId('diagnostics').hidden) byId('diagnostics').textContent = JSON.stringify({
      adapter: adapterInfo, softwareAdapter, render: summarize(stats), nervaStepsTotal: logicSteps,
    }, null, 2);
    return stats;
  });
  frameQueue = task.catch(() => {});
  runningFrame = task;
  return task.finally(() => { if (runningFrame === task) runningFrame = undefined; });
}

function scheduleAnimation(generation) {
  animationRequest = requestAnimationFrame(timestamp => animation(timestamp, generation));
}

async function animation(timestamp, generation) {
  if (!playing || benchmarkRunning || generation !== animationGeneration) return;
  animationRequest = undefined;
  const dt = lastFrameTime ? Math.min((timestamp - lastFrameTime) / 1000, 0.25) : 1 / 60;
  lastFrameTime = timestamp;
  try { runLogic(input(), dt); await renderFrame(); }
  catch (error) { pause(); reportError(error); }
  if (playing && !benchmarkRunning && generation === animationGeneration) scheduleAnimation(generation);
}

function reportError(error) {
  byId('status').textContent = error.message;
  byId('loading').textContent = error.message;
  byId('loading').hidden = false;
}

function clearInput() { keys.clear(); lookDX = lookDY = 0; interact = false; }
function pause() {
  playing = false; lastFrameTime = 0; clearInput();
  animationGeneration++;
  if (animationRequest !== undefined) cancelAnimationFrame(animationRequest);
  animationRequest = undefined;
  document.exitPointerLock?.();
  byId('enter').textContent = 'CONTINUAR';
}

function queueAction(action) {
  uiActionCount++; refreshControls();
  const task = uiActions.then(async () => {
    await window.fpsReady;
    if (benchmarkRunning || deviceLost) return;
    await action();
  });
  // Event listeners consume failures here, including initialization failures.
  uiActions = task.catch(error => { pause(); reportError(error); });
  return uiActions.finally(() => { uiActionCount--; refreshControls(); });
}

async function setupRenderer() {
  const preset = renderSettings();
  renderer = await createFPSRenderer({ device, world, ...preset, characterAsset, ...characterFrame(mission.npc.elapsed),
    format: navigator.gpu.getPreferredCanvasFormat(), profile: timestampFeature });
  canvas.width = preset.width; canvas.height = preset.height;
  context = canvas.getContext('webgpu');
  context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
}

window.getFpsState = () => ({ ...(controller?.state ?? {}), frameCount, pointerLocked, keys: [...keys],
  playing, quality, mission: structuredClone(mission), logicSteps, width: canvas.width, height: canvas.height,
  deviceLost, gpuUncapturedErrors: [...gpuUncapturedErrors], pendingUIActions: uiActionCount,
  antialiasing: { msaaSamples: presets[quality].sampleCount, fxaa: presets[quality].fxaa },
  resolutionScale: canvas.width / Math.max(1, canvas.clientWidth * (window.devicePixelRatio || 1)),
  npc: mission.npc ? { name: mission.npc.name, state: mission.npc.state, position: [...mission.npc.position],
    spoken: mission.npc.spoken, animation: mission.npc.state === 'walking' ? 'walk' : 'idle' } : null });

window.getNpcState = () => mission.npc ? { name: mission.npc.name, position: [...mission.npc.position],
  state: mission.npc.state, animation: mission.npc.state === 'walking' ? 'walk' : 'idle',
  dialogue: mission.npc.dialogue, spoken: mission.npc.spoken, interactionCount: mission.npc.interactionCount,
  jointCount: characterAsset?.jointCount ?? 0, animationTime: mission.npc.elapsed,
  boneUploadBytesLastFrame: lastStats?.boneUploadBytes ?? 0, frameCount } : null;

window.fpsReady = (async () => {
  assert(navigator.gpu, 'WebGPU no está disponible en este navegador');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  assert(adapter, 'No hay un adaptador WebGPU disponible');
  const info = adapter.info ?? {};
  adapterInfo = Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter'].map(key => [key, info[key] ?? null]));
  softwareAdapter = /swiftshader|llvmpipe|software/i.test(Object.values(adapterInfo).join(' '));
  timestampFeature = adapter.features.has('timestamp-query');
  device = await adapter.requestDevice({ requiredFeatures: timestampFeature ? ['timestamp-query'] : [] });
  device.addEventListener('uncapturederror', event => {
    gpuUncapturedErrors.push(event.error.message);
    pause(); reportError(event.error);
  });
  device.lost.then(info => {
    deviceLost = { reason: info.reason, message: info.message };
    pause(); refreshControls();
    reportError(new Error(`Dispositivo gráfico perdido (${info.reason}): ${info.message || 'el controlador dejó de responder'}`));
  }).catch(error => { pause(); reportError(error); });
  const sources = await Promise.all(['scene.nv', 'control.nv'].map(async name => {
    const response = await fetch(`./${name}`);
    assert(response.ok, `No se pudo cargar ${name}`);
    return response.text();
  }));
  const authored = buildFPSDescription(sources[0]);
  description = authored.description; world = authored.world;
  mission = { scanned: false, npc: createNPCState(description.character) };
  characterAsset = await loadGLTF(new URL(description.character.url, location.href).href);
  characterAnimator = createGLTFAnimator(characterAsset, { animation: 'idle', loop: true });
  controlProgram = prepareProgram(sources[1], { filename: 'control.nv' });
  controller = createFirstPersonController({ ...world.spawn, colliders: world.colliders,
    bounds: { min: [-7.5, world.floorY, -7.5], max: [7.5, 7.2, 43.5] } });
  await setupRenderer();
  await renderFrame({ time: 0 });
  byId('loading').hidden = true;
  byId('status').textContent = softwareAdapter ? 'Adaptador de software · el rendimiento depende del equipo' : 'Instalación lista para explorar';
  readyForInput = true; refreshControls();
  return { sceneInterpreterSteps: authored.interpreterSteps, objectCount: world.count, lightCount: world.lightCount,
    character: { name: description.character.name, jointCount: characterAsset.jointCount,
      vertices: characterAsset.primitives.reduce((sum, primitive) => sum + primitive.vertexCount, 0),
      triangles: characterAsset.primitives.reduce((sum, primitive) => sum + primitive.indexCount / 3, 0),
      animations: characterAsset.animations.map(animation => animation.name), bytes: characterAsset.byteLength } };
})().catch(error => { reportError(error); throw error; });
// The explicit readiness promise is also consumed by the automated harness.
window.fpsReady.catch(() => {});

byId('enter').addEventListener('click', () => queueAction(async () => {
    await canvas.requestPointerLock();
    if (!playing) { playing = true; lastFrameTime = 0; scheduleAnimation(++animationGeneration); }
    byId('enter').textContent = 'EXPLORANDO';
}));
canvas.addEventListener('click', () => { if (!pointerLocked && !benchmarkRunning) byId('enter').click(); });
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  if (!pointerLocked) pause();
});
document.addEventListener('mousemove', event => { if (pointerLocked) { lookDX += event.movementX; lookDY += event.movementY; } });
document.addEventListener('keydown', event => {
  if (event.code === 'Escape') { pause(); return; }
  if (!pointerLocked) return;
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyE'].includes(event.code)) {
    event.preventDefault(); keys.add(event.code);
    if (event.code === 'KeyE' && !event.repeat) interact = true;
  }
});
document.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', pause);
byId('stats').addEventListener('click', () => {
  byId('diagnostics').hidden = !byId('diagnostics').hidden;
  if (lastStats) byId('diagnostics').textContent = JSON.stringify({ adapter: adapterInfo, softwareAdapter, ...summarize(lastStats) }, null, 2);
});
byId('effects').addEventListener('click', () => queueAction(async () => {
  effectsActive = !effectsActive;
  byId('effects').textContent = effectsActive ? 'Efectos activos' : 'Efectos desactivados';
  if (!playing && !benchmarkRunning) await renderFrame();
}));
byId('quality').addEventListener('change', () => {
  const requestedQuality = byId('quality').value;
  return queueAction(async () => {
  pause();
  quality = requestedQuality;
  await mutateRenderer(async () => { renderer.dispose(); await setupRenderer(); });
  await renderFrame();
  });
});

// A resize changes render targets once, behind the same GPU queue as frames.
// The scene, mesh buffers and skinning palette remain resident.
function queueViewportResize() {
  if (resizeRequest !== undefined) cancelAnimationFrame(resizeRequest);
  resizeRequest = requestAnimationFrame(() => {
    resizeRequest = undefined;
    if (!readyForInput || benchmarkRunning || deviceLost) return;
    queueAction(async () => {
      const next = renderSettings();
      if (next.width === canvas.width && next.height === canvas.height) return;
      await mutateRenderer(() => { renderer.resize(next.width, next.height); canvas.width = next.width; canvas.height = next.height; });
      if (!playing) await renderFrame();
    });
  });
}
window.addEventListener('resize', queueViewportResize);
if (globalThis.ResizeObserver) new ResizeObserver(queueViewportResize).observe(canvas);

window.inspectCharacter = () => queueAction(async () => {
  pause();
  const npc = mission.npc;
  controller.reset({ position: [npc.position[0], npc.position[1] + 1.7, npc.position[2] - 1.9], yaw: 0, pitch: -0.16 });
  runLogic({ forward: 0, strafe: 0, sprint: false, jump: false, lookDX: 0, lookDY: 0, interact: false }, 0);
  await renderFrame({ time: 0 });
});
byId('character')?.addEventListener('click', () => { window.inspectCharacter(); });

function imageDifference(a, b) {
  assert(a.length === b.length, 'Capture sizes differ');
  let sum = 0, changed = 0;
  for (let index = 0; index < a.length; index++) {
    if (index % 4 === 3) continue;
    const difference = Math.abs(a[index] - b[index]);
    sum += difference;
    if (difference > 2) changed++;
  }
  return { changedChannels: changed, meanAbsoluteDifference: sum / (a.length / 4 * 3) };
}

window.runEngineBenchmark = async () => {
  const ready = await window.fpsReady;
  assert(!benchmarkRunning, 'An FPS benchmark is already running');
  benchmarkRunning = true; refreshControls();
  pause();
  try {
    await uiActions;
    if (runningFrame) await runningFrame;
    controller.reset();
    const baseline = await renderFrame({ capture: true, readback: true, time: 0 });
    assert(baseline.rgba.length === canvas.width * canvas.height * 4, 'Invalid RGBA dimensions');
    assert(baseline.rgba.some((value, index) => index % 4 !== 3 && value > 30), 'Empty first-person render');
    const differences = {};
    for (const effect of ['shadows', 'reflections', 'bloom', 'ao']) {
      const toggled = { shadows: true, reflections: true, bloom: true, ao: true, [effect]: false };
      const image = await renderFrame({ capture: true, readback: true, time: 0, selectedEffects: toggled });
      differences[effect] = imageDifference(baseline.rgba, image.rgba);
      assert(differences[effect].changedChannels > 10, `${effect} has no visible effect`);
    }
    const steady = [];
    for (let index = 0; index < 3; index++) steady.push(summarize(await renderFrame({ time: 0 })));
    assert(steady.every(frame => frame.resourceCreationsThisFrame === 0 && frame.sceneUploadBytes === 0), 'Steady FPS frames recreate resources or upload scene');
    const before = controller.state;
    const logic = runLogic({ forward: 1, strafe: 0, sprint: false, jump: false, lookDX: 40, lookDY: -12, interact: false }, 0.1);
    assert(controller.state.position[2] > before.position[2] && controller.state.yaw !== before.yaw, 'NERVA movement/look did not run');
    const movedFrame = await renderFrame({ capture: true, readback: true, time: 0 });
    const cameraRendering = imageDifference(baseline.rgba, movedFrame.rgba);
    assert(cameraRendering.changedChannels > 100, 'Moving the FPS camera did not change the rendered image');
    controller.reset({ position: [0, 1.7, 29.9], yaw: 0, pitch: 0 });
    runLogic({ forward: 0, strafe: 0, sprint: false, jump: false, lookDX: 0, lookDY: 0, interact: true }, 0);
    assert(mission.scanned, 'NERVA mission interaction failed');
    controller.reset(); mission = { scanned: false, npc: createNPCState(description.character) };
    runLogic({ forward: 0, strafe: 0, sprint: false, jump: false, lookDX: 0, lookDY: 0, interact: false }, 0);
    const final = await renderFrame({ capture: true, readback: true, time: 0 });
    assert(gpuUncapturedErrors.length === 0, 'WebGPU reported an uncaptured rendering error');
    assert(deviceLost === null, 'The WebGPU device was lost during rendering');
    byId('status').textContent = softwareAdapter ? 'WebGPU verificado · adaptador de software' : 'Escena y controles verificados';
    return { verified: true, nervaVersion: VERSION, adapter: adapterInfo, softwareAdapter,
      physicalGPUPerformanceValidated: false, quality, resolution: { width: canvas.width, height: canvas.height },
      antialiasing: { msaaSamples: presets[quality].sampleCount, fxaa: presets[quality].fxaa },
      ...ready, worldBytes: world.byteLength, colliderCount: world.colliders.length, batches: world.batches,
      baseline: summarize(baseline), steadyFrames: steady, final: summarize(final),
      gpuUncapturedErrors: [...gpuUncapturedErrors], deviceLost,
      tests: { effects: differences, persistentResources: true, browserNerva: true, movement: logic, cameraRendering, missionInteraction: true },
      scope: 'Real WebGPU first-person rendering and live NERVA logic. Software adapter timings do not establish physical GPU FPS or AAA asset quality.' };
  } finally { benchmarkRunning = false; refreshControls(); }
};
