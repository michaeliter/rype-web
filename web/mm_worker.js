// minimap2 part worker: loads ONE part of a multi-part .mmi (mounted as its own
// file from a byte range of the index, local or URL) and answers, per FASTQ
// batch, one byte per record: 1 if either mate maps in this part. The
// coordinator (worker.js) broadcasts each batch to every part worker of a
// sweep and ORs the answers.
importScripts('mm_filter.js', 'fsutil.js');

let M = null;
const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const ready = createMmFilter({ print: () => {}, printErr: (s) => post('log', { msg: s }) }).then((m) => { M = m; });
const lastError = () => M.ccall('mm_last_error', 'string', [], []);

async function mountPart(msg) {
  patchWorkerfsRead(M);
  const { offset, size } = msg.part;
  const src = msg.source === 'url'
    ? remoteSource(msg.url, size, msg.chunkBytes || (8 << 20), offset)
    : localSource(msg.file, offset, size);
  try { M.FS.unmount('/index'); } catch {}
  try { M.FS.mkdir('/index'); } catch {}
  M.FS.mount(M.WORKERFS, { blobs: [{ name: 'part.mmi', data: src }] }, '/index');
  FsStats.bytesFetched = 0;
  const t = performance.now();
  if (M.ccall('mm_part_load', 'number', ['string'], ['/index/part.mmi']) !== 0) throw new Error(lastError());
  return { nSeq: M._mm_part_n_seq(), k: M._mm_part_k(), w: M._mm_part_w(), loadMs: performance.now() - t, bytesFetched: FsStats.bytesFetched, heapBytes: M.HEAPU8.length };
}

function hits({ seq, b1, b2 }) {
  const t = performance.now();
  const outs = M._malloc(12);
  const p1 = M._malloc(b1.byteLength); M.HEAPU8.set(new Uint8Array(b1), p1);
  const p2 = b2 ? M._malloc(b2.byteLength) : 0; if (b2) M.HEAPU8.set(new Uint8Array(b2), p2);
  const rc = M.ccall('mm_part_hits', 'number', Array(7).fill('number'), [p1, b1.byteLength, p2, b2 ? b2.byteLength : 0, outs, outs + 4, outs + 8]);
  M._free(p1); if (p2) M._free(p2);
  if (rc !== 0) { M._free(outs); throw new Error(lastError()); }
  const hp = M.HEAPU32[outs >> 2], n = M.HEAPU32[(outs + 4) >> 2], nh = M.HEAPU32[(outs + 8) >> 2];
  const h = M.HEAPU8.slice(hp, hp + n); M._mm_free(hp); M._free(outs);
  post('result', { seq, hits: h, n, nh, ms: performance.now() - t, bytesFetched: FsStats.bytesFetched, heapBytes: M.HEAPU8.length }, [h.buffer]);
}

self.onerror = (e) => post('error', { msg: 'uncaught in minimap2 worker: ' + (e.message || e) });
self.onunhandledrejection = (e) => post('error', { msg: 'unhandled rejection in minimap2 worker: ' + (e.reason && e.reason.message || e.reason) });
self.onmessage = async (e) => {
  const msg = e.data;
  try {
    await ready;
    if (msg.type === 'mount') post('mounted', await mountPart(msg));
    else if (msg.type === 'hits') hits(msg);
  } catch (err) {
    post('error', { msg: String((err && err.message) || err) });
  }
};
