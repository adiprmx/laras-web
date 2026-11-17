// Server spike S6 — dua origin:
//  - http://127.0.0.1:4180 = origin app spike (halaman + Service Worker)
//  - http://127.0.0.1:4181 = origin media tiruan googlevideo (TANPA header CORS,
//    mendukung Range) — mereproduksi kondisi googlevideo secara setia.
// Dijalankan: node tests/spikes/s6-server.mjs
import http from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(DIR, 'media');

const MIME = { '.wav': 'audio/wav', '.webm': 'audio/webm', '.mp4': 'audio/mp4', '.js': 'text/javascript', '.html': 'text/html' };
const mimeOf = (p) => MIME[p.slice(p.lastIndexOf('.'))] ?? 'application/octet-stream';

// Origin app: halaman + SW + probe statis.
const appServer = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  const file = path === '/' ? 's6-page.html' : path.slice(1);
  const full = join(DIR, file);
  if (!existsSync(full) || !full.startsWith(DIR)) { res.writeHead(404); res.end('tidak ada'); return; }
  const body = readFileSync(full);
  res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
});

// Origin media: tanpa CORS, dukung Range (GET penuh dan Range).
const mediaServer = http.createServer((req, res) => {
  const file = req.url.split('?')[0].slice(1);
  const full = join(MEDIA, file);
  if (!existsSync(full) || !full.startsWith(MEDIA)) { res.writeHead(404); res.end('tidak ada'); return; }
  const size = statSync(full).size;
  const range = req.headers.range;
  const headers = { 'Content-Type': mimeOf(file), 'Accept-Ranges': 'bytes' }; // sengaja tanpa ACAO
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size || end >= size || start > end) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    const buf = readFileSync(full).subarray(start, end + 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': buf.length });
    res.end(buf);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    res.end(readFileSync(full));
  }
});

appServer.listen(4180, '127.0.0.1', () => console.log('origin app spike: http://127.0.0.1:4180/'));
mediaServer.listen(4181, '127.0.0.1', () => console.log('origin media spike: http://127.0.0.1:4181/ (tanpa CORS)'));
