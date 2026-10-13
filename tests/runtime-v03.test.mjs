import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProgram, runProgram, VERSION } from '../src/runtime.mjs';

const v03 = source => `nerva 0.3\n${source}`;
const json = value => JSON.parse(JSON.stringify(value));
const outputs = (source, options) => json(runProgram(v03(source), options).records.map(record => record.values));

test('0.3 runtime preserves legacy record versions and exposes operation usage', () => {
  assert.equal(VERSION, '0.3.0');
  for (const [source, version] of [['print(42)', '0.2'], ['nerva 0.2\nprint(42)', '0.2'], ['nerva 0.3\nprint(42)', '0.3']]) {
    const result = runProgram(source);
    assert.deepEqual(result.records, [{ kind: 'print', values: [42], version }]);
    assert.ok(Number.isSafeInteger(result.tensorOperations) && result.tensorOperations >= 0);
  }
});

test('records compose with lists, Unicode keys and literal multiline values', () => {
  assert.deepEqual(outputs(`
    const person = {
      name: "Nerva",
      "🧠": {ready: true},
      scores: [3, 8],
    }
    print(person.name, person["🧠"].ready, person.scores[1], len(person))
    print(keys(person), values({first: 1, second: 2}))
  `), [['Nerva', true, 8, 3], [['name', '🧠', 'scores'], [1, 2]]]);
});

test('record keys are data, including names belonging to JavaScript prototypes', () => {
  const result = runProgram(v03(`
    const data = {"__proto__": {polluted: true}, constructor: 4, toString: "own"}
    print(data["__proto__"].polluted, data.constructor, data.toString)
    print(has({}, "constructor"), get({}, "toString", "missing"), keys({}))
  `));
  assert.deepEqual(json(result.records.map(record => record.values)), [[true, 4, 'own'], [false, 'missing', []]]);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(result.globals.data, '__proto__'), true);
});

test('persistent list and record updates preserve earlier values and aliases', () => {
  assert.deepEqual(outputs(`
    const original = [1, 2]
    const alias = original
    const extended = append(original, 3)
    const changed = set(extended, 0, 9)
    const record = {name: "before", nested: {value: 1}}
    const updated = set(record, "name", "after")
    print(original, alias, extended, changed, concat(original, [4, 5]), slice(changed, 1, 3))
    print(record.name, updated.name, updated.nested.value, has(record, "absent"))
    print(get(record, "absent"), get(record, "absent", 42), get(original, 8, "fallback"))
  `), [[[1, 2], [1, 2], [1, 2, 3], [9, 2, 3], [1, 2, 4, 5], [2, 3]], ['before', 'after', 1, false], [null, 42, 'fallback']]);
});

test('collection callbacks retain lexical scope and reduce honors its initial value', () => {
  assert.deepEqual(outputs(`
    const factor = 3
    fn scale(x) { return x * factor }
    fn even(x) { return x % 2 == 0 }
    fn add(total, x) { return total + x }
    const values = [1, 2, 3, 4]
    print(map(values, scale), filter(values, even), reduce(values, add, 10))
    print(map([], scale), filter([], even), reduce([], add, 10), values)
  `), [[[3, 6, 9, 12], [2, 4], 20], [[], [], 10, [1, 2, 3, 4]]]);
});

test('sort is stable, uses a comparator and preserves its input', () => {
  assert.deepEqual(outputs(`
    fn compare(a, b) { return a.rank - b.rank }
    fn name(item) { return item.name }
    const items = [{name: "first", rank: 2}, {name: "second", rank: 1}, {name: "third", rank: 2}]
    print(map(sort(items, compare), name), map(items, name))
  `), [[['second', 'first', 'third'], ['first', 'second', 'third']]]);
});

test('string utilities and explicit conversions process realistic application data', () => {
  assert.deepEqual(outputs(`
    const words = split(trim("  NERVA:Profesional  "), ":")
    print(lower(words[0]), upper(words[1]), join(words, "/"))
    print(replace("a.a.a", ".", "-"), contains("código 🧠", "🧠"), contains("nerva", "x"))
    print(str(42), number(" 2.5 "), number(8), len(split("", ",")))
  `), [['nerva', 'PROFESIONAL', 'NERVA/Profesional'], ['a-a-a', true, false], ['42', 2.5, 8, 1]]);
});

test('JSON parsing and serialization round trip nested records without prototype access', () => {
  const result = outputs(`
    const decoded = json_parse("{\\\"name\\\":\\\"Nerva\\\",\\\"items\\\":[1,true,null],\\\"__proto__\\\":{\\\"x\\\":2}}")
    const encoded = json_stringify(decoded)
    const again = json_parse(encoded)
    print(again.name, again.items, again["__proto__"].x, encoded)
  `)[0];
  assert.deepEqual(result.slice(0, 3), ['Nerva', [1, true, null], 2]);
  assert.deepEqual(JSON.parse(result[3]), JSON.parse('{"name":"Nerva","items":[1,true,null],"__proto__":{"x":2}}'));
});

test('nested JSON inputs are snapshots rather than references into the host', () => {
  const input = { profile: { name: 'original' }, scores: [2, 3] };
  const prepared = prepareProgram(v03('print(data.profile.name, data.scores)'));
  const result = prepared.run({ inputs: { data: input } });
  input.profile.name = 'changed';
  input.scores.push(4);
  assert.deepEqual(json(result.records[0].values), ['original', [2, 3]]);
});

test('modulo has arithmetic precedence and rejects nonfinite results', () => {
  assert.deepEqual(outputs('print(17 % 5, -5 % 3, 6 + 8 % 3 * 2)'), [[2, -2, 10]]);
  assert.throws(() => runProgram(v03('print(1 % 0)')), /cero|zero|finito|finite/);
});

for (const [name, source, expected] of [
  ['duplicate record keys', 'const x = {same: 1, same: 2}', /Duplicate record key/],
  ['missing direct record members', 'print({}.missing)', /missing|clave|propiedad/i],
  ['out of range persistent updates', 'set([1], 1, 2)', /rango|range/i],
  ['negative collection slices', 'slice([1, 2], -1, 2)', /rango|range|negativo|nonnegative|inicio/i],
  ['nonboolean filter callbacks', 'fn bad(x) { return x }\nfilter([1], bad)', /booleana|boolean/i],
  ['nonnumeric sort callbacks', 'fn bad(a, b) { return true }\nsort([2, 1], bad)', /número|number/i],
  ['nonfunction map callbacks', 'map([1], 2)', /función|function/i],
  ['malformed JSON', 'json_parse("{")', /JSON|json/],
  ['nonfinite parsed JSON', 'json_parse("1e400")', /finito|finite/i],
  ['empty string conversion', 'number("")', /número|number/i],
  ['boolean number coercion', 'number(true)', /número|number|cadena|string/i],
]) {
  test(`0.3 rejects ${name}`, () => assert.throws(() => runProgram(v03(source)), expected));
}

test('prepared programs snapshot sources and isolate mutable module state for every run', () => {
  const modules = {
    'counter.nv': v03('export let count = 0\nexport fn next() { count = count + 1; return count }'),
  };
  const prepared = prepareProgram(v03('import {next as increment} from "./counter.nv"\nprint(increment(), increment())'), { filename: 'main.nv', modules });
  assert.equal(Object.isFrozen(prepared), true);
  modules['counter.nv'] = v03('export fn next() { return 999 }');
  const first = prepared.run();
  first.records[0].values[0] = 999;
  assert.deepEqual(prepared.run().records, [{ kind: 'print', version: '0.3', values: [1, 2] }]);
});

test('diamond imports execute a shared module once per run and share its lexical state', () => {
  const modules = {
    'shared.nv': v03('print("loaded")\nlet count = 0\nexport fn next() { count = count + 1; return count }'),
    'left.nv': v03('import {next} from "./shared.nv"\nexport fn left() { return next() }'),
    'right.nv': v03('import {next} from "./shared.nv"\nexport fn right() { return next() }'),
  };
  const prepared = prepareProgram(v03('import {left} from "./left.nv"\nimport * as right from "./right.nv"\nprint(left(), right.right(), left())'), { filename: 'main.nv', modules });
  const expected = [['loaded'], [1, 2, 3]];
  assert.deepEqual(prepared.run().records.map(record => record.values), expected);
  assert.deepEqual(prepared.run().records.map(record => record.values), expected);
});

test('namespace imports expose exported constants, functions and trainable parameters', () => {
  const prepared = prepareProgram(v03(`
    import * as model from "./lib/model.nv"
    print(model.name, model.predict(3))
    zero_grad(model.weight)
    backward(model.weight * model.weight)
    step(model.weight, 0.25)
    print(model.predict(3))
  `), {
    filename: 'main.nv',
    modules: { 'lib/model.nv': v03('export const name = "linear"\nexport param weight = tensor64(2)\nexport fn predict(x) { return value(weight) * x }') },
  });
  const result = prepared.run();
  assert.deepEqual(result.records.map(record => record.values), [['linear', 6], [3]]);
  assert.deepEqual(prepared.run().records, result.records);
});

test('module resolution follows each importing file rather than the entry directory', () => {
  const result = runProgram(v03('import {answer} from "./lib/outer.nv"\nprint(answer)'), {
    filename: 'project/main.nv',
    modules: {
      'project/lib/outer.nv': v03('import {base} from "../values.nv"\nexport const answer = base + 2'),
      'project/values.nv': v03('export const base = 40'),
    },
  });
  assert.deepEqual(result.records[0].values, [42]);
});

test('module errors report the file and original source location', () => {
  assert.throws(() => prepareProgram(v03('import {go} from "./lib.nv"\ngo()'), {
    filename: 'main.nv', modules: { 'lib.nv': v03('export fn go() {\n  return missing\n}') },
  }).run(), error => {
    assert.equal(error.name, 'LangError');
    assert.equal(error.file, 'lib.nv');
    assert.equal(error.line, 3);
    assert.ok(error.column > 0);
    assert.match(error.message, /missing/);
    return true;
  });
  assert.throws(() => prepareProgram(v03('import {go} from "./broken.nv"'), {
    filename: 'main.nv', modules: { 'broken.nv': v03('export const x = [') },
  }), error => error.name === 'LangError' && error.file === 'broken.nv');
});

for (const [name, source, modules, expected] of [
  ['missing modules', 'import {x} from "./absent.nv"', {}, /absent\.nv/],
  ['missing exports', 'import {secret} from "./lib.nv"', { 'lib.nv': 'const secret = 1' }, /secret.*export|export.*secret/i],
  ['bare module specifiers', 'import {x} from "library"', {}, /relativa|relative/i],
  ['circular module graphs', 'import {x} from "./a.nv"', { 'a.nv': 'import {y} from "./b.nv"\nexport const x = 1', 'b.nv': 'import {x} from "./a.nv"\nexport const y = 2' }, /circular|cycle/i],
]) {
  test(`module preparation rejects ${name}`, () => assert.throws(() => prepareProgram(v03(source), { filename: 'main.nv', modules }), expected));
}

test('module namespaces expose only exports and imported bindings cannot be rebound', () => {
  const modules = { 'lib.nv': 'const private_value = 1\nexport let answer = 42' };
  assert.throws(() => runProgram(v03('import * as lib from "./lib.nv"\nprint(lib.private_value)'), { filename: 'main.nv', modules }), /private_value|clave desconocida/);
  assert.throws(() => runProgram(v03('import {answer} from "./lib.nv"\nanswer = 0'), { filename: 'main.nv', modules }), /constante/);
});

test('named and namespace imports observe the same live exported mutable binding', () => {
  const result = runProgram(v03(`
    import {count, next} from "./counter.nv"
    import * as counter from "./counter.nv"
    print(count, counter.count)
    next()
    print(count, counter.count, get(counter, "count"), values(counter)[0])
  `), {
    filename: 'main.nv',
    modules: { 'counter.nv': v03('export let count = 0\nexport fn next() { count = count + 1 }') },
    captureGlobals: false,
  });
  assert.deepEqual(result.records.map(record => record.values), [[0, 0], [1, 1, 1, 1]]);
});

test('captureGlobals preserves output and steps while omitting global serialization', () => {
  const prepared = prepareProgram(v03('const data = {items: [1, 2]}\nconst t = ones([3])\nprint(data.items, value(sum(t)))'));
  const full = prepared.run();
  const minimal = prepared.run({ captureGlobals: false });
  assert.deepEqual(minimal.records, full.records);
  assert.equal(minimal.steps, full.steps);
  assert.ok(minimal.tensorOperations <= full.tensorOperations);
  assert.deepEqual(Object.keys(minimal.globals), []);
  assert.deepEqual(json(full.globals.data), { items: [1, 2] });
});

test('host functions receive JSON copies and their results do not remain host references', () => {
  let argument;
  const response = { ok: true, items: [5] };
  const result = runProgram(v03('const original = {items: [1, 2]}\nconst result = host.process(original)\nprint(original.items, result.items, result.ok)'), {
    host: { process(value) { argument = value; value.items.push(9); return response; } },
  });
  argument.items.push(10);
  response.items.push(6);
  assert.deepEqual(json(result.records[0].values), [[1, 2], [5], true]);
  assert.deepEqual(json(result.globals.result), { ok: true, items: [5] });
});

test('host supports multiple arguments and errors identify its call site and function', () => {
  assert.deepEqual(outputs('print(host.add(20, 22), host.status())', { host: { add: (a, b) => a + b, status: () => null } }), [[42, null]]);
  assert.throws(() => runProgram(v03('const before = 1\nhost.fail()'), { filename: 'service.nv', host: { fail() { throw new Error('backend unavailable'); } } }), error => {
    assert.equal(error.name, 'LangError');
    assert.equal(error.file, 'service.nv');
    assert.equal(error.line, 3);
    assert.match(error.message, /fail/);
    assert.match(error.message, /backend unavailable/);
    return true;
  });
});

const cycle = {}; cycle.self = cycle;
let resultGetterCalls = 0;
const resultAccessor = Object.defineProperty({}, 'value', { enumerable: true, get() { resultGetterCalls++; return 1; } });
for (const [name, value, expected] of [
  ['Promise results', Promise.resolve(1), /JSON|Promise|síncron|synch/i],
  ['function results', () => 1, /JSON|función|function/i],
  ['nonfinite results', Infinity, /finito|finite/i],
  ['cyclic results', cycle, /ciclos|cycle/i],
  ['accessor results', resultAccessor, /calculadas|accessor|JSON/i],
  ['custom prototypes', new Date(0), /JSON/i],
]) {
  test(`host rejects ${name} at its boundary`, () => {
    assert.throws(() => runProgram(v03('host.read()'), { host: { read: () => value } }), expected);
    assert.equal(resultGetterCalls, 0);
  });
}

test('host configuration accessors are rejected without invoking user code', () => {
  let getterCalls = 0;
  const host = Object.defineProperty({}, 'read', { enumerable: true, get() { getterCalls++; return () => 1; } });
  assert.throws(() => runProgram(v03('host.read()'), { host }), /host|función|function|calculada/i);
  assert.equal(getterCalls, 0);
});

test('non-JSON arguments are rejected before invoking the host handler', () => {
  let calls = 0;
  assert.throws(() => runProgram(v03('fn identity(x) { return x }\nhost.accept(identity)'), {
    host: { accept() { calls++; return null; } },
  }), /host\.accept|imprimir|exportar|JSON/i);
  assert.equal(calls, 0);
});

test('asynchronous host handlers are rejected before their bodies execute', () => {
  let calls = 0;
  assert.throws(() => runProgram(v03('host.read()'), {
    host: { async read() { calls++; return 1; } },
  }), /síncron|synch|async/i);
  assert.equal(calls, 0);
});

test('a rejected native Promise from a synchronous host handler is contained', async () => {
  assert.throws(() => runProgram(v03('host.read()'), {
    host: { read() { return Promise.reject(new Error('native promise failed')); } },
  }), /Promise|JSON|síncron|synch/i);
  // Allow Node to deliver any unhandled rejection; the test runner treats one as failure.
  await new Promise(resolve => setImmediate(resolve));
});

test('nested host executions restore the caller tensor budget on success and failure', () => {
  const source = v03('const first = ones([8])\nhost.nested()\nconst second = ones([8])\nprint(1)');
  const required = runProgram(v03('const first = ones([8])\nconst second = ones([8])\nprint(1)'), { captureGlobals: false }).tensorOperations;
  for (const failNested of [false, true]) {
    const host = { nested() {
      try {
        runProgram('ones([2])', { operationLimit: failNested ? 1 : 100, captureGlobals: false });
      } catch (error) { if (!failNested) throw error; }
      return null;
    } };
    assert.throws(() => runProgram(source, { host, operationLimit: required - 1, captureGlobals: false }), /operation budget/i);
    const result = runProgram(source, { host, operationLimit: required, captureGlobals: false });
    assert.deepEqual(result.records[0].values, [1]);
    assert.equal(result.tensorOperations, required);
  }
});

test('execution budgets accept larger safe integers and still enforce the requested limit', () => {
  const result = runProgram(v03('let i = 0\nwhile i < 26000 { i = i + 1 }\nprint(i)'), {
    stepLimit: 500000,
    operationLimit: 20000001,
    captureGlobals: false,
  });
  assert.deepEqual(result.records[0].values, [26000]);
  assert.ok(result.steps > 200000);
  assert.throws(() => runProgram(v03('while true {}'), { stepLimit: 50 }), /50 pasos/);
  assert.deepEqual(outputs('print(len(range(100001)))', { collectionLimit: 100001, captureGlobals: false }), [[100001]]);
});

test('budget options reject zero, fractions and integers outside the safe range', () => {
  for (const name of ['stepLimit', 'operationLimit', 'collectionLimit', 'loopLimit']) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      assert.throws(() => runProgram(v03(''), { [name]: value }), new RegExp(name));
    }
  }
});

test('loop and callback budgets are enforced independently of list length', () => {
  assert.throws(() => runProgram(v03('let i = 0\nwhile i < 3 { i = i + 1 }'), { loopLimit: 2 }), /2.*iteracion|iteracion.*2|bucle|loop/i);
  assert.deepEqual(outputs('let i = 0\nwhile i < 3 { i = i + 1 }\nprint(i)', { loopLimit: 3 }), [[3]]);
  assert.throws(() => runProgram(v03('fn increment(x) { return x + 1 }\nmap(range(100), increment)'), { stepLimit: 50 }), /50 pasos/);
});

test('derived collections and strings obey size bounds before producing results', () => {
  assert.throws(() => runProgram(v03('append([1, 2], 3)'), { collectionLimit: 2 }), /2 elementos/);
  assert.throws(() => runProgram(v03('concat([1, 2], [3])'), { collectionLimit: 2 }), /2 elementos/);
  assert.throws(() => runProgram(v03('json_parse("[1,2,3]")'), { collectionLimit: 2 }), /2 elementos/);
  assert.throws(() => runProgram(v03('split("a,b,c", ",")'), { collectionLimit: 2 }), /2 elementos/);
  const options = { inputs: { text: 'x'.repeat(100001) }, captureGlobals: false };
  assert.throws(() => runProgram(v03('replace(text, "x", "xx")'), options), /200000 caracteres/);
  assert.throws(() => runProgram(v03('join([text, text], "")'), options), /200000 caracteres/);
});
