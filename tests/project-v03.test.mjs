import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProject, loadBundle, loadProject } from '../src/project.mjs';

const cliPath = fileURLToPath(new URL('../src/nerva.mjs', import.meta.url));

function cli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  return result;
}

async function fixture(t, files = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nerva-project-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return directory;
}

const modularProgram = {
  'main.nv': 'nerva 0.3\nimport { answer } from "./lib/math.nv"\nprint(answer())',
  'lib/math.nv': 'import { double } from "./nested/double.nv"\nexport fn answer() { return double(21) }',
  'lib/nested/double.nv': 'export fn double(value) { return value * 2 }',
};

test('project loading resolves recursive imports and preserves relative source identities', async t => {
  const directory = await fixture(t, { ...modularProgram, 'unused.nv': 'const broken = [' });
  const project = await loadProject(join(directory, 'main.nv'), { root: directory });
  assert.equal(project.entry, 'main.nv');
  assert.deepEqual(Object.keys(project.sources).sort(), Object.keys(modularProgram).sort());
  for (const [name, source] of Object.entries(modularProgram)) assert.equal(project.sources[name], source);
  assert.deepEqual(project.prepared.run().records[0].values, [42]);
});

test('project loading resolves parent imports inside the project root', async t => {
  const directory = await fixture(t, {
    'apps/main.nv': 'import { answer } from "../lib/answer.nv"\nprint(answer)',
    'lib/answer.nv': 'export const answer = 42',
  });
  const project = await loadProject(join(directory, 'apps/main.nv'), { root: directory });
  assert.equal(project.entry, 'apps/main.nv');
  assert.deepEqual(Object.keys(project.sources).sort(), ['apps/main.nv', 'lib/answer.nv']);
  assert.deepEqual(project.prepared.run().records[0].values, [42]);
});

test('project preparation parses dependencies without running module side effects', async t => {
  const directory = await fixture(t, {
    'main.nv': 'import { answer } from "./lib/answer.nv"\nprint(answer)',
    'lib/answer.nv': 'assert(false, "must only run on execution")\nexport const answer = 42',
  });
  const project = await loadProject(join(directory, 'main.nv'), { root: directory });
  assert.throws(() => project.prepared.run(), /must only run on execution/);
});

test('project boundary rejects lexical imports and entries outside the root', async t => {
  const directory = await fixture(t, {
    'project/main.nv': 'import { answer } from "../outside.nv"\nprint(answer)',
    'outside.nv': 'export const answer = 42',
  });
  await assert.rejects(async () => loadProject(join(directory, 'project/main.nv'), { root: join(directory, 'project') }));
  await assert.rejects(async () => loadProject(join(directory, 'outside.nv'), { root: join(directory, 'project') }));
});

test('project boundary checks real paths to prevent module symlink escapes', async t => {
  const directory = await fixture(t, {
    'project/main.nv': 'import { answer } from "./linked.nv"\nprint(answer)',
    'outside.nv': 'export const answer = 42',
  });
  await symlink(join(directory, 'outside.nv'), join(directory, 'project/linked.nv'));
  await assert.rejects(async () => loadProject(join(directory, 'project/main.nv'), { root: join(directory, 'project') }));
});

test('bundles contain deterministic source snapshots with SHA-256 integrity hashes', async t => {
  const directory = await fixture(t, modularProgram);
  const first = await buildProject(join(directory, 'main.nv'), { root: directory });
  const second = await buildProject(join(directory, 'main.nv'), { root: directory });
  assert.deepEqual(first, second);
  assert.equal(first.format, 'nerva-bundle');
  assert.equal(first.version, 1);
  assert.equal(first.languageVersion, '0.3.0');
  assert.equal(first.entry, 'main.nv');
  assert.deepEqual(Object.keys(first.sources).sort(), Object.keys(modularProgram).sort());
  assert.deepEqual(Object.keys(first.hashes).sort(), Object.keys(first.sources).sort());
  for (const [name, source] of Object.entries(first.sources)) {
    assert.equal(first.hashes[name], createHash('sha256').update(source).digest('hex'));
  }
  const loaded = await loadBundle(JSON.parse(JSON.stringify(first)));
  assert.equal(loaded.entry, first.entry);
  assert.deepEqual(loaded.prepared.run().records[0].values, [42]);
});

test('bundle validation rejects modified sources, incompatible versions and missing entry sources', async t => {
  const directory = await fixture(t, modularProgram);
  const bundle = await buildProject(join(directory, 'main.nv'), { root: directory });
  const clone = () => JSON.parse(JSON.stringify(bundle));
  const altered = clone();
  altered.sources['lib/nested/double.nv'] = 'export fn double(value) { return value * 3 }';
  await assert.rejects(async () => loadBundle(altered));
  const incompatible = clone();
  incompatible.version = 99;
  await assert.rejects(async () => loadBundle(incompatible));
  const missing = clone();
  delete missing.sources[missing.entry];
  delete missing.hashes[missing.entry];
  await assert.rejects(async () => loadBundle(missing));
});

test('bundle paths cannot escape or alias the source snapshot namespace', async t => {
  const directory = await fixture(t, { 'main.nv': 'print(42)' });
  const bundle = await buildProject(join(directory, 'main.nv'), { root: directory });
  for (const unsafe of ['../main.nv', '/main.nv', 'lib/../main.nv']) {
    const altered = JSON.parse(JSON.stringify(bundle));
    altered.entry = unsafe;
    altered.sources = { [unsafe]: 'print(42)' };
    altered.hashes = { [unsafe]: createHash('sha256').update('print(42)').digest('hex') };
    await assert.rejects(async () => loadBundle(altered), `accepted unsafe bundle path ${unsafe}`);
  }
});

test('CLI builds a portable bundle and runs it after the original sources are deleted', async t => {
  const directory = await fixture(t, modularProgram);
  const built = cli(['build', 'main.nv', '--out', 'program.nvb'], directory);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(built.stderr, '');
  const bundle = JSON.parse(await readFile(join(directory, 'program.nvb'), 'utf8'));
  assert.equal(bundle.format, 'nerva-bundle');
  await rm(join(directory, 'main.nv'));
  await rm(join(directory, 'lib'), { recursive: true });
  const executed = cli(['run', 'program.nvb', '--json'], directory);
  assert.equal(executed.status, 0, executed.stderr);
  assert.deepEqual(JSON.parse(executed.stdout).records[0].values, [42]);
});

test('CLI rejects bundle tampering before executing its sources', async t => {
  const directory = await fixture(t, { 'main.nv': 'print("original")' });
  const bundle = await buildProject(join(directory, 'main.nv'), { root: directory });
  bundle.sources['main.nv'] = 'print("tampered")';
  await writeFile(join(directory, 'altered.nvb'), JSON.stringify(bundle));
  const result = cli(['run', 'altered.nvb', '--json'], directory);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(JSON.parse(result.stderr).error);
});

test('CLI check validates nested dependencies and reports their file and source location', async t => {
  const directory = await fixture(t, {
    'main.nv': 'import { answer } from "./lib/answer.nv"\nprint(answer)',
    'lib/answer.nv': 'import { value } from "./nested/value.nv"\nexport const answer = value',
    'lib/nested/value.nv': 'export const value =\n[',
  });
  const result = cli(['check', 'main.nv'], directory);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.ok(error.error);
  assert.match(error.file, /lib\/nested\/value\.nv$/);
  assert.ok(Number.isInteger(error.line) && error.line > 0);
  assert.ok(Number.isInteger(error.column) && error.column > 0);
});

test('CLI check does not execute either entry or dependency code', async t => {
  const directory = await fixture(t, {
    'main.nv': 'import { answer } from "./lib/answer.nv"\nassert(false, "entry executed")',
    'lib/answer.nv': 'assert(false, "dependency executed")\nexport const answer = missing_name',
  });
  const result = cli(['check', 'main.nv'], directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Sintaxis válida/);
});

test('CLI --root admits internal parent imports and rejects external imports', async t => {
  const directory = await fixture(t, {
    'project/apps/main.nv': 'import { answer } from "../lib/answer.nv"\nprint(answer)',
    'project/lib/answer.nv': 'export const answer = 42',
    'project/escape.nv': 'import { answer } from "../outside.nv"\nprint(answer)',
    'outside.nv': 'export const answer = 99',
  });
  const valid = cli(['run', 'project/apps/main.nv', '--root', 'project', '--json'], directory);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout).records[0].values, [42]);
  const escaped = cli(['run', 'project/escape.nv', '--root', 'project', '--json'], directory);
  assert.equal(escaped.status, 1);
  assert.equal(escaped.stdout, '');
  assert.ok(JSON.parse(escaped.stderr).error);
});

test('CLI exposes explicitly loaded synchronous JavaScript host functions', async t => {
  const directory = await fixture(t, {
    'main.nv': 'print(host.double(21), host.describe({name: "NERVA"}))',
    'host.mjs': 'export default { double(value) { return value * 2; }, describe(value) { return {name: value.name, length: value.name.length}; } };',
  });
  const executed = cli(['run', 'main.nv', '--host', 'host.mjs', '--json'], directory);
  assert.equal(executed.status, 0, executed.stderr);
  assert.deepEqual(JSON.parse(executed.stdout).records[0].values, [42, { name: 'NERVA', length: 5 }]);
  const absent = cli(['run', 'main.nv', '--json'], directory);
  assert.equal(absent.status, 1);
  assert.equal(absent.stdout, '');
  const error = JSON.parse(absent.stderr);
  assert.match(error.error, /host/);
  assert.match(error.file, /main\.nv$/);
  assert.equal(error.line, 1);
  assert.ok(error.column > 0);
});

test('CLI rejects a host module whose default export contains nonfunctions', async t => {
  const directory = await fixture(t, {
    'main.nv': 'print(42)',
    'host.mjs': 'export default { bad: 42 };',
  });
  const result = cli(['run', 'main.nv', '--host', 'host.mjs', '--json'], directory);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(JSON.parse(result.stderr).error);
});

test('CLI test recursively discovers test files and isolates module state for every case', async t => {
  const directory = await fixture(t, {
    'tests/first.test.nv': 'import { tick } from "../lib/counter.nv"\nassert(tick() == 1)',
    'tests/nested/second.test.nv': 'import { tick } from "../../lib/counter.nv"\nassert(tick() == 1)',
    'tests/ignored.nv': 'assert(false, "not a test")',
    'lib/counter.nv': 'let count = 0\nexport fn tick() { count = count + 1; return count }',
  });
  const result = cli(['test', 'tests', '--root', '.', '--json'], directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 0);
});

test('CLI test reports passing and failing cases in JSON and exits with failure', async t => {
  const directory = await fixture(t, {
    'tests/pass.test.nv': 'assert(6 * 7 == 42)',
    'tests/nested/fail.test.nv': 'assert(false, "expected test failure")',
  });
  const result = cli(['test', 'tests', '--json'], directory);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.match(result.stdout, /expected test failure/);
  assert.match(result.stdout, /nested\/fail\.test\.nv/);
});

test('CLI init creates a working independent project with runnable tests', async t => {
  const directory = await fixture(t);
  const created = cli(['init', 'app'], directory);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.stderr, '');
  const app = join(directory, 'app');
  const config = JSON.parse(await readFile(join(app, 'nerva.json'), 'utf8'));
  assert.ok(config && typeof config === 'object');
  assert.ok((await readFile(join(app, 'main.nv'), 'utf8')).trim());
  const testFiles = (await readdir(join(app, 'tests'))).filter(name => name.endsWith('.test.nv'));
  assert.ok(testFiles.length > 0);
  assert.ok((await readFile(join(app, 'tests', testFiles[0]), 'utf8')).trim());
  assert.ok(Array.isArray(await readdir(join(app, 'lib'))));
  const executed = cli(['run', 'main.nv', '--json'], app);
  assert.equal(executed.status, 0, executed.stderr);
  assert.ok(Array.isArray(JSON.parse(executed.stdout).records));
  const tested = cli(['test', 'tests', '--json'], app);
  assert.equal(tested.status, 0, tested.stderr);
  assert.equal(JSON.parse(tested.stdout).failed, 0);
});

test('CLI init never overwrites existing source or configuration files', async t => {
  const directory = await fixture(t, {
    'app/main.nv': 'print("keep my program")',
    'app/nerva.json': '{"custom":"keep my config"}\n',
    'app/tests/main.test.nv': 'assert(true, "keep my tests")',
  });
  const result = cli(['init', 'app'], directory);
  assert.equal(result.status, 1);
  assert.equal(await readFile(join(directory, 'app/main.nv'), 'utf8'), 'print("keep my program")');
  assert.equal(await readFile(join(directory, 'app/nerva.json'), 'utf8'), '{"custom":"keep my config"}\n');
  assert.equal(await readFile(join(directory, 'app/tests/main.test.nv'), 'utf8'), 'assert(true, "keep my tests")');
});
