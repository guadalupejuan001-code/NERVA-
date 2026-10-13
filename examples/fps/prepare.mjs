import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildFPSDescription, createNPCState } from './author.mjs';
import { createFirstPersonController } from '../../src/graphics/camera.mjs';
import { prepareProgram } from '../../src/runtime.mjs';

const output = fileURLToPath(new URL('../../private/fps/', import.meta.url));
await mkdir(output, { recursive: true });
const source = await readFile(new URL('./scene.nv', import.meta.url), 'utf8');
const { description, world, interpreterSteps } = buildFPSDescription(source);
const control = prepareProgram(await readFile(new URL('./control.nv', import.meta.url), 'utf8'), { filename: 'control.nv' });
const controller = createFirstPersonController({ ...world.spawn, colliders: world.colliders,
  bounds: { min: [-7.5, 0, -7.5], max: [7.5, 7.2, 43.5] } });
let mission = { scanned: false, npc: createNPCState(description.character) }, controlSteps = 0;
for (let frame = 0; frame < 10; frame++) {
  const result = control.run({ captureGlobals: false,
    inputs: { dt: 1 / 60, control: { forward: 1, strafe: 0, sprint: false, jump: false, lookDX: 0, lookDY: 0, interact: false }, mission },
    host: { move: (input, dt) => controller.step(input, dt), status: value => { mission = value; return null; } } });
  controlSteps += result.steps;
}
await writeFile(join(output, 'scene.json'), JSON.stringify(description, null, 2) + '\n');
const report = { node: process.version, objectCount: world.count, instancesBytes: world.instances.byteLength,
  sceneBytes: world.byteLength, lightCount: world.lightCount, colliderCount: world.colliders.length,
  batches: world.batches, sceneInterpreterSteps: interpreterSteps, controlFrames: 10, controlSteps,
  spawn: world.spawn, movedPosition: controller.state.position, mission,
  character: description.character,
  scope: 'NERVA authors the scene and original NPC, then runs movement/mission/NPC state logic; the host stores state and implements collision, skeletal animation and graphics. GPU validation is a separate browser run.' };
await writeFile(join(output, 'preparation-report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
