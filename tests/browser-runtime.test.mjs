import test from 'node:test';
import assert from 'node:assert/strict';
import { posix as reference } from 'node:path';
import { readFile } from 'node:fs/promises';
import { posix } from '../src/virtual-path.mjs';
import { prepareProgram } from '../src/runtime.mjs';

test('virtual module paths preserve POSIX normalization, dirname and join edge cases', () => {
  const paths = ['', '.', '..', '/', '//', '///', '/foo', '//foo', '///foo', '////foo',
    '//foo/bar', 'a//b', 'a///b///', '/a//b//', 'foo/', './', '../', '../../', 'foo/../',
    '././', '/./', '/foo/../../', 'a\\b/../c', '\\foo\\bar', 'á/漢字/../🙂', '\0/path',
    'a/.../b', '//../..//', '../a/../../b///', '/a/./.././b/..'];
  for (const path of paths) {
    assert.equal(posix.normalize(path), reference.normalize(path), `normalize ${JSON.stringify(path)}`);
    assert.equal(posix.dirname(path), reference.dirname(path), `dirname ${JSON.stringify(path)}`);
  }
  for (const paths of [[], [''], ['', ''], ['foo', '/bar'], ['/', '/foo', '/bar/'],
    ['..', '..', 'foo', '..'], ['//foo', '../bar', './'], ['a\\b', '..', 'c'], ['', '.', '/']])
    assert.equal(posix.join(...paths), reference.join(...paths), `join ${JSON.stringify(paths)}`);
  for (const value of [null, undefined, 4, false, [], {}, Symbol('path')]) {
    for (const name of ['normalize', 'dirname', 'join']) {
      assert.throws(() => posix[name](value), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
      assert.throws(() => reference[name](value), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    }
  }
});

test('ten thousand deterministic virtual paths agree with the independent Node POSIX reference', () => {
  let state = 0x16a67b93;
  const next = size => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % size;
  };
  const components = ['', '.', '..', 'a', 'module.nv', 'lib', 'á', '漢字', 'a\\b', '...', '\0'];
  function randomPath() {
    let path = next(4) === 0 ? '/'.repeat(next(4) + 1) : '';
    const count = next(12);
    for (let index = 0; index < count; index++) {
      if (index) path += '/'.repeat(next(4) + 1);
      path += components[next(components.length)];
    }
    if (next(3) === 0) path += '/'.repeat(next(4) + 1);
    return path;
  }
  for (let index = 0; index < 10_000; index++) {
    const first = randomPath(), second = randomPath(), third = randomPath();
    assert.equal(posix.normalize(first), reference.normalize(first), `normalize ${JSON.stringify(first)}`);
    assert.equal(posix.dirname(first), reference.dirname(first), `dirname ${JSON.stringify(first)}`);
    assert.equal(posix.join(first, second, third), reference.join(first, second, third),
      `join ${JSON.stringify([first, second, third])}`);
  }
});

test('portable runtime resolves relative in-memory modules and executes NERVA gameplay with host effects', () => {
  const events = [];
  const program = prepareProgram(`nerva 0.3
import { advance } from "./lib//motion.nv"
const next = advance(state, input, dt)
host.move(next)
print(next)
`, { filename: '/game/./main.nv', modules: {
    '/game/lib/../lib/motion.nv': `nerva 0.3
import { speed } from "../config.nv"
export fn advance(state, input, dt) {
  return {x: state.x + input.strafe * speed * dt, z: state.z + input.forward * speed * dt}
}
`,
    '/game/config.nv': 'nerva 0.3\nexport const speed = 4\n',
  } });
  const result = program.run({ inputs: { state: { x: 1, z: 2 }, input: { strafe: -1, forward: 1 }, dt: 0.25 },
    host: { move: state => { events.push({ ...state }); return null; } } });
  assert.deepEqual(events, [{ x: 0, z: 3 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.records[0].values)), [{ x: 0, z: 3 }]);
  assert.equal(program.run({ inputs: { state: { x: 0, z: 0 }, input: { strafe: 0, forward: 1 }, dt: 0.5 },
    host: { move: () => null } }).records[0].values[0].z, 2);
});

test('runtime module graph uses portable imports and its tensor operations retain their behavior', async () => {
  const runtime = new URL('../src/runtime.mjs', import.meta.url);
  const visited = new Set();
  async function inspect(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const source = await readFile(url, 'utf8');
    // This guard follows source imports of the browser entry. The renderer's
    // browser harness exercises this same graph in Chromium without Node shims.
    const imports = [...source.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)];
    for (const [, specifier] of imports) {
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `non-portable import ${specifier}`);
      await inspect(new URL(specifier, url));
    }
  }
  await inspect(runtime);
  assert.equal(visited.size, 4);
  const result = prepareProgram('nerva 0.3\nprint(tensor([[1, 2]]) @ tensor([[3], [4]]))').run();
  assert.deepEqual(result.records[0].values[0].data, [[11]]);
});
