import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runProgram, VERSION } from '../src/runtime.mjs';
import { getBudget } from '../src/tensor.mjs';

// Frozen before evaluation: this is optimization of actions for each supplied
// goal, not training a policy that learned planning for arbitrary new goals.
const config = Object.freeze({
  seed: 731, horizon: 12, dt: 1, maxVelocityPerAxis: 1,
  maxAccelerationPerAxis: 0.35, accelerationPenaltyMargin: 0.03,
  iterations: 700, learningRate: 0.01, goalWeight: 6,
  energyWeight: 0.025, accelerationWeight: 30,
  goalTolerance: 0.15, numericTolerance: 1e-9,
  stepLimit: 200_000, operationLimit: 20_000_000,
});
const calibrationGoals = [[2, 1], [-2, 2], [4, 0]];
const evaluationGoals = [[1.2, 3.3], [-4.5, -1], [5.5, -2.5], [9, 2], [14, 0]];

const differences = Array.from({ length: config.horizon + 1 }, (_, t) =>
  Array.from({ length: config.horizon }, (_, k) =>
    (t === k ? 1 : 0) - (t === k + 1 ? 1 : 0)));
const integration = Array.from({ length: config.horizon }, (_, t) =>
  Array.from({ length: config.horizon }, (_, k) => k <= t ? config.dt : 0));

export const source = `nerva 0.2
# Actions are differentiable velocities of a kinematic 2D robot.
# Start and end velocities are zero; D includes both boundary transitions.
param controls = tensor64(initial_controls)
const D = tensor64(difference_matrix)
const integration = tensor64(integration_matrix)
const endpoint_sum = ones([1, horizon], "f64") * dt
const target = tensor64([goal])
fn objective() {
    const velocity = tanh(controls) * max_velocity
    const displacement = endpoint_sum @ velocity
    const changes = D @ velocity / dt
    const violation = relu(changes ^ 2 - acceleration_guard ^ 2)
    return mse(displacement, target) * goal_weight + sum(velocity ^ 2) * dt * energy_weight + sum(violation ^ 2) * acceleration_weight
}
const initial_loss = value(objective())
for iteration in range(iterations) {
    zero_grad([controls])
    const loss = objective()
    backward(loss)
    step([controls], learning_rate)
}
const velocities = tanh(controls) * max_velocity
const path = integration @ velocities
const endpoint = path[horizon - 1]
const acceleration = D @ velocities / dt
const final_loss = value(objective())
assert(final_loss <= initial_loss + 1e-9, "The objective must not increase")
for t in range(horizon) {
    for axis in range(2) {
        assert(abs(value(velocities[t][axis])) <= max_velocity + 1e-9, "Velocity bound")
    }
}
let accepted = true
if value(sum((endpoint - tensor64(goal)) ^ 2)) > goal_tolerance ^ 2 {
    accepted = false
}
for t in range(horizon + 1) {
    for axis in range(2) {
        if abs(value(acceleration[t][axis])) > max_acceleration + 1e-9 {
            accepted = false
        }
    }
}
print(initial_loss, final_loss, velocities, path, accepted)
`;

// Deliberately no NERVA tensor functions, integration/difference matrices,
// gradients, or exported NERVA loss values: recompute physics with scalar JS.
function simulate(velocities, goal) {
  assert.equal(velocities.length, config.horizon);
  let position = [0, 0], previousVelocity = [0, 0], energy = 0;
  let maximumVelocity = 0, maximumAcceleration = 0;
  const path = [];
  for (const velocity of velocities) {
    assert.equal(velocity.length, 2);
    for (let axis = 0; axis < 2; axis++) {
      assert(Number.isFinite(velocity[axis]));
      position[axis] += config.dt * velocity[axis];
      energy += config.dt * velocity[axis] ** 2;
      maximumVelocity = Math.max(maximumVelocity, Math.abs(velocity[axis]));
      maximumAcceleration = Math.max(maximumAcceleration,
        Math.abs(velocity[axis] - previousVelocity[axis]) / config.dt);
    }
    previousVelocity = [...velocity];
    path.push([...position]);
  }
  for (const velocity of previousVelocity) {
    maximumAcceleration = Math.max(maximumAcceleration, Math.abs(velocity) / config.dt);
  }
  const distanceToGoal = Math.hypot(position[0] - goal[0], position[1] - goal[1]);
  const speedValid = maximumVelocity <= config.maxVelocityPerAxis + config.numericTolerance;
  const accelerationValid = maximumAcceleration <= config.maxAccelerationPerAxis + config.numericTolerance;
  const goalReached = distanceToGoal <= config.goalTolerance;
  return { endpoint: position, distanceToGoal, energy, maximumVelocity,
    maximumAcceleration, speedValid, accelerationValid, goalReached,
    accepted: speedValid && accelerationValid && goalReached, path };
}

function baseline(goal) {
  // A hand-written, goal-aware feasible trapezoid; stronger than zero actions.
  const envelope = Array.from({ length: config.horizon }, (_, t) =>
    Math.min(config.maxVelocityPerAxis,
      config.maxAccelerationPerAxis * config.dt * (t + 1),
      config.maxAccelerationPerAxis * config.dt * (config.horizon - t)));
  const capacity = envelope.reduce((a, b) => a + b, 0) * config.dt;
  const scale = goal.map(x => Math.max(-1, Math.min(1, x / capacity)));
  return envelope.map(v => scale.map(s => v * s));
}

function solve(goal, split) {
  const initialControls = Array.from({ length: config.horizon }, () => [0, 0]);
  const start = performance.now();
  const result = runProgram(source, {
    seed: config.seed, stepLimit: config.stepLimit, operationLimit: config.operationLimit,
    inputs: {
      initial_controls: initialControls, difference_matrix: differences,
      integration_matrix: integration, horizon: config.horizon, goal,
      dt: config.dt, max_velocity: config.maxVelocityPerAxis,
      max_acceleration: config.maxAccelerationPerAxis,
      acceleration_guard: config.maxAccelerationPerAxis - config.accelerationPenaltyMargin,
      iterations: config.iterations, learning_rate: config.learningRate,
      goal_weight: config.goalWeight, energy_weight: config.energyWeight,
      acceleration_weight: config.accelerationWeight, goal_tolerance: config.goalTolerance,
    },
  });
  const elapsedMs = performance.now() - start;
  const budget = getBudget();
  const [initialLoss, finalLoss, velocityTensor, pathTensor, acceptedNV] = result.records[0].values;
  const measured = simulate(velocityTensor.data, goal);
  assert.equal(measured.accepted, acceptedNV, 'Independent acceptance must match NERVA');
  assert(measured.speedValid, 'Every optimized action has hard speed bounds');
  measured.path.forEach((position, t) => position.forEach((value, axis) =>
    assert(Math.abs(value - pathTensor.data[t][axis]) < config.numericTolerance,
      'Independent scalar integration must match NERVA')));
  const initial = simulate(initialControls, goal);
  const baselineMetrics = simulate(baseline(goal), goal);
  const { path, ...optimized } = measured;
  const { path: initialPath, ...initialMetrics } = initial;
  const { path: baselinePath, ...baselineSummary } = baselineMetrics;
  return { split, goal, initial: initialMetrics, baseline: baselineSummary,
    optimized, initialLoss, finalLoss,
    energyImprovementVsBaselinePercent: optimized.accepted && baselineSummary.accepted && baselineSummary.energy > 0
      ? (baselineSummary.energy - optimized.energy) / baselineSummary.energy * 100 : null,
    velocityPlan: velocityTensor.data,
    execution: { steps: result.steps, tensorOperations: budget.used, elapsedMs } };
}

const started = performance.now();
const cases = [
  ...calibrationGoals.map(goal => solve(goal, 'calibration')),
  ...evaluationGoals.map(goal => solve(goal, 'evaluation')),
];
const evaluation = cases.filter(c => c.split === 'evaluation');
assert(evaluation.some(c => c.optimized.accepted), 'At least one new goal must succeed');
assert(!evaluation.at(-1).optimized.accepted, 'The unreachable goal must be rejected');
assert(evaluation.at(-1).baseline.accelerationValid, 'Baseline respects acceleration even for unreachable goals');
const reachablePerAxis = baseline([100, 0]).reduce((sum, row) => sum + row[0], 0) * config.dt;
assert(evaluation.at(-1).goal[0] > reachablePerAxis + config.goalTolerance);

const output = {
  experiment: 'Differentiable finite-horizon 2D planning with independent verification',
  nervaVersion: VERSION,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  config,
  protocol: {
    calibrationGoals, evaluationGoals,
    frozenBeforeEvaluation: true,
    calibrationUsedFor: 'Sanity checks only; no automated hyperparameter search',
    trainingData: 'None; each supplied goal defines a separate optimization problem',
    physics: 'Kinematic position update p[t+1] = p[t] + dt*v[t], per-axis speed and acceleration bounds, rest at start/end',
    verifiedProperties: ['finite 2D actions', 'speed bound for all steps',
      'acceleration bound including start and final stop', 'endpoint tolerance',
      'agreement of scalar JS simulation with NERVA tensor integration'],
    independentVerifier: 'Scalar JavaScript; accepts/rejects without calling NERVA or consuming its loss',
    baseline: 'Goal-aware trapezoid with hard per-axis speed/acceleration bounds',
    capacityPerAxis: reachablePerAxis,
  },
  summary: {
    calibrationAccepted: cases.filter(c => c.split === 'calibration' && c.optimized.accepted).length,
    calibrationTotal: calibrationGoals.length,
    evaluationAccepted: evaluation.filter(c => c.optimized.accepted).length,
    evaluationTotal: evaluation.length,
    unreachableGoalsRejected: evaluation.filter(c => c.goal.some(v => Math.abs(v) > reachablePerAxis)
      && !c.optimized.accepted).length,
    totalElapsedMs: performance.now() - started,
  },
  cases,
  limitations: [
    'This is a goal-specific local solver, not a model that learned general planning.',
    'Accelerations use a soft loss penalty; independent verification is mandatory.',
    'No obstacles, disturbances, uncertain physics, discrete actions, or real robot are evaluated.',
    'Success on this small frozen set does not establish generalization to arbitrary tasks.',
    'Energy comparisons are meaningful only for accepted plans with comparable endpoint tolerance.',
    'Timing describes this Node process and concurrent environment, not a speedup or performance benchmark.',
  ],
  languageOpportunities: [
    'A reusable differentiable simulator/rollout abstraction with modules.',
    'Constrained optimization or projected updates for hard acceleration limits.',
    'Trajectory types, units, state/action shape contracts, and explicit verification results.',
    'Receding-horizon replanning and robust tests under disturbances before physical control.',
  ],
};
const outIndex = process.argv.indexOf('--out');
if (outIndex >= 0) {
  const destination = resolve(process.argv[outIndex + 1] ?? 'experiments/results/planning.json');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(output, null, 2) + '\n');
}
console.log(JSON.stringify(output, null, 2));
