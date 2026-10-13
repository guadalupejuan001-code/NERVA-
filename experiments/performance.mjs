import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runProgram } from '../src/runtime.mjs';
import * as T from '../src/tensor.mjs';

// Experimental copies live in a temporary directory. The canonical runtime and
// its full API remain unchanged. These variants intentionally omit globals only
// on the internal decoder path where the host consumes records and steps.
const sourceURL = new URL('../src/runtime.mjs', import.meta.url);
const decoder = await readFile(new URL('../src/conversation_decoder.nv', import.meta.url), 'utf8');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => Number(value.toFixed(6));

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected exactly one occurrence: ${before}`);
  return source.replace(before, after);
}

function variant(source, cacheAST, recordsOnly) {
  source = replaceOnce(source, "from './parser.mjs'", `from ${JSON.stringify(new URL('../src/parser.mjs', import.meta.url).href)}`);
  source = replaceOnce(source, "from './tensor.mjs'", `from ${JSON.stringify(new URL('../src/tensor.mjs', import.meta.url).href)}`);
  if (cacheAST) {
    source = 'let cachedSource = null, cachedAST = null;\n' + source;
    source = replaceOnce(source, 'const ast = parse(source);',
      'const ast = source === cachedSource ? cachedAST : (cachedAST = parse(source), cachedSource = source, cachedAST);');
  }
  if (recordsOnly) {
    source = replaceOnce(source, 'for (const [name, binding] of global.bindings) {',
      'for (const [name, binding] of []) {');
  }
  return source;
}

function inputs(size, iteration = 0) {
  return { scores: Array.from({ length: size }, (_, i) => Math.sin(i * 0.31 + iteration * 0.17)),
    excluded: [0], generated: [1, 2], temperature: 0,
    top_k: 0, top_p: 1, repetition_penalty: 1.1, draw: 0 };
}

async function decoderExperiment(directory) {
  const original = await readFile(sourceURL, 'utf8');
  const variants = [{ name: 'original', run: runProgram }];
  for (const [name, cache, records] of [
    ['cache_ast', true, false], ['records_only', false, true], ['cache_ast_records_only', true, true],
  ]) {
    const file = join(directory, name + '.mjs');
    await writeFile(file, variant(original, cache, records));
    const module = await import(pathToFileURL(file).href);
    variants.push({ name, run: module.runProgram });
  }
  // Validate varying controls before timing. AST caches must also invalidate
  // when the source changes; the original public API is not being replaced.
  let parityCases = 0;
  for (const size of [8, 128, 1024, 8192]) {
    for (const iteration of [0, 1, 2]) {
      for (const temperature of [0, 0.8]) {
        const data = { ...inputs(size, iteration), temperature,
          draw: 0.37, top_k: temperature ? 6 : 0, top_p: temperature ? 0.9 : 1 };
        const expected = runProgram(decoder, { inputs: data });
        for (const candidate of variants.slice(1)) {
          const actual = candidate.run(decoder, { inputs: data });
          assert.deepEqual(actual.records, expected.records);
          assert.equal(actual.steps, expected.steps);
          if (candidate.name.includes('records_only')) assert.equal(Object.keys(actual.globals).length, 0);
        }
        parityCases++;
      }
    }
  }
  for (const candidate of variants.slice(1)) {
    assert.deepEqual(candidate.run('print(1)').records[0].values, [1]);
    assert.deepEqual(candidate.run('print(2)').records[0].values, [2]);
    assert.throws(() => candidate.run('print(unknown)'));
    assert.deepEqual(candidate.run('print(3)').records[0].values, [3]);
    assert.throws(() => candidate.run('print(tensor64([1,2]))', { operationLimit: 1 }));
  }
  const results = [];
  for (const [size, calls] of [[128, 160], [1024, 100], [8192, 40]]) {
    const data = inputs(size);
    for (let warmup = 0; warmup < 20; warmup++) {
      for (const candidate of variants) candidate.run(decoder, { inputs: data });
    }
    const samples = Object.fromEntries(variants.map(candidate => [candidate.name, []]));
    for (let repetition = 0; repetition < 5; repetition++) {
      // Rotate order so no variant always runs first; inputs are built before
      // timing. These are in-process greedy decoder measurements, not full LLM
      // generation or Node startup/pipe transfer measurements.
      for (let offset = 0; offset < variants.length; offset++) {
        const candidate = variants[(repetition + offset) % variants.length];
        const start = performance.now();
        for (let call = 0; call < calls; call++) candidate.run(decoder, { inputs: data });
        samples[candidate.name].push((performance.now() - start) / calls);
      }
    }
    const measurements = Object.fromEntries(variants.map(candidate => [candidate.name, {
      medianMsPerDecision: round(median(samples[candidate.name])),
      samplesMsPerDecision: samples[candidate.name].map(round),
      speedupVsOriginal: round(median(samples.original) / median(samples[candidate.name])),
    }]));
    results.push({ vocabularySize: size, callsPerRound: calls, rounds: 5, measurements });
  }
  return { hypothesis: 'Avoid repeated parsing and exporting unused globals on a fixed decoder path.',
    parityCases, cacheInvalidationAndBudgetChecks: true, results,
    scope: 'Temporary prototype, same records/steps on tested decoder inputs. records_only changes global export semantics and is not a public API replacement.',
    limitations: 'No full conversation speedup established; production needs a separate prepared/records-only API and all compatibility checks.' };
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
  const directory = await mkdtemp(join(tmpdir(), 'nerva-performance-'));
  try {
    const report = { experiment: 'execution_scaling', runtimeVersion: '0.2.0',
      environment: { node: process.version, cpu: cpus()[0]?.model, logicalCPUs: cpus().length },
      timingPolicy: 'Run after other experiments finish; alternating/rotated order and medians of five rounds.',
      decoder: await decoderExperiment(directory), fusion: fusionExperiment() };
    const text = JSON.stringify(report, null, 2) + '\n';
    if (args.length) await writeFile(args[1], text);
    process.stdout.write(text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; });
