// NERVA 0.3: modules, persistent collections and an explicit host boundary.
import path from './virtual-path.mjs';
import { parse, LangError } from './parser.mjs';
import * as T from './tensor.mjs';

export const VERSION = '0.3.0';
const MAX_STEPS = 200000;
const MAX_OUTPUT = 1000;
const MAX_OUTPUT_CHARS = 10000000;
const MAX_LIST = 100000;
const MAX_STRING = 200000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function () {});

class Environment {
  constructor(parent = null) { this.parent = parent; this.bindings = new Map(); }
  define(name, value, mutable = false) {
    if (this.bindings.has(name)) throw new Error(`Ya existe '${name}' en este ámbito.`);
    this.bindings.set(name, { value, mutable });
  }
  reference(name, binding) {
    if (this.bindings.has(name)) throw new Error(`Ya existe '${name}' en este ámbito.`);
    this.bindings.set(name, { get value() { return binding.value; }, mutable: false });
  }
  resolve(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    if (this.parent) return this.parent.resolve(name);
    throw new Error(`Nombre desconocido: '${name}'.`);
  }
  assign(name, value) {
    const binding = this.resolve(name);
    if (!binding.mutable) throw new Error(`'${name}' es constante; no puede reasignarse.`);
    binding.value = value;
  }
}
class Builtin {
  constructor(name, fn) { this.name = name; this.fn = fn; }
}
class UserFunction {
  constructor(node, env) { this.node = node; this.env = env; }
}
// No JavaScript properties or prototypes are visible through a NERVA record.
class RecordValue {
  constructor(entries = []) { this.entries = new Map(entries); }
}
class BindingReference {
  constructor(binding) { this.binding = binding; }
}
const dereference = value => value instanceof BindingReference ? value.binding.value : value;
class Signal {
  constructor(kind, value = null) { this.kind = kind; this.value = value; }
}

function finite(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Se esperaba un número finito.');
  return value;
}
function integer(value, name = 'valor') {
  finite(value);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} debe ser un entero seguro.`);
  return value;
}
function boolean(value) {
  if (typeof value !== 'boolean') throw new Error('La condición debe ser booleana; compara valores explícitamente.');
  return value;
}
function asTensor(value) {
  if (!(value instanceof T.Tensor)) throw new Error('Se esperaba un Tensor. Usa tensor([...]).');
  return value;
}
function shapeEqual(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
function params(value) {
  const result = Array.isArray(value) ? value : [value];
  if (!result.length || result.length > 32) throw new Error('Se requieren entre 1 y 32 parámetros.');
  if (new Set(result).size !== result.length) throw new Error('Un parámetro no puede aparecer dos veces.');
  for (const p of result) {
    asTensor(p);
    if (!p.requiresGrad || (p._parents && p._parents.length)) throw new Error('Se requieren parámetros hoja declarados con param.');
  }
  return result;
}
function scalar(value) {
  if (value instanceof T.Tensor) {
    if (value.shape.length !== 0) throw new Error('value() necesita un Tensor escalar.');
    return finite(value.data[0]);
  }
  return finite(value);
}
function string(value) {
  if (typeof value !== 'string') throw new Error('Se esperaba una cadena.');
  return value;
}
function boundedString(value) {
  string(value);
  if (value.length > MAX_STRING) throw new Error(`La cadena supera ${MAX_STRING} caracteres.`);
  return value;
}
function list(value) {
  if (!Array.isArray(value)) throw new Error('Se esperaba una lista.');
  return value;
}
function jsonValue(value, { collectionLimit = MAX_LIST } = {}) {
  let nodes = 0, chars = 0;
  const ancestors = new Set();
  function visit(v, depth = 0) {
    if (++nodes > 1000000) throw new Error('El JSON supera 1000000 valores y contenedores.');
    if (depth > 64) throw new Error('El JSON supera 64 niveles.');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return finite(v);
    if (typeof v === 'string') {
      chars += v.length;
      if (v.length > MAX_STRING || chars > MAX_OUTPUT_CHARS) throw new Error('Las cadenas JSON superan el límite de tamaño.');
      return v;
    }
    if (!v || typeof v !== 'object' || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null && !Array.isArray(v))) throw new Error('Se requieren valores JSON: números finitos, cadenas, booleanos, null, listas y registros.');
    if (ancestors.has(v)) throw new Error('El JSON no admite ciclos.');
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length > collectionLimit) throw new Error(`La lista JSON supera ${collectionLimit} elementos.`);
        const result = [];
        for (let i = 0; i < v.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('El JSON no admite listas dispersas ni propiedades calculadas.');
          result.push(visit(descriptor.value, depth + 1));
        }
        if (Reflect.ownKeys(v).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length))) throw new Error('La lista JSON contiene propiedades adicionales.');
        return result;
      }
      const keys = Reflect.ownKeys(v);
      if (keys.length > collectionLimit) throw new Error(`El registro JSON supera ${collectionLimit} entradas.`);
      const entries = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('El JSON no admite símbolos ni propiedades calculadas.');
        chars += key.length;
        if (key.length > MAX_STRING || chars > MAX_OUTPUT_CHARS) throw new Error('Las claves JSON superan el límite de tamaño.');
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      return new RecordValue(entries);
    } finally { ancestors.delete(v); }
  }
  return visit(value);
}
function plain(value, depth = 0, reserve = () => {}, describeFunctions = false) {
  reserve(1, 2);
  if (depth > 64) throw new Error('La salida supera 64 niveles.');
  if (value instanceof T.Tensor) {
    let prefix = 1, count = 0;
    for (const size of value.shape) { prefix *= size; count += prefix; }
    reserve(count, count * 2 + 100);
    for (const number of value.data) reserve(0, String(finite(number)).length);
    return T.serialize(value);
  }
  if (Array.isArray(value)) { reserve(0, value.length); return value.map(v => plain(v, depth + 1, reserve, describeFunctions)); }
  if (value instanceof RecordValue) {
    const result = Object.create(null);
    for (const [key, entry] of value.entries) {
      reserve(0, JSON.stringify(key).length + 2);
      result[key] = plain(dereference(entry), depth + 1, reserve, describeFunctions);
    }
    return result;
  }
  if (describeFunctions && (value instanceof UserFunction || value instanceof Builtin)) {
    const name = value.node?.name ?? value.name; reserve(0, name.length + 40);
    return { type: 'function', name };
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') { reserve(0, JSON.stringify(value).length); return value; }
  if (typeof value === 'number') { reserve(0, String(finite(value)).length); return value; }
  throw new Error('Este valor no se puede imprimir ni exportar.');
}

function annotateError(error, file, node) {
  if (!(error instanceof LangError)) error = new LangError(error?.message || String(error), { line: node?.line, column: node?.column, file });
  if (!error.file) error.file = file;
  return error;
}
function freezeAst(value, file) {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value)) value.file = file;
  for (const entry of Object.values(value)) if (entry && typeof entry === 'object') freezeAst(entry, file);
  return Object.freeze(value);
}
export function prepareProgram(source, { filename = '<program>', modules = {} } = {}) {
  if (typeof filename !== 'string' || !filename.length) throw new LangError('filename debe ser una cadena no vacía.');
  const rootFile = path.posix.normalize(filename);
  if (!modules || typeof modules !== 'object' || Array.isArray(modules)) throw annotateError(new Error('modules debe ser un objeto de nombres de archivo y fuentes.'), rootFile);
  const sources = new Map();
  for (const key of Object.keys(modules)) {
    const descriptor = Object.getOwnPropertyDescriptor(modules, key);
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') throw annotateError(new Error('Cada módulo debe tener una fuente de texto.'), rootFile);
    const canonical = path.posix.normalize(key);
    if (sources.has(canonical)) throw annotateError(new Error(`Nombre de módulo duplicado: '${canonical}'.`), rootFile);
    sources.set(canonical, descriptor.value);
  }
  const programs = new Map(), visiting = new Set();
  function load(file, text, importingNode = null) {
    if (visiting.has(file)) throw annotateError(new Error(`Importación circular: '${file}'.`), importingNode?.file ?? file, importingNode);
    if (programs.has(file)) return programs.get(file);
    let ast;
    try { ast = freezeAst(parse(text), file); }
    catch (error) { throw annotateError(error, file); }
    const exports = new Set(ast.body.filter(node => node.exported).map(node => node.name));
    const entry = { ast, imports: new Map(), exports };
    visiting.add(file);
    try {
      for (const node of ast.body) {
        if (node.type !== 'import') continue;
        if (typeof node.path !== 'string' || (!node.path.startsWith('./') && !node.path.startsWith('../'))) throw annotateError(new Error('Las importaciones requieren una ruta relativa ./ o ../.'), file, node);
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), node.path));
        if (!sources.has(dependency)) throw annotateError(new Error(`Módulo no encontrado: '${dependency}'.`), file, node);
        const loaded = load(dependency, sources.get(dependency), node);
        for (const name of node.names ?? []) if (!loaded.exports.has(name.imported)) throw annotateError(new Error(`'${dependency}' no exporta '${name.imported}'.`), file, node);
        entry.imports.set(node, dependency);
      }
      programs.set(file, entry);
      return entry;
    } finally { visiting.delete(file); }
  }
  load(rootFile, source);
  return Object.freeze({ run(options = {}) { return executeProgram(programs, rootFile, options); } });
}
export function runProgram(source, options = {}) {
  return prepareProgram(source, { filename: options.filename, modules: options.modules }).run(options);
}
function executeProgram(programs, rootFile, options) {
  const operationLimit = options.operationLimit ?? 20000000;
  const limit = options.stepLimit ?? MAX_STEPS;
  const collectionLimit = options.collectionLimit ?? MAX_LIST;
  const loopLimit = options.loopLimit ?? MAX_LIST;
  for (const [name, value] of [['operationLimit', operationLimit], ['stepLimit', limit], ['collectionLimit', collectionLimit], ['loopLimit', loopLimit]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw annotateError(new Error(`${name} debe ser un entero seguro positivo.`), rootFile);
  }
  const budget = T.createBudget(operationLimit);
  try { return T.withBudget(budget, () => executeWithBudget(programs, rootFile, options, budget, { limit, collectionLimit, loopLimit })); }
  catch (error) { throw annotateError(error, error?.file ?? rootFile); }
}
function executeWithBudget(programs, rootFile, options, budget, { limit, collectionLimit, loopLimit }) {
  const ast = programs.get(rootFile).ast;
  let steps = 0, outputChars = 0, serializationNodes = 0, serializationChars = 0, depth = 0, loopDepth = 0;
  let randomState = 42;
  const records = [];
  const base = new Environment();
  const global = new Environment(base);
  let currentNode = ast;
  const contexts = new Map([[rootFile, global]]);
  const initialized = new Set();
  const tick = node => {
    steps += 1;
    if (steps > limit) throw annotateError(new Error(`Se agotó el límite de ${limit} pasos.`), node?.file ?? rootFile, node);
  };
  const sized = value => {
    if (value.length > collectionLimit) throw new Error(`La lista supera ${collectionLimit} elementos.`);
    return value;
  };
  const recordVersion = () => programs.get(currentNode?.file ?? rootFile)?.ast.version ?? '0.2';
  const record = value => {
    if (records.length >= MAX_OUTPUT) throw new Error('La ejecución supera 1000 salidas.');
    const bytes = JSON.stringify(value).length;
    if (outputChars + bytes > MAX_OUTPUT_CHARS) throw new Error('La salida supera 10 millones de caracteres.');
    outputChars += bytes; records.push(value);
  };
  const reserve = (count, chars = 0) => {
    if (!Number.isSafeInteger(count) || count < 0 || serializationNodes + count > 1000000) throw new Error('La serialización supera el límite de 1000000 valores y contenedores.');
    if (!Number.isSafeInteger(chars) || chars < 0 || serializationChars + chars > MAX_OUTPUT_CHARS) throw new Error('La serialización supera el límite de 10 millones de caracteres.');
    serializationNodes += count;
    serializationChars += chars;
  };
  const builtin = (name, min, max, fn) => base.define(name, new Builtin(name, args => {
    if (args.length < min || args.length > max) throw new Error(`${name} espera ${min === max ? min : `${min}–${max}`} argumentos; recibió ${args.length}.`);
    return fn(...args);
  }));
  const seed = value => {
    integer(value, 'La semilla');
    if (value < 0 || value > 4294967295) throw new Error('La semilla debe estar entre 0 y 4294967295.');
    randomState = value >>> 0; return null;
  };
  const uniform = () => {
    randomState = (randomState + 0x6D2B79F5) >>> 0;
    let z = randomState;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  seed(options.seed ?? 42);
  builtin('seed', 1, 1, seed);
  builtin('tensor', 1, 1, value => T.tensor(value, 'f32'));
  builtin('tensor64', 1, 1, value => T.tensor(value, 'f64'));
  builtin('zeros', 1, 2, (shape, dtype = 'f32') => T.zeros(shape, dtype));
  builtin('ones', 1, 2, (shape, dtype = 'f32') => T.ones(shape, dtype));
  builtin('randn', 1, 2, (shape, scale = 1) => {
    finite(scale); const result = T.zeros(shape);
    for (let i = 0; i < result.data.length; i++) {
      const u = Math.max(uniform(), Number.MIN_VALUE), v = uniform();
      const sample = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale;
      result.data[i] = sample;
      if (!Number.isFinite(result.data[i])) throw new Error('randn produjo un valor fuera del rango del Tensor.');
    }
    return result;
  });
  builtin('shape', 1, 1, value => sized([...asTensor(value).shape]));
  builtin('reshape', 2, 2, (value, shape) => T.reshape(asTensor(value), shape));
  builtin('transpose', 1, 1, value => T.transpose(asTensor(value)));
  for (const name of ['relu', 'tanh', 'sigmoid', 'exp', 'log', 'sum', 'mean', 'softmax']) builtin(name, 1, 1, value => T[name](asTensor(value)));
  builtin('mse', 2, 2, (a, b) => T.mse(asTensor(a), asTensor(b)));
  builtin('cross_entropy', 2, 2, (logits, labels) => T.crossEntropy(asTensor(logits), labels));
  builtin('argmax', 1, 1, value => T.argmax(asTensor(value)));
  builtin('select_token', 8, 8, (logits, excluded, generated, temperature, topK, topP, penalty, draw) =>
    T.selectToken(asTensor(logits), excluded, generated, temperature, topK, topP, penalty, draw));
  builtin('detach', 1, 1, value => T.detach(asTensor(value)));
  builtin('backward', 1, 1, loss => { T.backward(asTensor(loss)); return null; });
  builtin('zero_grad', 1, 1, value => { T.zeroGrad(params(value)); return null; });
  builtin('step', 2, 2, (value, lr) => { T.step(params(value), finite(lr)); return null; });
  builtin('grad', 1, 1, value => {
    const p = asTensor(value);
    if (p.grad === null) throw new Error('Este Tensor aún no tiene gradiente; llama backward(loss).');
    return T.fromFlat(p.grad, p.shape, 'f64');
  });
  builtin('value', 1, 1, scalar);
  builtin('print', 1, 32, (...values) => { record({ kind: 'print', values: values.map(v => plain(v, 0, reserve)), version: recordVersion() }); return null; });
  builtin('assert', 1, 2, (test, message = 'La comprobación falló.') => {
    if (!boolean(test)) throw new Error(typeof message === 'string' ? message : 'La comprobación falló.');
    return null;
  });
  builtin('range', 1, 3, (a, b = undefined, stride = 1) => {
    let start = b === undefined ? 0 : integer(a), end = b === undefined ? integer(a) : integer(b);
    integer(stride, 'El paso');
    if (!stride) throw new Error('range no admite paso cero.');
    const count = Math.max(0, Math.ceil((end - start) / stride));
    if (!Number.isSafeInteger(count) || count > collectionLimit) throw new Error(`range supera ${collectionLimit} elementos.`);
    return Array.from({ length: count }, (_, i) => integer(start + i * stride, 'Un valor de range'));
  });
  builtin('len', 1, 1, value => {
    if (Array.isArray(value)) return value.length;
    if (value instanceof RecordValue) return value.entries.size;
    if (typeof value === 'string') return Array.from(value).length;
    if (value instanceof T.Tensor && value.shape.length) return value.shape[0];
    throw new Error('len espera una lista, un registro, una cadena o un Tensor con dimensiones.');
  });
  const lookup = (target, key, fallback = null, required = false) => {
    if (target instanceof RecordValue) {
      string(key);
      if (target.entries.has(key)) return dereference(target.entries.get(key));
      if (required) throw new Error(`Clave desconocida: '${key}'.`);
    } else {
      integer(key, 'El índice');
      const values = typeof target === 'string' ? Array.from(target) : target;
      if (!Array.isArray(values)) throw new Error('Se esperaba una lista, una cadena o un registro.');
      if (key >= 0 && key < values.length) return values[key];
    }
    if (required) throw new Error('Índice fuera de rango o clave desconocida.');
    return fallback;
  };
  builtin('append', 2, 2, (values, value) => { list(values); if (values.length >= collectionLimit) throw new Error(`La lista supera ${collectionLimit} elementos.`); return [...values, value]; });
  builtin('concat', 2, 2, (a, b) => { list(a); list(b); if (a.length + b.length > collectionLimit) throw new Error(`La lista supera ${collectionLimit} elementos.`); return [...a, ...b]; });
  builtin('slice', 2, 3, (values, start, end = undefined) => {
    const text = typeof values === 'string';
    const elements = text ? Array.from(values) : list(values);
    integer(start, 'El inicio'); end = end === undefined ? elements.length : integer(end, 'El final');
    if (start < 0 || end < start || end > elements.length) throw new Error('slice fuera de rango: requiere 0 <= inicio <= final <= longitud.');
    const result = elements.slice(start, end);
    return text ? result.join('') : result;
  });
  builtin('get', 2, 3, lookup);
  builtin('has', 2, 2, (target, key) => {
    if (target instanceof RecordValue) return target.entries.has(string(key));
    const values = typeof target === 'string' ? Array.from(target) : list(target);
    integer(key, 'El índice'); return key >= 0 && key < values.length;
  });
  builtin('set', 3, 3, (target, key, value) => {
    if (target instanceof RecordValue) {
      boundedString(key);
      if (!target.entries.has(key) && target.entries.size >= collectionLimit) throw new Error(`El registro supera ${collectionLimit} entradas.`);
      const result = new RecordValue(target.entries); result.entries.set(key, value); return result;
    }
    const values = list(target); integer(key, 'El índice');
    if (key < 0 || key >= values.length) throw new Error('Índice fuera de rango.');
    const result = [...values]; result[key] = value; return result;
  });
  builtin('keys', 1, 1, value => { if (!(value instanceof RecordValue)) throw new Error('keys espera un registro.'); return sized([...value.entries.keys()]); });
  builtin('values', 1, 1, value => { if (!(value instanceof RecordValue)) throw new Error('values espera un registro.'); return sized([...value.entries.values()].map(dereference)); });
  const callable = value => { if (!(value instanceof UserFunction) && !(value instanceof Builtin)) throw new Error('Se esperaba una función.'); return value; };
  builtin('map', 2, 2, (values, fn) => { list(values); callable(fn); return values.map(value => invoke(fn, [value], currentNode)); });
  builtin('filter', 2, 2, (values, fn) => { list(values); callable(fn); return values.filter(value => boolean(invoke(fn, [value], currentNode))); });
  builtin('reduce', 3, 3, (values, fn, initial) => { list(values); callable(fn); return values.reduce((result, value) => invoke(fn, [result, value], currentNode), initial); });
  builtin('sort', 2, 2, (values, fn) => { list(values); callable(fn); return [...values].sort((a, b) => finite(invoke(fn, [a, b], currentNode))); });
  builtin('split', 2, 2, (text, separator) => {
    string(text); string(separator);
    // Limit the native allocation even when the separator matches every character.
    const result = text.split(separator, Math.min(collectionLimit + 1, MAX_STRING + 1));
    return sized(result);
  });
  builtin('join', 1, 2, (values, separator = '') => {
    list(values); string(separator);
    let length = separator.length * Math.max(0, values.length - 1);
    for (const value of values) { string(value); length += value.length; }
    if (length > MAX_STRING) throw new Error(`La cadena supera ${MAX_STRING} caracteres.`);
    return values.join(separator);
  });
  builtin('trim', 1, 1, value => boundedString(string(value).trim()));
  builtin('lower', 1, 1, value => boundedString(string(value).toLowerCase()));
  builtin('upper', 1, 1, value => boundedString(string(value).toUpperCase()));
  builtin('replace', 3, 3, (text, search, replacement) => {
    string(text); string(search); string(replacement);
    let count = 0;
    if (!search.length) count = text.length + 1;
    else { for (let position = 0; (position = text.indexOf(search, position)) >= 0; position += search.length) count++; }
    if (text.length + count * (replacement.length - search.length) > MAX_STRING) throw new Error(`La cadena supera ${MAX_STRING} caracteres.`);
    return boundedString(text.replaceAll(search, () => replacement));
  });
  builtin('contains', 2, 2, (target, value) => {
    if (typeof target === 'string') return target.includes(string(value));
    list(target);
    if (value !== null && typeof value === 'object' || value instanceof UserFunction || value instanceof Builtin) throw new Error('contains compara valores escalares.');
    return target.includes(value);
  });
  builtin('str', 1, 1, value => {
    if (typeof value === 'string') return value;
    if (value === null || typeof value === 'boolean') return String(value);
    if (typeof value === 'number') return String(finite(value));
    return boundedString(JSON.stringify(plain(value, 0, reserve)));
  });
  builtin('number', 1, 1, value => {
    if (typeof value === 'number') return finite(value);
    if (typeof value !== 'string') throw new Error('number espera un número finito o una cadena numérica.');
    if (!value.trim().length) throw new Error('number necesita una cadena numérica no vacía.');
    return finite(Number(value));
  });
  builtin('json_parse', 1, 1, text => {
    boundedString(text);
    let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('El texto no es JSON válido.'); }
    return jsonValue(parsed, { collectionLimit });
  });
  builtin('json_stringify', 1, 1, value => boundedString(JSON.stringify(plain(value, 0, reserve))));
  builtin('abs', 1, 1, value => Math.abs(finite(value)));
  for (const name of ['round', 'floor', 'ceil']) builtin(name, 1, 1, value => finite(Math[name](finite(value))));
  builtin('sqrt', 1, 1, value => value instanceof T.Tensor ? T.pow(value, 0.5) : finite(Math.sqrt(finite(value))));
  builtin('min', 2, 2, (a, b) => Math.min(finite(a), finite(b)));
  builtin('max', 2, 2, (a, b) => Math.max(finite(a), finite(b)));
  builtin('checkpoint', 2, 2, (name, values) => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('El nombre del checkpoint admite 1–64 letras ASCII, números, _ o -.');
    const checkpoint = { format: 'nerva-checkpoint', version: 1, tensors: params(values).map(p => {
      const { shape, dtype, data } = plain(p, 0, reserve); return { shape, dtype, data };
    }) };
    record({ kind: 'checkpoint', name, checkpoint, version: recordVersion() });
    return JSON.stringify(checkpoint);
  });
  builtin('restore', 2, 2, (text, values) => {
    if (typeof text !== 'string' || text.length > MAX_OUTPUT_CHARS) throw new Error('restore espera una cadena JSON de checkpoint de hasta 10 millones de caracteres.');
    const ps = params(values);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('El checkpoint no es JSON válido.'); }
    if (!data || data.format !== 'nerva-checkpoint' || data.version !== 1 || !Array.isArray(data.tensors) || data.tensors.length !== ps.length) throw new Error('Formato o número de parámetros del checkpoint incorrecto.');
    const prepared = data.tensors.map((p, i) => {
      if (!p || !Array.isArray(p.shape) || !shapeEqual(p.shape, ps[i].shape) || p.dtype !== ps[i].dtype) throw new Error(`El parámetro ${i} del checkpoint tiene dimensiones o dtype incompatibles.`);
      const tensor = T.tensor(p.data, p.dtype);
      if (!shapeEqual(tensor.shape, p.shape)) throw new Error(`Los datos del parámetro ${i} no coinciden con sus dimensiones.`);
      return tensor;
    });
    // Validate every parameter before any change, so a bad checkpoint is atomic.
    ps.forEach((p, i) => { p.data.set(prepared[i].data); p.grad = null; p._version++; });
    return null;
  });

  if (options.host !== undefined) {
    if (!options.host || typeof options.host !== 'object' || Array.isArray(options.host)) throw new Error('host debe ser un objeto de funciones síncronas.');
    const entries = [];
    for (const name of Reflect.ownKeys(options.host)) {
      const descriptor = Object.getOwnPropertyDescriptor(options.host, name);
      if (typeof name !== 'string' || !NAME.test(name) || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw new Error('Cada entrada host debe ser una función síncrona con un nombre válido.');
      const handler = descriptor.value;
      if (Object.getPrototypeOf(handler) === ASYNC_FUNCTION_PROTOTYPE) throw new Error(`host.${name} debe ser una función síncrona.`);
      entries.push([name, new Builtin(`host.${name}`, args => {
        // The handler receives copies; interpreter values and environments stay private.
        try {
          const copied = args.map(value => plain(value, 0, reserve));
          const result = handler(...copied);
          if (result instanceof Promise) {
            // Consume a rejected native Promise before reporting the synchronous API error.
            Promise.prototype.then.call(result, undefined, () => {});
            throw new Error('El anfitrión debe devolver JSON síncrono; Promise no está permitido.');
          }
          return jsonValue(result, { collectionLimit });
        } catch (error) { throw new Error(`host.${name}: ${error?.message || String(error)}`); }
      })]);
    }
    if (entries.length > collectionLimit) throw new Error(`host supera ${collectionLimit} funciones.`);
    base.define('host', new RecordValue(entries));
  }
  if (options.inputs !== undefined) {
    const inputs = jsonValue(options.inputs, { collectionLimit });
    if (!(inputs instanceof RecordValue)) throw new Error('inputs debe ser un objeto JSON de nombres y valores.');
    for (const [name, value] of inputs.entries) {
      if (!NAME.test(name) || base.bindings.has(name)) throw new Error(`Nombre de entrada no permitido: '${name}'.`);
      global.define(name, value);
    }
  }
  const wrap = (node, fn) => {
    const previousNode = currentNode; currentNode = node ?? previousNode;
    try { return fn(); }
    catch (error) {
      if (error instanceof Signal) throw error;
      throw annotateError(error, node?.file ?? rootFile, node);
    }
    finally { currentNode = previousNode; }
  };
  function invoke(callee, args, node) {
    tick(node);
    return wrap(node, () => {
      if (args.length > 32) throw new Error('Una llamada admite hasta 32 argumentos.');
      if (callee instanceof Builtin) return callee.fn(args);
      if (!(callee instanceof UserFunction)) throw new Error('Este valor no es una función.');
      if (args.length !== callee.node.params.length) throw new Error(`${callee.node.name} espera ${callee.node.params.length} argumentos.`);
      if (depth >= 64) throw new Error('La llamada supera el límite de 64 niveles de funciones.');
      const local = new Environment(callee.env);
      callee.node.params.forEach((name, i) => local.define(name, args[i], true));
      const oldLoopDepth = loopDepth; loopDepth = 0; depth++;
      try { executeBlock(callee.node.body, local); return null; }
      catch (signal) { if (signal instanceof Signal && signal.kind === 'return') return signal.value; throw signal; }
      finally { depth--; loopDepth = oldLoopDepth; }
    });
  }
  function evaluate(node, env) {
    tick(node);
    return wrap(node, () => {
      switch (node.type) {
        case 'literal': return node.value;
        case 'id': return env.resolve(node.name).value;
        case 'list': if (node.items.length > collectionLimit) throw new Error(`La lista supera ${collectionLimit} elementos.`); return node.items.map(item => evaluate(item, env));
        case 'record': {
          if (node.entries.length > collectionLimit) throw new Error(`El registro supera ${collectionLimit} entradas.`);
          return new RecordValue(node.entries.map(entry => [entry.key, evaluate(entry.value, env)]));
        }
        case 'member': return lookup(evaluate(node.target, env), node.name, null, true);
        case 'unary': {
          const arg = evaluate(node.arg, env);
          if (node.op === 'not') return !boolean(arg);
          if (node.op === '+') return arg instanceof T.Tensor ? arg : finite(arg);
          if (node.op === '-') return arg instanceof T.Tensor ? T.neg(arg) : -finite(arg);
          throw new Error(`Operador desconocido: ${node.op}.`);
        }
        case 'binary': {
          const a = evaluate(node.left, env);
          if (node.op === 'and') return boolean(a) && boolean(evaluate(node.right, env));
          if (node.op === 'or') return boolean(a) || boolean(evaluate(node.right, env));
          const b = evaluate(node.right, env), tensor = a instanceof T.Tensor || b instanceof T.Tensor;
          if (node.op === '@') return T.matmul(asTensor(a), asTensor(b));
          const operators = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '^': 'pow' };
          if (operators[node.op] && tensor) return T[operators[node.op]](a, b);
          if (node.op === '+' && typeof a === 'string' && typeof b === 'string') {
            if (a.length + b.length > 200000) throw new Error('La cadena supera 200000 caracteres.');
            return a + b;
          }
          if (node.op === '==' || node.op === '!=') {
            if (tensor || Array.isArray(a) || Array.isArray(b) || typeof a === 'object' && a !== null || typeof b === 'object' && b !== null) throw new Error('Compara valores escalares; para Tensor escalar usa value().');
            return node.op === '==' ? a === b : a !== b;
          }
          finite(a); finite(b);
          switch (node.op) {
            case '+': return finite(a + b); case '-': return finite(a - b);
            case '*': return finite(a * b); case '/': return finite(a / b);
            case '%': if (b === 0) throw new Error('El divisor de % no puede ser cero.'); return finite(a % b);
            case '^': return finite(a ** b);
            case '<': return a < b; case '<=': return a <= b;
            case '>': return a > b; case '>=': return a >= b;
            default: throw new Error(`Operador desconocido: ${node.op}.`);
          }
        }
        case 'index': {
          const target = evaluate(node.target, env), index = evaluate(node.index, env);
          if (target instanceof T.Tensor) return T.sliceFirst(target, integer(index, 'El índice'));
          return lookup(target, index, null, true);
        }
        case 'call': {
          const callee = evaluate(node.callee, env);
          if (node.args.length > 32) throw new Error('Una llamada admite hasta 32 argumentos.');
          const args = node.args.map(arg => evaluate(arg, env));
          return invoke(callee, args, node);
        }
        default: throw new Error(`Expresión desconocida: ${node.type}.`);
      }
    });
  }
  function execute(node, env) {
    tick(node);
    return wrap(node, () => {
      switch (node.type) {
        case 'import': {
          const file = programs.get(node.file).imports.get(node);
          const module = initialize(file);
          const names = programs.get(file).exports;
          for (const name of node.names ?? []) env.reference(name.local, module.resolve(name.imported));
          if (node.namespace) {
            if (names.size > collectionLimit) throw new Error(`El registro supera ${collectionLimit} entradas.`);
            env.define(node.namespace, new RecordValue([...names].map(name => [name, new BindingReference(module.resolve(name))])));
          }
          return;
        }
        case 'let': {
          let value = evaluate(node.expr, env);
          if (node.kind === 'param') { value = asTensor(value); value = T.tensor(value, value.dtype, true); }
          if (node.shape && !shapeEqual(asTensor(value).shape, node.shape)) throw new Error(`'${node.name}' requiere Tensor[${node.shape.join(',')}]; recibió Tensor[${value.shape.join(',')}].`);
          env.define(node.name, value, node.kind === 'let'); return;
        }
        case 'fn': env.define(node.name, new UserFunction(node, env)); return;
        case 'assign': env.assign(node.name, evaluate(node.expr, env)); return;
        case 'expr': evaluate(node.expr, env); return;
        case 'return':
          if (!depth) throw new Error('return solo se permite dentro de una función.');
          throw new Signal('return', node.expr ? evaluate(node.expr, env) : null);
        case 'break': case 'continue':
          if (!loopDepth) throw new Error(`${node.type} solo se permite dentro de un bucle.`);
          throw new Signal(node.type);
        case 'if': executeBlock(boolean(evaluate(node.test, env)) ? node.then : node.else, new Environment(env)); return;
        case 'for': case 'while': {
          let iterable = null;
          if (node.type === 'for') {
            iterable = evaluate(node.iterable, env);
            if (!Array.isArray(iterable)) throw new Error('for espera una lista; utiliza range().');
          }
          let i = 0; loopDepth++;
          try {
            while (node.type === 'for' ? i < iterable.length : boolean(evaluate(node.test, env))) {
              if (i >= loopLimit) throw new Error(`El bucle supera ${loopLimit} iteraciones.`);
              tick(node);
              const local = new Environment(env);
              if (iterable) local.define(node.name, iterable[i]);
              i++;
              try { executeBlock(node.body, local); }
              catch (signal) {
                if (signal instanceof Signal && signal.kind === 'break') break;
                if (signal instanceof Signal && signal.kind === 'continue') continue;
                throw signal;
              }
            }
          } finally { loopDepth--; }
          return;
        }
        default: throw new Error(`Instrucción desconocida: ${node.type}.`);
      }
    });
  }
  function executeBlock(body, env) { for (const node of body) execute(node, env); }
  function initialize(file) {
    if (initialized.has(file)) return contexts.get(file);
    const env = contexts.get(file) ?? new Environment(base);
    contexts.set(file, env);
    executeBlock(programs.get(file).ast.body, env);
    initialized.add(file);
    return env;
  }
  initialize(rootFile);
  const globals = Object.create(null);
  for (const [name, binding] of options.captureGlobals === false ? [] : global.bindings) {
    if (binding.value instanceof UserFunction || binding.value instanceof Builtin) continue;
    globals[name] = wrap(ast.body.at(-1), () => { reserve(0, JSON.stringify(name).length + 2); return plain(binding.value, 0, reserve, true); });
  }
  return { records, globals, steps, tensorOperations: budget.used };
}

export function runSource2(source, options = {}) { return runProgram(source, options).records; }
