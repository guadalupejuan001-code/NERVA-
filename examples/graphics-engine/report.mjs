import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'private/graphics-engine');
const cpu = JSON.parse(await readFile(join(directory, 'cpu-report.json'), 'utf8'));
const browser = JSON.parse(await readFile(join(directory, 'browser-report.json'), 'utf8'));
if (!browser.ok || !browser.probe.compute.verified || !browser.benchmark.verified)
  throw new Error('Only successful, verified WebGPU measurements can be assembled');
const { screenshot, ...gpu } = browser;
const filenames = [
  'src/runtime.mjs', 'src/parser.mjs', 'src/project.mjs', 'src/tensor.mjs',
  'src/graphics/scene.mjs', 'src/graphics/graph.mjs', 'src/graphics/commands.mjs',
  'src/graphics/shaders.mjs', 'src/graphics/webgpu.mjs', 'src/graphics/index.mjs',
  'examples/graphics-engine/init.nv', 'examples/graphics-engine/frame.nv',
  'examples/graphics-engine/prepare.mjs', 'examples/graphics-engine/benchmark.mjs', 'examples/graphics-engine/index.html',
  'scripts/probe-webgpu.py',
];
const sourceHashes = {};
for (const filename of filenames) sourceHashes[filename] = createHash('sha256').update(await readFile(join(root, filename))).digest('hex');
const report = { format: 'nerva-graphics-evidence', version: 1, measuredAt: new Date().toISOString(),
  scope: 'Procedural instanced spheres: CPU reference and WebGPU correctness. Software adapter measurements do not establish physical GPU FPS.',
  sourceHashes, cpu, gpu };
await mkdir(directory, { recursive: true });
const destination = join(directory, 'report.json');
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ destination, verified: true,
  cpuInstances: cpu.cpu.at(-1).count, gpuInstances: gpu.benchmark.tests.stress.instanceCount,
  softwareAdapter: gpu.benchmark.softwareAdapter }) + '\n');
