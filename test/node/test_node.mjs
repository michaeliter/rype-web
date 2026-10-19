// Headless test of the wasm shim with a NODEFS-mounted index.
//   node test/node/test_node.mjs filter   <index.ryxdi> <r1.fq> [r2.fq|-] <out_prefix> [thr]
//   node test/node/test_node.mjs classify <index.ryxdi> <r1.fq> [r2.fq|-] <out.tsv>    [thr]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const createRypeMask = require('../../web/rype_mask.js');
const [,, mode, indexDir, r1Path, r2Arg, outPath, thr = '0.1'] = process.argv;
const r2Path = r2Arg && r2Arg !== '-' ? r2Arg : null;
const M = await createRypeMask();
M.FS.mkdir('/index'); M.FS.mount(M.NODEFS, { root: indexDir }, '/index');
const t0 = performance.now();
if (M.ccall('mask_load_index', 'number', ['string'], ['/index']) !== 0) throw new Error('load failed: ' + M.ccall('mask_last_error', 'string', [], []));
console.log(`index loaded in ${(performance.now() - t0).toFixed(0)} ms; k=${M._mask_index_k()} w=${M._mask_index_w()} buckets=${M._mask_index_num_buckets()}`);
const put = (p) => { if (!p) return [0, 0]; const b = fs.readFileSync(p); const ptr = M._malloc(b.length); M.HEAPU8.set(b, ptr); return [ptr, b.length]; };
const [in1, len1] = put(r1Path), [in2, len2] = put(r2Path);
const outs = M._malloc(32); // up to 8 x u32 out-params
const u32 = (i) => M.HEAPU32[(outs + 4 * i) >>> 2];
const take = (ptrIdx, lenIdx) => { const p = u32(ptrIdx), l = u32(lenIdx); const b = Buffer.from(M.HEAPU8.buffer, p, l).toString('binary'); M._mask_free(p); return Buffer.from(b, 'binary'); };
const t1 = performance.now();
let rc;
if (mode === 'filter') {
  rc = M.ccall('mask_filter', 'number', Array(11).fill('number'), [in1, len1, in2, len2, parseFloat(thr), outs, outs + 4, outs + 8, outs + 12, outs + 16, outs + 20]);
  if (rc !== 0) throw new Error('filter failed: ' + M.ccall('mask_last_error', 'string', [], []));
  fs.writeFileSync(outPath + '.R1.fq', take(0, 1));
  if (r2Path) fs.writeFileSync(outPath + '.R2.fq', take(2, 3));
  console.log(`filtered ${u32(4)} ${r2Path ? 'pairs' : 'reads'}, removed ${u32(5)}, ${(performance.now() - t1).toFixed(0)} ms`);
} else {
  rc = M.ccall('mask_classify', 'number', Array(9).fill('number'), [in1, len1, in2, len2, parseFloat(thr), outs, outs + 4, outs + 8, outs + 12]);
  if (rc !== 0) throw new Error('classify failed: ' + M.ccall('mask_last_error', 'string', [], []));
  fs.writeFileSync(outPath, Buffer.concat([Buffer.from('read_id\tbucket_name\tscore\n'), take(0, 1)]));
  console.log(`classified ${u32(2)} ${r2Path ? 'pairs' : 'reads'}, ${u32(3)} hits, ${(performance.now() - t1).toFixed(0)} ms`);
}
