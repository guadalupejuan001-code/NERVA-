import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgram, VERSION } from '../src/runtime.mjs';

test('exports a version and reports program outputs separately from globals', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  const result = runProgram('nerva 0.2\nconst answer = 6 * 7\nprint("answer", answer)');
  assert.deepEqual(result.records, [{ kind: 'print', values: ['answer', 42], version: '0.2' }]);
  assert.equal(result.globals.answer, 42);
  assert.ok(Number.isSafeInteger(result.steps) && result.steps > 0);
});

test('functions capture lexical scope and each call keeps its own mutable state', () => {
  const { records, globals } = runProgram(`
    let total = 0
    fn counter(start) {
      let value = start
      fn next() {
        value = value + 1
        total = total + 1
        return value
      }
      return next
    }
    const first = counter(10)
    const second = counter(100)
    fn call_with_shadow(next) {
      const value = 900
      return next()
    }
    print(first(), first(), call_with_shadow(first), second(), total)
  `);
  assert.deepEqual(records[0].values, [11, 12, 13, 101, 4]);
  assert.equal(globals.total, 4);
  assert.equal(Object.hasOwn(globals, 'counter'), false);
  assert.equal(Object.hasOwn(globals, 'first'), false);
  assert.equal(Object.hasOwn(globals, 'value'), false);
});

test('nested loops honor continue, break, early return and branch scope', () => {
  const { records, globals } = runProgram(`
    let score = 0
    for row in range(4) {
      if row == 1 { continue }
      let inner = 0
      while inner < 5 {
        inner = inner + 1
        if inner == 2 { continue }
        if inner == 4 { break }
        score = score + row * 10 + inner
      }
    }
    fn find_even(values) {
      for item in values {
        if item / 2 == 2 { return item }
      }
      return null
    }
    if score == 112 { const hidden = "local" }
    print(score, find_even([1, 4, 7]), find_even([1, 3]))
  `);
  assert.deepEqual(records[0].values, [112, 4, null]);
  assert.equal(Object.hasOwn(globals, 'row'), false);
  assert.equal(Object.hasOwn(globals, 'hidden'), false);
});

test('boolean operators short circuit and precedence is stable', () => {
  const { records } = runProgram(`
    fn fail() { assert(false, "must not run") }
    print(false and fail(), true or fail(), not false and 2 < 3)
    print(-2 ^ 2, 2 ^ 3 ^ 2, (2 + 3) * 4, 9 - 3 - 1)
  `);
  assert.deepEqual(records.map(record => record.values), [[false, true, true], [-4, 512, 20, 5]]);
});

test('strings use Unicode character indices, escaped contents and descending ranges', () => {
  const { records } = runProgram(`
    const text = "A😀é"
    print(len(text), text[1], text[2], "quote: \\\"\\n")
    print(range(5, -1, -2), range(2, 2), range(3))
  `);
  assert.deepEqual(records[0].values, [3, '😀', 'é', 'quote: "\n']);
  assert.deepEqual(records[1].values, [[5, 3, 1], [], [0, 1, 2]]);
});

test('JSON inputs are immutable and may drive user functions', () => {
  const { globals } = runProgram(`
    fn average(values) {
      let total = 0
      for number in values { total = total + number }
      return total / len(values)
    }
    const result = average(samples)
  `, { inputs: { samples: [2, 4, 9] } });
  assert.equal(globals.result, 5);
  assert.deepEqual(globals.samples, [2, 4, 9]);
  assert.throws(() => runProgram('samples = [0]', { inputs: { samples: [2] } }), /constante/);
});

test('random initialization repeats with the same seed across independent executions', () => {
  const source = 'const weights = randn([3, 2], 0.1)\nprint(weights)';
  assert.deepEqual(runProgram(source, { seed: 73 }).records, runProgram(source, { seed: 73 }).records);
  assert.notDeepEqual(runProgram(source, { seed: 73 }).records, runProgram(source, { seed: 74 }).records);
  assert.deepEqual(runProgram('seed(73)\n' + source).records, runProgram(source, { seed: 73 }).records);
});

test('language errors retain source locations', () => {
  assert.throws(() => runProgram('const x = 1\nprint(missing)'), error => {
    assert.equal(error.name, 'LangError');
    assert.equal(error.line, 2);
    assert.ok(error.column > 0);
    assert.match(error.message, /missing/);
    return true;
  });
});

const invalidPrograms = [
  ['constants cannot be reassigned', 'const x = 1\nx = 2', /constante/],
  ['parameters cannot be rebound', 'param p = tensor(1)\np = tensor(2)', /constante/],
  ['bindings cannot be duplicated', 'let x = 1\nconst x = 2', /Ya existe/],
  ['conditions require booleans', 'if 1 { print(1) }', /booleana/],
  ['return requires a function', 'return 1', /return solo/],
  ['break requires a loop', 'break', /break solo/],
  ['continue cannot leave a caller loop', 'fn jump() { continue }\nfor x in range(2) { jump() }', /continue solo/],
  ['arity is checked', 'fn twice(x) { return x * 2 }\ntwice()', /espera 1 argumentos/],
  ['range must make progress', 'range(1, 3, 0)', /paso cero/],
  ['indices cannot be negative', 'print([1][-1])', /fuera de rango/],
  ['nonfinite arithmetic is rejected', 'print(1 / 0)', /finito/],
  ['unsupported headers are rejected', 'nerva 0.4\nprint(1)', /0\.2 and 0\.3 headers/],
  ['missing separators are rejected', 'const x = 1 const y = 2', /newline or semicolon/],
];

for (const [name, source, expected] of invalidPrograms) {
  test(name, () => assert.throws(() => runProgram(source), expected));
}

test('step and tensor operation budgets bound execution and reset for later runs', () => {
  assert.throws(() => runProgram('while true {}', { stepLimit: 50 }), /límite de 50 pasos/);
  assert.throws(() => runProgram('const x = ones([20])\nprint(x)', { operationLimit: 10 }), /operation budget/);
  assert.deepEqual(runProgram('print(value(sum(ones([20]))))').records[0].values, [20]);
});

test('source, call depth, output and tensor dimensions have explicit limits', () => {
  assert.throws(() => runProgram('#' + 'x'.repeat(200000)), /Source exceeds/);
  assert.throws(() => runProgram('fn recurse() { return recurse() }\nrecurse()'), /64 niveles de funciones/);
  assert.throws(() => runProgram('for i in range(1001) { print(i) }'), /1000 salidas/);
  assert.throws(() => runProgram('zeros([1001, 1001])'), /at most 1000000 elements/);
  assert.throws(() => runProgram('range(100001)'), /100000 elementos/);
});

test('tensor annotations, shape validation and host values reject incompatible data', () => {
  assert.throws(() => runProgram('const x: Tensor[2, 2] = tensor([1, 2])'), /requiere Tensor\[2,2\]/);
  assert.throws(() => runProgram('tensor([[1, 2], [3]])'), /rectangular/);
  assert.throws(() => runProgram('reshape(tensor([1, 2]), [3])'), /preserve element count/);
  assert.throws(() => runProgram('tensor([1, 2]) + tensor([1, 2, 3])'), /Cannot broadcast/);
  assert.throws(() => runProgram('', { inputs: { print: 1 } }), /Nombre de entrada/);
  assert.deepEqual(runProgram('print(item.nested)', { inputs: { item: { nested: 1 } } }).records[0].values, [1]);
  assert.throws(() => runProgram('', { inputs: { item: Infinity } }), /finito/);
  assert.throws(() => runProgram('', { inputs: { item: () => 1 } }), /JSON/);
  assert.throws(() => runProgram('', { stepLimit: 0 }), /stepLimit/);
  assert.throws(() => runProgram('', { operationLimit: Number.MAX_SAFE_INTEGER + 1 }), /operationLimit/);
  assert.throws(() => runProgram('', { seed: -1 }), /semilla/);
});
