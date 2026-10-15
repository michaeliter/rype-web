// Writes and removes spool parts (one OPFS file per batch of an intermediate) for the
// coordinator. Storage promises starve in the coordinator itself: with 4 classifiers
// streaming 256 MB batches through it, createSyncAccessHandle() for a new part never
// resolved (measured on 20M pairs; the same code is fine on small inputs). Nothing else
// runs here, so the calls complete, and the coordinator only exchanges messages.
let dir = null, queue = Promise.resolve(); // messages are handled strictly in order
const handle = async (m) => {
  if (m.type === 'open') dir = m.dir;
  else if (m.type === 'write') {
    const fh = await dir.getFileHandle(m.name, { create: true });
    const a = await fh.createSyncAccessHandle();
    try { a.write(new Uint8Array(m.buf, m.off, m.len), { at: 0 }); a.flush(); } finally { a.close(); }
    self.postMessage({ type: 'written', seq: m.seq, file: await fh.getFile() });
  } else if (m.type === 'remove') await dir.removeEntry(m.name);
};
self.onmessage = (e) => { const m = e.data; queue = queue.then(() => handle(m)).catch((err) => self.postMessage({ type: 'error', seq: m.seq, msg: String((err && err.message) || err) })); };
