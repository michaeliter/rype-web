// Stream a .gz through the wasm inflater; report bytes, records, and compare to a reference if given.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const M = await require('./web/rype_mask.js')();
const [,, gzPath, refPath] = process.argv;
const gz = M._gz_new(), outs = M._malloc(8);
let bytes = 0, newlines = 0; const hash = crypto.createHash('md5');
const t0 = performance.now();
for await (const chunk of fs.createReadStream(gzPath, { highWaterMark: 1 << 20 })) {
  const p = M._malloc(chunk.length); M.HEAPU8.set(chunk, p);
  if (M._gz_feed(gz, p, chunk.length, outs, outs + 4) !== 0) throw new Error('gz: ' + M.ccall('gz_last_error', 'string', [], []));
  M._free(p);
  const op = M.HEAPU32[outs >> 2], ol = M.HEAPU32[(outs + 4) >> 2];
  const out = M.HEAPU8.subarray(op, op + ol);
  bytes += ol; for (let i = 0; i < ol; i++) if (out[i] === 10) newlines++;
  hash.update(out); M._free(op);
}
if (M._gz_finish(gz) !== 0) throw new Error('gz: ' + M.ccall('gz_last_error', 'string', [], []));
console.log(`${gzPath}: ${bytes} bytes, ${newlines / 4} records, md5 ${hash.digest('hex')}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
if (refPath) console.log('reference md5', crypto.createHash('md5').update(fs.readFileSync(refPath)).digest('hex'));
