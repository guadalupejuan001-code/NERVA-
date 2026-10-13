import { readFile, writeFile, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, dirname, basename, sep, posix, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from './parser.mjs';
import { prepareProgram, VERSION } from './runtime.mjs';

const sha256 = source => createHash('sha256').update(source, 'utf8').digest('hex');
const own = (value, key) => Object.hasOwn(value, key);
const slash = path => path.split(sep).join('/');
const defaults = { maxModules: 1000, maxSourceBytes: 10 * 1024 * 1024 };

function annotate(error, filename, node = {}) {
  error.file ??= filename;
  error.line ??= node.line ?? null;
  error.column ??= node.column ?? null;
  return error;
}

function within(root, file) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function moduleId(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
      || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value !== posix.normalize(value)
      || value === '..' || value.startsWith('../') || !value.endsWith('.nv')) {
    throw new Error(`Invalid project module path: ${String(value)}`);
  }
  return value;
}

function allowances(options) {
  const result = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const value = options[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
    result[name] = value;
  }
  return result;
}

function prepared(entry, sources) {
  const modules = Object.fromEntries(Object.entries(sources).filter(([name]) => name !== entry));
  return prepareProgram(sources[entry], { filename: entry, modules });
}

export async function loadProject(filename, options = {}) {
  const entryPath = resolve(filename);
  const requestedRoot = resolve(options.root ?? dirname(entryPath));
  if (!within(requestedRoot, entryPath)) throw annotate(new Error('Entry is outside project root'), filename);
  const root = await realpath(requestedRoot);
  const entry = moduleId(slash(relative(requestedRoot, entryPath)));
  const limits = allowances(options);
  const sources = Object.create(null), visiting = new Set();
  let bytes = 0;

  async function visit(id, importer = id, node = {}) {
    if (visiting.has(id)) throw annotate(new Error(`Module cycle: ${[...visiting, id].join(' -> ')}`), importer, node);
    if (own(sources, id)) return;
    if (Object.keys(sources).length >= limits.maxModules) throw new Error(`Project exceeds ${limits.maxModules} modules`);
    const path = resolve(root, ...moduleId(id).split('/'));
    try {
      const physical = await realpath(path);
      if (!within(root, physical)) throw new Error(`Module escapes project root: ${id}`);
      const information = await stat(physical);
      if (!information.isFile()) throw new Error(`Module is not a file: ${id}`);
      if (bytes + information.size > limits.maxSourceBytes) throw new Error(`Project exceeds ${limits.maxSourceBytes} source bytes`);
      const source = await readFile(physical, 'utf8');
      bytes += Buffer.byteLength(source, 'utf8');
      if (bytes > limits.maxSourceBytes) throw new Error(`Project exceeds ${limits.maxSourceBytes} source bytes`);
      sources[id] = source;
      let ast;
      try { ast = parse(source); }
      catch (error) { throw annotate(error, id); }
      visiting.add(id);
      for (const statement of ast.body) {
        if (statement.type !== 'import') continue;
        if (!statement.path.startsWith('./') && !statement.path.startsWith('../'))
          throw annotate(new Error('Imports must use relative .nv paths'), id, statement);
        const target = posix.normalize(posix.join(posix.dirname(id), statement.path));
        try { moduleId(target); }
        catch { throw annotate(new Error(`Import escapes project root or has an invalid .nv path: ${statement.path}`), id, statement); }
        await visit(target, id, statement);
      }
      visiting.delete(id);
    } catch (error) {
      throw annotate(error, importer, node);
    }
  }

  await visit(entry);
  const ordered = Object.fromEntries(Object.keys(sources).sort().map(id => [id, sources[id]]));
  return { root, entry, sources: ordered, prepared: prepared(entry, ordered) };
}

export async function buildProject(filename, options = {}) {
  const project = await loadProject(filename, options);
  return { format: 'nerva-bundle', version: 1, languageVersion: VERSION,
    entry: project.entry, sources: project.sources,
    hashes: Object.fromEntries(Object.entries(project.sources).map(([id, source]) => [id, sha256(source)])) };
}

export function loadBundle(bundle, options = {}) {
  if (!bundle || Array.isArray(bundle) || typeof bundle !== 'object'
      || bundle.format !== 'nerva-bundle' || bundle.version !== 1 || bundle.languageVersion !== VERSION
      || !bundle.sources || Array.isArray(bundle.sources) || typeof bundle.sources !== 'object'
      || !bundle.hashes || Array.isArray(bundle.hashes) || typeof bundle.hashes !== 'object') {
    throw new Error('Invalid or incompatible NERVA bundle');
  }
  const limits = allowances(options);
  const entry = moduleId(bundle.entry);
  const keys = Object.keys(bundle.sources).sort();
  if (!keys.length || keys.length > limits.maxModules || !own(bundle.sources, entry))
    throw new Error('Invalid bundle entry or module count');
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(bundle.hashes).sort()))
    throw new Error('Bundle sources and hashes must have identical keys');
  let bytes = 0;
  const sources = Object.create(null);
  for (const id of keys) {
    moduleId(id);
    const source = bundle.sources[id];
    if (typeof source !== 'string') throw new Error(`Invalid bundle source: ${id}`);
    bytes += Buffer.byteLength(source, 'utf8');
    if (bytes > limits.maxSourceBytes) throw new Error(`Bundle exceeds ${limits.maxSourceBytes} source bytes`);
    if (bundle.hashes[id] !== sha256(source)) throw new Error(`Bundle hash mismatch: ${id}`);
    sources[id] = source;
  }
  const ordered = Object.fromEntries(Object.entries(sources));
  return { entry, sources: ordered, prepared: prepared(entry, ordered) };
}

export async function discoverTests(directory) {
  const root = resolve(directory);
  const information = await stat(root);
  if (information.isFile()) {
    if (!root.endsWith('.test.nv')) throw new Error('A NERVA test file must end in .test.nv');
    return [root];
  }
  const results = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const item of entries) {
      if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'private') continue;
      const child = resolve(path, item.name);
      if (item.isDirectory()) await walk(child);
      else if (item.isFile() && item.name.endsWith('.test.nv')) results.push(child);
    }
  }
  await walk(root);
  return results;
}

export async function initProject(destination) {
  const root = resolve(destination);
  try {
    const entries = await readdir(root);
    if (entries.length) throw new Error('Project destination must be empty; existing files are never overwritten');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(resolve(root, 'lib'), { recursive: true });
  await mkdir(resolve(root, 'tests'), { recursive: true });
  const files = {
    'nerva.json': JSON.stringify({ name: basename(root), version: '0.1.0', entry: 'main.nv', tests: 'tests' }, null, 2) + '\n',
    'main.nv': 'nerva 0.3\nimport { greeting } from "./lib/greeting.nv"\nprint(greeting("NERVA"))\n',
    'lib/greeting.nv': 'nerva 0.3\nexport fn greeting(name) { return "Hola, " + name }\n',
    'tests/greeting.test.nv': 'nerva 0.3\nimport { greeting } from "../lib/greeting.nv"\nassert(greeting("NERVA") == "Hola, NERVA")\n',
  };
  for (const [name, source] of Object.entries(files)) await writeFile(resolve(root, name), source, { flag: 'wx' });
  return { root, files: Object.keys(files) };
}
