import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadProject } from '../../src/project.mjs';
import { VERSION } from '../../src/runtime.mjs';
import { createGraphicsCommandHost, createScene, cullScene, defaultCamera, getSceneMemory } from '../../src/graphics/index.mjs';

const output = fileURLToPath(new URL('../../private/graphics-engine/', import.meta.url));
await mkdir(output, { recursive: true });
const init = (await loadProject(fileURLToPath(new URL('./init.nv', import.meta.url)))).prepared;
const frame = (await loadProject(fileURLToPath(new URL('./frame.nv', import.meta.url)))).prepared;
const bridge = createGraphicsCommandHost();
const start = performance.now();
const initialization = init.run({ inputs: { settings: { count: 10_000, seed: 7, spread: 70 } },
  host: bridge.host, captureGlobals: false });
const handle = initialization.records[0].values[0].handle;
const frameSteps = [];
for (const [index, position] of [[0, 0, 0], [3, 0, 0], [3, 0, 0]].entries()) {
  const patches = index === 1 ? [
    { index: 0, position: [-2, 1, 10], radius: 1.8, color: [0.1, 0.8, 1] },
    { index: 1, position: [2, -1, 12], radius: 1.8, color: [1, 0.45, 0.1] },
  ] : [];
  const result = frame.run({ inputs: { scene_handle: handle, frame: { patches, camera: defaultCamera({ position }) } },
    host: bridge.host, captureGlobals: false });
  frameSteps.push(result.steps);
}
const commands = bridge.drain();
const trace = { format: 'nerva-graphics-commands', version: 1, nervaVersion: VERSION,
  width: 640, height: 480, commands, interpreterSteps: { init: initialization.steps, frames: frameSteps } };
await writeFile(join(output, 'commands.json'), JSON.stringify(trace, null, 2) + '\n');

const cpu = [];
for (const count of [1_000, 100_000, 1_000_000]) {
  const creationStart = performance.now();
  const scene = createScene({ count, seed: 7, spread: 100 });
  const creationMs = performance.now() - creationStart;
  const initialUploadBytes = scene.consumeDirtyRanges().bytes;
  cullScene(scene); // Warm up the reference kernel before measured repetitions.
  const samples = [];
  let reference;
  for (let iteration = 0; iteration < 5; iteration++) {
    const cullStart = performance.now();
    reference = cullScene(scene);
    samples.push(performance.now() - cullStart);
  }
  samples.sort((a, b) => a - b);
  const unchangedUploadBytes = scene.consumeDirtyRanges().bytes;
  scene.updateInstances([{ index: 0, position: [0, 0, 10] }, { index: count - 1, color: [0.1, 0.8, 1] }]);
  const partial = scene.consumeDirtyRanges();
  cpu.push({ count, sceneMemory: getSceneMemory(scene), creationMs,
    cullingMs: { min: samples[0], median: samples[2], max: samples[4], samples: 5 },
    visibleCount: reference.visible.length, lodCounts: reference.counts,
    initialUploadBytes, unchangedUploadBytes, twoInstanceUploadBytes: partial.bytes,
    ranges: partial.ranges, fullUploadBytesPerFrame: scene.byteLength });
}
const report = { version: VERSION, node: process.version, commandBytes: Buffer.byteLength(JSON.stringify(trace)),
  sceneCreations: bridge.sceneCount, commandCount: commands.length, preparationMs: performance.now() - start,
  interpreterSteps: trace.interpreterSteps, cpu,
  timingScope: 'CPU scene construction and reference culling only; upload bytes are planned instance-buffer traffic, not measured GPU bandwidth. No GPU FPS claim.' };
await writeFile(join(output, 'cpu-report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
