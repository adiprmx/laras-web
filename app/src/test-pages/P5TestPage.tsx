/**
 * Halaman uji unduhan P5 TERSEMBUNYI (rute /p5-test): mengisi
 * 10 lagu contoh + antre unduhan untuk tes E2E unduhan/offline.
 * Tidak ditautkan dari mana pun; hanya untuk verifikasi E2E.
 *
 * Skenario: 10 lagu "Lagu Uji P5 1..10" (durasi 10 detik,
 * cocok dengan fixture nada tone-10s.wav yang dilayani mock
 * proxy di E2E). Tombol "Unduh 10 lagu" mengantrekan semuanya
 * lewat manajer unduhan ASLI (bukan pintasan database) dengan
 * ukuran chunk kecil (50.000 byte) supaya jalur ber-chunk
 * ikut teruji walau fixture hanya 160.044 byte.
 *
 * Tombol skenario rekonsiliasi/eviction:
 * - "Buat file yatim": tulis file cache tanpa baris Dexie.
 * - "Hapus file lagu 1": hapus file cache lagu 1 (Dexie tetap
 *   mengklaim terunduh) — rekonsiliasi saat muat ulang wajib
 *   membersihkan statusnya.
 * - "Uji eviction": isi cache runtime + manifest, lalu pangkas
 *   sampai 0 — unduhan wajib utuh, runtime wajib kosong.
 *
 * Data contoh jelas berlabel dan hanya masuk lewat tombol di
 * halaman ini, tidak pernah otomatis.
 */
import { useState } from 'react';
import { getLibraryService } from '../data/library';
import { getDownloadStore } from '../downloads/downloadStore';
import { getDownloadManager } from '../downloads/downloadManager';
import type { SongImport } from '../data/types';

export const P5_SONG_IDS = [
  'p5test0001',
  'p5test0002',
  'p5test0003',
  'p5test0004',
  'p5test0005',
  'p5test0006',
  'p5test0007',
  'p5test0008',
  'p5test0009',
  'p5test0010',
] as const;

function song(id: string, title: string): SongImport {
  return {
    song: {
      id,
      title,
      albumId: null,
      durationSeconds: 10,
      thumbnailUrl: null,
      liked: 0,
      totalPlayTimeMs: 0,
      inLibrary: 0,
      downloadState: 0,
      filePath: null,
      fileSizeBytes: null,
      downloadedAt: null,
      formatId: null,
      unplayable: 0,
    },
    artistNames: ['Artis Uji P5'],
  };
}

export default function P5TestPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Siap.');

  const seed = (): void => {
    setBusy(true);
    setStatus('Mengisi 10 lagu contoh.');
    getLibraryService()
      .then(async (service) => {
        await service.importSongs(
          P5_SONG_IDS.map((id, i) => song(id, `Lagu Uji P5 ${i + 1}`)),
          { addToLibrary: true },
        );
        setStatus('Selesai.');
      })
      .catch(() => setStatus('Gagal mengisi lagu contoh.'))
      .finally(() => setBusy(false));
  };

  const downloadAll = (): void => {
    setBusy(true);
    setStatus('Mengunduh 10 lagu.');
    getDownloadManager()
      .then(async (manager) => {
        // Chunk kecil supaya jalur ber-chunk teruji dengan
        // fixture 160 KB (4 chunk per lagu, bukan 1).
        manager.setChunkSizeForTest(50_000);
        for (const [i, id] of P5_SONG_IDS.entries()) {
          await manager.enqueue(id, 'best', {
            title: `Lagu Uji P5 ${i + 1}`,
            durationSeconds: 10,
            artistNames: ['Artis Uji P5'],
          });
        }
        setStatus('10 lagu diantrekan.');
      })
      .catch(() => setStatus('Gagal mengantrekan unduhan.'))
      .finally(() => setBusy(false));
  };

  const makeOrphan = (): void => {
    setBusy(true);
    getDownloadStore()
      .putDownload(
        'p5orphan01',
        new Blob([new Uint8Array(100)], { type: 'audio/webm' }),
        'audio/webm',
      )
      .then(() => setStatus('File yatim dibuat.'))
      .catch(() => setStatus('Gagal membuat file yatim.'))
      .finally(() => setBusy(false));
  };

  const removeFirstFile = (): void => {
    setBusy(true);
    getDownloadStore()
      .deleteDownload(P5_SONG_IDS[0])
      .then(() => setStatus('File lagu 1 dihapus dari cache.'))
      .catch(() => setStatus('Gagal menghapus file lagu 1.'))
      .finally(() => setBusy(false));
  };

  const testEviction = (): void => {
    setBusy(true);
    setStatus('Menguji eviction.');
    getLibraryService()
      .then(async (service) => {
        const store = getDownloadStore();
        // Isi runtime: 3 entri x 1.000 byte + manifest.
        for (const key of ['rt1_251', 'rt2_251', 'rt3_251']) {
          await store.putRuntimeEntry(key, new Uint8Array(1000));
          await service.upsertCacheEntry({
            key,
            filePath: `/runtime/${key}`,
            sizeBytes: 1000,
          });
        }
        const manifest = await service.cacheEntriesByLru({ limit: 100 });
        const removed = await store.evictRuntimeCache(manifest, 0);
        await service.deleteCacheEntries(removed);
        const downloadsLeft = await store.listDownloads();
        const runtimeLeft = await Promise.all(
          ['rt1_251', 'rt2_251', 'rt3_251'].map((k) =>
            store.hasRuntimeEntry(k),
          ),
        );
        setStatus(
          `Eviction: runtime dihapus ${removed.length}/3, ` +
            `runtime tersisa ${runtimeLeft.filter(Boolean).length}, ` +
            `unduhan utuh ${downloadsLeft.length}.`,
        );
      })
      .catch(() => setStatus('Gagal menguji eviction.'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-xl font-bold">Uji Unduhan P5</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Halaman uji tersembunyi. Mengisi 10 lagu contoh dan
        mengantrekan unduhan lewat manajer asli untuk tes E2E.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={seed}
          disabled={busy}
          data-testid="p5-test-seed"
          className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black disabled:opacity-50"
        >
          Isi 10 lagu contoh
        </button>
        <button
          type="button"
          onClick={downloadAll}
          disabled={busy}
          data-testid="p5-test-download-all"
          className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black disabled:opacity-50"
        >
          Unduh 10 lagu
        </button>
        <button
          type="button"
          onClick={makeOrphan}
          disabled={busy}
          data-testid="p5-test-make-orphan"
          className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium disabled:opacity-50"
        >
          Buat file yatim
        </button>
        <button
          type="button"
          onClick={removeFirstFile}
          disabled={busy}
          data-testid="p5-test-remove-first-file"
          className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium disabled:opacity-50"
        >
          Hapus file lagu 1
        </button>
        <button
          type="button"
          onClick={testEviction}
          disabled={busy}
          data-testid="p5-test-eviction"
          className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium disabled:opacity-50"
        >
          Uji eviction
        </button>
      </div>
      <p data-testid="p5-test-status" className="mt-4 text-sm text-zinc-400">
        {status}
      </p>
    </div>
  );
}
