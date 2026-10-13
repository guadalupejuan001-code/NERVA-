#!/usr/bin/env node
// Bounded enumerative synthesis over a small, explicit grammar.
// The search receives training pairs, never a target function or held-out data.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runProgram, VERSION } from '../src/runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const grammar = Object.freeze({
  variable: 'x',
  constants: Object.freeze([-2, -1, 0, 1, 2, 3]),
  binaryOperators: Object.freeze(['+', '-', '*', '/']),
  complexity: 'One node per variable, constant or binary operator.',
});
const defaults = Object.freeze({ maxCandidates: 30000, maxMilliseconds: 15000, maxComplexity: 9 });
const interpreterLimits = Object.freeze({ stepLimit: 1000, operationLimit: 10000 });
const digest = value => createHash('sha256').update(value).digest('hex');

function argumentsFrom(args) {
  const options = { ...defaults, out: null };
  const names = new Map([
    ['--max-candidates', ['maxCandidates', 1, 100000]],
    ['--max-ms', ['maxMilliseconds', 1, 45000]],
    ['--max-complexity', ['maxComplexity', 1, 11]],
  ]);
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Falta el valor de ${name}`);
    if (name === '--out') { options.out = resolve(value); continue; }
    const specification = names.get(name);
    if (!specification) throw new Error(`Opción desconocida: ${name}`);
    const [key, minimum, maximum] = specification;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
      throw new Error(`${name} debe ser un entero entre ${minimum} y ${maximum}`);
    options[key] = number;
  }
  return options;
}

function freezePairs(xs, target) {
  return Object.freeze(xs.map(x => Object.freeze({ x, y: target(x) })));
}

function makeFixtures() {
  // Only this fixture harness knows the reference rules. Search receives the
  // frozen TRAIN pairs, not these functions, task names, or held-out inputs.
  const trainingInputs = Object.freeze([-2, -1, 0, 1, 2]);
  const heldOutInputs = Object.freeze([-3.5, -0.5, 0.5, 3.5, 5]);
  const targets = [
    ['affine', x => 2 * x + 1],
    ['quadratic', x => x * x - 2 * x + 3],
  ];
  return targets.map(([name, target]) => ({
    name,
    train: freezePairs(trainingInputs, target),
    heldOut: freezePairs(heldOutInputs, target),
  }));
}

function sourceFor(expression) {
  return `nerva 0.2\nfn predict(x) { return ${expression} }\nfor point in points { print(predict(point)) }`;
}

function execute(expression, points) {
  const result = runProgram(sourceFor(expression), {
    ...interpreterLimits,
    inputs: { points: points.map(point => point.x) },
  });
  if (result.records.length !== points.length) throw new Error('Unexpected prediction count');
  return result.records.map(record => {
    if (record.kind !== 'print' || record.values.length !== 1 || !Number.isFinite(record.values[0]))
      throw new Error('Unexpected prediction record');
    return record.values[0];
  });
}

function metrics(points, predictions) {
  const errors = points.map((point, index) => predictions[index] - point.y);
  const mse = errors.reduce((total, error) => total + error * error, 0) / points.length;
  if (!Number.isFinite(mse)) throw new Error('Non-finite evaluation loss');
  return {
    mse,
    maximumAbsoluteError: Math.max(...errors.map(Math.abs)),
    exactWithin1e12: errors.filter(error => Math.abs(error) <= 1e-12).length,
    points: points.map((point, index) => ({ ...point, prediction: predictions[index] })),
  };
}

function search(train, options) {
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const levels = new Map();
  const seenSyntax = new Set();
  const seenTrainingBehavior = new Set();
  const stats = { candidates: 0, valid: 0, errors: 0, duplicateTrainingBehavior: 0, retained: 0 };
  const errorSamples = [];
  let best = null;
  let stopReason = 'grammar_complexity_budget';

  function consider(expression, complexity, pool) {
    if (stats.candidates >= options.maxCandidates) { stopReason = 'candidate_budget'; return false; }
    if (performance.now() - started >= options.maxMilliseconds) { stopReason = 'time_budget'; return false; }
    if (seenSyntax.has(expression)) return true;
    seenSyntax.add(expression);
    stats.candidates++;
    try {
      const predictions = execute(expression, train);
      const score = metrics(train, predictions).mse;
      stats.valid++;
      // Rank by training accuracy first, grammar complexity second. Enumeration
      // order resolves remaining ties deterministically without held-out data.
      if (!best || score < best.trainMse || (score === best.trainMse && complexity < best.complexity))
        best = { expression, complexity, trainMse: score };
      if (score === 0) { stopReason = 'exact_training_fit'; return false; }
      const behavior = JSON.stringify(predictions);
      if (seenTrainingBehavior.has(behavior)) {
        stats.duplicateTrainingBehavior++;
      } else {
        seenTrainingBehavior.add(behavior);
        pool.push({ expression, complexity });
        stats.retained++;
      }
    } catch (error) {
      stats.errors++;
      if (errorSamples.length < 3) errorSamples.push({ expression, error: error.message });
    }
    return true;
  }

  outer: for (let complexity = 1; complexity <= options.maxComplexity; complexity += 2) {
    const pool = [];
    if (complexity === 1) {
      for (const expression of [grammar.variable, ...grammar.constants.map(String)])
        if (!consider(expression, complexity, pool)) break outer;
    } else {
      for (let leftCost = 1; leftCost < complexity - 1; leftCost += 2) {
        const rightCost = complexity - leftCost - 1;
        for (const left of levels.get(leftCost) ?? []) {
          for (const right of levels.get(rightCost) ?? []) {
            for (const operator of grammar.binaryOperators) {
              // Canonicalize commutative operands to avoid equivalent syntax.
              const operands = (operator === '+' || operator === '*') && left.expression > right.expression
                ? [right.expression, left.expression] : [left.expression, right.expression];
              const expression = `(${operands[0]} ${operator} ${operands[1]})`;
              if (!consider(expression, complexity, pool)) break outer;
            }
          }
        }
      }
    }
    levels.set(complexity, pool);
  }
  const cpu = process.cpuUsage(cpuStarted);
  return {
    ...stats,
    stopReason,
    elapsedMilliseconds: Number((performance.now() - started).toFixed(3)),
    cpuMilliseconds: Number(((cpu.user + cpu.system) / 1000).toFixed(3)),
    selected: best,
    errorSamples,
    pruning: 'Keep only the first expression for each exact TRAIN prediction vector; held-out behavior is never used.',
  };
}

function nearestTable(train, points) {
  // Deliberately simple memorization control: store labels, then return the
  // nearest observed label. Lower training x wins a distance tie.
  return points.map(point => {
    let nearest = train[0];
    for (const row of train) if (Math.abs(row.x - point.x) < Math.abs(nearest.x - point.x)) nearest = row;
    return nearest.y;
  });
}

function evaluateSelected(selected, points) {
  if (!selected) return { error: 'No valid candidate was found' };
  try { return metrics(points, execute(selected.expression, points)); }
  catch (error) { return { error: error.message }; }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  // Both held-out sets are frozen and hashed before any search begins.
  const fixtures = makeFixtures();
  const partitions = fixtures.map(task => ({
    name: task.name,
    trainSha256: digest(JSON.stringify(task.train)),
    heldOutSha256: digest(JSON.stringify(task.heldOut)),
    trainInputs: task.train.map(point => point.x),
    heldOutInputs: task.heldOut.map(point => point.x),
  }));
  const tasks = fixtures.map(task => {
    const synthesis = search(task.train, options);
    // The selected program is fixed before evaluating outside TRAIN.
    return {
      name: task.name,
      synthesis,
      selectedProgram: synthesis.selected ? sourceFor(synthesis.selected.expression) : null,
      train: evaluateSelected(synthesis.selected, task.train),
      heldOut: evaluateSelected(synthesis.selected, task.heldOut),
      memorizedNearestTable: {
        train: metrics(task.train, nearestTable(task.train, task.train)),
        heldOut: metrics(task.heldOut, nearestTable(task.train, task.heldOut)),
      },
    };
  });
  const report = {
    experiment: 'bounded-program-synthesis-v1',
    runtimeVersion: VERSION,
    runtimeSha256: digest(await readFile(resolve(root, 'src/runtime.mjs'))),
    nodeVersion: process.version,
    scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))),
    grammar,
    budgetsPerTask: { maxCandidates: options.maxCandidates, maxMilliseconds: options.maxMilliseconds, maxComplexity: options.maxComplexity },
    interpreterLimitsPerCandidate: interpreterLimits,
    selection: 'Training MSE first, then grammar node count; stop at the first exact fit in increasing complexity.',
    partitions,
    tasks,
    interpretation: [
      'This searches a hand-written arithmetic grammar using black-box examples; it does not train neural weights.',
      'The target functions and frozen held-out pairs are accessible to the fixture harness only, not to the search interface.',
      'Equivalent TRAIN behavior can conceal different out-of-sample behavior; behavioral pruning is an efficiency heuristic, not a proof.',
      'A finite held-out check validates these points only, not every input or general autonomous programming.',
      'The memorization control is a table with nearest-neighbor fallback, not a trained competing model.',
    ],
    nextStep: 'Scale to typed, guided synthesis with independent verification and counterexamples; retain explicit search and runtime budgets.',
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, json);
  }
  process.stdout.write(json);
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
});
