#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  if (process.argv.length > 3) throw new Error('Uso: node scripts/verify-origin.mjs [ruta-a-UNIDAD]');
  const manifest = JSON.parse(await readFile(resolve(root, 'provenance.json'), 'utf8'));
  const unidad = process.argv[2] ? resolve(process.argv[2]) : null;
  const files = [];
  for (const file of manifest.files) {
    const local = sha256(await readFile(resolve(root, file.path)));
    const source = unidad ? sha256(await readFile(resolve(unidad, file.sourcePath))) : null;
    files.push({ path: file.path, matchesOrigin: local === file.sha256,
      ...(unidad ? { matchesUnidad: local === source, unidadMatchesOrigin: source === file.sha256 } : {}) });
  }
  const ok = files.every(file => file.matchesOrigin && (!unidad || (file.matchesUnidad && file.unidadMatchesOrigin)));
  process.stdout.write(JSON.stringify({ ok, originCommit: manifest.origin.commit, files }, null, 2) + '\n');
  if (!ok) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
});
