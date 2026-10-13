/**
 * Dependency and lifetime planner for synchronous GPU command encoding.
 *
 * Sizes and memory metrics are bytes. Allocation IDs describe opportunities to
 * reuse storage; this module does not allocate GPU resources. A backend must
 * implement the allocations and resource transitions for its own API.
 */
const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function () {});

export class RenderGraph {
  #resources = new Map();
  #passes = new Map();

  resource(name, descriptor = {}) {
    validateName(name, 'Resource');
    if (this.#resources.has(name)) throw new Error(`Duplicate resource: ${name}`);
    validateDescriptor(descriptor, `Resource ${name}`);
    const { size, alignment = 4, persistent = false, external = false, kind = 'buffer' } = descriptor;
    if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError(`Resource ${name} size must be a positive safe integer`);
    if (!Number.isSafeInteger(alignment) || alignment <= 0 || 2 ** Math.round(Math.log2(alignment)) !== alignment)
      throw new TypeError(`Resource ${name} alignment must be a positive power of two`);
    if (typeof persistent !== 'boolean' || typeof external !== 'boolean')
      throw new TypeError(`Resource ${name} persistent and external must be booleans`);
    validateName(kind, `Resource ${name} kind`);
    const reservedBytes = alignBytes(size, alignment);
    this.#resources.set(name, Object.freeze({ size, alignment, persistent, external, kind, reservedBytes }));
    return this;
  }

  pass(name, descriptor = {}) {
    validateName(name, 'Pass');
    if (this.#passes.has(name)) throw new Error(`Duplicate pass: ${name}`);
    validateDescriptor(descriptor, `Pass ${name}`);
    const { reads = [], writes = [], after = [], execute = () => {} } = descriptor;
    if (typeof execute !== 'function') throw new TypeError(`Pass ${name} execute must be a function`);
    if (Object.getPrototypeOf(execute) === ASYNC_FUNCTION_PROTOTYPE)
      throw new TypeError(`Pass ${name} execute must be synchronous`);
    this.#passes.set(name, Object.freeze({
      reads: copyNames(reads, `Pass ${name} reads`),
      writes: copyNames(writes, `Pass ${name} writes`),
      after: copyNames(after, `Pass ${name} after`),
      execute,
    }));
    return this;
  }

  compile() {
    const names = [...this.#passes.keys()];
    const indices = new Map(names.map((name, index) => [name, index]));
    const outgoing = names.map(() => new Set());
    const incoming = names.map(() => 0);
    const lastWriter = new Map();
    const readers = new Map();
    const edge = (before, after) => {
      const source = indices.get(before), target = indices.get(after);
      if (!outgoing[source].has(target)) {
        outgoing[source].add(target);
        incoming[target]++;
      }
    };

    // Access order is the declaration order. Explicit `after` constraints can
    // reorder independent passes, but cannot reverse resource hazards.
    for (const name of names) {
      const pass = this.#passes.get(name);
      for (const dependency of pass.after) {
        if (!this.#passes.has(dependency)) throw new Error(`Pass ${name} depends on unknown pass: ${dependency}`);
        edge(dependency, name);
      }
      for (const resource of [...pass.reads, ...pass.writes])
        if (!this.#resources.has(resource)) throw new Error(`Pass ${name} uses unknown resource: ${resource}`);
      for (const resource of pass.reads) {
        const writer = lastWriter.get(resource);
        if (writer === undefined && !this.#resources.get(resource).external)
          throw new Error(`Pass ${name} reads uninitialized resource: ${resource}`);
        if (writer !== undefined) edge(writer, name);
        if (!readers.has(resource)) readers.set(resource, new Set());
        readers.get(resource).add(name);
      }
      for (const resource of pass.writes) {
        const writer = lastWriter.get(resource);
        if (writer !== undefined) edge(writer, name);
        for (const reader of readers.get(resource) ?? [])
          if (reader !== name) edge(reader, name);
        readers.set(resource, new Set());
        lastWriter.set(resource, name);
      }
    }

    // Pick the earliest declared ready pass so schedules are reproducible.
    const ready = [];
    for (let i = 0; i < names.length; i++) if (incoming[i] === 0) ready.push(i);
    const order = [];
    for (let cursor = 0; cursor < ready.length; cursor++) {
      const source = ready[cursor];
      order.push(names[source]);
      for (const target of outgoing[source]) {
        if (--incoming[target] === 0) {
          let insertion = ready.length;
          while (insertion > cursor + 1 && ready[insertion - 1] > target) insertion--;
          ready.splice(insertion, 0, target);
        }
      }
    }
    if (order.length !== names.length)
      throw new Error(`Render graph dependency cycle: ${names.filter((_, index) => incoming[index] > 0).join(', ')}`);

    const lifetimes = Object.create(null);
    for (let index = 0; index < order.length; index++) {
      const pass = this.#passes.get(order[index]);
      for (const resource of [...pass.reads, ...pass.writes]) {
        if (!lifetimes[resource]) lifetimes[resource] = { firstUse: index, lastUse: index };
        else lifetimes[resource].lastUse = index;
      }
    }

    const allocations = Object.create(null);
    const memory = { persistentBytes: 0, transientPeakBytes: 0, unaliasedTransientBytes: 0, externalBytes: 0 };
    const slots = [];
    let nextId = 0;
    const usedResources = [...this.#resources.entries()]
      .filter(([name]) => lifetimes[name])
      .sort(([a], [b]) => lifetimes[a].firstUse - lifetimes[b].firstUse);

    for (const [name, resource] of usedResources) {
      const { size, alignment, persistent, external, kind, reservedBytes } = resource;
      let allocationId = null, capacity = reservedBytes;
      if (external) {
        memory.externalBytes = addBytes(memory.externalBytes, reservedBytes);
        capacity = 0;
      } else if (persistent) {
        allocationId = nextId++;
        memory.persistentBytes = addBytes(memory.persistentBytes, reservedBytes);
      } else {
        memory.unaliasedTransientBytes = addBytes(memory.unaliasedTransientBytes, reservedBytes);
        let candidate;
        for (const slot of slots) {
          if (slot.lastUse < lifetimes[name].firstUse && slot.kind === kind &&
              slot.alignment >= alignment && slot.reservedBytes >= reservedBytes &&
              (!candidate || slot.reservedBytes < candidate.reservedBytes)) candidate = slot;
        }
        if (!candidate) {
          candidate = { allocationId: nextId++, kind, alignment, reservedBytes, lastUse: -1 };
          slots.push(candidate);
          memory.transientPeakBytes = addBytes(memory.transientPeakBytes, reservedBytes);
        }
        candidate.lastUse = lifetimes[name].lastUse;
        allocationId = candidate.allocationId;
        capacity = candidate.reservedBytes;
      }
      allocations[name] = Object.freeze({ allocationId, offset: 0, size, reservedBytes: capacity, alignment, persistent, external, kind });
      Object.freeze(lifetimes[name]);
    }

    // Snapshot callbacks as well as metadata: changing this graph later cannot
    // change a prepared plan. Effects before a callback failure are not undone.
    const callbacks = order.map(name => this.#passes.get(name).execute);
    const execute = context => {
      const executed = [];
      for (let index = 0; index < order.length; index++) {
        const callback = callbacks[index];
        const result = callback(context);
        // Report the synchronous contract failure without allowing a rejected
        // native Promise to become an unrelated unhandled rejection.
        if (result instanceof Promise) Promise.prototype.then.call(result, undefined, () => {});
        if (result != null && typeof result.then === 'function')
          throw new TypeError(`Pass ${order[index]} returned a Promise; render graph callbacks must be synchronous`);
        executed.push(order[index]);
      }
      return executed;
    };
    return Object.freeze({
      order: Object.freeze(order),
      lifetimes: Object.freeze(lifetimes),
      allocations: Object.freeze(allocations),
      memory: Object.freeze(memory),
      execute,
    });
  }
}

function validateName(name, label) {
  if (typeof name !== 'string' || name.trim().length === 0) throw new TypeError(`${label} name must be a nonempty string`);
}

function validateDescriptor(descriptor, label) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor))
    throw new TypeError(`${label} descriptor must be an object`);
}

function copyNames(names, label) {
  if (!Array.isArray(names)) throw new TypeError(`${label} must be an array`);
  const copy = [];
  for (const name of names) {
    validateName(name, label);
    if (!copy.includes(name)) copy.push(name);
  }
  return Object.freeze(copy);
}

function alignBytes(size, alignment) {
  const aligned = Math.ceil(size / alignment) * alignment;
  if (!Number.isSafeInteger(aligned)) throw new RangeError('Aligned resource size exceeds the safe integer range');
  return aligned;
}

function addBytes(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError('Render graph memory exceeds the safe integer range');
  return result;
}
