#!/usr/bin/env node
// Reproduce with: node experiments/learning.mjs --out experiments/results/learning.json
// Model training and Adam updates execute in NERVA, not in JavaScript.
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProgram, VERSION } from '../src/runtime.mjs';

const specification = Object.freeze({
  seeds: [7, 42, 2026],
  iterations: 300,
  trainSamples: 64,
  heldoutSamples: 64,
  trainThreshold: 0.001,
  noiseAmplitude: 0.03,
  stepLimit: 200000,
  operationLimit: 20000000,
  cpuLimitMs: 120000,
});

const configurations = [
  { id: 'sgd_raw', optimizer: 'sgd', standardize: false, learningRate: 0.002 },
  { id: 'adam_raw', optimizer: 'adam', standardize: false, learningRate: 0.05, beta1: 0.9, beta2: 0.999, epsilon: 1e-8 },
  { id: 'sgd_standardized', optimizer: 'sgd', standardize: true, learningRate: 0.2 },
];

function dataset(size, heldout) {
  const features = [], labels = [];
  for (let index = 0; index < size; index++) {
    const angle = 2 * Math.PI * (index + (heldout ? 0.5 : 0)) / size;
    const radius = heldout ? 0.7 + 0.6 * ((index * 17) % size) / (size - 1) : 1;
    const x1 = radius * Math.sin(angle);
    const x2 = radius * 20 * Math.cos(angle);
    const noise = specification.noiseAmplitude * Math.sin(3 * angle + 0.2);
    features.push([x1, x2]);
    labels.push([1.5 * x1 - 0.7 * x2 + 0.3 + noise]);
  }
  return { features, labels };
}

// Both splits and all hyperparameters are fixed before any model is trained.
// Heldout loss is evaluated once per run, after the final parameter update.
const train = dataset(specification.trainSamples, false);
const heldout = dataset(specification.heldoutSamples, true);

function program(configuration) {
  const adam = configuration.optimizer === 'adam';
  const scale = configuration.standardize ? '[1, 20]' : '[1, 1]';
  const update = adam ? `
    const gw = grad(weight)
    const gb = grad(bias)
    mw = ${configuration.beta1} * mw + ${1 - configuration.beta1} * gw
    mb = ${configuration.beta1} * mb + ${1 - configuration.beta1} * gb
    vw = ${configuration.beta2} * vw + ${1 - configuration.beta2} * gw ^ 2
    vb = ${configuration.beta2} * vb + ${1 - configuration.beta2} * gb ^ 2
    const correction1 = 1 - ${configuration.beta1} ^ iteration
    const correction2 = 1 - ${configuration.beta2} ^ iteration
    const update_w = (mw / correction1) / (sqrt(vw / correction2) + ${configuration.epsilon})
    const update_b = (mb / correction1) / (sqrt(vb / correction2) + ${configuration.epsilon})
    zero_grad([weight, bias])
    # A linear surrogate supplies the chosen update direction to existing step().
    # detach preserves the snapshot; Adam needs no privileged parameter mutation.
    const surrogate = sum(weight * detach(update_w)) + sum(bias * detach(update_b))
    backward(surrogate)
    step([weight, bias], learning_rate)
  ` : 'step([weight, bias], learning_rate)';
  return `nerva 0.2
    const scale = tensor64(${scale})
    const train_x = tensor64(train_features) / scale
    const train_y = tensor64(train_labels)
    const heldout_x = tensor64(heldout_features) / scale
    const heldout_y = tensor64(heldout_labels)
    # Multiply normalized weights so every configuration starts with the same predictions.
    param weight: Tensor[2, 1] = tensor64(randn([2, 1], 0.25)) * reshape(scale, [2, 1])
    param bias: Tensor[1] = tensor64(randn([1], 0.25))
    ${adam ? `let mw = zeros([2, 1], "f64")
    let mb = zeros([1], "f64")
    let vw = zeros([2, 1], "f64")
    let vb = zeros([1], "f64")` : ''}
    const initial_train_loss = value(mse(train_x @ weight + bias, train_y))
    let previous_loss = initial_train_loss
    let first_step_at_threshold = null
    let loss_increases = 0
    let report_at = 1
    for epoch in range(iterations) {
      const iteration = epoch + 1
      zero_grad([weight, bias])
      const loss = mse(train_x @ weight + bias, train_y)
      backward(loss)
      ${update}
      const current_loss = value(mse(train_x @ weight + bias, train_y))
      if current_loss > previous_loss + 0.000000000001 { loss_increases = loss_increases + 1 }
      if first_step_at_threshold == null and current_loss <= train_threshold { first_step_at_threshold = iteration }
      if iteration == report_at or iteration == iterations {
        print("progress", iteration, current_loss)
        report_at = report_at + 25
      }
      previous_loss = current_loss
    }
    const train_loss = value(mse(train_x @ weight + bias, train_y))
    const heldout_loss = value(mse(heldout_x @ weight + bias, heldout_y))
    const raw_weight = weight / reshape(scale, [2, 1])
    const fitted_bias = value(bias[0])
  `;
}

function cpuMs(start) {
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

function rounded(value) { return Math.round(value * 1000) / 1000; }

function distribution(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    sample_stddev: values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null,
  };
}

export function runLearningExperiment() {
  const experimentCpuStart = process.cpuUsage();
  const experimentWallStart = performance.now();
  const runs = [];
  for (const configuration of configurations) {
    for (const seed of specification.seeds) {
      if (cpuMs(experimentCpuStart) >= specification.cpuLimitMs) {
        runs.push({ configuration: configuration.id, seed, status: 'skipped', error: 'Experiment CPU allowance exhausted' });
        continue;
      }
      const runCpuStart = process.cpuUsage();
      const runWallStart = performance.now();
      try {
        const { globals, records, steps } = runProgram(program(configuration), {
          seed,
          stepLimit: specification.stepLimit,
          operationLimit: specification.operationLimit,
          inputs: {
            train_features: train.features,
            train_labels: train.labels,
            heldout_features: heldout.features,
            heldout_labels: heldout.labels,
            iterations: specification.iterations,
            train_threshold: specification.trainThreshold,
            learning_rate: configuration.learningRate,
          },
        });
        runs.push({
          configuration: configuration.id,
          seed,
          status: 'ok',
          initial_train_loss: globals.initial_train_loss,
          train_loss: globals.train_loss,
          heldout_loss: globals.heldout_loss,
          first_step_at_threshold: globals.first_step_at_threshold,
          loss_increases: globals.loss_increases,
          fitted_weight_in_raw_units: globals.raw_weight.data.flat(),
          fitted_bias: globals.fitted_bias,
          iterations: specification.iterations,
          interpreter_steps: steps,
          wall_ms: rounded(performance.now() - runWallStart),
          cpu_ms: rounded(cpuMs(runCpuStart)),
          train_trace: records.map(record => ({ iteration: record.values[1], loss: record.values[2] })),
        });
      } catch (error) {
        runs.push({
          configuration: configuration.id, seed, status: 'failed',
          error: error.message, line: error.line ?? null, column: error.column ?? null,
          wall_ms: rounded(performance.now() - runWallStart), cpu_ms: rounded(cpuMs(runCpuStart)),
        });
      }
    }
  }
  const summaries = configurations.map(configuration => {
    const matching = runs.filter(run => run.configuration === configuration.id);
    const successful = matching.filter(run => run.status === 'ok');
    const reached = successful.filter(run => run.first_step_at_threshold !== null);
    return {
      configuration: configuration.id,
      successful_runs: successful.length,
      failed_or_skipped_runs: matching.length - successful.length,
      train_loss: successful.length ? distribution(successful.map(run => run.train_loss)) : null,
      heldout_loss: successful.length ? distribution(successful.map(run => run.heldout_loss)) : null,
      threshold_reached_runs: reached.length,
      first_step_at_threshold: reached.length ? distribution(reached.map(run => run.first_step_at_threshold)) : null,
    };
  });
  return {
    experiment: 'nerva-conditioned-regression',
    format_version: 1,
    runtime_version: VERSION,
    node_version: process.version,
    hypothesis: 'With differently scaled features, Adam may reach low loss sooner than SGD with one raw-coordinate learning rate. Explicit feature scaling may also remove this difficulty without Adam.',
    specification,
    configurations,
    dataset: {
      target_formula: 'y = 1.5*x1 - 0.7*x2 + 0.3 + 0.03*sin(3*angle+0.2)',
      train_features: train.features,
      train_labels: train.labels,
      heldout_features: heldout.features,
      heldout_labels: heldout.labels,
      separation: '64 train angles; 64 distinct half-step heldout angles with radii ranging from 0.7 to 1.3. Both splits were fixed before training.',
      train_feature_hessian_eigenvalues: [1, 400],
      train_noise_mse_at_true_parameters: specification.noiseAmplitude ** 2 / 2,
    },
    protocol: {
      tuning: 'None. All three configurations, 300 iterations and seeds were declared before execution; no heldout-guided adjustments.',
      initialization: 'Same seeded randn predictions in all configurations; f32 random samples are copied into f64 trainable parameters.',
      adam_implementation: 'NERVA grad, moments, bias correction and tensor primitives; backward of a linear surrogate followed by existing step applies its update.',
      threshold: 'First post-update train MSE <= 0.001; null means not reached within 300 iterations.',
      timings: 'Context only. Other agents can run concurrently; these wall/CPU times are not a controlled optimizer speed comparison.',
      repeatability: 'Datasets, seeds and numeric results are deterministic; timing fields and Node version may vary between machines.',
    },
    runs,
    summaries,
    total_wall_ms: rounded(performance.now() - experimentWallStart),
    total_cpu_ms: rounded(cpuMs(experimentCpuStart)),
    limitations: [
      'This is one small synthetic linear regression task and three initializations; it does not establish superiority across tasks or architectures.',
      'Learning rates differ by declared configuration and were not exhaustively optimized. Results compare these configurations, not equal-cost optimizer budgets.',
      'Adam needs extra interpreter work for moments and the surrogate. No runtime primitive or external tensor library was added.',
      'Heldout points test this predefined function at unseen coordinates; they do not measure conversation quality, language modeling or performance at large model scale.',
      'The two-minute CPU guard prevents starting additional runs after the allowance; each synchronous run is separately bounded by interpreter and tensor budgets.',
    ],
  };
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write('Usage: node experiments/learning.mjs [--out result.json]\n');
    return;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--out' && args[1] && !args[1].startsWith('--'))) {
    throw new Error('Usage: node experiments/learning.mjs [--out result.json]');
  }
  const result = runLearningExperiment();
  const json = JSON.stringify(result, null, 2) + '\n';
  if (args.length) {
    const output = resolve(args[1]);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
  }
  process.stdout.write(json);
  if (result.runs.some(run => run.status !== 'ok')) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  });
}
