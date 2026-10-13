import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runProgram } from '../src/runtime.mjs';

const workerPath = fileURLToPath(new URL('../src/conversation_worker.mjs', import.meta.url));
const defaults = { scores: [1, 2, 3], excluded: [], generated: [], temperature: 0, top_k: 0, top_p: 1, repetition_penalty: 1, draw: 0.5 };

function select(changes = {}) {
  const inputs = { ...defaults, ...changes };
  return runProgram(`
    const logits = tensor64(scores)
    const selected = select_token(logits, excluded, generated, temperature, top_k, top_p, repetition_penalty, draw)
  `, { inputs }).globals;
}

function runWorker(chunks) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Decoder process exceeded 10 seconds')); }, 10000);
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        resolve({ code, stderr, messages: stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [] });
      } catch (error) { reject(error); }
    });
    for (const chunk of chunks) child.stdin.write(chunk);
    child.stdin.end();
  });
}

test('greedy selection respects exclusions, tie order and signed repetition penalties', () => {
  assert.equal(select().selected, 2);
  assert.equal(select({ scores: [2, 2, 1] }).selected, 0);
  assert.equal(select({ excluded: [2] }).selected, 1);
  assert.equal(select({ scores: [3, 2], generated: [0, 0], repetition_penalty: 2 }).selected, 1);
  assert.equal(select({ scores: [-1, -1.5], generated: [0], repetition_penalty: 2 }).selected, 1);
  assert.deepEqual(select({ generated: [2], repetition_penalty: 2 }).logits.data, defaults.scores);
});

test('draw controls equal-probability sampling and top-k/top-p restrict its support', () => {
  for (const [draw, expected] of [[0, 0], [0.2, 0], [0.4, 1], [0.8, 2], [0.999999, 2]]) {
    assert.equal(select({ scores: [0, 0, 0], temperature: 1, draw }).selected, expected);
  }
  assert.equal(select({ scores: [0, 0, 0], temperature: 1, top_k: 1, draw: 0.99 }).selected, 0);
  assert.equal(select({ scores: [0, 0, 0], temperature: 1, top_k: 2, draw: 0.99 }).selected, 1);
  assert.equal(select({ scores: [0, 0, 0], temperature: 1, top_p: 0.5, draw: 0.99 }).selected, 1);
  assert.equal(select({ scores: [1000, 1001, 999], temperature: 0.000001, draw: 0.99 }).selected, 1);
});

test('token selection rejects invalid vocabulary IDs and controls', () => {
  const invalid = [
    [{ excluded: [0, 1, 2] }, /All tokens are excluded/],
    [{ excluded: [3] }, /valid token IDs/],
    [{ generated: [-1] }, /valid token IDs/],
    [{ generated: [1.5] }, /valid token IDs/],
    [{ draw: 1 }, /random draw/],
    [{ temperature: -0.1 }, /control/],
    [{ top_k: 1.5 }, /top_k/],
    [{ top_p: 0 }, /control/],
    [{ repetition_penalty: 0.9 }, /control/],
    [{ scores: [[1, 2]] }, /requires a vector/],
    [{ scores: [] }, /requires a vector/],
  ];
  for (const [changes, expected] of invalid) assert.throws(() => select(changes), expected);
});

test('the real decoder worker processes fragmented requests and several decisions per process', async () => {
  const requests = [defaults, { ...defaults, excluded: [2] }, { ...defaults, scores: [0, 0, 0], temperature: 1, draw: 0.8 }];
  const input = requests.map(request => JSON.stringify(request) + '\n').join('');
  const result = await runWorker([input.slice(0, 12), input.slice(12, 97), input.slice(97)]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.messages, [{ token: 2 }, { token: 1 }, { token: 2 }]);
});

test('the decoder worker rejects extra fields, incomplete requests and invalid decisions', async () => {
  for (const [input, expected] of [
    [JSON.stringify({ ...defaults, source: 'print(1)' }) + '\n', /Invalid decoder fields/],
    [JSON.stringify(defaults), /Incomplete decoder request/],
    ['not-json\n', /JSON|Unexpected token/],
    [JSON.stringify({ ...defaults, excluded: [0, 1, 2] }) + '\n', /All tokens are excluded/],
  ]) {
    const result = await runWorker([input]);
    assert.equal(result.code, 1);
    assert.equal(result.messages.length, 1);
    assert.match(result.messages[0].error, expected);
  }
});

test('one decoder process enforces its decision limit', async () => {
  const result = await runWorker([(JSON.stringify(defaults) + '\n').repeat(1025)]);
  assert.equal(result.code, 1);
  assert.equal(result.messages.length, 1025);
  assert.deepEqual(result.messages[0], { token: 2 });
  assert.deepEqual(result.messages[1023], { token: 2 });
  assert.match(result.messages[1024].error, /exceeds 1024 decisions/);
});
