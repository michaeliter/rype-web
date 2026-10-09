// Classifier worker: one wasm instance with its own mount of the index. The
// coordinator (worker.js) spawns several of these and hands each one whole
// FASTQ batches; results go back in the same message shape, keyed by `seq`.
importScripts('rype_mask.js');

let M = null;
let simulateFail = null; // ?simulateFail=<seq>: throw once on that batch (tests the retry path)
const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const ready = createRypeMask({ print: () => {}, printErr: (s) => post('log', { msg: s }) }).then((m) => { M = m; });
const lastError = () => M.ccall('mask_last_error', 'string', [], []);

// ---------------------------------------------------------------- index sources
let bytesFetched = 0;

// Index files are presented to WORKERFS as chunked, cached sources, and the
// WORKERFS read op is patched to copy straight out of the cache. rype makes
// ~80k reads per pass over a 1.7 GB shard, most under 4 KB, and the stock
// WORKERFS path (Blob.slice + FileReaderSync per read) costs a round trip to the
// browser process each: ~25 s per pass measured, for both local and URL sources.
// Fetching 8 MB chunks instead makes it ~220 round trips per pass.
class ChunkedSource {
  constructor(size, fetchRange, chunk = 8 << 20, keep = 4) { this.size = size; this.fetchRange = fetchRange; this.chunk = chunk; this.keep = keep; this.cache = new Map(); }
  chunkAt(i) {
    let c = this.cache.get(i);
    if (c) return c;
    c = this.fetchRange(i * this.chunk, Math.min(this.size, (i + 1) * this.chunk));
    this.cache.set(i, c);
    if (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value);
    return c;
  }
  readInto(buffer, offset, length, position) { // WORKERFS stream_ops.read contract
    const end = Math.min(this.size, position + length);
    for (let pos = position; pos < end;) {
      const i = Math.floor(pos / this.chunk), c = this.chunkAt(i);
      const off = pos - i * this.chunk, n = Math.min(c.length - off, end - pos);
      buffer.set(c.subarray(off, off + n), offset + (pos - position));
      pos += n;
    }
    return Math.max(0, end - position);
  }
  slice(a, b) { const out = new Uint8Array(Math.max(0, Math.min(b, this.size) - a)); this.readInto(out, 0, out.length, a); return new Blob([out]); }
}
const localSource = (file) => new ChunkedSource(file.size, (a, b) => new Uint8Array(new FileReaderSync().readAsArrayBuffer(file.slice(a, b))));
function remoteSource(url, size, chunk) {
  return new ChunkedSource(size, (a, b) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', `bytes=${a}-${b - 1}`);
    xhr.send();
    if (xhr.status !== 206) throw new Error(`range request failed (${xhr.status}) for ${url}`);
    const buf = new Uint8Array(xhr.response);
    bytesFetched += buf.length;
    return buf;
  }, chunk);
}
let readPatched = false;
function patchWorkerfsRead() {
  if (readPatched) return;
  readPatched = true;
  const orig = M.WORKERFS.stream_ops.read;
  M.WORKERFS.stream_ops.read = (stream, buffer, offset, length, position) => {
    const c = stream.node.contents;
    return c instanceof ChunkedSource ? c.readInto(buffer, offset, length, position) : orig(stream, buffer, offset, length, position);
  };
}

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
  for (const rel of shards) {
    const head = await fetch(base + rel, { method: 'HEAD' });
    const size = parseInt(head.headers.get('Content-Length') || '', 10);
    if (!head.ok || !(size > 0)) throw new Error(`cannot size ${rel} (server must expose Content-Length)`);
    if (head.headers.get('Accept-Ranges') !== 'bytes') throw new Error(`${rel}: server does not advertise byte ranges`);
    entries.push({ name: rel, data: remoteSource(base + rel, size, chunkBytes) });
  }
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
  patchWorkerfsRead();
  try { M.FS.unmount('/index'); } catch {}
  try { M.FS.mkdir('/index'); } catch {}
  M.FS.mount(M.WORKERFS, { blobs: entries }, '/index');
  bytesFetched = 0;
  if (M.ccall('mask_load_index', 'number', ['string'], ['/index']) !== 0) throw new Error(lastError());
  const shards = entries.filter((e) => e.name.startsWith('inverted/'));
  return { k: M._mask_index_k(), w: M._mask_index_w(), buckets: M._mask_index_num_buckets(),
           shards: shards.length, shardBytes: shards.reduce((a, e) => a + e.data.size, 0), source: msg.source };
}

// ---------------------------------------------------------------- one batch
const u32 = (p, i) => M.HEAPU32[(p + 4 * i) >> 2];
function takeOut(outs, ptrIdx, lenIdx) { const p = u32(outs, ptrIdx), l = u32(outs, lenIdx); const b = M.HEAPU8.slice(p, p + l); M._mask_free(p); return b; }

function classify({ seq, mode, b1, b2, threshold }) {
  const t = performance.now();
  const outs = M._malloc(32);
  const p1 = M._malloc(b1.byteLength); M.HEAPU8.set(new Uint8Array(b1), p1);
  const p2 = b2 ? M._malloc(b2.byteLength) : 0; if (b2) M.HEAPU8.set(new Uint8Array(b2), p2);
  let rc;
  if (mode === 'classify') {
    rc = M.ccall('mask_classify', 'number', Array(9).fill('number'), [p1, b1.byteLength, p2, b2 ? b2.byteLength : 0, threshold, outs, outs + 4, outs + 8, outs + 12]);
  } else {
    rc = M.ccall('mask_filter', 'number', Array(11).fill('number'), [p1, b1.byteLength, p2, b2 ? b2.byteLength : 0, threshold, outs, outs + 4, outs + 8, outs + 12, outs + 16, outs + 20]);
  }
  M._free(p1); if (p2) M._free(p2);
  if (rc !== 0) { M._free(outs); throw new Error(lastError()); }
  const r = mode === 'classify'
    ? { total: u32(outs, 2), affected: u32(outs, 3), out1: takeOut(outs, 0, 1), out2: null }
    : { total: u32(outs, 4), affected: u32(outs, 5), out1: takeOut(outs, 0, 1), out2: b2 ? takeOut(outs, 2, 3) : null };
  M._free(outs);
  const transfer = [r.out1.buffer, ...(r.out2 ? [r.out2.buffer] : [])];
  post('result', { seq, ...r, ms: performance.now() - t, bytesFetched, heapBytes: M.HEAPU8.length }, transfer);
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
