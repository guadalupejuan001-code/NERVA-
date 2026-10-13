import { deflateSync } from 'node:zlib';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const hex = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);

export function validateFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid frame');
  for (const name of ['width', 'height']) {
    if (!Number.isSafeInteger(frame[name]) || frame[name] < 16 || frame[name] > 2048)
      throw new Error('Frame dimensions must be integers between 16 and 2048');
  }
  if (!Array.isArray(frame.points) || frame.points.length > 256
      || !Array.isArray(frame.lines) || frame.lines.length > 512) throw new Error('Invalid geometry count');
  for (const point of frame.points) {
    if (!point || ![point.x, point.y, point.z].every(finite) || point.z <= 0) throw new Error('Invalid projected point');
  }
  for (const line of frame.lines) {
    if (!line || ![line.x1, line.y1, line.x2, line.y2].every(value => finite(value) && Math.abs(value) <= 1e6)
        || !hex(line.color)) throw new Error('Invalid line command');
  }
  return frame;
}

// Cohen-Sutherland clips the 2D command buffer before rasterizing. The NERVA
// geometry module separately rejects camera-near intersections in this demo.
export function clipLine(line, width, height) {
  let { x1, y1, x2, y2 } = line;
  const right = width - 1, bottom = height - 1;
  const code = (x, y) => (x < 0 ? 1 : x > right ? 2 : 0) | (y < 0 ? 4 : y > bottom ? 8 : 0);
  for (let iteration = 0; iteration < 8; iteration++) {
    const a = code(x1, y1), b = code(x2, y2);
    if (!(a | b)) return { x1, y1, x2, y2, color: line.color };
    if (a & b) return null;
    const outside = a || b;
    let x, y;
    if (outside & 8) { x = x1 + (x2 - x1) * (bottom - y1) / (y2 - y1); y = bottom; }
    else if (outside & 4) { x = x1 + (x2 - x1) * -y1 / (y2 - y1); y = 0; }
    else if (outside & 2) { y = y1 + (y2 - y1) * (right - x1) / (x2 - x1); x = right; }
    else { y = y1 + (y2 - y1) * -x1 / (x2 - x1); x = 0; }
    if (!finite(x) || !finite(y)) throw new Error('Clipping produced nonfinite coordinates');
    if (outside === a) { x1 = x; y1 = y; }
    else { x2 = x; y2 = y; }
  }
  throw new Error('Clipping did not converge');
}

const clippedLines = frame => frame.lines.map(line => clipLine(line, frame.width, frame.height)).filter(Boolean);
const decimal = value => Number(value.toFixed(4));

export function renderSVG(frame) {
  validateFrame(frame);
  const lines = clippedLines(frame).map(line =>
    `<line x1="${decimal(line.x1)}" y1="${decimal(line.y1)}" x2="${decimal(line.x2)}" y2="${decimal(line.y2)}" stroke="${line.color}"/>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}">
<rect width="100%" height="100%" fill="#0b1221"/>
<g stroke-width="2" stroke-linecap="round">${lines}</g>
</svg>\n`;
}

function rasterize(frame) {
  const { width, height } = frame;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) { pixels[i] = 11; pixels[i + 1] = 18; pixels[i + 2] = 33; }
  for (const line of clippedLines(frame)) {
    const color = [1, 3, 5].map(start => Number.parseInt(line.color.slice(start, start + 2), 16));
    let x = Math.round(line.x1), y = Math.round(line.y1);
    const endX = Math.round(line.x2), endY = Math.round(line.y2);
    const dx = Math.abs(endX - x), dy = -Math.abs(endY - y);
    const sx = x < endX ? 1 : -1, sy = y < endY ? 1 : -1;
    let error = dx + dy;
    for (let step = 0; step <= width + height; step++) {
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const offset = (y * width + x) * 3;
        pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
      }
      if (x === endX && y === endY) break;
      const double = 2 * error;
      if (double >= dy) { error += dy; x += sx; }
      if (double <= dx) { error += dx; y += sy; }
    }
  }
  return pixels;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const label = Buffer.from(type, 'ascii');
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([label, bytes])));
  return Buffer.concat([size, label, bytes, checksum]);
}

export function renderPNG(frame) {
  validateFrame(frame);
  const pixels = rasterize(frame);
  const rows = Buffer.alloc(frame.height * (frame.width * 3 + 1));
  for (let y = 0; y < frame.height; y++) {
    const offset = y * (frame.width * 3 + 1);
    rows[offset] = 0;
    pixels.copy(rows, offset + 1, y * frame.width * 3, (y + 1) * frame.width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(frame.width, 0); header.writeUInt32BE(frame.height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
