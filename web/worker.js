// Coordinator worker: reads one or two FASTQ files as a stream (gunzip in
// wasm), cuts them into batches, and hands each batch to one of N classifier
// workers (classifier.js), each holding its own wasm instance and mount of the
// index. Results are written to browser disk storage (OPFS) in input order.
// This worker's own wasm instance is only used for gunzip.
importScripts('rype_mask.js');

let M = null;
const post = (type, data = {}) => self.postMessage({ type, ...data });
const ready = createRypeMask({ print: () => {}, printErr: (s) => post('log', { msg: s }) }).then((m) => { M = m; });

// ---------------------------------------------------------------- classifier pool
let pool = [];

// Spawn N classifiers and mount the index in each. Local File objects clone
// cheaply across postMessage; a URL source is re-opened by every classifier.
async function mountIndex(msg) {
  for (const w of pool) w.terminate();
  const n = Math.max(1, msg.workers | 0);
  pool = Array.from({ length: n }, () => new Worker('classifier.js?v=' + Date.now()));
  const infos = await Promise.all(pool.map((w) => new Promise((resolve, reject) => {
    w.onmessage = (e) => { const d = e.data; if (d.type === 'mounted') resolve(d); else if (d.type === 'error') reject(new Error(d.msg)); else if (d.type === 'log') post('log', d); };
    w.onerror = (e) => reject(new Error('classifier failed to start: ' + (e.message || e)));
    w.postMessage(w === pool[pool.length - 1] ? msg : { ...msg, simulateFail: null }); // the test hook fails one worker only (the first to be dispatched)
  })));
  return { ...infos[0], workers: n };
}

// ---------------------------------------------------------------- FASTQ input
// Reads a (possibly gzipped) FASTQ as a stream and hands out whole 4-line records.
// gunzip via zlib in the wasm module: DecompressionStream('gzip') rejects
// multi-member files ("Junk found after end of compressed data"), which most
// real FASTQ gz files are.
function gunzipStream() {
  let gz = M._gz_new(), outs = M._malloc(8);
  const fail = () => { throw new Error('gzip: ' + M.ccall('gz_last_error', 'string', [], [])); };
  return new TransformStream({
    transform(chunk, ctrl) {
      const p = M._malloc(chunk.length); M.HEAPU8.set(chunk, p);
      const rc = M._gz_feed(gz, p, chunk.length, outs, outs + 4);
      M._free(p);
      if (rc !== 0) fail();
      const op = M.HEAPU32[outs >> 2], ol = M.HEAPU32[(outs + 4) >> 2];
      if (ol) ctrl.enqueue(M.HEAPU8.slice(op, op + ol));
      M._free(op);
    },
    flush() { const rc = M._gz_finish(gz); M._gz_free(gz); M._free(outs); gz = 0; if (rc !== 0) fail(); },
  });
}

class RecordReader {
  static tPull = 0; // cumulative ms spent waiting on input (read + gunzip)
  // Chunks are kept as a list and assembled once per batch: concatenating on
  // every stream chunk is quadratic (measured: ~200 s of memcpy on a 5.5 GB file).
  constructor(file) {
    let s = file.stream();
    if (/\.gz$/i.test(file.name)) s = s.pipeThrough(gunzipStream());
    this.reader = s.getReader(); this.chunks = []; this.len = 0; this.lines = 0; this.eof = false; this.bytesIn = 0; this.isGz = /\.gz$/i.test(file.name);
  }
  push(c) { this.chunks.push(c); this.len += c.length; for (let i = 0; i < c.length; i++) if (c[i] === 10) this.lines++; }
  async pull() {
    const t = performance.now();
    const { value, done } = await this.reader.read();
    RecordReader.tPull += performance.now() - t;
    if (done) { this.eof = true; const last = this.chunks[this.chunks.length - 1]; if (this.len && last[last.length - 1] !== 10) this.push(new Uint8Array([10])); return; }
    if (!this.isGz) this.bytesIn += value.length;
    this.push(value);
  }
  complete() { return Math.floor(this.lines / 4); }
  async fillBytes(n) { while (!this.eof && this.len < n) await this.pull(); }
  async fillRecords(k) { while (!this.eof && this.complete() < k) await this.pull(); }
  take(k) { // first k complete records, as one contiguous array (single copy)
    let need = 4 * k, ci = 0, cut = 0, total = 0;
    for (; ci < this.chunks.length && need; ci++) {
      const c = this.chunks[ci];
      for (let i = 0; i < c.length; i++) if (c[i] === 10 && --need === 0) { cut = i + 1; break; }
      if (need) total += c.length;
    }
    if (need) throw new Error('internal: take() beyond complete records');
    ci--; // chunk containing the cut
    const out = new Uint8Array(total + cut); let off = 0;
    for (let j = 0; j < ci; j++) { out.set(this.chunks[j], off); off += this.chunks[j].length; }
    out.set(this.chunks[ci].subarray(0, cut), off);
    const rest = this.chunks[ci].subarray(cut);
    this.chunks = rest.length ? [rest, ...this.chunks.slice(ci + 1)] : this.chunks.slice(ci + 1);
    this.len -= out.length; this.lines -= 4 * k;
    return out;
  }
}

// ---------------------------------------------------------------- output sinks
// Streams bytes to OPFS (disk-backed, unbounded) with in-memory fallback; gzip optional.
class Sink {
  constructor(name, gzip) { this.name = name; this.gzip = gzip; this.parts = []; this.pos = 0; }
  async open(dir) {
    if (dir) { this.handle = await dir.getFileHandle(this.name, { create: true }); this.access = await this.handle.createSyncAccessHandle(); }
    if (this.gzip) {
      const cs = new CompressionStream('gzip');
      this.writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();
      this.pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; this.raw(value); } })();
    }
  }
  raw(u8) { if (this.access) { this.access.write(u8, { at: this.pos }); this.pos += u8.length; } else this.parts.push(u8); }
  async write(u8) { if (!u8.length) return; if (this.writer) await this.writer.write(u8); else this.raw(u8); }
  async close() {
    if (this.writer) { await this.writer.close(); await this.pump; }
    if (this.access) { this.access.flush(); this.access.close(); return await this.handle.getFile(); }
    return new File(this.parts, this.name);
  }
}
async function outputDir() {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('rype-out', { create: true });
    for await (const name of dir.keys()) await dir.removeEntry(name); // previous run's outputs
    return dir;
  } catch { return null; } // no OPFS: fall back to in-memory output
}

// ---------------------------------------------------------------- the run
async function run({ mode, r1, r2, threshold, batchBytes, gzipOut }) {
  const in1 = new RecordReader(r1), in2 = r2 ? new RecordReader(r2) : null;
  const base = r1.name.replace(/\.(fastq|fq)(\.gz)?$/i, '').replace(/[._-]?R?1$/i, '');
  const ext = gzipOut ? '.gz' : '';
  const dir = await outputDir();
  const sinks = mode === 'classify'
    ? [new Sink(`${base}.classified.tsv${ext}`, gzipOut)]
    : [new Sink(`${base}.masked${r2 ? '.R1' : ''}.fastq${ext}`, gzipOut), ...(r2 ? [new Sink(`${base}.masked.R2.fastq${ext}`, gzipOut)] : [])];
  for (const s of sinks) await s.open(dir);
  if (mode === 'classify') await sinks[0].write(new TextEncoder().encode('read_id\tbucket_name\tscore\n'));

  let total = 0, affected = 0, tClassify = 0, tTake = 0, tWrite = 0, batches = 0;
  const fetched = new Map(); // classifier -> its cumulative index bytes fetched
  const bytesFetched = () => [...fetched.values()].reduce((a, b) => a + b, 0);
  const t0 = performance.now();
  const phases = () => ({ read: RecordReader.tPull, batch: tTake, classify: tClassify, write: tWrite, batches, workers: pool.length });
  const progress = () => post('progress', { total, affected, bytesIn: in1.bytesIn, fileBytes: r1.size, bytesFetched: bytesFetched(), elapsedMs: performance.now() - t0, phases: phases() });

  // Dispatch: batches go to idle classifiers as they are read; results are
  // written strictly in sequence so output order matches input order.
  const idle = [...pool], waiters = [], results = new Map(), retry = [], busy = new Map();
  let seq = 0, written = 0, inflight = 0, failure = null, draining = Promise.resolve();
  const wake = () => { while (waiters.length) waiters.shift()(); };
  // A classifier that traps or cannot grow its heap is dropped and its batch
  // re-queued for the survivors, so an over-estimated worker count degrades to
  // fewer workers instead of a failed run. A crash that takes the batch with
  // it, or the last worker failing, ends the run.
  const drop = (w, job, why) => {
    w.terminate(); pool = pool.filter((x) => x !== w);
    const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1);
    const hadJob = busy.delete(w); if (hadJob) inflight--;
    if (!pool.length) failure = new Error(`${why}; no classifier workers left. Try ?workers=1 or a smaller batch.`);
    else if (hadJob && !job) failure = new Error(`${why}; its batch was lost. Try fewer workers (?workers=${pool.length}).`);
    else { if (job) retry.push(job); post('warn', { msg: `A classifier worker failed (${why}); continuing with ${pool.length}.` }); }
  };
  const dispatch = (job) => {
    const w = idle.pop(); inflight++; busy.set(w, job);
    w.postMessage({ type: 'classify', seq: job.seq, mode, b1: job.b1, b2: job.b2, threshold }, [job.b1, ...(job.b2 ? [job.b2] : [])]);
  };
  const drain = () => draining = draining.then(async () => {
    for (; results.has(written); written++) {
      const r = results.get(written); results.delete(written);
      const t = performance.now();
      total += r.total; affected += r.affected; tClassify += r.ms;
      await sinks[0].write(r.out1);
      if (r.out2) await sinks[1].write(r.out2);
      tWrite += performance.now() - t; batches++;
      post('log', { msg: `batch ${written}: ${r.total} records in ${r.ms.toFixed(0)} ms, classifier heap ${(r.heapBytes / 1048576).toFixed(0)} MB` });
      progress();
    }
  });
  for (const w of pool) {
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'result') { results.set(d.seq, d); fetched.set(w, d.bytesFetched); busy.delete(w); inflight--; idle.push(w); drain(); }
      else if (d.type === 'error' && d.retryable) drop(w, { seq: d.seq, b1: d.b1, b2: d.b2 }, d.msg);
      else if (d.type === 'error') failure = new Error(d.msg);
      else if (d.type === 'log') post('log', d);
      wake();
    };
    w.onerror = (e) => { drop(w, null, 'classifier crashed: ' + (e.message || e)); wake(); };
  }
  const check = () => { if (failure) throw failure; };
  const until = async (cond) => { while (!cond()) { check(); await new Promise((r) => waiters.push(r)); } check(); };

  for (;;) {
    await in1.fillBytes(batchBytes);
    let n = in1.complete();
    if (in2) { await in2.fillRecords(n); n = Math.min(n, in2.complete()); }
    if (n === 0) {
      if (in1.len || (in2 && in2.len)) throw new Error(in2 && in1.complete() !== in2.complete() ? 'R1 and R2 have different numbers of records' : 'truncated FASTQ record at end of file');
      break;
    }
    let t = performance.now();
    const b1 = in1.take(n), b2 = in2 ? in2.take(n) : null;
    tTake += performance.now() - t;
    while (retry.length) { await until(() => idle.length > 0); dispatch(retry.shift()); }
    await until(() => idle.length > 0);
    dispatch({ seq: seq++, b1: b1.buffer, b2: b2 ? b2.buffer : null });
  }
  while (retry.length || inflight) {
    if (retry.length) { await until(() => idle.length > 0); dispatch(retry.shift()); }
    else await until(() => inflight === 0 || retry.length > 0);
  }
  await draining; check();
  const files = [];
  for (const s of sinks) files.push(await s.close());
  post('done', { mode, total, affected, elapsedMs: performance.now() - t0, bytesFetched: bytesFetched(), files, paired: !!r2, phases: phases() });
}

self.onerror = (e) => post('error', { msg: 'uncaught in worker: ' + (e.message || e) });
self.onunhandledrejection = (e) => post('error', { msg: 'unhandled rejection in worker: ' + (e.reason && e.reason.message || e.reason) });
self.onmessage = async (e) => {
  const msg = e.data;
  try {
    await ready;
    if (msg.type === 'mount') post('mounted', await mountIndex(msg));
    else if (msg.type === 'run') await run(msg);
  } catch (err) {
    post('error', { msg: String((err && err.message) || err) });
  }
};
