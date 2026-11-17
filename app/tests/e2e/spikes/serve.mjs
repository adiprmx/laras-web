// Server statis origin spike S3/S5/S9 (bukan bagian aplikasi).
//
// Melayani:
// - app/public/ di root: /manifest.webmanifest, /sw.js, /icons/*
//   (aset PWA ASLI aplikasi, untuk uji S9)
// - tests/e2e/spikes/fixtures/ di /spikes/: halaman harness + nada WAV
//
// Mendukung header Range (206) untuk file media. Tanpa CORS header
// (sengaja: uji S5 butuh respons lintas origin tanpa ACAO).
//
// Port default 5229 (hindari bentrok dengan preview 4173 / dev 5173 /
// vite spike S1 di 5199).
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '../../..');
const PUBLIC_DIR = resolve(here, '../../../public');
const FIXTURES_DIR = resolve(here, 'fixtures');
const PORT = Number(process.env.SPIKE_PORT ?? 5229);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
};

function resolveFile(pathname) {
  if (pathname.startsWith('/spikes/')) {
    const rel = pathname.slice('/spikes/'.length);
    const full = join(FIXTURES_DIR, rel);
    return full.startsWith(FIXTURES_DIR) ? full : null;
  }
  // '/' dan '/index.html': di produksi dilayani dari hasil build. Server
  // spike melayani index.html sumber agar precache SW P0 (yang memuat
  // '/' dan '/index.html') tidak gagal total karena 404.
  if (pathname === '/' || pathname === '/index.html') {
    return join(APP_DIR, 'index.html');
  }
  const full = join(PUBLIC_DIR, pathname);
  return full.startsWith(PUBLIC_DIR) ? full : null;
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const file = resolveFile(decodeURIComponent(url.pathname));
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('tidak ditemukan');
      return;
    }
    const size = statSync(file).size;
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        if (start < size && start <= end) {
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
          });
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('gagal server');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`server spike jalan di http://localhost:${PORT}`);
});
