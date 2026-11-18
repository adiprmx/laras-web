/**
 * Tes konsistensi Service Worker (`public/sw.js`) dengan modul
 * unduhan. SW adalah file statis yang tidak bisa mengimpor
 * konstanta TypeScript, jadi nama cache diduplikasi di sana;
 * tes ini memaksa kedua salinan tetap sama.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeSwVersion } from './swVersion';
import {
  DOWNLOADS_CACHE_NAME,
  RUNTIME_CACHE_NAME,
} from './constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.join(HERE, '..', '..', 'public', 'sw.js');

function readSw(): string {
  return readFileSync(SW_PATH, 'utf8');
}

describe('public/sw.js', () => {
  it('memakai placeholder versi build (diganti plugin Vite)', () => {
    const sw = readSw();
    expect(sw).toContain('__LARAS_SW_VERSION__');
    expect(sw).toContain('laras-shell-${SW_VERSION}');
    // Tidak ada lagi versi manual hardcode.
    expect(sw).not.toContain('laras-shell-v2');
  });

  it('nama cache sama dengan konstanta TypeScript', () => {
    const sw = readSw();
    expect(sw).toContain(`'${DOWNLOADS_CACHE_NAME}'`);
    expect(sw).toContain(`'${RUNTIME_CACHE_NAME}'`);
  });

  it('aktivasi melindungi cache unduhan (K9)', () => {
    const sw = readSw();
    expect(sw).toContain('function isProtectedCache');
    expect(sw).toContain('function isDeletableOnActivate');
    // Predikat lindung dipakai SEBELUM penghapusan di activate.
    expect(sw).toContain('keys.filter(isDeletableOnActivate)');
    expect(sw).toContain('if (isProtectedCache(cacheName)) return false;');
  });

  it('melayani /dl/ dari cache unduhan dengan potong Range', () => {
    const sw = readSw();
    expect(sw).toContain("url.pathname.startsWith('/dl/')");
    expect(sw).toContain('function serveDownload');
    expect(sw).toContain('status: 206');
    expect(sw).toContain('Content-Range');
    expect(sw).toContain('function parseRange');
  });

  it('navigasi tetap network-first (perbaikan Red 1 R3)', () => {
    const sw = readSw();
    expect(sw).toContain("request.mode === 'navigate'");
    expect(sw).toContain('caches.match(request)');
  });
});

describe('computeSwVersion', () => {
  it('format <versi>-<8 heksadesimal>', () => {
    const version = computeSwVersion('0.9.0', 'isi sw.js');
    expect(version).toMatch(/^0\.9\.0-[0-9a-f]{8}$/);
  });

  it('deterministik untuk isi yang sama, berubah bila isi berubah', () => {
    const a = computeSwVersion('0.9.0', 'isi sw.js');
    const b = computeSwVersion('0.9.0', 'isi sw.js');
    const c = computeSwVersion('0.9.0', 'isi sw.js berubah');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('berubah bila versi package naik', () => {
    expect(computeSwVersion('0.9.0', 'x')).not.toBe(
      computeSwVersion('0.9.1', 'x'),
    );
  });
});
