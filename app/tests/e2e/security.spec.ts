/**
 * Tes E2E keamanan Blue 1 (Red 1 H1/S2/R2).
 *
 * Spesifikasi ini menyajikan `dist/` sendiri lewat server statis
 * kecil (port acak per worker) yang menerapkan header dari
 * `app/public/_headers` ASLI (di-parse dari file, bukan disalin)
 * — membuktikan gerbang H1 (rute uji jatuh ke beranda, /spike
 * tetap jalan) dan CSP (header hadir, solver + pemutar + spike
 * tetap jalan) pada artefak yang sama dengan yang di-deploy.
 * Membutuhkan `npm run build` dulu (job e2e CI membangun sebelum
 * tes; lokal: build sekali sebelum menjalankan spesifikasi ini).
 *
 * Jaringan luar di-mock (pola p4-helpers): tidak ada resolve live
 * di sini (LOGIN_REQUIRED dari IP VM, terbukti §5). Pemutar diuji
 * lewat jalur stream dari hasil pencarian (bukan /player-test,
 * yang tidak ada di build produksi sejak H1).
 */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { mockP4Network } from './p4-helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, '..', '..');
const DIST = path.join(APP_ROOT, 'dist');
const HEADERS_FILE = path.join(APP_ROOT, 'public', '_headers');

/** Parse public/_headers: aturan `/*` -> map nama header (lowercase) -> nilai. */
function parseHeadersFile(): Map<string, string> {
  const text = readFileSync(HEADERS_FILE, 'utf8');
  const headers = new Map<string, string>();
  let inCatchAll = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('/')) {
      inCatchAll = line === '/*';
      continue;
    }
    if (!inCatchAll) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return headers;
}

const CSP_HEADERS = parseHeadersFile();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Server statis dist/ + header _headers (meniru Cloudflare Pages).
 * SPA fallback: path yang bukan file -> index.html.
 */
function startDistServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        // Segmen persen rusak (uji R2) membuat decodeURIComponent
        // melempar — pakai path mentah, yang jatuh ke index.html.
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          pathname = url.pathname;
        }
        let filePath = path.join(DIST, pathname);
        // Direktori (mis. `/`) atau path di luar dist -> index.html.
        if (
          !filePath.startsWith(DIST) ||
          !existsSync(filePath) ||
          !statSync(filePath).isFile()
        ) {
          filePath = path.join(DIST, 'index.html');
        }
        const ext = path.extname(filePath);
        const body = readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          ...Object.fromEntries(CSP_HEADERS),
        });
        res.end(body);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end('server uji gagal');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server dist tidak mendapat port'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** Kumpulkan pelanggaran CSP dari console + pageerror selama uji. */
function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (
      msg.type() === 'error' &&
      /Content Security Policy|CSP|Refused to|violates/i.test(msg.text())
    ) {
      violations.push(msg.text());
    }
  });
  page.on('pageerror', (error) => {
    if (/Content Security Policy|CSP/i.test(error.message)) {
      violations.push(error.message);
    }
  });
  return violations;
}

test.describe('build produksi + CSP (server dist)', () => {
  let baseUrl: string;
  let server: Server;

  test.beforeAll(async () => {
    if (!existsSync(path.join(DIST, 'index.html'))) {
      throw new Error(
        'dist/ tidak ada — jalankan `npm run build` sebelum spesifikasi ini.',
      );
    }
    if (!CSP_HEADERS.has('content-security-policy')) {
      throw new Error('public/_headers tidak memuat Content-Security-Policy.');
    }
    ({ server, baseUrl } = await startDistServer());
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('header CSP + security hadir dan sama dengan _headers (S2)', async ({
    page,
  }) => {
    const response = await page.goto(baseUrl + '/');
    expect(response).not.toBeNull();
    const headers = response!.headers();
    expect(headers['content-security-policy']).toBe(
      CSP_HEADERS.get('content-security-policy'),
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    // CSP melarang 'unsafe-eval' penuh; WASM diizinkan lewat
    // 'wasm-unsafe-eval' (arsitektur §6). toContain di bawah
    // sengaja memakai kutip penuh: 'wasm-unsafe-eval' tidak
    // mengandung substring 'unsafe-eval' berkutip.
    expect(headers['content-security-policy']).toContain('wasm-unsafe-eval');
    expect(headers['content-security-policy']).not.toContain("'unsafe-eval'");
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('rute uji jatuh ke beranda, chunk TestPage tidak dimuat (H1)', async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    for (const route of ['/library-test', '/player-test', '/p4-test']) {
      await page.goto(baseUrl + route);
      await expect(page.getByTestId('home-page')).toBeVisible();
    }
    await expect(page.getByTestId('library-test-seed-1000')).toHaveCount(0);
    await expect(page.getByTestId('player-test-play')).toHaveCount(0);
    await expect(page.getByTestId('p4-test-seed')).toHaveCount(0);
    expect(requested.filter((u) => u.includes('TestPage'))).toEqual([]);
  });

  test('/spike tetap jalan di build produksi (pengecualian H1)', async ({
    page,
  }) => {
    const violations = collectCspViolations(page);
    await page.goto(baseUrl + '/spike');
    await expect(
      page.getByRole('heading', { name: 'Uji putar lima lagu' }),
    ).toBeVisible();
    await expect(page.getByTestId('spike-mode-cepat')).toBeVisible();
    // Mulai lalu hentikan: halaman berfungsi penuh di bawah CSP
    // tanpa menunggu resolve live (gagal jaringan dari VM).
    await page.getByTestId('spike-mode-cepat').click();
    await expect(page.getByTestId('spike-stop')).toBeVisible();
    await page.getByTestId('spike-stop').click();
    await expect(page.getByTestId('spike-summary')).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('URL browse rusak tidak mem-blank app (R2)', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto(baseUrl + '/browse/%E0%A4%A');
    await expect(page.getByTestId('home-page')).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('WebAssembly tetap bisa dikompilasi di bawah CSP (solver)', async ({
    page,
  }) => {
    const violations = collectCspViolations(page);
    await page.goto(baseUrl + '/');
    // Modul WASM minimal (magic + versi, tanpa section): bila CSP
    // memblokir kompilasi WASM, compile melempar — dan QuickJS-WASM
    // solver tidak akan pernah jalan.
    const ok = await page.evaluate(async () => {
      try {
        const mod = await WebAssembly.compile(
          new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
        );
        return mod instanceof WebAssembly.Module;
      } catch {
        return false;
      }
    });
    expect(ok).toBe(true);
    // Worker solver same-origin yang asli (nama chunk dicari di
    // dist, bukan di-hardcode — hash berubah tiap build) bisa
    // dibuat di bawah CSP (worker-src 'self').
    const workerFile = readdirSync(path.join(DIST, 'assets')).find((f) =>
      /^solverWorker-.*\.js$/.test(f),
    );
    expect(workerFile).toBeDefined();
    const workerOk = await page.evaluate(async (url) => {
      return new Promise<boolean>((resolvePromise) => {
        let done = false;
        const finish = (v: boolean): void => {
          if (!done) {
            done = true;
            resolvePromise(v);
          }
        };
        try {
          const w = new Worker(url, { type: 'module' });
          w.addEventListener('error', () => {
            w.terminate();
            finish(false);
          });
          setTimeout(() => {
            w.terminate();
            finish(true);
          }, 1000);
        } catch {
          finish(false);
        }
      });
    }, `/assets/${workerFile!}`);
    expect(workerOk).toBe(true);
    expect(violations).toEqual([]);
  });

  test('pemutar tetap berputar di bawah CSP (jalur stream, mock)', async ({
    page,
  }) => {
    const violations = collectCspViolations(page);
    await mockP4Network(page.context());
    await page.goto(baseUrl + '/search?q=noah');
    await page.getByTestId('search-song-hhn-nGSuenM').click();
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const hook = (
            window as unknown as {
              __larasPlayer?: { getState: () => { status: string } };
            }
          ).__larasPlayer;
          return hook?.getState().status ?? null;
        }),
      )
      .toBe('playing');
    expect(violations).toEqual([]);
  });
});
