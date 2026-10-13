import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'private/fps');
const preparation = JSON.parse(await readFile(join(output, 'preparation-report.json'), 'utf8'));
const browser = JSON.parse(await readFile(join(output, 'browser-report.json'), 'utf8'));
const controls = JSON.parse(await readFile(join(output, 'controls-report.json'), 'utf8'));
const optionalReport = async filename => {
  try { return JSON.parse(await readFile(join(output, filename), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
};
const rendererQA = await optionalReport('gpu-final-qa.json');
const characterQA = await optionalReport('skin-gpu-qa.json');
const characterStructureQA = await optionalReport('gltf-qa.json');
const npcQA = await optionalReport('npc-final-qa.json');
const packageQA = await optionalReport('package-qa.json');
if (!browser.ok || !browser.benchmark?.verified || !controls.ok)
  throw new Error('FPS evidence requires successful WebGPU and real-input verification');
if (!characterQA) throw new Error('Run npm run test:fps:character before assembling FPS evidence');
for (const [label, evidence] of Object.entries({ rendererQA, characterQA, characterStructureQA, npcQA, packageQA })) {
  if (evidence && !evidence.verified) throw new Error(`${label} verification failed`);
}
const character = browser.benchmark.character;
if (!character || !controls.npcChecksAvailable)
  throw new Error('FPS evidence requires the character and real NPC interaction checks');
if (characterQA && (characterQA.asset.joints !== character.jointCount ||
  characterQA.asset.vertices !== character.vertices || characterQA.asset.triangles !== character.triangles))
  throw new Error('GPU character evidence belongs to a different asset');
if (characterStructureQA && (characterStructureQA.jointCount !== character.jointCount ||
  characterStructureQA.vertexCount !== character.vertices || characterStructureQA.triangleCount !== character.triangles))
  throw new Error('Structural character evidence belongs to a different asset');
const clean = report => { const { screenshot, ...data } = report; return data; };
const sourceHashes = {};
for (const filename of ['src/runtime.mjs','src/parser.mjs','src/tensor.mjs','src/virtual-path.mjs',
  'src/graphics/index.mjs','src/graphics/camera.mjs','src/graphics/scene.mjs','src/graphics/graph.mjs',
  'src/graphics/webgpu.mjs','src/graphics/shaders.mjs','src/graphics/world.mjs','src/graphics/gltf.mjs',
  'src/graphics/fps-renderer.mjs','src/graphics/fps-shaders.mjs','examples/fps/author.mjs',
  'examples/fps/scene.nv','examples/fps/control.nv','examples/fps/app.mjs','examples/fps/index.html',
  'examples/fps/quality.mjs','examples/fps/prepare.mjs','examples/fps/report.mjs',
  'assets/characters/iria.gltf','assets/characters/iria.bin','scripts/build-character.py',
  'scripts/probe-webgpu.py','scripts/probe-fps.py','scripts/probe-fps-renderer.py','scripts/probe-fps-character.py']) {
  sourceHashes[filename] = createHash('sha256').update(await readFile(join(root, filename))).digest('hex');
}
const report = { format: 'nerva-fps-evidence', version: 2, measuredAt: new Date().toISOString(),
  scope: 'First-person procedural installation and original rigged character rendered by WebGPU; scene and live movement, mission and NPC logic authored in NERVA. Native resolution, MSAA/FXAA, skinning pixels, effect contributions and persistent uploads verified. Software adapter evidence does not establish physical GPU FPS or photogrammetric asset quality.',
  sourceHashes, preparation, browser: clean(browser), controls: clean(controls), rendererQA,
  characterQA, characterStructureQA, npcQA, packageQA };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ verified: true, output: join(output, 'report.json'),
  objectCount: preparation.objectCount, resolution: browser.benchmark.resolution,
  softwareAdapter: browser.benchmark.softwareAdapter, character,
  controls: controls.tests, characterGPUVerified: characterQA?.verified ?? false }) + '\n');
