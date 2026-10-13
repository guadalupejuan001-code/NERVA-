import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VERSION } from './runtime.mjs';
import { loadProject, buildProject, loadBundle, discoverTests, initProject } from './project.mjs';

const HELP = `NERVA ${VERSION} — proyectos, datos y aprendizaje local
Uso:
  nerva run programa.nv|paquete.nvb [--json] [--inputs datos.json] [--host funciones.mjs]
  nerva check programa.nv [--root proyecto]
  nerva build programa.nv --out paquete.nvb [--root proyecto] [--json]
  nerva test carpeta|archivo.test.nv [--root proyecto] [--json]
  nerva init carpeta [--json]
  nerva --version

También admite carpetas con nerva.json para run, check, build y test.
run/test: --seed N, --steps N, --operations N, --max-list N, --max-loops N.
run: --globals incluye variables en JSON; --profile añade operaciones tensoriales.
--out guarda checkpoints emitidos por run.
--root establece la raíz de los módulos. --host carga funciones JavaScript
síncronas elegidas por el anfitrión. build crea un snapshot portable con SHA-256.
Sin --out, run no guarda checkpoints. Requiere Node.js 18+ y cero paquetes npm.
`;

function diagnostic(error) {
  return { error: error.message, file: error.file ?? null,
    line: error.line ?? null, column: error.column ?? null };
}

function display(value) {
  if (value?.type === 'tensor' && Array.isArray(value.shape) && ['f32', 'f64'].includes(value.dtype))
    return `Tensor[${value.shape.join(',')}] ${value.dtype} ${JSON.stringify(value.data)}`;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function positive(value, name) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new Error(`${name} debe ser un entero seguro positivo.`);
  return Number(value);
}

function optionsFor(command, args) {
  const options = { runtime: { captureGlobals: false }, json: false, root: undefined,
    output: null, inputs: null, host: null, globals: false, profile: false };
  const runtimeNames = { '--steps': 'stepLimit', '--operations': 'operationLimit',
    '--max-list': 'collectionLimit', '--max-loops': 'loopLimit' };
  const numericCommands = ['run', 'test'];
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--json' && command !== 'check') { options.json = true; continue; }
    if (name === '--globals' && command === 'run') { options.globals = true; options.runtime.captureGlobals = true; continue; }
    if (name === '--profile' && command === 'run') { options.profile = true; continue; }
    const allowed = name === '--root' && command !== 'init'
      || name === '--out' && ['run', 'build'].includes(command)
      || name === '--inputs' && command === 'run'
      || name === '--host' && numericCommands.includes(command)
      || name === '--seed' && numericCommands.includes(command)
      || Object.hasOwn(runtimeNames, name) && numericCommands.includes(command);
    if (!allowed) throw new Error(`Opción no reconocida: ${name}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Falta el valor de ${name}`);
    if (name === '--root') options.root = resolve(value);
    else if (name === '--out') options.output = resolve(value);
    else if (name === '--inputs') options.inputs = resolve(value);
    else if (name === '--host') options.host = resolve(value);
    else if (name === '--seed') {
      if (!/^\d+$/.test(value)) throw new Error('La semilla debe ser un entero no negativo.');
      options.runtime.seed = Number(value);
    } else options.runtime[runtimeNames[name]] = positive(value, name);
  }
  return options;
}

async function findProjectRoot(directory) {
  let current = directory;
  while (true) {
    try { if ((await stat(join(current, 'nerva.json'))).isFile()) return current; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function targetFor(filename, command, options) {
  const target = resolve(filename);
  const information = await stat(target);
  if (!information.isDirectory()) return { filename: target, root: options.root ?? await findProjectRoot(dirname(target)) };
  let config;
  try { config = JSON.parse(await readFile(join(target, 'nerva.json'), 'utf8')); }
  catch (error) {
    if (command === 'test' && error.code === 'ENOENT') return { filename: target, root: options.root ?? await findProjectRoot(target) ?? target };
    throw new Error(`No se puede leer nerva.json: ${error.message}`);
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('nerva.json debe ser un objeto.');
  const name = command === 'test' ? config.tests ?? 'tests' : config.entry ?? 'main.nv';
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('La ruta del proyecto debe ser una cadena.');
  const path = resolve(target, name);
  const inside = relative(target, path);
  if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || resolve(target, inside) !== path)
    throw new Error('La configuración apunta fuera del proyecto.');
  return { filename: path, root: options.root ?? target };
}

async function hostFor(filename) {
  const module = await import(pathToFileURL(filename).href);
  const functions = module.default ?? Object.fromEntries(Object.entries(module));
  if (!functions || Array.isArray(functions) || typeof functions !== 'object')
    throw new Error('El módulo host debe exportar funciones en un objeto.');
  return functions;
}

async function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); return; }
  if (args.length === 1 && args[0] === '--version') { process.stdout.write(`NERVA ${VERSION}\n`); return; }
  const [command, supplied, ...rest] = args;
  if (!['run', 'check', 'build', 'test', 'init'].includes(command)) throw new Error(HELP);
  const hasFilename = supplied && !supplied.startsWith('--');
  if (!hasFilename && command !== 'test') throw new Error(HELP);
  const filename = hasFilename ? supplied : '.';
  const options = optionsFor(command, hasFilename ? rest : args.slice(1));
  if (command === 'init') {
    const result = await initProject(filename);
    process.stdout.write(options.json ? JSON.stringify({ version: VERSION, ...result }) + '\n' : `Proyecto NERVA creado: ${result.root}\n`);
    return;
  }
  if (options.host) options.runtime.host = await hostFor(options.host);
  if (options.inputs) options.runtime.inputs = JSON.parse(await readFile(options.inputs, 'utf8'));
  const target = await targetFor(filename, command, options);
  if (command === 'test') {
    const information = await stat(target.filename);
    const root = target.root ?? (information.isDirectory() ? target.filename : dirname(target.filename));
    const files = await discoverTests(target.filename);
    if (!files.length) throw new Error('No se encontraron archivos *.test.nv.');
    const tests = [];
    for (const file of files) {
      const name = relative(root, file).split('\\').join('/');
      try {
        const project = await loadProject(file, { root });
        const result = project.prepared.run(options.runtime);
        tests.push({ file: name, status: 'passed', records: result.records, steps: result.steps });
      } catch (error) { tests.push({ file: name, status: 'failed', error: diagnostic(error) }); }
    }
    const failed = tests.filter(test => test.status === 'failed').length;
    const report = { version: VERSION, passed: tests.length - failed, failed, tests };
    if (options.json) process.stdout.write(JSON.stringify(report) + '\n');
    else {
      for (const test of tests) process.stdout.write(`${test.status === 'passed' ? 'OK' : 'FAIL'} ${test.file}${test.error ? ': ' + test.error.error : ''}\n`);
      process.stdout.write(`${report.passed} aprobadas; ${failed} fallidas.\n`);
    }
    if (failed) process.exitCode = 1;
    return;
  }
  if (command === 'build') {
    if (!options.output) throw new Error('build requiere --out archivo.nvb.');
    const bundle = await buildProject(target.filename, { root: target.root });
    const sourceRoot = target.root ?? dirname(target.filename);
    let outputIdentity;
    try { outputIdentity = await realpath(options.output); }
    catch (error) { if (error.code !== 'ENOENT') throw error; outputIdentity = options.output; }
    for (const name of Object.keys(bundle.sources)) {
      if (await realpath(resolve(sourceRoot, name)) === outputIdentity)
        throw new Error('build no puede sobrescribir un archivo fuente del proyecto.');
    }
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(bundle, null, 2) + '\n');
    process.stdout.write(options.json
      ? JSON.stringify({ version: VERSION, output: options.output, entry: bundle.entry, modules: Object.keys(bundle.sources).length }) + '\n'
      : `Paquete creado: ${options.output}\n`);
    return;
  }
  const project = target.filename.endsWith('.nvb')
    ? loadBundle(JSON.parse(await readFile(target.filename, 'utf8')))
    : await loadProject(target.filename, { root: target.root });
  if (command === 'check') { process.stdout.write('Sintaxis válida.\n'); return; }
  const result = project.prepared.run(options.runtime);
  if (options.output) {
    const checkpoints = result.records.filter(record => record.kind === 'checkpoint');
    if (checkpoints.length) await mkdir(options.output, { recursive: true });
    for (const record of checkpoints) await writeFile(join(options.output, `${record.name}.json`), JSON.stringify(record.checkpoint, null, 2) + '\n');
  }
  if (options.json) process.stdout.write(JSON.stringify({ version: VERSION, records: result.records, steps: result.steps,
    ...(options.profile ? { tensorOperations: result.tensorOperations } : {}), ...(options.globals ? { globals: result.globals } : {}) }) + '\n');
  else for (const record of result.records) {
    if (record.kind === 'print') process.stdout.write(record.values.map(display).join(' ') + '\n');
    else process.stdout.write(`Checkpoint: ${record.name}${options.output ? ' → ' + join(options.output, record.name + '.json') : ' (usa --out para guardarlo)'}\n`);
  }
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(JSON.stringify(diagnostic(error)) + '\n');
  process.exitCode = 1;
});
