import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../src/project.mjs';
import { createGraphicsCommandHost } from '../src/graphics/index.mjs';

test('NERVA frames update the same persistent host scene through compact commands', async () => {
  const init = (await loadProject(fileURLToPath(new URL('../examples/graphics-engine/init.nv', import.meta.url)))).prepared;
  const frame = (await loadProject(fileURLToPath(new URL('../examples/graphics-engine/frame.nv', import.meta.url)))).prepared;
  const bridge = createGraphicsCommandHost();
  const result = init.run({ inputs: { settings: { count: 100_000, seed: 7 } }, host: bridge.host });
  const handle = result.records[0].values[0].handle;
  const scene = bridge.getScene(handle), original = scene.positions;
  scene.consumeDirtyRanges();
  frame.run({ inputs: { scene_handle: handle, frame: { patches: [{ index: 9, position: [1, 2, 3] }], camera: {} } }, host: bridge.host });
  frame.run({ inputs: { scene_handle: handle, frame: { patches: [], camera: { position: [2, 0, 0] } } }, host: bridge.host });
  assert.equal(bridge.getScene(handle), scene);
  assert.equal(scene.positions, original);
  assert.deepEqual(Array.from(scene.positions.subarray(36, 39)), [1, 2, 3]);
  assert.equal(scene.consumeDirtyRanges().bytes, 32);
  const commands = bridge.drain();
  assert.deepEqual(commands.map(command => command.type), ['create_scene', 'update_instances', 'render_scene', 'render_scene']);
  assert.ok(JSON.stringify(commands).length < 1000, 'command size must be independent of resident instance data');
  assert.equal(bridge.sceneCount, 1);
  assert.deepEqual(bridge.drain(), []);
});

test('invalid host edits and handles leave state and command queue intact', () => {
  const bridge = createGraphicsCommandHost();
  const handle = bridge.host.create_scene({ count: 2 });
  bridge.drain();
  assert.throws(() => bridge.host.update_instances(handle, [{ index: 0, radius: -1 }]), /positive/);
  assert.throws(() => bridge.host.render_scene(handle, { near: 10, far: 2 }), /far/);
  assert.throws(() => bridge.host.render_scene(handle, { near: Infinity }), /finite/);
  assert.throws(() => bridge.host.render_scene('missing', {}), /Unknown scene/);
  assert.equal(bridge.getScene(handle).revision, 0);
  assert.equal(bridge.pendingCount, 0);
});

test('queued commands own caller data', () => {
  const bridge = createGraphicsCommandHost();
  const handle = bridge.host.create_scene({ count: 2 });
  const patches = [{ index: 0, color: [1, 0, 0] }], camera = { position: [0, 0, 0] };
  bridge.host.update_instances(handle, patches);
  bridge.host.render_scene(handle, camera);
  patches[0].color[0] = 0;
  camera.position[0] = 99;
  const commands = bridge.drain();
  assert.deepEqual(commands[1].patches[0].color, [1, 0, 0]);
  assert.deepEqual(commands[2].camera.position, [0, 0, 0]);
});
