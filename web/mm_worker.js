// minimap2 part worker: loads ONE part of a multi-part .mmi (mounted as its own
// file from a byte range of the index, local or URL) and answers, per FASTQ
// batch, one byte per record: 1 if either mate maps in this part. The
// coordinator (worker.js) broadcasts each batch to every part worker of a
// sweep and ORs the answers.
importScripts('mm_filter.js', 'fsutil.js');

let M = null;
let simulateFail = null; // ?mmSimulateFail=<seq>: this worker fails that batch with a memory error (tests the coordinator's fallback)
const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const ready = createMmFilter({ print: () => {}, printErr: (s) => post('log', { msg: s }) }).then((m) => { M = m; });
const lastError = () => M.ccall('mm_last_error', 'string', [], []);

async function mountPart(msg) {
  const { offset, size } = msg.part;
  const src = msg.source === 'url'
    ? remoteSource(msg.url, size, msg.chunkBytes || (8 << 20), offset)
    : localSource(msg.file, offset, size);
  mountIndexFs(M, [{ name: 'part.mmi', data: src }]);
  const t = performance.now();
  if (M.ccall('mm_part_load', 'number', ['string'], ['/index/part.mmi']) !== 0) throw new Error(lastError());
  return { nSeq: M._mm_part_n_seq(), k: M._mm_part_k(), w: M._mm_part_w(), loadMs: performance.now() - t, bytesFetched: FsStats.bytesFetched, heapBytes: M.HEAPU8.length };
}

function hits({ seq, b1, b2 }) {
  const t = performance.now();
  const { hits: h, n, nh } = partHits(M, b1, b2);
  post('result', { seq, hits: h, n, nh, ms: performance.now() - t, bytesFetched: FsStats.bytesFetched, heapBytes: M.HEAPU8.length }, [h.buffer]);
}

self.onerror = (e) => post('error', { msg: 'uncaught in minimap2 worker: ' + (e.message || e) });
self.onunhandledrejection = (e) => post('error', { msg: 'unhandled rejection in minimap2 worker: ' + (e.reason && e.reason.message || e.reason) });
self.onmessage = async (e) => {
  const msg = e.data;
  try {
    await ready;
    if (msg.type === 'mount') { simulateFail = msg.simulateFail != null ? parseInt(msg.simulateFail, 10) : null; post('mounted', await mountPart(msg)); }
    else if (msg.type === 'hits') {
      if (simulateFail !== null && msg.seq === simulateFail) { simulateFail = null; throw new WebAssembly.RuntimeError('simulated out-of-memory'); }
      hits(msg);
    }
  } catch (err) {
    post('error', { msg: String((err && err.message) || err) });
  }
};
