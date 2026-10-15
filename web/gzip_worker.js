// Compresses one buffer with CompressionStream('gzip') and sends it back, buffer
// transferred both ways (see GzipPool in worker.js).
self.onmessage = async (e) => {
  try {
    const { buf, off, len } = e.data;
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    const fed = w.write(new Uint8Array(buf, off, len)).then(() => w.close());
    const out = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    await fed;
    self.postMessage({ buf: out.buffer }, [out.buffer]);
  } catch (err) { self.postMessage({ error: String((err && err.message) || err) }); }
};
