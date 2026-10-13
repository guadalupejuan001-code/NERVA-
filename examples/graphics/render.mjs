import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { loadProject } from '../../src/project.mjs';
import { VERSION } from '../../src/runtime.mjs';
import { validateFrame, renderSVG, renderPNG } from './backend.mjs';

const directory = fileURLToPath(new URL('./', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node examples/graphics/render.mjs [--out directory]');
const output = resolve(args[1] ?? join(directory, '../../private/graphics'));
await mkdir(output, { recursive: true });
const project = await loadProject(join(directory, 'scene.nv'));
const frames = [];
for (const [index, angle] of [0, 0.6, 1.2].entries()) {
  let frame = null;
  const start = performance.now();
  const result = project.prepared.run({ captureGlobals: false,
    inputs: { scene: { angle, pitch: 0.35, width: 640, height: 480, focal: 280, distance: 5, near: 0.1 } },
    host: { sin: Math.sin, cos: Math.cos,
      present: value => { if (frame) throw new Error('A frame was already presented'); frame = validateFrame(value); return null; } },
  });
  if (!frame) throw new Error('No frame presented');
  const geometryMs = performance.now() - start;
  const name = `frame-${String(index).padStart(2, '0')}`;
  await writeFile(join(output, `${name}.svg`), renderSVG(frame));
  await writeFile(join(output, `${name}.png`), renderPNG(frame));
  frames.push({ index, angle, points: frame.points.length, lines: frame.lines.length,
    interpreterSteps: result.steps, tensorOperations: result.tensorOperations,
    geometryMs, svg: `${name}.svg`, png: `${name}.png` });
}
const report = { nervaVersion: VERSION, output, frames,
  scope: 'Offline wireframe CPU proof: NERVA builds/rotates/projects geometry; JavaScript rasterizes and exports images. No GPU, depth buffer, lighting or real-time frame-rate claim.' };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
