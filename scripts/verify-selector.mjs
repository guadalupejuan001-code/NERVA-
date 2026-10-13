import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-selector.mjs ../UNIDAD');
for (const name of ['token_selector.mjs', 'conversation_worker_fast.mjs']) {
  assert.deepEqual(readFileSync(resolve(root, 'src', name)),
    readFileSync(resolve(process.argv[2], 'src/ia_propia/assets/nerva', name)), name + ' differs');
}
console.log('Both optional selector files match UNIDAD byte for byte.');
