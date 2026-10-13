import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraBasis, createFirstPersonController } from '../src/graphics/camera.mjs';
import { createScene, cameraParameters, cullScene, defaultCamera } from '../src/graphics/scene.mjs';

const close = (actual, expected, epsilon = 2e-6) => assert.ok(Math.abs(actual - expected) <= epsilon,
  `${actual} differs from ${expected}`);
const dot = (a, b) => a.reduce((value, component, index) => value + component * b[index], 0);

test('FPS camera basis is orthonormal with yaw toward +X and pitch toward +Y', () => {
  for (const yaw of [0, Math.PI / 2, -Math.PI, 0.7]) {
    for (const pitch of [0, 0.4, -1.5]) {
      const { right, up, forward } = cameraBasis({ yaw, pitch });
      for (const vector of [right, up, forward]) {
        close(dot(vector, vector), 1);
        assert.ok(vector.every(value => Object.is(value, Math.fround(value))));
      }
      close(dot(right, up), 0); close(dot(right, forward), 0); close(dot(up, forward), 0);
    }
  }
  const yaw = cameraBasis({ yaw: Math.PI / 2 });
  close(yaw.forward[0], 1); close(yaw.forward[2], 0);
  const pitch = cameraBasis({ pitch: Math.PI / 4 });
  close(pitch.forward[1], Math.SQRT1_2); close(pitch.up[2], -Math.SQRT1_2);
  for (const value of [NaN, Infinity, 1e40]) assert.throws(() => cameraBasis({ yaw: value }));
});

test('camera parameters and CPU frustum use the same rotated f32 basis', () => {
  const scene = createScene({ count: 4 });
  scene.updateInstances([
    { index: 0, position: [10, 2, 0], radius: 0.1 },
    { index: 1, position: [-10, 2, 0], radius: 0.1 },
    { index: 2, position: [0, 2, 10], radius: 0.1 },
    { index: 3, position: [10, 12, 0], radius: 0.1 },
  ]);
  const camera = defaultCamera({ position: [0, 2, 0], yaw: Math.PI / 2, fovY: Math.PI / 3, aspect: 1 });
  assert.deepEqual([...cullScene(scene, camera).visible], [0]);
  const parameters = cameraParameters(camera);
  assert.deepEqual(camera.forward, parameters.forward);
  assert.deepEqual(parameters.forward, cameraBasis({ yaw: parameters.yaw, pitch: parameters.pitch }).forward);
  assert.deepEqual([...cullScene(scene, { ...camera, pitch: Math.PI / 4 }).visible], [3]);
  assert.throws(() => cameraParameters({ yaw: NaN }));
  assert.throws(() => cameraParameters({ pitch: Infinity }));
});

test('FPS movement normalizes diagonals, uses horizontal yaw and ignores pitch for walking', () => {
  const straight = createFirstPersonController(), diagonal = createFirstPersonController();
  const first = straight.step({ forward: 1 }, 0.25), second = diagonal.step({ forward: 1, strafe: 1 }, 0.25);
  close(first.position[2] + 4, 1);
  close(Math.hypot(second.position[0], second.position[2] + 4), 1);
  const rotated = createFirstPersonController({ yaw: Math.PI / 2, pitch: 1 });
  const state = rotated.step({ forward: 1, sprint: true }, 0.1);
  close(state.position[0], 0.7); close(state.position[2], -4); close(state.position[1], 1.7);
});

test('mouse movement clamps pitch, wraps yaw and camera/state snapshots do not expose mutable state', () => {
  const controller = createFirstPersonController();
  const state = controller.step({ lookDX: 1_000_000, lookDY: -1_000_000 }, 0);
  assert.ok(state.yaw >= -Math.PI && state.yaw < Math.PI);
  assert.ok(state.pitch < Math.PI / 2 && state.pitch > 1.5);
  const camera = controller.camera;
  camera.position[0] = 200;
  assert.equal(controller.state.position[0], 0);
  assert.throws(() => { controller.state.position[0] = 10; });
  close(controller.step({ lookDY: 1_000_000 }, 0).pitch, -Math.PI / 2 + 0.01);
  assert.equal(controller.camera.near, 0.08);
});

test('swept body stops at thin walls and slides along their free axis', () => {
  const controller = createFirstPersonController({ position: [0, 1.7, 0], speed: 20, radius: 0.28,
    colliders: [{ min: [-5, 0, 0.5], max: [5, 3, 0.51] }] });
  const state = controller.step({ forward: 1, strafe: 1 }, 0.25);
  close(state.position[2], 0.5 - 0.28);
  close(state.position[0], 20 * 0.25 / Math.SQRT2);
  assert.equal(state.grounded, true);
});

test('body and world bounds stop movement at all sides and frame deltas are capped', () => {
  const bounds = { min: [-1, 0, -1], max: [1, 4, 1] };
  const controller = createFirstPersonController({ position: [0, 1.7, 0], bounds, radius: 0.25 });
  close(controller.step({ forward: 1 }, 10).position[2], 0.75);
  close(controller.step({ strafe: -1 }, 10).position[0], -0.75);
  close(controller.step({ forward: -1, sprint: true }, 10).position[2], -0.75);
  const capped = createFirstPersonController();
  close(capped.step({ forward: 1 }, 2).position[2], -3);
  assert.throws(() => createFirstPersonController({ bounds }));
  assert.throws(() => createFirstPersonController({ bounds: { min: [0, 0, 0], max: [0.1, 1, 0.1] } }));
});

test('jump follows gravity, lands on a collider and requires a fresh button press', () => {
  const platform = { min: [-2, 0, -2], max: [2, 0.5, 2] };
  const controller = createFirstPersonController({ position: [0, 2.2, 0], colliders: [platform] });
  assert.equal(controller.state.grounded, true);
  controller.step({ jump: true }, 0);
  const airborne = controller.step({ jump: true }, 0.1);
  assert.ok(airborne.position[1] > 2.2);
  assert.equal(airborne.grounded, false);
  for (let step = 0; step < 15; step++) controller.step({ jump: true }, 0.1);
  close(controller.state.position[1], 2.2);
  assert.equal(controller.state.grounded, true);
  controller.step({ jump: false }, 0.01);
  assert.ok(controller.step({ jump: true }, 0.1).position[1] > 2.2);
});

test('jump hits ceilings and walking off a platform starts a fall', () => {
  const controller = createFirstPersonController({ position: [0, 1.7, 0],
    colliders: [{ min: [-2, 2, -2], max: [2, 2.1, 2] }] });
  for (let frame = 0; frame < 3; frame++) controller.step({ jump: frame === 0 }, 0.1);
  assert.ok(controller.state.position[1] <= 2 - 0.15 + 1e-7);
  const platform = createFirstPersonController({ position: [0, 2.7, 0],
    colliders: [{ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }] });
  platform.step({ strafe: 1 }, 0.25);
  assert.equal(platform.state.grounded, false);
  const before = platform.state.position[1];
  platform.step({}, 0.1);
  assert.ok(platform.state.position[1] < before);
});

test('invalid commands and reset positions are atomic and collider snapshots are isolated', () => {
  const collider = { min: [-5, 0, 1], max: [5, 3, 2] };
  const controller = createFirstPersonController({ position: [0, 1.7, 0], colliders: [collider] });
  collider.min[2] = 20;
  close(controller.step({ forward: 1 }, 0.25).position[2], 0.72);
  const state = controller.state;
  for (const input of [{ forward: NaN }, { lookDX: Infinity }, { sprint: 1 }, { jump: 'yes' }]) {
    assert.throws(() => controller.step(input, 0.1));
    assert.deepEqual(controller.state, state);
  }
  assert.throws(() => controller.step({}, -1));
  assert.throws(() => controller.reset({ position: [0, 1.7, 1.5] }));
  assert.deepEqual(controller.state, state);
  controller.reset();
  assert.deepEqual(controller.state.position, [0, 1.7, 0]);
  assert.throws(() => createFirstPersonController({ radius: 0 }));
  assert.throws(() => createFirstPersonController({ position: [0, 0, 0] }));
  assert.throws(() => createFirstPersonController({ colliders: [{ min: [0, 0, 0], max: [0, 1, 1] }] }));
});

test('moving blockers can be replaced without removing the static scene', () => {
  const controller = createFirstPersonController({ position: [0, 1.7, 0],
    colliders: [{ min: [-2, 0, 4], max: [2, 3, 5] }] });
  const moving = { min: [-1, 0, 1], max: [1, 2, 2] };
  controller.setDynamicColliders([moving]);
  moving.min[2] = 30;
  assert.equal(controller.dynamicColliderCount, 1);
  close(controller.step({ forward: 1 }, 0.25).position[2], 0.72);
  controller.setDynamicColliders([]);
  assert.equal(controller.dynamicColliderCount, 0);
  for (let frame = 0; frame < 4; frame++) controller.step({ forward: 1 }, 0.25);
  close(controller.state.position[2], 3.72);
});

test('invalid dynamic blockers leave the previous collision set intact', () => {
  const controller = createFirstPersonController({ position: [0, 1.7, 0] });
  controller.setDynamicColliders([{ min: [-1, 0, 1], max: [1, 2, 2] }]);
  assert.throws(() => controller.setDynamicColliders([{ min: [-1, 0, -1], max: [1, 2, 1] }]), /intersects/);
  assert.throws(() => controller.setDynamicColliders([{ min: [0, 0, 8], max: [0, 2, 9] }]), /exceed/);
  assert.equal(controller.dynamicColliderCount, 1);
  close(controller.step({ forward: 1 }, 0.25).position[2], 0.72);
});
