import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runProgram } from '../src/runtime.mjs';
import * as T from '../src/tensor.mjs';

test('new module words remain usable as legacy variable and function names', () => {
  const source = `nerva 0.2
    const from = 4
    let as = 3
    as = as + from
    let import = 2
    import = import + 1
    fn export(value) { return value * 2 }
    print(from, as, import, export(21))
  `;
  assert.deepEqual(runProgram(source).records[0].values, [4, 7, 3, 42]);
});

test('derived shape lists and imported namespaces respect collection budgets', () => {
  assert.throws(() => runProgram('print(shape(tensor64([[[1]]])))', { collectionLimit: 2 }), /supera/);
  const source = 'import * as lib from "./lib.nv"\nprint(lib)';
  const modules = { 'lib.nv': 'export const a=1\nexport const b=2\nexport const c=3' };
  assert.throws(() => runProgram(source, { modules, collectionLimit: 2 }), /supera/);
  assert.equal(Object.keys(runProgram(source, { modules, collectionLimit: 3 }).records[0].values[0]).length, 3);
});

test('budget callbacks reject async functions before their bodies execute', () => {
  let called = false;
  assert.throws(() => T.withBudget(T.createBudget(), async () => { called = true; }), /synchronous/);
  assert.equal(called, false);
});

test('a rejected Promise from budget work does not terminate the Node process', () => {
  const moduleURL = new URL('../src/tensor.mjs', import.meta.url).href;
  const source = `import * as T from ${JSON.stringify(moduleURL)};
    const outer = T.createBudget(100);
    T.withBudget(outer, () => {
      T.tensor([1]);
      const before = T.getBudget(outer).used;
      try { T.withBudget(T.createBudget(), () => Promise.reject(new Error('child rejected'))); }
      catch (error) { if (!error.message.includes('synchronous')) throw error; }
      T.tensor([2]);
      if (T.getBudget(outer).used <= before) throw new Error('Outer budget not restored');
    });
    setImmediate(() => process.stdout.write('survived'));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'survived');
});

test('CLI preserves default JSON fields and exposes profiling explicitly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nerva-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'main.nv');
  await writeFile(path, 'print(value(sum(ones([2]))))');
  const cli = fileURLToPath(new URL('../src/nerva.mjs', import.meta.url));
  const run = flags => spawnSync(process.execPath, [cli, 'run', path, '--json', ...flags], { encoding: 'utf8', timeout: 10000 });
  const ordinary = run([]), profiled = run(['--profile']);
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(profiled.status, 0, profiled.stderr);
  const oldShape = JSON.parse(ordinary.stdout), newShape = JSON.parse(profiled.stdout);
  assert.deepEqual(Object.keys(oldShape).sort(), ['records', 'steps', 'version']);
  assert.deepEqual(newShape.records, oldShape.records);
  assert.ok(newShape.tensorOperations > 0);
});

test('build rejects source outputs and preserves the entry and imported modules', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nerva-build-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'main.nv'), lib = join(directory, 'lib.nv');
  const source = 'import {answer} from "./lib.nv"\nprint(answer)';
  const dependency = 'export const answer=42';
  await writeFile(path, source);
  await writeFile(lib, dependency);
  const cli = fileURLToPath(new URL('../src/nerva.mjs', import.meta.url));
  for (const output of [path, lib]) {
    const result = spawnSync(process.execPath, [cli, 'build', path, '--out', output], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr).error, /sobrescribir/);
  }
  assert.equal(await readFile(path, 'utf8'), source);
  assert.equal(await readFile(lib, 'utf8'), dependency);
});
