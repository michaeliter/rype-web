// Coordinator worker: reads one or two FASTQ files as a stream (gunzip in
// wasm), cuts them into batches, and hands each batch to one of N classifier
// workers (classifier.js), each holding its own wasm instance and mount of the
// index. Results are written to browser disk storage (OPFS) in input order.
// This worker's own wasm instance is only used for gunzip.
importScripts('rype_mask.js', 'fsutil.js');

let M = null;
const post = (type, data = {}) => self.postMessage({ type, ...data });
const ready = createRypeMask({ print: () => {}, printErr: (s) => post('log', { msg: s }) }).then((m) => { M = m; });

// ---------------------------------------------------------------- classifier pool
let pool = [], lastMount = null; // lastMount: to bring the classifiers back after a two-pass run released them

// A URL index is downloaded once into browser storage (fsutil cacheRemote) and then
// mounted as local files: rype streams its whole index once per batch, so range
// requests would refetch it for every batch of every run. Progress is posted as 'download'.
async function cachedRyxdi(base, what) {
  if (!base.endsWith('/')) base += '/';
  const r = await fetch(base + 'manifest.toml'); if (!r.ok) throw new Error(`${r.status} fetching manifest.toml`);
  const manifest = await r.text();
  const shards = [...manifest.matchAll(/^shard_id\s*=\s*(\d+)/gm)].map((m) => `inverted/shard.${m[1]}.parquet`);
  if (!shards.length) throw new Error('manifest.toml lists no shards');
  const paths = ['buckets.parquet', ...shards];
  const sizes = await Promise.all(paths.map((p) => remoteInfo(base + p).then((i) => i.size)));
  const total = sizes.reduce((a, b) => a + b, 0);
  const files = []; let before = 0;
  for (let i = 0; i < paths.length; i++) {
    files.push(await cacheRemote(base + paths[i], (done) => post('download', { what, done: before + done, total })));
    before += sizes[i];
  }
  return { files: [new File([manifest], 'manifest.toml'), ...files], paths: ['manifest.toml', ...paths] };
}

// Spawn N classifiers and mount the index in each. Local File objects (picked or
// cached) clone cheaply across postMessage.
async function mountIndex(msg) {
  for (const w of pool) w.terminate();
  if (msg.source === 'url' && msg.cache !== false) msg = { ...msg, source: 'local', cached: true, ...(await cachedRyxdi(msg.base, 'index')) }; // cache: false streams by range instead
  lastMount = msg;
  const n = Math.max(1, msg.workers | 0);
  pool = Array.from({ length: n }, () => new Worker('classifier.js?v=' + Date.now()));
  const infos = await Promise.all(pool.map((w) => new Promise((resolve, reject) => {
    w.onmessage = (e) => { const d = e.data; if (d.type === 'mounted') resolve(d); else if (d.type === 'error') reject(new Error(d.msg)); else if (d.type === 'log') post('log', d); };
    w.onerror = (e) => reject(new Error('classifier failed to start: ' + (e.message || e)));
    w.postMessage(w === pool[pool.length - 1] ? msg : { ...msg, simulateFail: null }); // the test hook fails one worker only (the first to be dispatched)
  })));
  return { ...infos[0], workers: n, cached: !!msg.cached, cacheBytes: await cacheUsage() };
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
      const op = u32At(M, outs), ol = u32At(M, outs + 4);
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
    this.chunks = []; this.len = 0; this.lines = 0; this.eof = false; this.bytesIn = 0;
    // bytesIn counts file bytes before any gunzip, so progress is a fraction of file.size for gz input too.
    let s = file.stream().pipeThrough(new TransformStream({ transform: (chunk, c) => { this.bytesIn += chunk.length; c.enqueue(chunk); } }));
    if (/\.gz$/i.test(file.name)) s = s.pipeThrough(gunzipStream());
    this.reader = s.getReader();
  }
  push(c) { this.chunks.push(c); this.len += c.length; for (let i = 0; i < c.length; i++) if (c[i] === 10) this.lines++; }
  async pull() {
    const t = performance.now();
    const { value, done } = await this.reader.read();
    RecordReader.tPull += performance.now() - t;
    if (done) { this.eof = true; const last = this.chunks[this.chunks.length - 1]; if (this.len && last[last.length - 1] !== 10) this.push(new Uint8Array([10])); return; }
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
// Parallel gzip for final outputs: each batch is compressed by one of a few gzip workers
// and the members are appended in input order (concatenated gzip members are one valid
// gzip file; our own reader and every common tool accept that). A single CompressionStream
// on this thread dominated the run: 257 s of 299 s on 1M long reads.
const GZIP_WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
class GzipPool {
  constructor(n) { this.idle = []; this.waiters = []; this.all = Array.from({ length: n }, () => new Worker('gzip_worker.js?v=' + Date.now())); this.idle.push(...this.all); }
  async compress(u8) { // transfers u8's buffer; resolves to the gzip member
    while (!this.idle.length) await new Promise((r) => this.waiters.push(r));
    const w = this.idle.pop();
    return new Promise((resolve, reject) => {
      const free = () => { this.idle.push(w); const f = this.waiters.shift(); if (f) f(); };
      w.onmessage = (e) => { free(); e.data.error ? reject(new Error('gzip: ' + e.data.error)) : resolve(new Uint8Array(e.data.buf)); };
      w.onerror = (e) => reject(new Error('gzip worker crashed: ' + (e.message || e)));
      w.postMessage({ buf: u8.buffer, off: u8.byteOffset, len: u8.length }, [u8.buffer]);
    });
  }
  close() { for (const w of this.all) w.terminate(); }
}
let gzPool = null; // shared by a run's gzip sinks, closed when the run ends
const gzipPool = () => gzPool || (gzPool = new GzipPool(GZIP_WORKERS));

// Streams bytes to OPFS (disk-backed, unbounded) with in-memory fallback; gzip optional.
class Sink {
  constructor(name, gzip, storeAs) { this.name = name; this.gzip = gzip; this.storeAs = storeAs || name; this.parts = []; this.pos = 0; this.commits = []; this.tail = Promise.resolve(); }
  async open(dir) {
    if (dir) { this.handle = await dir.getFileHandle(this.storeAs, { create: true }); this.access = await this.handle.createSyncAccessHandle(); }
    if (this.gzip) this.pool = gzipPool();
  }
  raw(u8) { if (this.access) { this.access.write(u8, { at: this.pos }); this.pos += u8.length; } else this.parts.push(u8); }
  async write(u8) {
    if (!u8.length) return;
    if (!this.pool) return this.raw(u8);
    // Compress now, commit in order behind the earlier batches; at most one batch per gzip
    // worker is in flight, so memory stays bounded and a failure surfaces at the next write.
    const member = this.pool.compress(u8);
    this.tail = this.tail.then(async () => this.raw(await member)); this.tail.catch(() => {}); // awaited below and in close()
    this.commits.push(this.tail);
    if (this.commits.length >= GZIP_WORKERS) await this.commits.shift();
  }
  async close() {
    await this.tail;
    if (this.access) { this.access.flush(); this.access.close(); const f = await this.handle.getFile(); return this.storeAs === this.name ? f : new File([f], this.name); }
    return new File(this.parts, this.name);
  }
}
// Intermediate output between passes: one file per batch, so the pass that reads it
// can delete each part as soon as it has been consumed. (A whole-file intermediate
// kept two full copies of the sample on disk while a sweep ran: the one being read
// and the one being written.) The files are written and removed by spool_worker.js,
// because storage promises do not get serviced in this worker while a run saturates
// it (see that file); here a part is just a File. Without OPFS the parts stay in
// memory and are dropped the same way. Quacks like a File for RecordReader.
class SpoolIO {
  constructor(dir) {
    this.w = new Worker('spool_worker.js?v=' + Date.now()); this.seq = 0; this.pending = new Map();
    this.w.onmessage = (e) => { const d = e.data, p = this.pending.get(d.seq); if (!p) return; this.pending.delete(d.seq); d.type === 'error' ? p.reject(new Error('spool: ' + d.msg)) : p.resolve(d.file); };
    this.w.onerror = (e) => { for (const p of this.pending.values()) p.reject(new Error('spool worker crashed: ' + (e.message || e))); this.pending.clear(); };
    this.w.postMessage({ type: 'open', dir });
  }
  write(name, u8) { // transfers u8's buffer; resolves to the written part as a File
    const seq = this.seq++;
    return new Promise((resolve, reject) => { this.pending.set(seq, { resolve, reject }); this.w.postMessage({ type: 'write', seq, name, buf: u8.buffer, off: u8.byteOffset, len: u8.length }, [u8.buffer]); });
  }
  remove(name) { this.w.postMessage({ type: 'remove', name }); }
  close() { this.w.terminate(); }
}
class Spool {
  constructor(io, name) { this.io = io === true ? null : io; this.name = name; this.parts = []; this.size = 0; }
  async open() {}
  async write(u8) {
    if (!u8.length) return;
    this.size += u8.length;
    this.parts.push(this.io ? await this.io.write(`${this.name}.${this.parts.length}`, u8) : u8);
  }
  async close() { return this; }
  stream() { // the parts in order; each is dropped once fully read
    const { io, parts, name } = this; let i = 0, rd = null;
    return new ReadableStream({
      pull: async (ctrl) => {
        for (;;) {
          if (!rd) {
            if (i >= parts.length) return ctrl.close();
            const p = parts[i]; parts[i] = null;
            if (!io) { i++; return ctrl.enqueue(p); }
            rd = p.stream().getReader();
          }
          const { value, done } = await rd.read();
          if (!done) return ctrl.enqueue(value);
          rd = null; io.remove(`${name}.${i++}`);
        }
      },
    });
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
// Pass 1: rype over the classifier pool. Writes `names` into `dir`; returns the files and stats.
async function rypePass({ mode, r1, r2, threshold, batchBytes, gzipOut, dir, names, spool, t0, stage, step, steps }) {
  const in1 = new RecordReader(r1), in2 = r2 ? new RecordReader(r2) : null;
  const sinks = names.map((n) => spool ? new Spool(spool, n) : new Sink(n, gzipOut));
  for (const s of sinks) await s.open(dir);
  if (mode === 'classify') await sinks[0].write(new TextEncoder().encode('read_id\tbucket_name\tscore\n'));

  let total = 0, affected = 0, tClassify = 0, tTake = 0, tWrite = 0, batches = 0;
  const hist = new Uint32Array(102), keptBins = []; // best-score histogram, and each survivor's bin in output order (see classifier.js)
  const fetched = new Map(); // classifier -> its cumulative index bytes fetched
  const bytesFetched = () => [...fetched.values()].reduce((a, b) => a + b, 0);
  const phases = () => ({ read: RecordReader.tPull, batch: tTake, classify: tClassify, write: tWrite, batches, workers: pool.length });
  // Progress is the file position of the last batch whose results are written (posOf), not
  // bytes read: the reader runs a batch ahead, so bytesIn hit 100% while work remained.
  const posOf = new Map(); let bytesDone = 0;
  const progress = () => post('progress', { stage, step, steps, total, affected, bytesDone, fileBytes: r1.size, bytesFetched: bytesFetched(), elapsedMs: performance.now() - t0, phases: phases() });

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
      const r = results.get(written); results.delete(written); bytesDone = posOf.get(written) ?? bytesDone; posOf.delete(written);
      const t = performance.now();
      total += r.total; affected += r.affected; tClassify += r.ms;
      if (r.hist) for (let i = 0; i < hist.length; i++) hist[i] += r.hist[i];
      if (r.keptBins) keptBins.push(r.keptBins);
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
    posOf.set(seq, in1.bytesIn - in1.len); // file bytes consumed through this batch (gz: compressed bytes read, less the uncompressed remainder, a bounded over-estimate)
    dispatch({ seq: seq++, b1: b1.buffer, b2: b2 ? b2.buffer : null });
  }
  while (retry.length || inflight) {
    if (retry.length) { await until(() => idle.length > 0); dispatch(retry.shift()); }
    else await until(() => inflight === 0 || retry.length > 0);
  }
  await draining; check();
  const files = [];
  for (const s of sinks) files.push(await s.close());
  const bins = new Uint8Array(total - affected); let o = 0; for (const b of keptBins) { bins.set(b, o); o += b.length; }
  return { files, total, affected, bytesFetched: bytesFetched(), phases: phases(), hist: mode === 'filter' ? Array.from(hist) : null, bins };
}


// ---------------------------------------------------------------- pass 2: minimap2 sweeps
// Keep the records whose hit byte is 0. Records are 4 lines; input is our own
// well-formed output, so counting newlines is enough.
function dropHits(buf, hits) {
  const out = new Uint8Array(buf.length); let o = 0, rec = 0, nl = 0, start = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10 && ++nl === 4) {
    if (!hits[rec]) { out.set(buf.subarray(start, i + 1), o); o += i + 1 - start; }
    rec++; nl = 0; start = i + 1;
  }
  if (rec !== hits.length) throw new Error(`internal: ${rec} records vs ${hits.length} hit flags`);
  return out.subarray(0, o);
}

// One sweep: every batch of `inputs` goes to every part worker of `group`;
// a pair is dropped if any part reports a mapped mate. Reading the next batch
// overlaps the workers' mapping of the current one.
// bins: one byte per input record (its report histogram bin); histMm[bin] is incremented
// for each record removed, and the survivors' bins come back in order for the next sweep.
async function mmSweep({ inputs, bins, histMm, mm, group, names, storeAs, gzipOut, spool, dir, batchBytes, t0, stage, step, steps, onStats, simulateFail }) {
  const tSweep0 = performance.now();
  group = [...group]; const dropped = []; // parts shed by a memory fallback; the caller sweeps them later
  let workers = [], failure = null; const waiters = []; const wake = () => { while (waiters.length) waiters.shift()(); };
  const results = new Map(); // worker -> result of the batch in flight
  const spawn = async () => {
    workers = group.map(() => new Worker('mm_worker.js?v=' + Date.now()));
    const infos = await Promise.all(workers.map((w, i) => new Promise((resolve, reject) => {
      w.onmessage = (e) => { const d = e.data; if (d.type === 'mounted') resolve(d); else if (d.type === 'error') reject(new Error(d.msg)); else if (d.type === 'log') post('log', d); };
      w.onerror = (e) => reject(new Error('minimap2 worker failed to start: ' + (e.message || e)));
      const part = mm.parts[group[i]], hook = i === workers.length - 1 ? simulateFail : null; // the test hook fails one worker only
      w.postMessage(mm.source === 'url' ? { type: 'mount', source: 'url', url: mm.url, part, chunkBytes: mm.chunkBytes, simulateFail: hook } : { type: 'mount', source: 'local', file: mm.file, part, simulateFail: hook });
    })));
    post('log', { msg: `${stage}: parts loaded, ${infos.map((i) => `${i.nSeq} seqs/${(i.heapBytes / 2 ** 30).toFixed(2)} GiB`).join(', ')}` });
    for (const w of workers) {
      w.onmessage = (e) => { const d = e.data; if (d.type === 'result') results.set(w, d); else if (d.type === 'error') failure = new Error(`${stage}: ${d.msg}`); else if (d.type === 'log') post('log', d); wake(); };
      w.onerror = (e) => { failure = new Error(`${stage}: minimap2 worker crashed: ` + (e.message || e)); wake(); };
    }
  };
  // Memory fallback: a part worker that traps, cannot grow its heap or crashes takes
  // the sweep down to half as many parts at a time. The shed parts are swept afterwards
  // over this sweep's output (filtering is idempotent, so records already screened by
  // them before the failure are merely screened twice). The batch in flight is resent.
  const shrink = async (e) => {
    const oom = /memory|abort|enlarge|crashed|unreachable|RuntimeError|OOM/i.test(String(e && e.message || e));
    if (!oom) throw e;
    if (group.length < 2) throw new Error(`minimap2 index part ${group[0] + 1} does not fit in a browser worker (4 GB of memory; ${e.message}). Use an index built with more, smaller parts.`);
    for (const w of workers) w.terminate();
    const keep = Math.floor(group.length / 2);
    dropped.unshift(...group.slice(keep)); group = group.slice(0, keep);
    post('warn', { msg: `A minimap2 part worker ran out of memory (${e.message}); continuing with ${keep} part${keep > 1 ? 's' : ''} at a time.` });
    failure = null; results.clear(); simulateFail = null; // the test hook fires once
  };
  const spawnOrShrink = async () => { for (;;) { try { await spawn(); return; } catch (e) { await shrink(e); } } };
  await spawnOrShrink();
  const until = async (cond) => { while (!cond()) { if (failure) throw failure; await new Promise((r) => waiters.push(r)); } if (failure) throw failure; };
  try {
    const in1 = new RecordReader(inputs[0]), in2 = inputs[1] ? new RecordReader(inputs[1]) : null;
    const sinks = names.map((n, i) => spool ? new Spool(spool, n) : new Sink(n, gzipOut, storeAs && storeAs[i]));
    for (const s of sinks) await s.open(dir);
    let total = 0, removed = 0, tMap = 0, tWrite = 0, batches = 0, seq = 0;
    const tLoad = performance.now() - tSweep0; let tRead = 0, tSend = 0, tWait = 0, tFilter = 0; // wall ms per phase of this sweep
    const wall = () => ({ load: tLoad, read: tRead, send: tSend, wait: tWait, filter: tFilter, write: tWrite, sweep: performance.now() - tSweep0 });
    const stats = () => onStats({ total, removed, tMap, tWrite, batches, bytesFetched: [...results.values()].reduce((a, r) => a + r.bytesFetched, 0), wall: wall() });
    const outBins = new Uint8Array(bins.length); let nOut = 0;
    const readBatch = async () => {
      const t = performance.now(); try { return await readBatch0(); } finally { tRead += performance.now() - t; }
    };
    const readBatch0 = async () => {
      await in1.fillBytes(batchBytes);
      let n = in1.complete();
      if (in2) { await in2.fillRecords(n); n = Math.min(n, in2.complete()); }
      if (n === 0) { if (in1.len || (in2 && in2.len)) throw new Error('truncated FASTQ record at end of intermediate file'); return null; }
      return { b1: in1.take(n), b2: in2 ? in2.take(n) : null, n };
    };
    const send = (batch) => { const t = performance.now(); results.clear(); for (const w of workers) w.postMessage({ type: 'hits', seq, b1: batch.b1.buffer, b2: batch.b2 ? batch.b2.buffer : null }); seq++; tSend += performance.now() - t; };
    const resend = (batch) => { results.clear(); for (const w of workers) w.postMessage({ type: 'hits', seq: seq - 1, b1: batch.b1.buffer, b2: batch.b2 ? batch.b2.buffer : null }); };
    const finish = async (batch) => {
      let t = performance.now();
      for (;;) {
        try { await until(() => results.size === workers.length); break; }
        catch (e) { await shrink(e); await spawnOrShrink(); resend(batch); }
      }
      tWait += performance.now() - t; t = performance.now();
      const any = new Uint8Array(batch.n); let ms = 0;
      for (const r of results.values()) { ms = Math.max(ms, r.ms); for (let i = 0; i < batch.n; i++) any[i] |= r.hits[i]; }
      tMap += ms;
      let kept = 0;
      if (total + batch.n > bins.length) throw new Error(`internal: ${total + batch.n} records in the minimap2 pass but ${bins.length} rype survivors`);
      for (let i = 0; i < batch.n; i++) { const b = bins[total + i]; if (any[i]) histMm[b]++; else { outBins[nOut++] = b; kept++; } }
      total += batch.n; removed += batch.n - kept;
      const o1 = dropHits(batch.b1, any), o2 = batch.b2 ? dropHits(batch.b2, any) : null;
      tFilter += performance.now() - t; t = performance.now();
      await sinks[0].write(o1);
      if (o2) await sinks[1].write(o2);
      tWrite += performance.now() - t; batches++;
      stats();
      post('progress', { stage, step, steps, total, affected: removed, recordsTotal: bins.length, bytesFetched: FsStats.bytesFetched, elapsedMs: performance.now() - t0 }); // recordsTotal: this sweep's input count is known exactly
    };
    let inflight = null;
    for (;;) {
      const next = await readBatch();
      if (inflight) await finish(inflight);
      if (!next) break;
      send(next); inflight = next;
    }
    const files = [];
    for (const s of sinks) files.push(await s.close());
    stats(); // final figures, also for a sweep that saw no batches
    return { files, total, removed, bins: outBins.subarray(0, nOut), swept: group, dropped };
  } finally {
    for (const w of workers) w.terminate();
  }
}

// ---------------------------------------------------------------- the run
async function run(msg) {
  const { mode, r1, r2, gzipOut, mmWorkers } = msg; let mm = msg.mm;
  const base = r1.name.replace(/\.(fastq|fq)(\.gz)?$/i, '').replace(/[._-]?R?1$/i, '');
  const ext = gzipOut ? '.gz' : '';
  const dir = await outputDir();
  const t0 = performance.now();
  const finalNames = mode === 'classify'
    ? [`${base}.classified.tsv${ext}`]
    : [`${base}.masked${r2 ? '.R1' : ''}.fastq${ext}`, ...(r2 ? [`${base}.masked.R2.fastq${ext}`] : [])];
  const twoPass = mode === 'filter' && mm && mm.parts.length;
  const io = twoPass && dir ? new SpoolIO(dir) : null; // intermediates; without OPFS the parts stay in memory
  const spoolOf = (yes) => yes ? (io || true) : null;
  const midNames = (tag) => [`${base}.${tag}${r2 ? '.R1' : ''}.fastq`, ...(r2 ? [`${base}.${tag}.R2.fastq`] : [])];
  // Pass 2 sweeps `conc` parts at a time; each sweep is one progress step, as is pass 1.
  let conc = twoPass ? Math.max(1, Math.min(mmWorkers | 0 || 1, mm.parts.length)) : 0;
  const regroup = (parts, n) => { const out = []; for (let i = 0; i < parts.length; i += n) out.push(parts.slice(i, i + n)); return out; };
  const groups = twoPass ? regroup(mm.parts.map((_, k) => k), conc) : [];
  let steps = 1 + groups.length;
  // A URL minimap2 index is downloaded into browser storage while pass 1 runs (network
  // and CPU overlap); the sweeps then read it as a local file.
  let mmReady = null;
  if (twoPass && mm.source === 'url' && lastMount?.cache !== false) { // a streamed rype index means a streamed minimap2 index too
    mmReady = cacheRemote(mm.url, (done, total) => post('download', { what: 'minimap2', done, total })).then((file) => ({ ...mm, source: 'local', file }));
    mmReady.catch(() => {}); // reported where it is awaited; do not also surface as unhandled
  }
  if (!pool.length) await mountIndex(lastMount); // released at the end of the previous two-pass run
  const tRun0 = performance.now(), walls = {};
  const pass1 = await rypePass({ ...msg, dir, t0, stage: 'rype', step: 1, steps, names: twoPass ? midNames('rype') : finalNames, spool: spoolOf(twoPass), gzipOut: twoPass ? false : gzipOut });
  if (!twoPass) {
    if (gzPool) { gzPool.close(); gzPool = null; }
    post('done', { mode, total: pass1.total, affected: pass1.affected, elapsedMs: performance.now() - t0, bytesFetched: pass1.bytesFetched, files: pass1.files, paired: !!r2, phases: pass1.phases, hist: pass1.hist, threshold: msg.threshold });
    return;
  }
  // The classifiers (~1.8 GB each) are not needed again this run: release them so the
  // sweeps' part workers (~2.7 GB each) do not sit on top of them. Next run remounts.
  for (const w of pool) w.terminate(); pool = [];
  walls.pass1 = performance.now() - tRun0; let t = performance.now();
  if (mmReady) mm = await mmReady;
  walls.mmDownloadWait = performance.now() - t;
  // Pass 2: minimap2 over the T2T parts, `mmWorkers` parts at a time; each
  // sweep reads the previous sweep's survivors, so the data shrinks as it goes.
  let inputs = pass1.files, bins = pass1.bins, mmRemoved = 0, mmStats = { tMap: 0, tWrite: 0, batches: 0, bytesFetched: 0 };
  const histMm = new Uint32Array(102); // per report bin, records minimap2 removed
  let retries = 0; // a final sweep re-run after a memory fallback reads the previous final output, so it is stored under another name
  for (let g = 0; g < groups.length; g++) {
    const last = g === groups.length - 1;
    const stage = `minimap2 parts ${groups[g].map((k) => k + 1).join(',')} of ${mm.parts.length}`;
    const sweepStats = {};
    const res = await mmSweep({ inputs, bins, histMm, mm, group: groups[g], names: last ? finalNames : midNames(`mm${g}`), gzipOut: last && gzipOut, spool: spoolOf(!last), dir, batchBytes: msg.batchBytes, t0, stage, step: g + 2, steps, onStats: (s) => Object.assign(sweepStats, s), simulateFail: g === 0 ? msg.mmSimulateFail : null, storeAs: last && retries ? finalNames.map((n) => `${n}.retry${retries}`) : null });
    mmRemoved += res.removed; mmStats.tMap += sweepStats.tMap || 0; mmStats.tWrite += sweepStats.tWrite || 0; mmStats.batches += sweepStats.batches || 0; mmStats.bytesFetched += sweepStats.bytesFetched || 0;
    inputs = res.files; bins = res.bins; // the sweep removed its input parts as it read them
    if (res.dropped.length) { // memory fallback: the shed parts and the rest go on at the reduced width
      conc = res.swept.length; mmStats.fallbacks = (mmStats.fallbacks || 0) + 1; if (last) retries++;
      groups.splice(g + 1, groups.length, ...regroup([...res.dropped, ...groups.slice(g + 1).flat()], conc)); steps = 1 + groups.length;
    }
    walls[`sweep${g + 1}`] = sweepStats.wall; // per-phase wall ms inside this sweep
    post('log', { msg: `${stage}: ${JSON.stringify(Object.fromEntries(Object.entries(sweepStats.wall).map(([k, v]) => [k, Math.round(v / 1000)])))} s` });
  }
  walls.total = performance.now() - tRun0;
  if (io) io.close();
  if (gzPool) { gzPool.close(); gzPool = null; }
  post('done', { mode, total: pass1.total, affected: pass1.affected + mmRemoved, rypeRemoved: pass1.affected, mmRemoved, elapsedMs: performance.now() - t0,
    bytesFetched: pass1.bytesFetched + mmStats.bytesFetched, files: inputs, paired: !!r2, hist: pass1.hist, histMm: Array.from(histMm), threshold: msg.threshold,
    phases: { ...pass1.phases, mm: { ...mmStats, parts: mm.parts.length, concurrency: conc, walls } } });
}

self.onerror = (e) => post('error', { msg: 'uncaught in worker: ' + (e.message || e) });
self.onunhandledrejection = (e) => post('error', { msg: 'unhandled rejection in worker: ' + (e.reason && e.reason.message || e.reason) });
self.onmessage = async (e) => {
  const msg = e.data;
  try {
    await ready;
    if (msg.type === 'mount') post('mounted', await mountIndex(msg));
    else if (msg.type === 'run') await run(msg);
    else if (msg.type === 'clearCache') { for (const w of pool) w.terminate(); pool = []; await cacheClear(); post('cacheCleared'); }
  } catch (err) {
    post('error', { msg: String((err && err.message) || err) });
  }
};
