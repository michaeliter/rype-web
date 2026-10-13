// Classifier worker: one wasm instance with its own mount of the index. The
// coordinator (worker.js) spawns several of these and hands each one whole
// FASTQ batches; results go back in the same message shape, keyed by `seq`.
importScripts('rype_mask.js', 'fsutil.js');

let M = null;
let simulateFail = null; // ?simulateFail=<seq>: throw once on that batch (tests the retry path)
const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const ready = createRypeMask({ print: () => {}, printErr: (s) => post('log', { msg: s }) }).then((m) => { M = m; });
const lastError = () => M.ccall('mask_last_error', 'string', [], []);

// ---------------------------------------------------------------- index sources
async function remoteEntries(base, chunkBytes) {
  if (!base.endsWith('/')) base += '/';
  const get = async (rel) => { const r = await fetch(base + rel); if (!r.ok) throw new Error(`${r.status} fetching ${rel}`); return r; };
  const manifest = await (await get('manifest.toml')).text();
  const shards = [...manifest.matchAll(/^shard_id\s*=\s*(\d+)/gm)].map((m) => `inverted/shard.${m[1]}.parquet`);
  if (!shards.length) throw new Error('manifest.toml lists no shards');
  const entries = [
    { name: 'manifest.toml', data: new Blob([manifest]) },
    { name: 'buckets.parquet', data: await (await get('buckets.parquet')).blob() },
  ];
  for (const rel of shards) entries.push({ name: rel, data: remoteSource(base + rel, await remoteSize(base + rel), chunkBytes) });
  return entries;
}

function localEntries(files, paths) {
  // paths[i] is files[i] relative to the picked folder (webkitRelativePath
  // does not survive postMessage, so the page computes it).
  const entries = files.map((f, i) => ({ name: paths[i], data: localSource(f) }));
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('manifest.toml') || !names.has('buckets.parquet')) throw new Error('index folder must contain manifest.toml and buckets.parquet');
  if (!entries.some((e) => /^inverted\/.*\.parquet$/.test(e.name))) throw new Error('index folder has no inverted/*.parquet shards');
  return entries;
}

async function mountIndex(msg) {
  const entries = msg.source === 'url' ? await remoteEntries(msg.base, msg.chunkBytes || (8 << 20)) : localEntries(msg.files, msg.paths);
  mountIndexFs(M, entries);
  if (M.ccall('mask_load_index', 'number', ['string'], ['/index']) !== 0) throw new Error(lastError());
  const shards = entries.filter((e) => e.name.startsWith('inverted/'));
  return { k: M._mask_index_k(), w: M._mask_index_w(), buckets: M._mask_index_num_buckets(),
           shards: shards.length, shardBytes: shards.reduce((a, e) => a + e.data.size, 0), source: msg.source };
}

// ---------------------------------------------------------------- one batch
const u32 = (p, i) => u32At(M, p + 4 * i);
const HIST_BINS = 102; // MASK_HIST_BINS in mask.c: no-hit bin + 101 bins of 0.01 containment
function takeOut(outs, ptrIdx, lenIdx) { const p = u32(outs, ptrIdx), l = u32(outs, lenIdx); const b = M.HEAPU8.slice(p, p + l); M._mask_free(p); return b; }

function classify({ seq, mode, b1, b2, threshold }) {
  const t = performance.now();
  const outs = M._malloc(28);
  const p1 = M._malloc(b1.byteLength); M.HEAPU8.set(new Uint8Array(b1), p1);
  const p2 = b2 ? M._malloc(b2.byteLength) : 0; if (b2) M.HEAPU8.set(new Uint8Array(b2), p2);
  let rc, hist = 0;
  if (mode === 'classify') {
    rc = M.ccall('mask_classify', 'number', Array(9).fill('number'), [p1, b1.byteLength, p2, b2 ? b2.byteLength : 0, threshold, outs, outs + 4, outs + 8, outs + 12]);
  } else {
    hist = M._malloc(HIST_BINS * 4); M.HEAPU8.fill(0, hist, hist + HIST_BINS * 4);
    rc = M.ccall('mask_filter', 'number', Array(13).fill('number'), [p1, b1.byteLength, p2, b2 ? b2.byteLength : 0, threshold, outs, outs + 4, outs + 8, outs + 12, outs + 16, outs + 20, hist, outs + 24]);
  }
  M._free(p1); if (p2) M._free(p2);
  if (rc !== 0) { M._free(outs); throw new Error(lastError()); }
  const r = mode === 'classify'
    ? { total: u32(outs, 2), affected: u32(outs, 3), out1: takeOut(outs, 0, 1), out2: null }
    : { total: u32(outs, 4), affected: u32(outs, 5), out1: takeOut(outs, 0, 1), out2: b2 ? takeOut(outs, 2, 3) : null, hist: M.HEAPU32.slice(hist >>> 2, (hist >>> 2) + HIST_BINS), keptBins: null };
  if (mode !== 'classify') { const kb = u32(outs, 6), nk = r.total - r.affected; r.keptBins = M.HEAPU8.slice(kb, kb + nk); M._mask_free(kb); }
  M._free(outs); if (hist) M._free(hist);
  const transfer = [r.out1.buffer, ...(r.out2 ? [r.out2.buffer] : []), ...(r.keptBins ? [r.keptBins.buffer] : [])];
  post('result', { seq, ...r, ms: performance.now() - t, bytesFetched: FsStats.bytesFetched, heapBytes: M.HEAPU8.length }, transfer);
}

self.onerror = (e) => post('error', { msg: 'uncaught in classifier: ' + (e.message || e) });
self.onunhandledrejection = (e) => post('error', { msg: 'unhandled rejection in classifier: ' + (e.reason && e.reason.message || e.reason) });
self.onmessage = async (e) => {
  const msg = e.data;
  try {
    await ready;
    if (msg.type === 'mount') { simulateFail = msg.simulateFail != null ? parseInt(msg.simulateFail, 10) : null; post('mounted', await mountIndex(msg)); }
    else if (msg.type === 'classify') {
      if (simulateFail !== null && msg.seq === simulateFail) { simulateFail = null; throw new WebAssembly.RuntimeError('simulated out-of-memory'); }
      classify(msg);
    }
  } catch (err) {
    const text = String((err && err.message) || err);
    // A wasm trap or failed memory growth leaves this instance unusable but the
    // input buffers intact: hand them back so the coordinator can retry the batch
    // elsewhere. A clean rype error (rc != 0) is not retryable.
    const retryable = msg.type === 'classify' && (err instanceof WebAssembly.RuntimeError || /memory|abort/i.test(text));
    if (retryable) post('error', { msg: text, retryable: true, seq: msg.seq, b1: msg.b1, b2: msg.b2 }, [msg.b1, ...(msg.b2 ? [msg.b2] : [])]);
    else post('error', { msg: text });
  }
};
