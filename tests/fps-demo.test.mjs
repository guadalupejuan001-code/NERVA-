import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildFPSDescription, createNPCState } from '../examples/fps/author.mjs';
import { fpsRenderSettings } from '../examples/fps/quality.mjs';
import { prepareProgram } from '../src/runtime.mjs';
import { createFirstPersonController } from '../src/graphics/camera.mjs';

test('NERVA authors a complete first-person installation with four geometry batches and bounded light budget', async () => {
  const source = await readFile(new URL('../examples/fps/scene.nv', import.meta.url), 'utf8');
  const { world, description, interpreterSteps } = buildFPSDescription(source);
  assert.ok(world.count > 400 && world.count < 2000);
  assert.deepEqual(world.batches.map(batch => batch.kind), ['box', 'cylinder', 'sphere', 'pipe']);
  assert.equal(world.lightCount, 14);
  assert.ok(world.colliders.length > 30);
  assert.ok(interpreterSteps > 1000 && interpreterSteps < 100000);
  assert.equal(world.instances.byteLength, world.count * 64);
  assert.ok(description.objects.some(object => object.material.reflection > 0.5));
  assert.equal(description.character.name, 'Iria');
  assert.equal(createNPCState(description.character).state, 'idle');
  assert.doesNotThrow(() => createFirstPersonController({ ...world.spawn, colliders: world.colliders }));
});

test('NERVA original NPC patrols within its route, stops nearby and preserves dialogue state', async () => {
  const source = await readFile(new URL('../examples/fps/control.nv', import.meta.url), 'utf8');
  const scene = buildFPSDescription(await readFile(new URL('../examples/fps/scene.nv', import.meta.url), 'utf8'));
  const program = prepareProgram(source);
  const controller = createFirstPersonController({ position: [0, 1.7, -4] });
  let mission = { scanned: false, npc: createNPCState(scene.description.character) };
  const run = (input = {}, dt = 0.25) => program.run({ captureGlobals: false, inputs: { dt, mission,
    control: { forward: 0, strafe: 0, sprint: false, jump: false, lookDX: 0, lookDY: 0, interact: false, ...input } },
    host: { move: (movement, elapsed) => controller.step(movement, elapsed), status: value => { mission = value; return null; } } });
  run();
  assert.equal(mission.npc.state, 'idle');
  assert.deepEqual(mission.npc.position, scene.description.character.position);
  const visited = [];
  for (let frame = 0; frame < 80; frame++) {
    run(); visited.push(mission.npc.position[2]);
    assert.ok(Math.abs(mission.npc.position[2] - 6) <= 0.65 + 1e-12);
  }
  assert.equal(mission.npc.state, 'walking');
  assert.ok(Math.max(...visited) > 6.5 && Math.min(...visited) < 5.5, 'NPC walks both legs of the bounded route');
  controller.reset({ position: [-1.7, 1.7, mission.npc.position[2] - 1.2] });
  const stopped = [...mission.npc.position];
  run();
  assert.equal(mission.npc.state, 'idle');
  assert.deepEqual(mission.npc.position, stopped);
  assert.match(mission.message, /Pulsa E para hablar con Iria/);
  run({ interact: true });
  assert.equal(mission.npc.state, 'speaking');
  assert.equal(mission.npc.spoken, true);
  assert.equal(mission.npc.interactionCount, 1);
  assert.equal(mission.message, scene.description.character.dialogue);
  assert.equal(mission.scanned, false, 'Talking to the NPC does not inspect the distant console');
  run();
  assert.equal(mission.npc.speechRemaining, 4.75);
  assert.deepEqual(mission.npc.position, stopped);
  controller.reset({ position: [0, 1.7, 29] });
  run({ interact: true });
  assert.equal(mission.scanned, true);
  assert.equal(mission.npc.spoken, true);
});

test('high quality uses native display pixels within budget and keeps viewport aspect', () => {
  assert.deepEqual(fpsRenderSettings('high', { width: 1280, height: 720 }),
    { width: 1280, height: 720, shadowSize: 2048, sampleCount: 4, fxaa: true });
  assert.equal(fpsRenderSettings('high', { width: 1280, height: 720, devicePixelRatio: 2 }).width, 1920);
  const portrait = fpsRenderSettings('high', { width: 400, height: 800, devicePixelRatio: 2 });
  assert.equal(portrait.width, 540); assert.equal(portrait.height, 1080);
  assert.equal(fpsRenderSettings('validation', { width: 1280, height: 720 }).width, 320);
  assert.throws(() => fpsRenderSettings('high', { width: 0, height: 720 }), /positive/);
  assert.throws(() => fpsRenderSettings('unknown', { width: 1280, height: 720 }), /Unknown/);
});

test('NERVA control program handles movement and persistent host mission state', async () => {
  const source = await readFile(new URL('../examples/fps/control.nv', import.meta.url), 'utf8');
  const program = prepareProgram(source);
  const controller = createFirstPersonController({ position: [0, 1.7, 0] });
  let mission = { scanned: false };
  const run = input => program.run({ captureGlobals: false, inputs: { dt: 0.1, mission,
    control: { forward: 0, strafe: 0, sprint: false, jump: false, lookDX: 0, lookDY: 0, interact: false, ...input } },
    host: { move: (movement, dt) => controller.step(movement, dt), status: value => { mission = value; return null; } } });
  run({ forward: 1 });
  assert.ok(controller.state.position[2] > 0);
  run({ interact: true });
  assert.equal(mission.scanned, false);
  controller.reset({ position: [0, 1.7, 29] });
  run({ interact: true });
  assert.equal(mission.scanned, true);
  controller.reset({ position: [0, 1.7, 0] });
  run({});
  assert.equal(mission.scanned, true, 'mission state survives fresh interpreter runs in the host');
});
