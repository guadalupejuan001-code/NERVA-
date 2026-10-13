import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runProgram, runSource2, VERSION } from '../src/runtime.mjs';
import { prepareTokenSelector } from '../src/token_selector.mjs';
import { getBudget } from '../src/tensor.mjs';
import * as T from '../src/tensor.mjs';

const source = readFileSync(new URL('../src/conversation_decoder.nv', import.meta.url), 'utf8');
const select = prepareTokenSelector(source);
const defaults = {scores: [1, 2, 3], excluded: [], generated: [], temperature: 0,
  top_k: 0, top_p: 1, repetition_penalty: 1, draw: 0.5};

test('specialized selection has exact tokens and operation charges across controls and vocabulary sizes', () => {
  let cases = 0;
  for (const size of [1, 3, 128, 2048, 8192, 65536]) {
    for (const temperature of [0, 0.000001, 0.8, 2]) {
      for (const draw of [0, 0.25, 0.5, 0.9999999999999999]) {
        for (const top_k of [0, 1, 7]) {
          const input = {...defaults, scores: Array.from({length: size}, (_, i) => i % 3 ? Math.sin(i * .31) : 0),
            excluded: size > 1 ? [0, 0] : [], generated: [size - 1, size - 1],
            repetition_penalty: 1.3, top_p: .8, top_k, temperature, draw};
          const before = structuredClone(input);
          const expected = runProgram(source, {inputs: input});
          const budget = getBudget();
          assert.equal(select(input), expected.records[0].values[1]);
          assert.deepEqual(getBudget(), budget);
          assert.deepEqual(input, before);
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 288);
});

test('preserves operation and step boundaries and resets budgets after exceptions', () => {
  const expected = runProgram(source, {inputs: defaults});
  const charged = expected.tensorOperations ?? getBudget().used;
  for (let stepLimit = 1; stepLimit < expected.steps; stepLimit++) {
    assert.throws(() => runProgram(source, {inputs: defaults, stepLimit}));
    assert.throws(() => select(defaults, {stepLimit}));
  }
  assert.equal(select(defaults, {stepLimit: expected.steps, operationLimit: charged}), 2);
  for (const options of [{operationLimit: charged - 1}, {operationLimit: 0}, {operationLimit: 20000001},
      {stepLimit: 200001}, {stepLimit: 0}, {operationLimit: 1.5}, {stepLimit: NaN}]) {
    if (VERSION === '0.2.0' || !(options.operationLimit > 20000000 || options.stepLimit > 200000))
      assert.throws(() => runProgram(source, {inputs: defaults, ...options}));
    assert.throws(() => select(defaults, options));
    assert.equal(select(defaults), 2);
  }
});

test('rejects invalid values and executable input and refuses a changed fixed program', () => {
  for (const changes of [{scores: []}, {scores: [[1, 2]]}, {scores: [NaN]}, {scores: [Infinity]},
      {scores: new Float64Array([1])}, {scores: [null]}, {scores: Array(3)}, {scores: Array(65537).fill(0)},
      {excluded: [3]}, {excluded: [0, 1, 2]}, {generated: [-1]}, {generated: [1.5]},
      {generated: Array(4097).fill(1)}, {excluded: [null]}, {draw: 1}, {top_p: 0},
      {top_k: 1.5}, {temperature: -1}, {temperature: '1'}, {repetition_penalty: 3},
      {source: 'print(1)'}, {node: 'sh'}, {scores: {value: 1}}]) {
    assert.throws(() => select({...defaults, ...changes}));
    assert.equal(select(defaults), 2);
  }
  for (const input of [null, [], {}, {...defaults, draw: undefined}]) assert.throws(() => select(input));
  assert.throws(() => prepareTokenSelector(source.replace('tensor64', 'tensor')), /Unsupported fixed decoder/);
  assert.throws(() => prepareTokenSelector(source + '\nprint(999)'), /Unsupported fixed decoder/);
  assert.throws(() => prepareTokenSelector(' '.repeat(200001)), /Source exceeds/);
});

test('public interpreter still exports globals and outputs without changing its API', () => {
  const result = runProgram(source, {inputs: defaults});
  assert.deepEqual(Object.keys(result).sort(), VERSION === '0.2.0' ? ['globals', 'records', 'steps'] :
    ['globals', 'records', 'steps', 'tensorOperations']);
  assert.deepEqual(result.globals.scores, defaults.scores);
  assert.deepEqual(result.globals.logits.data, defaults.scores);
  assert.deepEqual(runSource2(source, {inputs: defaults}), result.records);
});

test('rejects JSON accessors and hidden executable values without invoking them', () => {
  let calls = 0;
  const input = {...defaults};
  Object.defineProperty(input, 'scores', {get() {calls++; return [1];}, enumerable: true});
  assert.throws(() => select(input));
  const scores = [1, 2, 3];
  Object.defineProperty(scores, '0', {get() {calls++; return 1;}, enumerable: true});
  assert.throws(() => select({...defaults, scores}));
  assert.equal(calls, 0);
  assert.throws(() => select({...defaults, [Symbol('code')]: () => 1}));
  assert.throws(() => select(Object.assign(Object.create({code() {}}), defaults)));
  assert.throws(() => select({...defaults, scores: Object.assign([1, 2], {code() {}})}));
});

test('on 0.3 the specialization preserves enclosing budgets on success and failure', {skip: !T.withBudget}, () => {
  const caller = T.createBudget(100);
  T.withBudget(caller, () => {
    T.ones([3]);
    const before = getBudget();
    assert.equal(select(defaults), 2);
    assert.deepEqual(getBudget(), before);
    assert.throws(() => select(defaults, {operationLimit: 1}));
    assert.deepEqual(getBudget(), before);
    const charged = runProgram(source, {inputs: defaults}).tensorOperations;
    assert.equal(select(defaults, {operationLimit: charged}), 2);
    assert.throws(() => select(defaults, {operationLimit: charged - 1}));
    assert.deepEqual(getBudget(), before);
  });
});
