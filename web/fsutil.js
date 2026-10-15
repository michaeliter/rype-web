// Shared by classifier.js and mm_worker.js (importScripts): index files are
// presented to WORKERFS as chunked, cached sources, and the WORKERFS read op is
// patched to copy straight out of the cache. rype makes ~80k reads per pass over
// a 1.7 GB shard, most under 4 KB, and the stock WORKERFS path (Blob.slice +
// FileReaderSync per read) costs a round trip to the browser process each: ~25 s
// per pass measured, for both local and URL sources. Fetching 8 MB chunks
// instead makes it ~220 round trips per pass.
const FsStats = { bytesFetched: 0 };

class ChunkedSource {
  // size/offset select a byte range of the underlying file (a multi-part
  // minimap2 index part is mounted as its own file this way).
  constructor(size, fetchRange, chunk = 8 << 20, keep = 4, offset = 0) { this.size = size; this.offset = offset; this.fetchRange = fetchRange; this.chunk = chunk; this.keep = keep; this.cache = new Map(); }
  chunkAt(i) {
    let c = this.cache.get(i);
    if (c) return c;
    c = this.fetchRange(this.offset + i * this.chunk, this.offset + Math.min(this.size, (i + 1) * this.chunk));
    this.cache.set(i, c);
    if (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value);
    return c;
  }
  readInto(buffer, offset, length, position) { // WORKERFS stream_ops.read contract
    const end = Math.min(this.size, position + length);
    for (let pos = position; pos < end;) {
      const i = Math.floor(pos / this.chunk), c = this.chunkAt(i);
      const off = pos - i * this.chunk, n = Math.min(c.length - off, end - pos);
      if (!(n > 0)) throw new Error(`index read stalled: position ${pos} of ${this.size} (offset ${this.offset}), chunk ${i} has ${c.length} bytes, need ${end - pos}`);
      buffer.set(c.subarray(off, off + n), offset + (pos - position));
      pos += n;
    }
    return Math.max(0, end - position);
  }
  slice(a, b) { const out = new Uint8Array(Math.max(0, Math.min(b, this.size) - a)); this.readInto(out, 0, out.length, a); return new Blob([out]); }
}
const localSource = (file, offset = 0, size = file.size) =>
  new ChunkedSource(size, (a, b) => new Uint8Array(new FileReaderSync().readAsArrayBuffer(file.slice(a, b))), 8 << 20, 4, offset);
function remoteSource(url, size, chunk = 8 << 20, offset = 0) {
  return new ChunkedSource(size, (a, b) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', `bytes=${a}-${b - 1}`);
    xhr.send();
    if (xhr.status !== 206) throw new Error(`range request failed (${xhr.status}) for ${url}`);
    const buf = new Uint8Array(xhr.response);
    FsStats.bytesFetched += buf.length;
    return buf;
  }, chunk, 4, offset);
}
// HEAD a URL and return its size, insisting on byte-range support.
async function remoteSize(url) {
  const head = await fetch(url, { method: 'HEAD' });
  const size = parseInt(head.headers.get('Content-Length') || '', 10);
  if (!head.ok || !(size > 0)) throw new Error(`cannot size ${url} (server must expose Content-Length)`);
  if (head.headers.get('Accept-Ranges') !== 'bytes') throw new Error(`${url}: server does not advertise byte ranges`);
  return size;
}
function patchWorkerfsRead(M) {
  if (M.WORKERFS.__patched) return;
  M.WORKERFS.__patched = true;
  const orig = M.WORKERFS.stream_ops.read;
  M.WORKERFS.stream_ops.read = (stream, buffer, offset, length, position) => {
    const c = stream.node.contents;
    return c instanceof ChunkedSource ? c.readInto(buffer, offset, length, position) : orig(stream, buffer, offset, length, position);
  };
}
// Mount blobs ([{name, data}], data a File/Blob or ChunkedSource) at /index, replacing any
// previous mount. Patches the read op first, which every mount needs.
function mountIndexFs(M, blobs) {
  patchWorkerfsRead(M);
  try { M.FS.unmount('/index'); } catch {}
  try { M.FS.mkdir('/index'); } catch {}
  M.FS.mount(M.WORKERFS, { blobs }, '/index');
  FsStats.bytesFetched = 0;
}
// Read a u32 at a wasm address. >>> not >>: a pointer above 2 GiB is negative under a
// signed shift and indexes nothing.
// ---------------------------------------------------------------- download-once cache (OPFS)
// A remote index file is fetched once into origin-private storage and served from there
// afterwards: rype streams its whole index once per batch and minimap2 its 9 GB per run, so
// on-demand ranges would cost a full download every time. Layout: rype-cache/<sha1(url)>/
// data + meta.json {url, size, tag, doneUpTo, done}. Chunks are fetched CACHE_PAR at a time
// and committed in order, so an interrupted download resumes from doneUpTo. Worker-only
// (createSyncAccessHandle).
const CACHE_DIR = 'rype-cache', CACHE_CHUNK = 32 << 20, CACHE_PAR = 4;
async function cacheKey(url) { const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(url)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function cacheRoot(create) { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(CACHE_DIR, { create }); }
async function readJson(dir, name) { try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); } catch { return null; } }
async function writeJson(dir, name, obj) { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(JSON.stringify(obj)); await w.close(); }
const fmtGB = (b) => (b / 1e9).toFixed(b < 1e9 ? 2 : 1) + ' GB';
// HEAD the URL: size, byte-range support and a change tag (ETag or Last-Modified).
async function remoteInfo(url) {
  const head = await fetch(url, { method: 'HEAD' });
  const size = parseInt(head.headers.get('Content-Length') || '', 10);
  if (!head.ok || !(size > 0)) throw new Error(`cannot size ${url} (server must expose Content-Length)`);
  if (head.headers.get('Accept-Ranges') !== 'bytes') throw new Error(`${url}: server does not advertise byte ranges`);
  return { size, tag: head.headers.get('ETag') || head.headers.get('Last-Modified') || '' };
}
// Return the cached File for url, downloading (or resuming) it first if needed.
// onProgress(doneBytes, totalBytes) is called as chunks commit.
async function cacheRemote(url, onProgress) {
  const { size, tag } = await remoteInfo(url);
  const dir = await (await cacheRoot(true)).getDirectoryHandle(await cacheKey(url), { create: true });
  let meta = await readJson(dir, 'meta.json');
  const same = meta && meta.size === size && meta.tag === tag;
  if (same && meta.done) { onProgress?.(size, size); return (await dir.getFileHandle('data')).getFile(); }
  let doneUpTo = same ? meta.doneUpTo || 0 : 0;
  const est = await navigator.storage.estimate();
  if (est.quota - est.usage < size - doneUpTo + (64 << 20)) throw new Error(`the index needs ${fmtGB(size - doneUpTo)} of browser storage and only ${fmtGB(Math.max(0, est.quota - est.usage))} is free; remove downloaded indexes or free disk space`);
  meta = { url, size, tag, doneUpTo, done: false }; await writeJson(dir, 'meta.json', meta);
  const fh = await dir.getFileHandle('data', { create: true });
  const ah = await fh.createSyncAccessHandle();
  try {
    ah.truncate(size);
    const inflight = new Map(), landed = new Set(); let next = doneUpTo, lastSaved = doneUpTo;
    const fetchChunk = async (off) => {
      const end = Math.min(size, off + CACHE_CHUNK);
      const r = await fetch(url, { headers: { Range: `bytes=${off}-${end - 1}` } });
      if (r.status !== 206) throw new Error(`range request failed (${r.status}) for ${url}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length !== end - off) throw new Error(`short range response for ${url}`);
      try { ah.write(buf, { at: off }); } catch (e) { throw new Error(/space/i.test(e.message) ? `browser storage ran out while downloading ${url}; free disk space or remove downloaded indexes` : e.message); }
      FsStats.bytesFetched += buf.length;
      return off;
    };
    onProgress?.(doneUpTo, size);
    while (doneUpTo < size) {
      while (next < size && inflight.size < CACHE_PAR) { inflight.set(next, fetchChunk(next)); next += CACHE_CHUNK; }
      const off = await Promise.race(inflight.values()); inflight.delete(off); landed.add(off);
      while (landed.delete(doneUpTo)) doneUpTo = Math.min(size, doneUpTo + CACHE_CHUNK);
      onProgress?.(doneUpTo, size);
      if (doneUpTo - lastSaved >= 256 << 20) { ah.flush(); await writeJson(dir, 'meta.json', { ...meta, doneUpTo }); lastSaved = doneUpTo; }
    }
    ah.flush();
  } finally { ah.close(); }
  await writeJson(dir, 'meta.json', { ...meta, doneUpTo: size, done: true });
  return fh.getFile();
}
// Bytes held by the cache (complete and partial downloads).
async function cacheUsage() {
  let bytes = 0;
  try { const root = await cacheRoot(false); for await (const [, h] of root) if (h.kind === 'directory') { const m = await readJson(h, 'meta.json'); if (m) bytes += m.done ? m.size : m.doneUpTo || 0; } } catch {}
  return bytes;
}
async function cacheClear() { try { const root = await navigator.storage.getDirectory(); await root.removeEntry(CACHE_DIR, { recursive: true }); } catch {} }

const u32At = (M, p) => M.HEAPU32[p >>> 2];
// Drive mm_part_hits on a loaded part: one byte per record of b1, 1 if any mate maps.
function partHits(M, b1, b2) {
  const outs = M._malloc(12);
  const p1 = M._malloc(b1.byteLength); M.HEAPU8.set(new Uint8Array(b1), p1);
  const p2 = b2 ? M._malloc(b2.byteLength) : 0; if (b2) M.HEAPU8.set(new Uint8Array(b2), p2);
  const rc = M.ccall('mm_part_hits', 'number', Array(7).fill('number'), [p1, b1.byteLength, p2, b2 ? b2.byteLength : 0, outs, outs + 4, outs + 8]);
  M._free(p1); if (p2) M._free(p2);
  if (rc !== 0) { M._free(outs); throw new Error(M.ccall('mm_last_error', 'string', [], [])); }
  const hp = u32At(M, outs), n = u32At(M, outs + 4), nh = u32At(M, outs + 8);
  const hits = M.HEAPU8.slice(hp, hp + n); M._mm_free(hp); M._free(outs);
  return { hits, n, nh };
}
if (typeof module !== 'undefined') module.exports = { FsStats, ChunkedSource, localSource, remoteSource, remoteSize, patchWorkerfsRead, mountIndexFs, u32At, partHits, cacheRemote, cacheUsage, cacheClear };
