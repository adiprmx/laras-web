/**
 * Penyimpanan file unduhan di Cache Storage (P5).
 *
 * Satu-satunya modul yang menyentuh cache `laras-downloads-v1`.
 * File unduhan disimpan sebagai respons cache dengan kunci URL
 * same-origin `/dl/<videoId>`; Service Worker melayani kunci itu
 * ke elemen audio (dengan potong Range) saat lagu diputar.
 *
 * Part unduhan (`/dl-part/<videoId>/<index>`) hidup di cache
 * yang sama supaya resume lintas restart tidak butuh store lain;
 * part dihapus saat file selesai dirakit atau saat unduhan
 * dibatalkan. Rekonsiliasi menghapus part yatim (tanpa job).
 *
 * Eviction runtime (`evictRuntimeCache`) bekerja HANYA pada
 * cache `laras-runtime-v1` + manifest `cache_entries`; ia tidak
 * pernah membuka cache unduhan (K9). Pemisahan ini ditegakkan
 * konstruksi (nama cache berbeda, fungsi berbeda) dan dibuktikan
 * tes (`downloadStore.test.ts` + E2E `downloads.spec.ts`).
 */

import {
  DOWNLOADS_CACHE_NAME,
  RUNTIME_CACHE_NAME,
  downloadPartUrl,
  downloadUrl,
  partFromDownloadPartPath,
  videoIdFromDownloadPath,
} from './constants';

/** Subset Cache Storage yang dipakai modul ini (bisa dipalsukan). */
export interface CacheLike {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
  keys(): Promise<Request[]>;
}

export interface CacheStorageLike {
  open(cacheName: string): Promise<CacheLike>;
  delete(cacheName: string): Promise<boolean>;
}

function defaultCaches(): CacheStorageLike {
  if (typeof caches === 'undefined') {
    throw new Error('Cache Storage tidak tersedia di browser ini');
  }
  return caches as unknown as CacheStorageLike;
}

/**
 * Tipe konten yang boleh disimpan/disajikan untuk unduhan (R8,
 * Red 2): audio/*, video/*, atau application/octet-stream. Tipe
 * lain (mis. text/html dari upstream yang lolos ke cache)
 * diganti application/octet-stream supaya navigasi ke /dl/<id>
 * tidak pernah me-render HTML same-origin (stored XSS lewat
 * cache unduhan). Cerminan `safeDownloadContentType` di
 * public/sw.js — SW tidak bisa mengimpor modul ini, jadi kedua
 * salinan harus tetap sama (tes downloadStore.test.ts +
 * sw.test.ts memaksanya).
 */
export function safeDownloadContentType(contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    type.startsWith('audio/') ||
    type.startsWith('video/') ||
    type === 'application/octet-stream'
  ) {
    return contentType;
  }
  return 'application/octet-stream';
}

/** Satu entri manifest cache runtime (dari store `cache_entries`). */
export interface RuntimeCacheEntry {
  key: string;
  sizeBytes: number;
  lastAccessed: number;
}

export class DownloadStore {
  private cachesRef: CacheStorageLike;
  private origin: string;

  constructor(opts: { caches?: CacheStorageLike; origin?: string } = {}) {
    this.cachesRef = opts.caches ?? defaultCaches();
    this.origin =
      opts.origin ??
      (typeof location !== 'undefined'
        ? location.origin
        : 'http://localhost');
  }

  private downloadsCache(): Promise<CacheLike> {
    return this.cachesRef.open(DOWNLOADS_CACHE_NAME);
  }

  private runtimeCache(): Promise<CacheLike> {
    return this.cachesRef.open(RUNTIME_CACHE_NAME);
  }

  private absolute(path: string): string {
    return `${this.origin}${path}`;
  }

  /** Apakah file unduhan lagu ini ada di cache. */
  async hasDownload(videoId: string): Promise<boolean> {
    const cache = await this.downloadsCache();
    const found = await cache.match(this.absolute(downloadUrl(videoId)));
    return found !== undefined;
  }

  /** Simpan file unduhan lengkap (dipanggil sesudah ukuran cocok). */
  async putDownload(
    videoId: string,
    blob: Blob,
    contentType: string,
  ): Promise<void> {
    const cache = await this.downloadsCache();
    // Pertahanan lapis kedua (R8, Red 2): tipe di luar audio/*,
    // video/*, application/octet-stream TIDAK PERNAH masuk cache
    // (diganti application/octet-stream) — lapis pertama ada di
    // Service Worker saat menyajikan (`public/sw.js`).
    const headers = new Headers({
      'Content-Type': safeDownloadContentType(contentType),
      'Content-Length': String(blob.size),
    });
    await cache.put(
      this.absolute(downloadUrl(videoId)),
      new Response(blob, { headers }),
    );
  }

  /** Baca file unduhan sebagai blob (dipakai rakitan/tes). */
  async getDownload(videoId: string): Promise<Blob | null> {
    const cache = await this.downloadsCache();
    const found = await cache.match(this.absolute(downloadUrl(videoId)));
    if (!found) return null;
    return found.blob();
  }

  /** Hapus file unduhan satu lagu. */
  async deleteDownload(videoId: string): Promise<boolean> {
    const cache = await this.downloadsCache();
    return cache.delete(this.absolute(downloadUrl(videoId)));
  }

  /** Semua videoId yang punya file unduhan di cache. */
  async listDownloads(): Promise<string[]> {
    const cache = await this.downloadsCache();
    const keys = await cache.keys();
    const ids: string[] = [];
    for (const request of keys) {
      const pathname = new URL(request.url).pathname;
      const videoId = videoIdFromDownloadPath(pathname);
      if (videoId) ids.push(videoId);
    }
    return ids.sort();
  }

  /** Hapus semua file unduhan (bukan part). */
  async deleteAllDownloads(): Promise<number> {
    const ids = await this.listDownloads();
    const cache = await this.downloadsCache();
    for (const id of ids) {
      await cache.delete(this.absolute(downloadUrl(id)));
    }
    return ids.length;
  }

  // ---------- Part unduhan (resume) ----------

  /** Simpan satu part (chunk) unduhan. */
  async putPart(
    videoId: string,
    index: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const cache = await this.downloadsCache();
    const copy = bytes.slice();
    await cache.put(
      this.absolute(downloadPartUrl(videoId, index)),
      new Response(copy as BodyInit, {
        headers: { 'Content-Length': String(copy.length) },
      }),
    );
  }

  /** Baca satu part sebagai byte, atau null bila tidak ada. */
  async getPart(videoId: string, index: number): Promise<Uint8Array | null> {
    const cache = await this.downloadsCache();
    const found = await cache.match(
      this.absolute(downloadPartUrl(videoId, index)),
    );
    if (!found) return null;
    const buffer = await found.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /** Indeks part yang sudah tersimpan untuk satu lagu, urut naik. */
  async listPartIndexes(videoId: string): Promise<number[]> {
    const cache = await this.downloadsCache();
    const keys = await cache.keys();
    const indexes: number[] = [];
    for (const request of keys) {
      const pathname = new URL(request.url).pathname;
      const part = partFromDownloadPartPath(pathname);
      if (part && part.videoId === videoId) indexes.push(part.index);
    }
    return indexes.sort((a, b) => a - b);
  }

  /** Semua part di cache: videoId -> indeks part. */
  async listAllParts(): Promise<Map<string, number[]>> {
    const cache = await this.downloadsCache();
    const keys = await cache.keys();
    const parts = new Map<string, number[]>();
    for (const request of keys) {
      const pathname = new URL(request.url).pathname;
      const part = partFromDownloadPartPath(pathname);
      if (!part) continue;
      const list = parts.get(part.videoId) ?? [];
      list.push(part.index);
      parts.set(part.videoId, list);
    }
    for (const list of parts.values()) list.sort((a, b) => a - b);
    return parts;
  }

  /** Hapus semua part satu lagu. Mengembalikan jumlah part. */
  async deleteParts(videoId: string): Promise<number> {
    const indexes = await this.listPartIndexes(videoId);
    if (indexes.length === 0) return 0;
    const cache = await this.downloadsCache();
    for (const index of indexes) {
      await cache.delete(this.absolute(downloadPartUrl(videoId, index)));
    }
    return indexes.length;
  }

  /** Hapus part milik lagu-lagu tertentu. */
  async deletePartsFor(videoIds: Iterable<string>): Promise<number> {
    let removed = 0;
    for (const videoId of videoIds) {
      removed += await this.deleteParts(videoId);
    }
    return removed;
  }

  // ---------- Eviction cache runtime (K9: unduhan tidak tersentuh) ----------

  /**
   * Pangkas cache runtime sampai totalnya di bawah `limitBytes`,
   * memakai urutan LRU dari manifest (`lastAccessed` paling lama
   * dulu). Cache unduhan TIDAK PERNAH dibuka di sini: fungsi ini
   * hanya menyentuh `laras-runtime-v1` dan daftar manifest yang
   * diberikan pemanggil.
   *
   * Mengembalikan kunci yang dihapus (pemanggil menghapus baris
   * manifestnya sendiri). Kunci manifest berbentuk
   * `<videoId>_<itag>`; kunci cache runtime adalah URL
   * same-origin `/runtime/<key>`.
   */
  async evictRuntimeCache(
    manifest: RuntimeCacheEntry[],
    limitBytes: number,
  ): Promise<string[]> {
    const sorted = [...manifest].sort(
      (a, b) => a.lastAccessed - b.lastAccessed,
    );
    let total = sorted.reduce((sum, e) => sum + e.sizeBytes, 0);
    if (total <= limitBytes) return [];
    const cache = await this.runtimeCache();
    const removed: string[] = [];
    for (const entry of sorted) {
      if (total <= limitBytes) break;
      await cache.delete(this.absolute(`/runtime/${entry.key}`));
      removed.push(entry.key);
      total -= entry.sizeBytes;
    }
    return removed;
  }

  /** Sisipkan entri runtime (dipakai tes + cache streaming P5+). */
  async putRuntimeEntry(key: string, bytes: Uint8Array): Promise<void> {
    const cache = await this.runtimeCache();
    const copy = bytes.slice();
    await cache.put(
      this.absolute(`/runtime/${key}`),
      new Response(copy as BodyInit, {
        headers: { 'Content-Length': String(copy.length) },
      }),
    );
  }

  /** Apakah entri runtime ada (dipakai tes). */
  async hasRuntimeEntry(key: string): Promise<boolean> {
    const cache = await this.runtimeCache();
    const found = await cache.match(this.absolute(`/runtime/${key}`));
    return found !== undefined;
  }
}

let sharedStore: DownloadStore | null = null;

/** Store unduhan bersama (satu instance per halaman). */
export function getDownloadStore(): DownloadStore {
  if (!sharedStore) sharedStore = new DownloadStore();
  return sharedStore;
}
