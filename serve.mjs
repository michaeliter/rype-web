// Static dev server with HTTP Range support and permissive CORS, so index shards
// can be fetched by byte range the way a real mirror would serve them.
//   node serve.mjs [port] [root]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const port = parseInt(process.argv[2] || '8765', 10);
const root = path.resolve(process.argv[3] || '.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.toml': 'text/plain', '.parquet': 'application/octet-stream', '.fq': 'text/plain', '.gz': 'application/gzip' };
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, cors); return res.end('not found'); }
  const size = fs.statSync(file).size;
  const head = { ...cors, 'Accept-Ranges': 'bytes', 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
