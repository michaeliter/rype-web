// Measures how much wasm memory this browser lets one instance grow to, by growing a
// throwaway Memory in 256 MB steps until the browser refuses. The answer sizes the batches
// (rype needs ~5.6 bytes of heap per input byte) and decides whether a minimap2 index part
// (~3 GiB loaded) can fit at all. Runs in its own worker so the pages are released when the
// page terminates it. Posts { bytes }.
const PAGE = 65536, STEP = 4096; // 256 MB
let mem = null;
for (const max of [65536, 32768, 16384]) { try { mem = new WebAssembly.Memory({ initial: 0, maximum: max }); break; } catch {} }
let pages = mem ? mem.buffer.byteLength / PAGE : 0;
if (mem) for (;;) { try { mem.grow(STEP); pages += STEP; } catch { break; } }
self.postMessage({ bytes: pages * PAGE });
