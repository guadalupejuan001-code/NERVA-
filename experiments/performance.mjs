import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { runProgram, prepareProgram, VERSION } from '../src/runtime.mjs';
import * as T from '../src/tensor.mjs';

// Measure the public APIs independently: preparation avoids repeated parsing;
// captureGlobals controls serialization without changing records or steps.
const decoder = await readFile(new URL('../src/conversation_decoder.nv', import.meta.url), 'utf8');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => Number(value.toFixed(6));

function variantsFor(source) {
  const prepared = prepareProgram(source);
  return [
    { name: 'run_program', captureGlobals: true,
      run: options => runProgram(source, { ...options, captureGlobals: true }) },
    { name: 'prepared_program', captureGlobals: true,
      run: options => prepared.run({ ...options, captureGlobals: true }) },
    { name: 'run_records_only', captureGlobals: false,
      run: options => runProgram(source, { ...options, captureGlobals: false }) },
    { name: 'prepared_records_only', captureGlobals: false,
      run: options => prepared.run({ ...options, captureGlobals: false }) },
  ];
}

function inputs(size, iteration = 0) {
  return { scores: Array.from({ length: size }, (_, i) => Math.sin(i * 0.31 + iteration * 0.17)),
    excluded: [0], generated: [1, 2], temperature: 0,
    top_k: 0, top_p: 1, repetition_penalty: 1.1, draw: 0 };
}

function decoderExperiment() {
  const preparationStart = performance.now();
  const variants = variantsFor(decoder);
  const preparationMs = performance.now() - preparationStart;
  // Validate varying controls before timing. Prepared programs reuse their
  // syntax, while inputs, execution state and budgets are fresh for each run.
  let parityCases = 0;
  for (const size of [8, 128, 1024, 8192]) {
    for (const iteration of [0, 1, 2]) {
      for (const temperature of [0, 0.8]) {
        const data = { ...inputs(size, iteration), temperature,
          draw: 0.37, top_k: temperature ? 6 : 0, top_p: temperature ? 0.9 : 1 };
        const expected = variants[0].run({ inputs: data });
        let recordsOnlyOperations;
        for (const candidate of variants.slice(1)) {
          const actual = candidate.run({ inputs: data });
          assert.deepEqual(actual.records, expected.records);
          assert.equal(actual.steps, expected.steps);
          assert(Number.isSafeInteger(actual.tensorOperations) && actual.tensorOperations > 0);
          if (candidate.captureGlobals) {
            assert.deepEqual(actual.globals, expected.globals);
            assert.equal(actual.tensorOperations, expected.tensorOperations);
          } else {
            assert.equal(Object.keys(actual.globals).length, 0);
            if (recordsOnlyOperations !== undefined) assert.equal(actual.tensorOperations, recordsOnlyOperations);
            recordsOnlyOperations = actual.tensorOperations;
          }
        }
        parityCases++;
      }
    }
  }
  for (const value of [1, 2, 3]) {
    for (const candidate of variantsFor(`print(${value})`)) {
      assert.deepEqual(candidate.run({}).records[0].values, [value]);
    }
  }
  for (const candidate of variantsFor('print(unknown)')) assert.throws(() => candidate.run({}));
  for (const candidate of variantsFor('print(tensor64([1,2]))')) {
    assert.throws(() => candidate.run({ operationLimit: 1 }));
    assert.deepEqual(candidate.run({}).records[0].values[0].data, [1, 2]);
  }
  const results = [];
  for (const [size, calls] of [[128, 160], [1024, 100], [8192, 40]]) {
    const data = inputs(size);
    for (let warmup = 0; warmup < 20; warmup++) {
      for (const candidate of variants) candidate.run({ inputs: data });
    }
    const samples = Object.fromEntries(variants.map(candidate => [candidate.name, []]));
    for (let repetition = 0; repetition < 5; repetition++) {
      // Rotate order so no variant always runs first; inputs are built before
      // timing. These are in-process greedy decoder measurements, not full LLM
      // generation or Node startup/pipe transfer measurements.
      for (let offset = 0; offset < variants.length; offset++) {
        const candidate = variants[(repetition + offset) % variants.length];
        const start = performance.now();
        for (let call = 0; call < calls; call++) candidate.run({ inputs: data });
        samples[candidate.name].push((performance.now() - start) / calls);
      }
    }
    const measurements = Object.fromEntries(variants.map(candidate => [candidate.name, {
      medianMsPerDecision: round(median(samples[candidate.name])),
      samplesMsPerDecision: samples[candidate.name].map(round),
      speedupVsRunProgram: round(median(samples.run_program) / median(samples[candidate.name])),
    }]));
    const ratio = (before, after) => round(median(samples[before]) / median(samples[after]));
    results.push({ vocabularySize: size, callsPerRound: calls, rounds: 5, measurements,
      isolatedComparisons: {
        preparationWithGlobals: ratio('run_program', 'prepared_program'),
        preparationWithoutGlobals: ratio('run_records_only', 'prepared_records_only'),
        omitGlobalsWithoutPreparation: ratio('run_program', 'run_records_only'),
        omitGlobalsWithPreparation: ratio('prepared_program', 'prepared_records_only'),
      } });
  }
  return { hypothesis: 'Avoid repeated parsing and exporting unused globals on a fixed decoder path.',
    preparationMs: round(preparationMs), parityCases,
    preparedSourceIsolationAndBudgetChecks: true, results,
    scope: 'Public runProgram and prepareProgram(...).run APIs with captureGlobals true/false; same records/steps on tested decoder inputs. Preparation occurs outside repeated-run timings.',
    limitations: 'No full conversation or system speedup established. Omitting globals changes the returned global exports and their serialization cost; results describe in-process token decisions only.' };
}

function fused(x, weight, bias) {
  const result = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) result[i] = Math.tanh(x[i] * weight + bias);
  return result;
}

function fusionExperiment() {
  const results = [];
  for (const [size, calls] of [[8192, 24], [65536, 4]]) {
    T.resetBudget();
    const values = Float64Array.from({ length: size }, (_, i) => Math.sin(i * 0.13));
    const tensor = T.fromFlat(values, [size], 'f64');
    const generic = () => T.tanh(T.add(T.mul(tensor, 0.73), -0.17)).data;
    const specialized = () => fused(values, 0.73, -0.17);
    T.resetBudget();
    assert.deepEqual(generic(), specialized());
    for (let warmup = 0; warmup < 10; warmup++) { T.resetBudget(); generic(); specialized(); }
    const samples = { generic: [], fused: [] };
    let checksum = 0;
    for (let repetition = 0; repetition < 5; repetition++) {
      for (const name of repetition % 2 ? ['fused', 'generic'] : ['generic', 'fused']) {
        T.resetBudget();
        const fn = name === 'generic' ? generic : specialized;
        const start = performance.now();
        for (let call = 0; call < calls; call++) checksum += fn()[size - 1];
        samples[name].push((performance.now() - start) / calls);
      }
    }
    assert.ok(Number.isFinite(checksum));
    results.push({ elements: size, dtype: 'f64', callsPerRound: calls, rounds: 5,
      exactForwardParity: true,
      medianMsPerCall: { generic: round(median(samples.generic)), fused: round(median(samples.fused)) },
      speedup: round(median(samples.generic) / median(samples.fused)),
      samplesMsPerCall: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, values.map(round)])) });
  }
  return { expression: 'tanh(x * 0.73 - 0.17)', results,
    scope: 'Handwritten inference-only JavaScript kernel, not an implemented NERVA compiler.',
    limitations: 'Fused prototype bypasses tensor validation/accounting and has no backward pass. Speedups mix fewer allocations, fewer checks and fewer traversals; production must preserve errors, budgets and gradients.' };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node experiments/performance.mjs [--out result.json]');
  const report = { experiment: 'execution_scaling', runtimeVersion: VERSION,
    environment: { node: process.version, cpu: cpus()[0]?.model, logicalCPUs: cpus().length },
    timingPolicy: 'Run after other experiments finish; alternating/rotated order and medians of five rounds.',
    decoder: decoderExperiment(), fusion: fusionExperiment() };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (args.length) await writeFile(args[1], text);
  process.stdout.write(text);
}

main().catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; });
