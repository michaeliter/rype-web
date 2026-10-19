import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const createRypeMask = require('../web/rype_mask.js');
const [,, indexDir, fastqPath] = process.argv;
const M = await createRypeMask();
M.FS.mkdir('/index'); M.FS.mount(M.NODEFS, { root: indexDir }, '/index');
// Count bytes and distinct 1 MB chunks read from the shard.
const origRead = M.NODEFS.stream_ops.read;
let bytes = 0, chunks = new Set();
M.NODEFS.stream_ops.read = function(stream, buffer, offset, length, position) {
  const n = origRead.call(this, stream, buffer, offset, length, position);
  if (stream.path.includes('shard')) { bytes += n; for (let c = Math.floor(position/1048576); c <= Math.floor((position+n)/1048576); c++) chunks.add(c); }
  return n;
};
M.ccall('mask_load_index', 'number', ['string'], ['/index']);
const loadBytes = bytes; bytes = 0; chunks.clear();
const fq = fs.readFileSync(fastqPath);
const inPtr = M._malloc(fq.length); M.HEAPU8.set(fq, inPtr);
// mask_filter(buf1, len1, buf2, len2, threshold, out1, out1_len, out2, out2_len, n_total, n_removed, hist, kept_bins)
const out = M._malloc(7 * 4), hist = M._malloc(102 * 4); // seven output slots, then the 102-bin histogram
const rc = M.ccall('mask_filter', 'number', Array(13).fill('number'),
  [inPtr, fq.length, 0, 0, 0.1, out, out + 4, out + 8, out + 12, out + 16, out + 20, hist, out + 24]);
if (rc !== 0) throw new Error(M.ccall('mask_last_error', 'string', [], []));
console.log(`reads=${M.HEAPU32[(out + 16) >>> 2]} removed=${M.HEAPU32[(out + 20) >>> 2]} footer/load=${(loadBytes/1e6).toFixed(1)}MB batch_read=${(bytes/1e6).toFixed(0)}MB distinct_1MB_chunks=${chunks.size}`);
