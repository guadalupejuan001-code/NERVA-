import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { loadProject } from '../src/project.mjs';
import { validateFrame, clipLine, renderSVG, renderPNG } from '../examples/graphics/backend.mjs';

const project = await loadProject(fileURLToPath(new URL('../examples/graphics/scene.nv', import.meta.url)));
const scene = { angle: 0, pitch: 0, width: 640, height: 480, focal: 280, distance: 5, near: 0.1 };
function frameFor(overrides = {}) {
  let frame;
  const result = project.prepared.run({ captureGlobals: false, inputs: { scene: { ...scene, ...overrides } },
    host: { sin: Math.sin, cos: Math.cos, present: value => { frame = validateFrame(value); return null; } } });
  return { frame, result };
}

test('NERVA projects an independently known cube with eight vertices and twelve edges', () => {
  const { frame, result } = frameFor();
  assert.equal(frame.points.length, 8); assert.equal(frame.lines.length, 12);
  assert.deepEqual({ ...frame.points[0] }, { x: 250, y: 310, z: 4 });
  assert.equal(frame.points[4].x, 320 - 280 / 6);
  assert.equal(frame.points[4].y, 240 + 280 / 6);
  assert.deepEqual(result.records[0].values[0], Object.assign(Object.create(null), { vertices: 8, edges: 12 }));
  assert.ok(result.tensorOperations > 0);
});

test('rotation changes the projected scene while preparation remains reusable', () => {
  const first = frameFor().frame, rotated = frameFor({ angle: Math.PI / 2, pitch: 0.35 }).frame;
  assert.notDeepEqual(rotated.points, first.points);
  assert.deepEqual(frameFor().frame, first);
  assert(rotated.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.z > scene.near));
  const quarterTurn = frameFor({ angle: Math.PI / 2 }).frame.points[0];
  assert.ok(Math.abs(quarterTurn.z - 6) < 1e-12);
  assert.ok(Math.abs(quarterTurn.x - (320 - 280 / 6)) < 1e-12);
});

test('scene rejects invalid dimensions and geometry crossing the camera near plane', () => {
  assert.throws(() => frameFor({ width: 0 }));
  assert.throws(() => frameFor({ distance: 0.5 }));
  assert.throws(() => frameFor({ distance: 1.25, near: 0.25 }));
  assert.throws(() => frameFor({ angle: Infinity }));
});

test('viewport clipping keeps crossing lines and rejects fully outside lines', () => {
  const color = '#68e0ff';
  assert.deepEqual(clipLine({ x1: -20, y1: 20, x2: 100, y2: 20, color }, 80, 60), { x1: 0, y1: 20, x2: 79, y2: 20, color });
  assert.equal(clipLine({ x1: -20, y1: -10, x2: -5, y2: -4, color }, 80, 60), null);
  const zoomed = frameFor({ focal: 5000 }).frame;
  for (const line of zoomed.lines) {
    const clipped = clipLine(line, zoomed.width, zoomed.height);
    if (clipped) for (const [value, maximum] of [[clipped.x1, 639], [clipped.x2, 639], [clipped.y1, 479], [clipped.y2, 479]])
      assert.ok(value >= 0 && value <= maximum);
  }
});

test('SVG and PNG contain the geometry exported by NERVA', () => {
  const { frame } = frameFor({ angle: 0.6, pitch: 0.35 });
  const svg = renderSVG(frame);
  assert.equal((svg.match(/<line /g) ?? []).length, 12);
  const png = renderPNG(frame);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 640); assert.equal(png.readUInt32BE(20), 480);
  const compressed = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const rows = inflateSync(Buffer.concat(compressed));
  assert.equal(rows.length, 480 * (640 * 3 + 1));
  assert(rows.includes(104), 'The raster must contain cyan geometry pixels');
});

test('backend rejects malformed commands before exporting image data', () => {
  const frame = frameFor().frame;
  assert.throws(() => renderSVG({ ...frame, lines: [{ x1: 0, y1: 0, x2: 1, y2: 1, color: '" onload="bad' }] }));
  assert.throws(() => renderPNG({ ...frame, width: 30000 }));
});
