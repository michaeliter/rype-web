// Headless test of the minimap2 shim (or MOD=rm: the rammap shim) against one index part.
//   node test_mm.mjs <part.mmi> <r1.fq> [r2.fq|-] <truth_pairs.txt>
// truth_pairs.txt: one read id (mate suffix stripped) per line that native
// minimap2 maps in this part (either mate). Prints a diff summary; exit 1 on mismatch.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const [,, partPath, r1Path, r2Arg, truthPath] = process.argv;
const r2Path = r2Arg && r2Arg !== '-' ? r2Arg : null;
const P = process.env.MOD === 'rm' ? 'rm_part_' : 'mm_part_'; // MOD=rm tests the rammap module
const M = await require(process.env.MOD === 'rm' ? './web/rm_filter.js' : './web/mm_filter.js')({ print: () => {}, printErr: (s) => console.error('[mm]', s) });
M.FS.mkdir('/index'); M.FS.mount(M.NODEFS, { root: path.dirname(path.resolve(partPath)) }, '/index');
let t0 = performance.now();
if (M.ccall(P + 'load', 'number', ['string'], ['/index/' + path.basename(partPath)]) !== 0) throw new Error(M.ccall(P === 'rm_part_' ? 'rm_last_error' : 'mm_last_error', 'string', [], []));
console.log(`part loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${M['_' + P + 'n_seq']()} seqs, k=${M['_' + P + 'k']()} w=${M['_' + P + 'w']()}, heap ${(M.HEAPU8.length / 2 ** 30).toFixed(2)} GiB`);
const put = (p) => { if (!p) return [0, 0]; const b = fs.readFileSync(p); const ptr = M._malloc(b.length); M.HEAPU8.set(b, ptr); return [ptr, b.length]; };
const [p1, l1] = put(r1Path), [p2, l2] = put(r2Path);
const outs = M._malloc(12);
t0 = performance.now();
if (M.ccall(P + 'hits', 'number', Array(7).fill('number'), [p1, l1, p2, l2, outs, outs + 4, outs + 8]) !== 0) throw new Error(M.ccall(P === 'rm_part_' ? 'rm_last_error' : 'mm_last_error', 'string', [], []));
const hp = M.HEAPU32[outs >>> 2], n = M.HEAPU32[(outs + 4) >>> 2], nh = M.HEAPU32[(outs + 8) >>> 2];
const hits = M.HEAPU8.slice(hp, hp + n);
console.log(`${n} records, ${nh} with a mapping, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const ids = fs.readFileSync(r1Path, 'utf8').split('\n').filter((l, i) => i % 4 === 0 && l).map((l) => l.slice(1).split(/\s/)[0].replace(/\/[12]$/, ''));
const got = new Set(ids.filter((_, i) => hits[i]));
const truth = new Set(fs.readFileSync(truthPath, 'utf8').split('\n').filter(Boolean));
const missing = [...truth].filter((x) => !got.has(x)), extra = [...got].filter((x) => !truth.has(x));
console.log(`truth ${truth.size}, got ${got.size}, missing ${missing.length}, extra ${extra.length}`, missing.slice(0, 5), extra.slice(0, 5));
process.exit(missing.length || extra.length ? 1 : 0);
