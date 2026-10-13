const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;
const EPSILON = 1e-7;

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw new TypeError(`${name} must be a finite Float32 number`);
  return value;
}

function positive(value, name) {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function vector(value, name) {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value)) || value.length !== 3)
    throw new TypeError(`${name} must contain exactly three numbers`);
  return Array.from(value, (component, axis) => finite(component, `${name}[${axis}]`));
}

function box(value, name) {
  if (!value || typeof value !== 'object') throw new TypeError(`${name} must be an AABB`);
  const min = vector(value.min, `${name}.min`), max = vector(value.max, `${name}.max`);
  if (min.some((component, axis) => component >= max[axis]))
    throw new RangeError(`${name}.max must exceed min on all axes`);
  return { min, max };
}

function wrapYaw(value) {
  return ((value + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
}

/** A left-handed +Z camera: positive yaw looks +X; positive pitch looks +Y.
 * Vectors are rounded exactly once for sharing CPU references and GPU uniforms.
 */
export function cameraBasis({ yaw = 0, pitch = 0 } = {}) {
  yaw = Math.fround(finite(yaw, 'yaw'));
  pitch = Math.fround(finite(pitch, 'pitch'));
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return {
    right: [cy, 0, -sy].map(Math.fround),
    up: [-sy * sp, cp, -cy * sp].map(Math.fround),
    forward: [sy * cp, sp, cy * cp].map(Math.fround),
  };
}

/** Small, deterministic FPS controller with a swept AABB body and wall sliding.
 * The body occupies radius on X/Z, eyeHeight below the camera, and bodyHeight
 * from feet to head. This is movement/collision scaffolding, not rigid-body physics.
 * Mouse deltas use browser coordinates: positive lookDY looks down.
 * Large frame deltas are capped at 250 ms; movement is subdivided at half-radius.
 */
export function createFirstPersonController({ position = [0, 1.7, -4], yaw = 0, pitch = 0,
  eyeHeight = 1.7, bodyHeight = eyeHeight + 0.15, radius = 0.28, speed = 4,
  sprintSpeed = 7, colliders = [], bounds, sensitivity = 0.0025,
  gravity = 9.81, jumpSpeed = 4.5 } = {}) {
  eyeHeight = positive(eyeHeight, 'eyeHeight');
  bodyHeight = positive(bodyHeight, 'bodyHeight');
  if (bodyHeight < eyeHeight) throw new RangeError('bodyHeight must be at least eyeHeight');
  radius = positive(radius, 'radius');
  speed = positive(speed, 'speed');
  sprintSpeed = positive(sprintSpeed, 'sprintSpeed');
  sensitivity = positive(sensitivity, 'sensitivity');
  gravity = positive(gravity, 'gravity');
  jumpSpeed = positive(jumpSpeed, 'jumpSpeed');
  if (!Array.isArray(colliders)) throw new TypeError('colliders must be an array');
  const staticSolids = Array.from(colliders, (collider, index) => box(collider, `colliders[${index}]`));
  let solids = staticSolids;
  const limits = bounds === undefined ? null : box(bounds, 'bounds');
  if (limits && (limits.max[0] - limits.min[0] <= radius * 2 ||
      limits.max[2] - limits.min[2] <= radius * 2 || limits.max[1] - limits.min[1] < bodyHeight))
    throw new RangeError('bounds must fit the controller body');
  const groundY = limits?.min[1] ?? 0;
  const headOffset = bodyHeight - eyeHeight;
  const maximumPitch = HALF_PI - 0.01;
  const initial = { position: vector(position, 'position'), yaw: finite(yaw, 'yaw'), pitch: finite(pitch, 'pitch') };
  let location, currentYaw, currentPitch, verticalVelocity = 0, grounded = false, previousJump = false;

  function horizontalOverlap(solid, axis) {
    const other = axis === 0 ? 2 : 0;
    return location[other] + radius > solid.min[other] + EPSILON &&
      location[other] - radius < solid.max[other] - EPSILON &&
      location[1] + headOffset > solid.min[1] + EPSILON &&
      location[1] - eyeHeight < solid.max[1] - EPSILON;
  }

  function footprintOverlaps(solid) {
    return location[0] + radius > solid.min[0] + EPSILON && location[0] - radius < solid.max[0] - EPSILON &&
      location[2] + radius > solid.min[2] + EPSILON && location[2] - radius < solid.max[2] - EPSILON;
  }

  function supported() {
    const feet = location[1] - eyeHeight;
    return feet <= groundY + EPSILON || solids.some(solid => footprintOverlaps(solid) && Math.abs(feet - solid.max[1]) <= EPSILON);
  }

  function moveHorizontal(axis, amount) {
    if (amount === 0) return;
    const before = location[axis];
    let next = before + amount;
    if (limits) next = Math.max(limits.min[axis] + radius, Math.min(limits.max[axis] - radius, next));
    for (const solid of solids) {
      if (!horizontalOverlap(solid, axis)) continue;
      if (amount > 0 && before + radius <= solid.min[axis] + EPSILON && next + radius > solid.min[axis])
        next = Math.min(next, solid.min[axis] - radius);
      if (amount < 0 && before - radius >= solid.max[axis] - EPSILON && next - radius < solid.max[axis])
        next = Math.max(next, solid.max[axis] + radius);
    }
    location[axis] = next;
  }

  function moveVertical(amount) {
    const before = location[1];
    let next = before + amount;
    const floor = groundY + eyeHeight;
    const ceiling = limits ? limits.max[1] - headOffset : Infinity;
    if (next < floor) { next = floor; verticalVelocity = 0; }
    if (next > ceiling) { next = ceiling; verticalVelocity = 0; }
    for (const solid of solids) {
      if (!footprintOverlaps(solid)) continue;
      if (amount < 0 && before - eyeHeight >= solid.max[1] - EPSILON && next - eyeHeight < solid.max[1]) {
        next = Math.max(next, solid.max[1] + eyeHeight);
        verticalVelocity = 0;
      }
      if (amount > 0 && before + headOffset <= solid.min[1] + EPSILON && next + headOffset > solid.min[1]) {
        next = Math.min(next, solid.min[1] - headOffset);
        verticalVelocity = 0;
      }
    }
    location[1] = next;
  }

  function snapshot() {
    return Object.freeze({ position: Object.freeze([...location]), yaw: currentYaw, pitch: currentPitch,
      verticalVelocity, grounded });
  }

  function reset(next = initial) {
    if (!next || typeof next !== 'object') throw new TypeError('reset state must be an object');
    const nextPosition = vector(next.position ?? initial.position, 'position');
    const nextYaw = wrapYaw(finite(next.yaw ?? initial.yaw, 'yaw'));
    const nextPitch = Math.max(-maximumPitch, Math.min(maximumPitch, finite(next.pitch ?? initial.pitch, 'pitch')));
    if (nextPosition[1] - eyeHeight < groundY - EPSILON || (limits && (
      nextPosition[0] - radius < limits.min[0] || nextPosition[0] + radius > limits.max[0] ||
      nextPosition[2] - radius < limits.min[2] || nextPosition[2] + radius > limits.max[2] ||
      nextPosition[1] + headOffset > limits.max[1])))
      throw new RangeError('controller position is outside its movement bounds');
    if (solids.some(solid => nextPosition[0] + radius > solid.min[0] + EPSILON &&
      nextPosition[0] - radius < solid.max[0] - EPSILON && nextPosition[2] + radius > solid.min[2] + EPSILON &&
      nextPosition[2] - radius < solid.max[2] - EPSILON && nextPosition[1] + headOffset > solid.min[1] + EPSILON &&
      nextPosition[1] - eyeHeight < solid.max[1] - EPSILON))
      throw new RangeError('controller position intersects a collider');
    location = nextPosition;
    currentYaw = nextYaw; currentPitch = nextPitch;
    verticalVelocity = 0; previousJump = false; grounded = supported();
    return snapshot();
  }

  reset();
  return Object.freeze({
    get state() { return snapshot(); },
    get dynamicColliderCount() { return solids.length - staticSolids.length; },
    get camera() { return { position: [...location], yaw: currentYaw, pitch: currentPitch, near: 0.08, far: 200 }; },
    reset,
    /** Replace kinematic blockers while preserving the static scene colliders. */
    setDynamicColliders(colliders) {
      if (!Array.isArray(colliders)) throw new TypeError('dynamic colliders must be an array');
      const dynamic = Array.from(colliders, (collider, index) => box(collider, `dynamic colliders[${index}]`));
      if (dynamic.some(solid => location[0] + radius > solid.min[0] + EPSILON &&
        location[0] - radius < solid.max[0] - EPSILON && location[2] + radius > solid.min[2] + EPSILON &&
        location[2] - radius < solid.max[2] - EPSILON && location[1] + headOffset > solid.min[1] + EPSILON &&
        location[1] - eyeHeight < solid.max[1] - EPSILON))
        throw new RangeError('dynamic collider intersects the controller body');
      solids = staticSolids.concat(dynamic);
    },
    step(input = {}, dt = 0) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object');
      dt = finite(dt, 'dt');
      if (dt < 0) throw new RangeError('dt must be nonnegative');
      const forward = Math.max(-1, Math.min(1, finite(input.forward ?? 0, 'forward')));
      const strafe = Math.max(-1, Math.min(1, finite(input.strafe ?? 0, 'strafe')));
      const lookDX = finite(input.lookDX ?? 0, 'lookDX'), lookDY = finite(input.lookDY ?? 0, 'lookDY');
      const sprint = input.sprint ?? false, jump = input.jump ?? false;
      if (typeof sprint !== 'boolean' || typeof jump !== 'boolean') throw new TypeError('sprint and jump must be booleans');
      const nextYaw = wrapYaw(finite(currentYaw + lookDX * sensitivity, 'updated yaw'));
      const nextPitch = Math.max(-maximumPitch, Math.min(maximumPitch, finite(currentPitch - lookDY * sensitivity, 'updated pitch')));
      const elapsed = Math.min(dt, 0.25);
      if (elapsed === 0) {
        currentYaw = nextYaw; currentPitch = nextPitch;
        return snapshot();
      }
      const movementSpeed = sprint ? sprintSpeed : speed;
      const normalization = Math.max(1, Math.hypot(forward, strafe));
      const vx = (Math.sin(nextYaw) * forward + Math.cos(nextYaw) * strafe) * movementSpeed / normalization;
      const vz = (Math.cos(nextYaw) * forward - Math.sin(nextYaw) * strafe) * movementSpeed / normalization;
      const launch = jump && !previousJump && grounded;
      const initialVelocity = launch ? jumpSpeed : verticalVelocity;
      const travel = Math.max(Math.abs(vx * elapsed), Math.abs(vz * elapsed),
        Math.abs(initialVelocity * elapsed) + gravity * elapsed * elapsed);
      const steps = Math.max(1, Math.ceil(travel / (radius * 0.5)), Math.ceil(elapsed * 120));
      if (!Number.isSafeInteger(steps) || steps > 10_000) throw new RangeError('movement exceeds the controller substep budget');
      currentYaw = nextYaw; currentPitch = nextPitch;
      previousJump = jump;
      if (launch) { verticalVelocity = jumpSpeed; grounded = false; }
      const interval = elapsed / steps;
      for (let index = 0; index < steps; index++) {
        moveHorizontal(0, vx * interval);
        moveHorizontal(2, vz * interval);
        if (!grounded) verticalVelocity -= gravity * interval;
        moveVertical(verticalVelocity * interval);
        grounded = supported();
        if (grounded) verticalVelocity = 0;
      }
      return snapshot();
    },
  });
}
