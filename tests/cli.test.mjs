import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/runtime.mjs';

const cliPath = fileURLToPath(new URL('../src/nerva.mjs', import.meta.url));

function cli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  return result;
}

async function fixture(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'nerva-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source);
  return directory;
}

test('CLI reports the runtime version and help without a program', () => {
  const version = cli(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `NERVA ${VERSION}\n`);
  assert.equal(version.stderr, '');
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /run programa\.nv/);
});

test('CLI JSON output exposes records, version and steps and loads JSON inputs', async t => {
  const directory = await fixture(t, {
    'program.nv': 'nerva 0.2\nconst answer = samples[0] + samples[1]\nprint("answer", answer)',
    'inputs.json': JSON.stringify({ samples: [20, 22] }),
  });
  const result = cli(['run', 'program.nv', '--json', '--inputs', 'inputs.json'], directory);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, VERSION);
  assert.deepEqual(payload.records, [{ kind: 'print', values: ['answer', 42], version: '0.2' }]);
  assert.ok(Number.isSafeInteger(payload.steps) && payload.steps > 0);
  assert.deepEqual(Object.keys(payload).sort(), ['records', 'steps', 'version']);
  const readable = cli(['run', 'program.nv', '--inputs', 'inputs.json'], directory);
  assert.equal(readable.status, 0);
  assert.equal(readable.stdout, 'answer 42\n');
});

test('CLI check validates syntax without evaluating the program', async t => {
  const directory = await fixture(t, { 'program.nv': 'print(unknown_name)', 'broken.nv': 'const x = [' });
  const valid = cli(['check', 'program.nv'], directory);
  assert.equal(valid.status, 0);
  assert.equal(valid.stdout, 'Sintaxis válida.\n');
  assert.equal(valid.stderr, '');
  const broken = cli(['check', 'broken.nv'], directory);
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, '');
  const error = JSON.parse(broken.stderr);
  assert.match(error.error, /Expected an expression/);
  assert.equal(error.line, 1);
  assert.ok(error.column > 0);
});

test('CLI runtime errors are structured stderr with a nonzero exit code', async t => {
  const directory = await fixture(t, { 'program.nv': 'const x = 1\nprint(missing)' });
  const result = cli(['run', 'program.nv', '--json'], directory);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.match(error.error, /Nombre desconocido.*missing/);
  assert.equal(error.line, 2);
  assert.ok(error.column > 0);
});

test('CLI seeds reproduce random tensors across processes', async t => {
  const directory = await fixture(t, { 'random.nv': 'print(randn([4]))' });
  const first = cli(['run', 'random.nv', '--json', '--seed', '7'], directory);
  const second = cli(['run', 'random.nv', '--json', '--seed', '7'], directory);
  const other = cli(['run', 'random.nv', '--json', '--seed', '8'], directory);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(other.status, 0);
  assert.equal(first.stdout, second.stdout);
  assert.notEqual(first.stdout, other.stdout);
});

test('CLI persists checkpoints only with an explicit output directory', async t => {
  const directory = await fixture(t, { 'save.nv': 'param weights = tensor64([2, 3])\ncheckpoint("model", weights)' });
  const withoutOutput = cli(['run', 'save.nv', '--json'], directory);
  assert.equal(withoutOutput.status, 0);
  assert.deepEqual(await readdir(directory), ['save.nv']);
  const withOutput = cli(['run', 'save.nv', '--json', '--out', 'models'], directory);
  assert.equal(withOutput.status, 0);
  const emitted = JSON.parse(withOutput.stdout).records[0].checkpoint;
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'models', 'model.json'), 'utf8')), emitted);
  assert.deepEqual(await readdir(join(directory, 'models')), ['model.json']);
});

test('CLI rejects unsupported options, missing arguments and invalid seeds', async t => {
  const directory = await fixture(t, { 'program.nv': 'print(1)' });
  for (const [args, expected] of [
    [['run', 'program.nv', '--unknown'], /Opción no reconocida/],
    [['run', 'program.nv', '--inputs'], /Falta el valor/],
    [['run', 'program.nv', '--seed', '-1'], /entero no negativo/],
    [['run', 'program.nv', '--seed', '4294967296'], /semilla/],
    [['check', 'program.nv', '--json'], /Opción no reconocida/],
  ]) {
    const result = cli(args, directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error, expected);
  }
});
