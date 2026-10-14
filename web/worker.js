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
// Pass 1: rype over the classifier pool. Writes `names` into `dir`; returns the files and stats.
async function rypePass({ mode, r1, r2, threshold, batchBytes, gzipOut, dir, names, t0, stage, step, steps }) {
  const in1 = new RecordReader(r1), in2 = r2 ? new RecordReader(r2) : null;
  const sinks = names.map((n) => new Sink(n, gzipOut));
  for (const s of sinks) await s.open(dir);
  if (mode === 'classify') await sinks[0].write(new TextEncoder().encode('read_id\tbucket_name\tscore\n'));

  let total = 0, affected = 0, tClassify = 0, tTake = 0, tWrite = 0, batches = 0;
  const hist = new Uint32Array(102), keptBins = []; // best-score histogram, and each survivor's bin in output order (see classifier.js)
  const fetched = new Map(); // classifier -> its cumulative index bytes fetched
  const bytesFetched = () => [...fetched.values()].reduce((a, b) => a + b, 0);
  const phases = () => ({ read: RecordReader.tPull, batch: tTake, classify: tClassify, write: tWrite, batches, workers: pool.length });
  const progress = () => post('progress', { stage, step, steps, total, affected, bytesIn: in1.bytesIn, fileBytes: r1.size, bytesFetched: bytesFetched(), elapsedMs: performance.now() - t0, phases: phases() });

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
async function mmSweep({ inputs, bins, histMm, mm, group, names, gzipOut, dir, batchBytes, t0, stage, step, steps, onStats }) {
  const workers = group.map(() => new Worker('mm_worker.js?v=' + Date.now()));
  let failure = null; const waiters = []; const wake = () => { while (waiters.length) waiters.shift()(); };
  const results = new Map(); // worker -> result of the batch in flight
  const infos = await Promise.all(workers.map((w, i) => new Promise((resolve, reject) => {
    w.onmessage = (e) => { const d = e.data; if (d.type === 'mounted') resolve(d); else if (d.type === 'error') reject(new Error(d.msg)); else if (d.type === 'log') post('log', d); };
    w.onerror = (e) => reject(new Error('minimap2 worker failed to start: ' + (e.message || e)));
    const part = mm.parts[group[i]];
    w.postMessage(mm.source === 'url' ? { type: 'mount', source: 'url', url: mm.url, part, chunkBytes: mm.chunkBytes } : { type: 'mount', source: 'local', file: mm.file, part });
  })));
  post('log', { msg: `${stage}: parts loaded, ${infos.map((i) => `${i.nSeq} seqs/${(i.heapBytes / 2 ** 30).toFixed(2)} GiB`).join(', ')}` });
  for (const w of workers) {
    w.onmessage = (e) => { const d = e.data; if (d.type === 'result') results.set(w, d); else if (d.type === 'error') failure = new Error(`${stage}: ${d.msg}`); else if (d.type === 'log') post('log', d); wake(); };
    w.onerror = (e) => { failure = new Error(`${stage}: minimap2 worker crashed: ` + (e.message || e)); wake(); };
  }
  const until = async (cond) => { while (!cond()) { if (failure) throw failure; await new Promise((r) => waiters.push(r)); } if (failure) throw failure; };
  try {
    const in1 = new RecordReader(inputs[0]), in2 = inputs[1] ? new RecordReader(inputs[1]) : null;
    const sinks = names.map((n) => new Sink(n, gzipOut));
    for (const s of sinks) await s.open(dir);
    let total = 0, removed = 0, tMap = 0, tWrite = 0, batches = 0, seq = 0;
    const outBins = new Uint8Array(bins.length); let nOut = 0;
    const readBatch = async () => {
      await in1.fillBytes(batchBytes);
      let n = in1.complete();
      if (in2) { await in2.fillRecords(n); n = Math.min(n, in2.complete()); }
      if (n === 0) { if (in1.len || (in2 && in2.len)) throw new Error('truncated FASTQ record at end of intermediate file'); return null; }
      return { b1: in1.take(n), b2: in2 ? in2.take(n) : null, n };
    };
    const send = (batch) => { results.clear(); for (const w of workers) w.postMessage({ type: 'hits', seq, b1: batch.b1.buffer, b2: batch.b2 ? batch.b2.buffer : null }); seq++; };
    const finish = async (batch) => {
      await until(() => results.size === workers.length);
      const any = new Uint8Array(batch.n); let ms = 0;
      for (const r of results.values()) { ms = Math.max(ms, r.ms); for (let i = 0; i < batch.n; i++) any[i] |= r.hits[i]; }
      tMap += ms;
      const t = performance.now();
      let kept = 0;
      if (total + batch.n > bins.length) throw new Error(`internal: ${total + batch.n} records in the minimap2 pass but ${bins.length} rype survivors`);
      for (let i = 0; i < batch.n; i++) { const b = bins[total + i]; if (any[i]) histMm[b]++; else { outBins[nOut++] = b; kept++; } }
      total += batch.n; removed += batch.n - kept;
      await sinks[0].write(dropHits(batch.b1, any));
      if (batch.b2) await sinks[1].write(dropHits(batch.b2, any));
      tWrite += performance.now() - t; batches++;
      onStats({ total, removed, tMap, tWrite, batches, bytesFetched: [...results.values()].reduce((a, r) => a + r.bytesFetched, 0) });
      post('progress', { stage, step, steps, total, affected: removed, bytesIn: in1.bytesIn, fileBytes: inputs[0].size, bytesFetched: FsStats.bytesFetched, elapsedMs: performance.now() - t0 });
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
    return { files, total, removed, bins: outBins.subarray(0, nOut) };
  } finally {
    for (const w of workers) w.terminate();
  }
}

// ---------------------------------------------------------------- the run
async function run(msg) {
  const { mode, r1, r2, gzipOut, mm, mmWorkers } = msg;
  const base = r1.name.replace(/\.(fastq|fq)(\.gz)?$/i, '').replace(/[._-]?R?1$/i, '');
  const ext = gzipOut ? '.gz' : '';
  const dir = await outputDir();
  const t0 = performance.now();
  const finalNames = mode === 'classify'
    ? [`${base}.classified.tsv${ext}`]
    : [`${base}.masked${r2 ? '.R1' : ''}.fastq${ext}`, ...(r2 ? [`${base}.masked.R2.fastq${ext}`] : [])];
  const twoPass = mode === 'filter' && mm && mm.parts.length;
  const midNames = (tag) => [`${base}.${tag}${r2 ? '.R1' : ''}.fastq`, ...(r2 ? [`${base}.${tag}.R2.fastq`] : [])];
  // Pass 2 sweeps `conc` parts at a time; each sweep is one progress step, as is pass 1.
  const conc = twoPass ? Math.max(1, Math.min(mmWorkers | 0 || 1, mm.parts.length)) : 0;
  const groups = []; if (twoPass) for (let i = 0; i < mm.parts.length; i += conc) groups.push(mm.parts.map((_, k) => k).slice(i, i + conc));
  const steps = 1 + groups.length;
  const pass1 = await rypePass({ ...msg, dir, t0, stage: 'rype', step: 1, steps, names: twoPass ? midNames('rype') : finalNames, gzipOut: twoPass ? false : gzipOut });
  if (!twoPass) {
    post('done', { mode, total: pass1.total, affected: pass1.affected, elapsedMs: performance.now() - t0, bytesFetched: pass1.bytesFetched, files: pass1.files, paired: !!r2, phases: pass1.phases, hist: pass1.hist, threshold: msg.threshold });
    return;
  }
  // Pass 2: minimap2 over the T2T parts, `mmWorkers` parts at a time; each
  // sweep reads the previous sweep's survivors, so the data shrinks as it goes.
  let inputs = pass1.files, bins = pass1.bins, stale = [], mmRemoved = 0, mmStats = { tMap: 0, tWrite: 0, batches: 0, bytesFetched: 0 };
  const histMm = new Uint32Array(102); // per report bin, records minimap2 removed
  for (let g = 0; g < groups.length; g++) {
    const last = g === groups.length - 1;
    const stage = `minimap2 parts ${groups[g].map((k) => k + 1).join(',')} of ${mm.parts.length}`;
    const sweepStats = {};
    const res = await mmSweep({ inputs, bins, histMm, mm, group: groups[g], names: last ? finalNames : midNames(`mm${g}`), gzipOut: last && gzipOut, dir, batchBytes: msg.batchBytes, t0, stage, step: g + 2, steps, onStats: (s) => Object.assign(sweepStats, s) });
    mmRemoved += res.removed; mmStats.tMap += sweepStats.tMap || 0; mmStats.tWrite += sweepStats.tWrite || 0; mmStats.batches += sweepStats.batches || 0; mmStats.bytesFetched += sweepStats.bytesFetched || 0;
    for (const f of stale) { try { await dir.removeEntry(f.name); } catch {} }
    stale = inputs; inputs = res.files; bins = res.bins;
  }
  for (const f of stale) { try { await dir.removeEntry(f.name); } catch {} }
  post('done', { mode, total: pass1.total, affected: pass1.affected + mmRemoved, rypeRemoved: pass1.affected, mmRemoved, elapsedMs: performance.now() - t0,
    bytesFetched: pass1.bytesFetched + mmStats.bytesFetched, files: inputs, paired: !!r2, hist: pass1.hist, histMm: Array.from(histMm), threshold: msg.threshold,
    phases: { ...pass1.phases, mm: { ...mmStats, parts: mm.parts.length, concurrency: conc } } });
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
