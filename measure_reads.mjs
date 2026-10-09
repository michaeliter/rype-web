import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const createRypeMask = require('./web/rype_mask.js');
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
const inPtr = M._malloc(fq.length); M.HEAPU8.set(fq, inPtr); const outPP = M._malloc(16);
M.ccall('mask_filter', 'number', ['number','number','number','number','number','number','number'], [inPtr, fq.length, 0.1, outPP, outPP+4, outPP+8, outPP+12]);
console.log(`reads=${M.HEAPU32[(outPP+8)>>2]} footer/load=${(loadBytes/1e6).toFixed(1)}MB batch_read=${(bytes/1e6).toFixed(0)}MB distinct_1MB_chunks=${chunks.size}`);
