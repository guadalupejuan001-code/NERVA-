import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderGraph } from '../src/graphics/graph.mjs';

test('render graph schedules read, write and overwrite hazards with the same context', () => {
  const graph = new RenderGraph().resource('visible', { size: 64 });
  const context = { commands: [] };
  for (const [name, reads, writes] of [
    ['clear', [], ['visible']],
    ['cull', ['visible'], ['visible']],
    ['shadow', ['visible'], []],
    ['render', ['visible'], []],
    ['reset', [], ['visible']],
  ]) {
    graph.pass(name, { reads, writes, execute: ctx => {
      assert.equal(ctx, context);
      ctx.commands.push(name);
    } });
  }
  const plan = graph.compile();
  assert.deepEqual(plan.order, ['clear', 'cull', 'shadow', 'render', 'reset']);
  assert.deepEqual(plan.lifetimes.visible, { firstUse: 0, lastUse: 4 });
  assert.deepEqual(plan.execute(context), plan.order);
  assert.deepEqual(context.commands, plan.order);
});

test('explicit dependencies schedule independent passes reproducibly', () => {
  const graph = new RenderGraph()
    .pass('render', { after: ['clear'] })
    .pass('unrelated')
    .pass('clear');
  assert.deepEqual(graph.compile().order, ['unrelated', 'clear', 'render']);
  assert.deepEqual(graph.compile().order, graph.compile().order);
});

test('overwrites wait for every reader and expose contradictory ordering', () => {
  const graph = new RenderGraph()
    .resource('data', { size: 4, external: true })
    .pass('readerA', { reads: ['data'] })
    .pass('readerB', { reads: ['data'], after: ['overwrite'] })
    .pass('overwrite', { writes: ['data'] });
  assert.throws(() => graph.compile(), /cycle/);
});

test('write-after-write hazards cannot be reversed by explicit dependencies', () => {
  const graph = new RenderGraph()
    .resource('data', { size: 4 })
    .pass('first', { writes: ['data'], after: ['second'] })
    .pass('second', { writes: ['data'] });
  assert.throws(() => graph.compile(), /cycle/);
});

test('cycles and unknown explicit dependencies fail during compilation', () => {
  assert.throws(() => new RenderGraph().pass('a', { after: ['b'] }).compile(), /unknown pass: b/);
  assert.throws(() => new RenderGraph().pass('a', { after: ['a'] }).compile(), /cycle/);
  assert.throws(() => new RenderGraph()
    .pass('a', { after: ['c'] })
    .pass('b', { after: ['a'] })
    .pass('c', { after: ['b'] }).compile(), /cycle/);
});

test('reads require an earlier producer unless storage is external', () => {
  assert.throws(() => new RenderGraph()
    .resource('data', { size: 4 })
    .pass('read', { reads: ['data'] })
    .pass('write', { writes: ['data'] }).compile(), /uninitialized resource: data/);
  assert.throws(() => new RenderGraph()
    .resource('state', { size: 4, persistent: true })
    .pass('read', { reads: ['state'] }).compile(), /uninitialized/);
  assert.throws(() => new RenderGraph()
    .resource('data', { size: 4 })
    .pass('increment', { reads: ['data'], writes: ['data'] }).compile(), /uninitialized/);
  assert.deepEqual(new RenderGraph()
    .resource('import', { size: 16, external: true })
    .pass('read', { reads: ['import'] }).compile().order, ['read']);
});

test('unknown read or write resources produce actionable errors', () => {
  for (const access of ['reads', 'writes'])
    assert.throws(() => new RenderGraph().pass('draw', { [access]: ['missing'] }).compile(), /draw uses unknown resource: missing/);
});

test('non-overlapping lifetimes reuse larger compatible transient storage', () => {
  const plan = new RenderGraph()
    .resource('large', { size: 61, alignment: 16 })
    .resource('small', { size: 29, alignment: 8 })
    .pass('produceLarge', { writes: ['large'] })
    .pass('consumeLarge', { reads: ['large'] })
    .pass('produceSmall', { writes: ['small'] })
    .pass('consumeSmall', { reads: ['small'] }).compile();
  assert.deepEqual(plan.lifetimes.large, { firstUse: 0, lastUse: 1 });
  assert.deepEqual(plan.lifetimes.small, { firstUse: 2, lastUse: 3 });
  assert.equal(plan.allocations.large.allocationId, plan.allocations.small.allocationId);
  assert.equal(plan.allocations.small.size, 29);
  assert.equal(plan.allocations.small.reservedBytes, 64);
  assert.equal(plan.allocations.small.offset, 0);
  assert.equal(plan.memory.transientPeakBytes, 64);
  assert.equal(plan.memory.unaliasedTransientBytes, 96);
});

test('resources touched in the same pass cannot alias', () => {
  const plan = new RenderGraph()
    .resource('a', { size: 16 })
    .resource('b', { size: 16 })
    .pass('producer', { writes: ['a'] })
    .pass('transform', { reads: ['a'], writes: ['b'] }).compile();
  assert.notEqual(plan.allocations.a.allocationId, plan.allocations.b.allocationId);
  assert.equal(plan.memory.transientPeakBytes, 32);
});

test('repeated writes extend the whole resource lifetime conservatively', () => {
  const plan = new RenderGraph()
    .resource('a', { size: 16 })
    .resource('b', { size: 16 })
    .pass('first', { writes: ['a'] })
    .pass('middle', { writes: ['b'] })
    .pass('last', { writes: ['a'] }).compile();
  assert.deepEqual(plan.lifetimes.a, { firstUse: 0, lastUse: 2 });
  assert.notEqual(plan.allocations.a.allocationId, plan.allocations.b.allocationId);
});

test('aliasing respects kind, alignment and slot capacity', () => {
  const graph = new RenderGraph();
  const descriptors = [
    ['a', { size: 64, alignment: 16 }],
    ['b', { size: 32, alignment: 32 }],
    ['c', { size: 16, alignment: 4, kind: 'texture' }],
    ['d', { size: 128, alignment: 4 }],
  ];
  for (const [name, descriptor] of descriptors) {
    graph.resource(name, descriptor).pass(name, { writes: [name] });
  }
  const plan = graph.compile();
  assert.equal(new Set(Object.values(plan.allocations).map(allocation => allocation.allocationId)).size, 4);
  assert.equal(plan.memory.transientPeakBytes, 240);
});

test('best-fit alias selection keeps a large slot available for a later resource', () => {
  const plan = new RenderGraph()
    .resource('large', { size: 128 })
    .resource('small', { size: 32 })
    .resource('nextSmall', { size: 32 })
    .resource('nextLarge', { size: 128 })
    .pass('first', { writes: ['large', 'small'] })
    .pass('second', { writes: ['nextSmall', 'nextLarge'] }).compile();
  assert.equal(plan.allocations.large.allocationId, plan.allocations.nextLarge.allocationId);
  assert.equal(plan.allocations.small.allocationId, plan.allocations.nextSmall.allocationId);
  assert.equal(plan.memory.transientPeakBytes, 160);
});

test('persistent and external storage are counted separately and never aliased', () => {
  const plan = new RenderGraph()
    .resource('persistent', { size: 9, alignment: 8, persistent: true })
    .resource('external', { size: 100, alignment: 64, external: true, persistent: true })
    .resource('transient', { size: 7 })
    .resource('unused', { size: 1_000_000, persistent: true })
    .pass('first', { reads: ['external'], writes: ['persistent'] })
    .pass('second', { writes: ['transient'] }).compile();
  assert.notEqual(plan.allocations.persistent.allocationId, plan.allocations.transient.allocationId);
  assert.equal(plan.allocations.external.allocationId, null);
  assert.equal(plan.allocations.external.reservedBytes, 0);
  assert.equal(plan.allocations.unused, undefined);
  assert.equal(plan.lifetimes.unused, undefined);
  assert.deepEqual(plan.memory, {
    persistentBytes: 16, transientPeakBytes: 8, unaliasedTransientBytes: 8, externalBytes: 128,
  });
});

test('lifetimes follow the compiled execution order rather than declaration order', () => {
  const plan = new RenderGraph()
    .resource('first', { size: 16 })
    .resource('second', { size: 16 })
    .pass('a', { writes: ['first'], after: ['b'] })
    .pass('b', { writes: ['second'] }).compile();
  assert.deepEqual(plan.order, ['b', 'a']);
  assert.deepEqual(plan.lifetimes.second, { firstUse: 0, lastUse: 0 });
  assert.deepEqual(plan.lifetimes.first, { firstUse: 1, lastUse: 1 });
  assert.equal(plan.allocations.first.allocationId, plan.allocations.second.allocationId);
});

test('prepared plans snapshot descriptors, resource lists and callbacks', () => {
  const resource = { size: 16, alignment: 8 };
  const writes = ['data'];
  const pass = { writes, execute: context => context.push('original') };
  const graph = new RenderGraph().resource('data', resource).pass('write', pass);
  resource.size = 999;
  writes.push('missing');
  pass.execute = () => { throw new Error('mutated'); };
  const plan = graph.compile();
  graph.pass('later', { reads: ['data'] });
  const context = [];
  assert.deepEqual(plan.execute(context), ['write']);
  assert.deepEqual(context, ['original']);
  assert.equal(plan.allocations.data.size, 16);
  assert.deepEqual(graph.compile().order, ['write', 'later']);
  assert.throws(() => plan.order.push('extra'), TypeError);
  assert.throws(() => { plan.lifetimes.data.lastUse = 99; }, TypeError);
  assert.throws(() => { plan.allocations.data.size = 99; }, TypeError);
  assert.throws(() => { plan.memory.persistentBytes = 99; }, TypeError);
});

test('callback failures stop following commands without undoing prior effects', () => {
  const failure = new Error('encoder failure');
  const context = [];
  const plan = new RenderGraph()
    .pass('first', { execute: context => context.push('first') })
    .pass('failure', { execute: context => { context.push('failure'); throw failure; } })
    .pass('last', { execute: context => context.push('last') }).compile();
  assert.throws(() => plan.execute(context), error => error === failure);
  assert.deepEqual(context, ['first', 'failure']);
});

test('callbacks do not receive the internal callback array as this', () => {
  const plan = new RenderGraph().pass('encode', { execute: function (context) {
    assert.equal(this, undefined);
    assert.equal(context.encoder, 'frame');
  } }).compile();
  assert.deepEqual(plan.execute({ encoder: 'frame' }), ['encode']);
});

test('Promise and thenable callbacks are rejected during synchronous execution', () => {
  for (const result of [Promise.resolve(), { then() {} }]) {
    const context = [];
    const plan = new RenderGraph()
      .pass('async', { execute: () => result })
      .pass('later', { execute: context => context.push('later') }).compile();
    assert.throws(() => plan.execute(context), /async returned a Promise/);
    assert.deepEqual(context, []);
  }
});

test('async callbacks are rejected before running and rejected native Promises are contained', async () => {
  let called = false;
  assert.throws(() => new RenderGraph().pass('async', { execute: async () => { called = true; } }), /synchronous/);
  assert.equal(called, false);
  const plan = new RenderGraph().pass('rejected', { execute: () => Promise.reject(new Error('late rejection')) }).compile();
  assert.throws(() => plan.execute({}), /returned a Promise/);
  await new Promise(resolve => setImmediate(resolve));
});

test('descriptor validation rejects invalid names, sizes, flags and pass lists', () => {
  for (const name of ['', ' ', null, 1]) {
    assert.throws(() => new RenderGraph().resource(name, { size: 1 }), TypeError);
    assert.throws(() => new RenderGraph().pass(name), TypeError);
  }
  for (const size of [0, -1, 0.5, Infinity, NaN, '4', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => new RenderGraph().resource('r', { size }), /positive safe integer/);
  for (const alignment of [0, -2, 3, 0.5, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => new RenderGraph().resource('r', { size: 4, alignment }), /power of two/);
  for (const flag of ['persistent', 'external'])
    assert.throws(() => new RenderGraph().resource('r', { size: 4, [flag]: 1 }), /booleans/);
  for (const descriptor of [null, [], 'invalid']) {
    assert.throws(() => new RenderGraph().resource('r', descriptor), /descriptor/);
    assert.throws(() => new RenderGraph().pass('p', descriptor), /descriptor/);
  }
  assert.throws(() => new RenderGraph().resource('r', { size: 4, kind: '' }), /nonempty/);
  assert.throws(() => new RenderGraph().pass('p', { execute: true }), /function/);
  for (const list of ['reads', 'writes', 'after']) {
    assert.throws(() => new RenderGraph().pass('p', { [list]: 'name' }), /array/);
    assert.throws(() => new RenderGraph().pass('p', { [list]: [null] }), /nonempty/);
  }
});

test('duplicate names fail but duplicate access entries are harmless', () => {
  assert.throws(() => new RenderGraph().resource('r', { size: 4 }).resource('r', { size: 4 }), /Duplicate resource/);
  assert.throws(() => new RenderGraph().pass('p').pass('p'), /Duplicate pass/);
  const plan = new RenderGraph()
    .resource('r', { size: 4 })
    .pass('write', { writes: ['r', 'r'] })
    .pass('read', { reads: ['r', 'r'], after: ['write', 'write'] }).compile();
  assert.deepEqual(plan.order, ['write', 'read']);
  assert.equal(plan.memory.transientPeakBytes, 4);
});

test('unsafe aligned sizes and memory totals fail before execution', () => {
  assert.throws(() => new RenderGraph().resource('huge', { size: Number.MAX_SAFE_INTEGER, alignment: 4 }), /safe integer range/);
  assert.throws(() => new RenderGraph()
    .resource('huge', { size: Number.MAX_SAFE_INTEGER, alignment: 1 })
    .resource('other', { size: 1, alignment: 1 })
    .pass('write', { writes: ['huge', 'other'] }).compile(), /memory exceeds/);
});

test('empty graphs and resource names matching object prototype keys are supported', () => {
  const empty = new RenderGraph().compile();
  assert.deepEqual(empty.order, []);
  assert.deepEqual(empty.execute({}), []);
  assert.deepEqual(empty.memory, { persistentBytes: 0, transientPeakBytes: 0, unaliasedTransientBytes: 0, externalBytes: 0 });
  const plan = new RenderGraph()
    .resource('__proto__', { size: 4 })
    .pass('constructor', { writes: ['__proto__'] }).compile();
  assert.equal(plan.allocations.__proto__.size, 4);
  assert.deepEqual(plan.lifetimes.__proto__, { firstUse: 0, lastUse: 0 });
});
