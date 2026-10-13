import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../src/runtime.mjs';

function close(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} must be within ${tolerance} of ${expected}`);
}

test('SGD learns a linear regression with matrix multiplication and broadcast bias', () => {
  const { globals, records } = runProgram(`
    nerva 0.2
    const x = tensor64([[-2], [-1], [0], [1], [2]])
    const y = tensor64([[-3], [-1], [1], [3], [5]])
    param weight: Tensor[1, 1] = tensor64([[0]])
    param bias: Tensor[1] = tensor64([0])
    const initial = value(mse(x @ weight + bias, y))
    let previous = initial
    for epoch in range(100) {
      zero_grad([weight, bias])
      const loss = mse(x @ weight + bias, y)
      backward(loss)
      step([weight, bias], 0.1)
      const next = value(mse(x @ weight + bias, y))
      assert(next <= previous + 0.000000000001, "loss increased")
      previous = next
    }
    const final = value(mse(x @ weight + bias, y))
    const prediction = value((tensor64([[3]]) @ weight + bias)[0][0])
    print(initial, final, prediction)
  `);
  close(globals.initial, 9);
  assert.ok(globals.final < 1e-16, `Final loss is ${globals.final}`);
  assert.ok(globals.final < globals.initial / 1e8);
  close(globals.weight.data[0][0], 2, 1e-8);
  close(globals.bias.data[0], 1, 1e-8);
  close(globals.prediction, 7, 1e-8);
  assert.deepEqual(records[0].values, [globals.initial, globals.final, globals.prediction]);
});

const differentiableObjective = `
  const x = tensor64([[0.2, -0.4], [0.8, 0.3]])
  param weight = tensor64(parameters)
  param bias = tensor64(offset)
  const activations = tanh(transpose(transpose(x @ reshape(weight, [2, 2]) + bias)))
  const loss = mean((sigmoid(activations) - tensor64([[0.1, 0.7], [0.8, 0.3]])) ^ 2)
  const cost = value(loss)
`;

function objective(parameters, offset, differentiate = false) {
  return runProgram(differentiableObjective + (differentiate ? '\nbackward(loss)\nconst dw = grad(weight)\nconst db = grad(bias)' : ''), {
    inputs: { parameters, offset },
  }).globals;
}

test('reverse gradients match finite differences across matrix, broadcast and nonlinear operations', () => {
  const parameters = [0.4, -0.3, 0.2, 0.7];
  const offset = [0.05, -0.1];
  const actual = objective(parameters, offset, true);
  const epsilon = 1e-5;
  for (let index = 0; index < parameters.length; index++) {
    const plus = [...parameters], minus = [...parameters];
    plus[index] += epsilon;
    minus[index] -= epsilon;
    const numeric = (objective(plus, offset).cost - objective(minus, offset).cost) / (2 * epsilon);
    close(actual.dw.data[index], numeric, 1e-8);
  }
  for (let index = 0; index < offset.length; index++) {
    const plus = [...offset], minus = [...offset];
    plus[index] += epsilon;
    minus[index] -= epsilon;
    const numeric = (objective(parameters, plus).cost - objective(parameters, minus).cost) / (2 * epsilon);
    close(actual.db.data[index], numeric, 1e-8);
  }
});

test('cross entropy is stable for large logits and yields the expected classification gradient', () => {
  const { globals } = runProgram(`
    param logits = tensor64([[1000, 1001, 999], [-1000, -1000, -1000]])
    const loss = cross_entropy(logits, [1, 0])
    backward(loss)
    const gradient = grad(logits)
    const probabilities = softmax(logits)
  `);
  const denominator = Math.exp(-1) + 1 + Math.exp(-2);
  close(globals.loss.data, (Math.log(denominator) + Math.log(3)) / 2);
  const expected = [[Math.exp(-1) / denominator / 2, (1 / denominator - 1) / 2, Math.exp(-2) / denominator / 2], [-1 / 3, 1 / 6, 1 / 6]];
  for (let row = 0; row < 2; row++) {
    close(globals.probabilities.data[row].reduce((sum, value) => sum + value, 0), 1);
    close(globals.gradient.data[row].reduce((sum, value) => sum + value, 0), 0);
    for (let column = 0; column < 3; column++) close(globals.gradient.data[row][column], expected[row][column]);
  }
});

test('shared parameters accumulate gradients, zero_grad clears them and detach cuts a branch', () => {
  const { globals } = runProgram(`
    param p = tensor64([2, -3])
    const loss = sum(p * p + p + detach(p) * 10)
    backward(loss)
    const once = grad(p)
    backward(loss)
    const twice = grad(p)
    zero_grad(p)
    backward(loss)
    const reset = grad(p)
    step(p, 0.1)
  `);
  assert.deepEqual(globals.once.data, [5, -5]);
  assert.deepEqual(globals.twice.data, [10, -10]);
  assert.deepEqual(globals.reset.data, [5, -5]);
  assert.deepEqual(globals.p.data, [1.5, -2.5]);
});

test('first-dimension indexing routes gradients to the selected slice', () => {
  const { globals } = runProgram(`
    param matrix = tensor64([[1, 2], [3, 4]])
    const loss = sum(matrix[1] ^ 2)
    backward(loss)
    const gradient = grad(matrix)
  `);
  assert.deepEqual(globals.gradient.data, [[0, 0], [6, 8]]);
});

test('training rejects stale losses, disconnected values and invalid updates', () => {
  assert.throws(() => runProgram('param p = tensor(2)\nconst loss = p ^ 2\nbackward(loss)\nstep(p, 0.1)\nbackward(loss)'), /updated after this loss/);
  assert.throws(() => runProgram('param p = tensor(2)\nbackward(detach(p))'), /not connected/);
  assert.throws(() => runProgram('param p = tensor([1, 2])\nbackward(p)'), /scalar loss/);
  assert.throws(() => runProgram('param p = tensor(2)\nstep(p, 0.1)'), /requires a gradient/);
  assert.throws(() => runProgram('param p = tensor(2)\nbackward(p ^ 2)\nstep(p, 0)'), /positive/);
  assert.throws(() => runProgram('param p = tensor(2)\nzero_grad([p, p])'), /dos veces/);
  assert.throws(() => runProgram('param p = tensor(2)\nstep(p + 1, 0.1)'), /parámetros hoja/);
  assert.throws(() => runProgram('param p = tensor(2)\ngrad(p)'), /aún no tiene gradiente/);
});

test('checkpoint and restore preserve all learned tensors and clear previous gradients', () => {
  const { globals, records } = runProgram(`
    param weight = tensor64([[2, -3]])
    param bias = tensor64([0.5])
    const original = checkpoint("model_01", [weight, bias])
    const loss = sum(weight ^ 2) + sum(bias ^ 2)
    backward(loss)
    step([weight, bias], 0.1)
    const changed = checkpoint("updated", [weight, bias])
    restore(original, [weight, bias])
    const restored = checkpoint("restored", [weight, bias])
    backward(sum(weight ^ 2) + sum(bias ^ 2))
    const fresh_gradient = grad(weight)
  `);
  assert.notEqual(globals.changed, globals.original);
  assert.equal(globals.restored, globals.original);
  assert.deepEqual(globals.weight.data, [[2, -3]]);
  assert.deepEqual(globals.bias.data, [0.5]);
  assert.deepEqual(globals.fresh_gradient.data, [[4, -6]]);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    kind: 'checkpoint', name: 'model_01', version: '0.2',
    checkpoint: { format: 'nerva-checkpoint', version: 1, tensors: [
      { shape: [1, 2], dtype: 'f64', data: [[2, -3]] },
      { shape: [1], dtype: 'f64', data: [0.5] },
    ] },
  });
  assert.throws(() => runProgram('param p = tensor(2)\nconst saved = checkpoint("ok", p)\nbackward(p ^ 2)\nrestore(saved, p)\ngrad(p)'), /aún no tiene gradiente/);
});

test('checkpoints transfer through plain JSON between independent program runs', () => {
  const saved = runProgram('param p = tensor64([[1, 2], [3, 4]])\ncheckpoint("weights", p)').records[0].checkpoint;
  const { globals } = runProgram('param p = zeros([2, 2], "f64")\nrestore(saved, p)\nconst prediction = p @ tensor64([2, 1])', {
    inputs: { saved: JSON.stringify(saved) },
  });
  assert.deepEqual(globals.prediction.data, [4, 10]);
});

test('restore validates checkpoint version, parameter count, dtype, shape and data', () => {
  const checkpoint = { format: 'nerva-checkpoint', version: 1, tensors: [{ shape: [2], dtype: 'f64', data: [1, 2] }] };
  const variants = [
    ['not JSON', /JSON válido/],
    [JSON.stringify({ ...checkpoint, version: 2 }), /Formato/],
    [JSON.stringify({ ...checkpoint, tensors: [] }), /número de parámetros/],
    [JSON.stringify({ ...checkpoint, tensors: [{ shape: [2], dtype: 'f32', data: [1, 2] }] }), /dtype incompatibles/],
    [JSON.stringify({ ...checkpoint, tensors: [{ shape: [1, 2], dtype: 'f64', data: [[1, 2]] }] }), /dimensiones/],
    [JSON.stringify({ ...checkpoint, tensors: [{ shape: [2], dtype: 'f64', data: [1] }] }), /no coinciden/],
  ];
  for (const [saved, expected] of variants) {
    assert.throws(() => runProgram('param p = tensor64([0, 0])\nrestore(saved, p)', { inputs: { saved } }), expected);
  }
  assert.throws(() => runProgram('param p = tensor(1)\ncheckpoint("../bad", p)'), /nombre del checkpoint/);
});
