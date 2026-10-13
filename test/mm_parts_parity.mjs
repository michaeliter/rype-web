// Per-part parity of the minimap2 wasm module against the native CLI: every part of the
// multi-part index is mounted by byte range exactly as web/mm_worker.js does (WORKERFS +
// ChunkedSource, here over fs.readSync), the sr_mix pairs are mapped, and the hit set must
// equal testdata/sr_parts_truth/part<i>.txt (tools/mm_parts_truth.sh, native minimap2).
// Why: pairing geometry and tie-breaks differ per part composition, so a cascade-level
// check can hide a per-part miss (it did: R2 orientation, 3 reads on part 1).
//   node test/mm_parts_parity.mjs [index.mmi] [r1.fq] [r2.fq]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mmi = process.argv[2] || path.join(root, 'testdata/chm13_sr_parts.mmi');
const r1Path = process.argv[3] || path.join(root, 'testdata/sr_mix_r1.fq');
const r2Path = process.argv[4] || path.join(root, 'testdata/sr_mix_r2.fq');
if (!fs.existsSync(mmi) || !fs.existsSync(mmi + '.parts.json')) { console.log(`SKIP mm-parts-parity: missing ${mmi} or its .parts.json`); process.exit(0); }
const parts = JSON.parse(fs.readFileSync(mmi + '.parts.json', 'utf8')).parts;
const { ChunkedSource, patchWorkerfsRead } = new Function(fs.readFileSync(path.join(root, 'web/fsutil.js'), 'utf8') + '; return { ChunkedSource, patchWorkerfsRead };')();
// WORKERFS asserts a worker environment and constructs a FileReaderSync at mount; neither is
// used once the read op is patched to ChunkedSource, so stub both for Node.
globalThis.WorkerGlobalScope ||= class {}; globalThis.FileReaderSync ||= class {};
const createMmFilter = require(path.join(root, 'web/mm_filter.js'));
const fd = fs.openSync(mmi, 'r');
const readIds = (p) => fs.readFileSync(p, 'utf8').split('\n').filter((l, i) => i % 4 === 0 && l).map((l) => l.slice(1).split(/\s/)[0].replace(/\/[12]$/, ''));
const ids = readIds(r1Path);
const only = process.env.PARTS ? new Set(process.env.PARTS.split(',').map(Number)) : null; // PARTS=1,2 to run a subset
let failed = 0;
for (let i = 0; i < parts.length; i++) {
  if (only && !only.has(i)) continue;
  const { offset, size } = parts[i];
  // A fresh module per part, as each mm_worker.js holds exactly one part.
  const M = await createMmFilter({ print: () => {}, printErr: (s) => console.error('[mm]', s) });
  patchWorkerfsRead(M);
  const put = (p) => { const b = fs.readFileSync(p); const ptr = M._malloc(b.length); M.HEAPU8.set(b, ptr); return [ptr, b.length]; };
  const [p1, l1] = put(r1Path), [p2, l2] = put(r2Path);
  const src = new ChunkedSource(size, (a, b) => { const buf = new Uint8Array(b - a); fs.readSync(fd, buf, 0, b - a, offset + a); return buf; }, 8 << 20, 4, 0);
  try { M.FS.unmount('/index'); } catch {}
  try { M.FS.mkdir('/index'); } catch {}
  M.FS.mount(M.WORKERFS, { blobs: [{ name: 'part.mmi', data: src }] }, '/index');
  let t0 = performance.now();
  if (M.ccall('mm_part_load', 'number', ['string'], ['/index/part.mmi']) !== 0) throw new Error(M.ccall('mm_last_error', 'string', [], []));
  const tLoad = (performance.now() - t0) / 1000;
  const outs = M._malloc(12);
  t0 = performance.now();
  if (M.ccall('mm_part_hits', 'number', Array(7).fill('number'), [p1, l1, p2, l2, outs, outs + 4, outs + 8]) !== 0) throw new Error(M.ccall('mm_last_error', 'string', [], []));
  const hp = M.HEAPU32[outs >> 2], n = M.HEAPU32[(outs + 4) >> 2];
  const hits = M.HEAPU8.slice(hp, hp + n); M._mm_free(hp); M._free(outs);
  const tMap = (performance.now() - t0) / 1000;
  const got = new Set(ids.filter((_, j) => hits[j]));
  const truth = new Set(fs.readFileSync(path.join(root, `testdata/sr_parts_truth/part${i}.txt`), 'utf8').split('\n').filter(Boolean));
  const missing = [...truth].filter((x) => !got.has(x)), extra = [...got].filter((x) => !truth.has(x));
  const ok = !missing.length && !extra.length; if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} part ${i} (${(size / 2 ** 30).toFixed(2)} GiB, ${M._mm_part_n_seq()} seqs): ${got.size} mapped pairs, truth ${truth.size}, missing ${missing.length}, extra ${extra.length}; load ${tLoad.toFixed(1)} s, map ${tMap.toFixed(1)} s` + (ok ? '' : ` ${JSON.stringify({ missing: missing.slice(0, 5), extra: extra.slice(0, 5) })}`));
}
const ran = only ? only.size : parts.length; console.log(`${ran - failed}/${ran} parts match native minimap2`);
process.exit(failed ? 1 : 0);
