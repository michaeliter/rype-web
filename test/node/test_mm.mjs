// Headless test of the minimap2 shim against one index part (NODEFS-mounted file).
//   node test/node/test_mm.mjs <part.mmi> <r1.fq> [r2.fq|-] <truth_pairs.txt>
// truth_pairs.txt: one read id (mate suffix stripped) per line that native minimap2 maps
// in this part (either mate). Prints a diff summary; exit 1 on mismatch.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { readIds } from './test/util.mjs';
const require = createRequire(import.meta.url);
const [,, partPath, r1Path, r2Arg, truthPath] = process.argv;
const r2Path = r2Arg && r2Arg !== '-' ? r2Arg : null;
const { partHits } = require('../../web/fsutil.js');
const M = await require('../../web/mm_filter.js')({ print: () => {}, printErr: (s) => console.error('[mm]', s) });
M.FS.mkdir('/index'); M.FS.mount(M.NODEFS, { root: path.dirname(path.resolve(partPath)) }, '/index');
let t0 = performance.now();
if (M.ccall('mm_part_load', 'number', ['string'], ['/index/' + path.basename(partPath)]) !== 0) throw new Error(M.ccall('mm_last_error', 'string', [], []));
console.log(`part loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${M._mm_part_n_seq()} seqs, k=${M._mm_part_k()} w=${M._mm_part_w()}, heap ${(M.HEAPU8.length / 2 ** 30).toFixed(2)} GiB`);
t0 = performance.now();
const { hits, n, nh } = partHits(M, fs.readFileSync(r1Path), r2Path ? fs.readFileSync(r2Path) : null);
console.log(`${n} records, ${nh} with a mapping, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const ids = readIds(fs.readFileSync(r1Path, 'utf8'));
const got = new Set(ids.filter((_, i) => hits[i]));
const truth = new Set(fs.readFileSync(truthPath, 'utf8').split('\n').filter(Boolean));
const missing = [...truth].filter((x) => !got.has(x)), extra = [...got].filter((x) => !truth.has(x));
console.log(`truth ${truth.size}, got ${got.size}, missing ${missing.length}, extra ${extra.length}`, missing.slice(0, 5), extra.slice(0, 5));
process.exit(missing.length || extra.length ? 1 : 0);
