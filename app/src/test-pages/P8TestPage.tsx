/**
 * Halaman uji Backup dan Ekspor P8 TERSEMBUNYI (rute /p8-test):
 * seed data contoh untuk tes E2E round-trip (ekspor -> hapus ->
 * impor kembali) dan screenshot docs/p8/. Tidak ditautkan dari
 * mana pun; DEV-only (Red 1 H1), hilang total dari build produksi.
 *
 * Tombol:
 * - "Seed data P8": isi 5 lagu (1 album, 2 artis), 1 playlist
 *   berisi 2 lagu, 1 favorit, 2 riwayat putar, 2 riwayat
 *   pencarian, antrean 2 lagu + posisi pemutar, dan 1 file
 *   unduhan tanaman (cache + penanda terunduh — mensimulasikan
 *   unduhan tanpa jalur pipeline; pipeline sendiri ditutup E2E P5).
 * - "Bersihkan": hapus semua data lewat wipeAllData asli.
 *
 * Data seed jelas berlabel uji dan hanya masuk lewat tombol di
 * halaman ini, tidak pernah otomatis.
 */
import { useState } from 'react';
import type { BackupData } from '../backup/format';
import { wipeAllData } from '../backup/wipe';
import { getLibraryService } from '../data/library';
import { downloadUrl } from '../downloads/constants';
import { getDownloadStore } from '../downloads/downloadStore';

const SEED: BackupData = {
  version: 1,
  appVersion: '0.9.0',
  exportedAt: new Date('2026-11-19T00:00:00.000Z'),
  songs: [
    {
      id: 'p8vid-001',
      title: 'Lagu Uji P8 Satu',
      artists: [{ id: 'UC-P8-1', name: 'Artis Uji P8' }],
      albumId: 'MPRE-P8-1',
      durationSeconds: 200,
      thumbnailUrl: null,
      liked: true,
      inLibrary: true,
      totalPlayTimeMs: 60000,
      dateAdded: 1791926400000,
      downloaded: true,
      unplayable: false,
    },
    {
      id: 'p8vid-002',
      title: 'Lagu Uji P8 Dua',
      artists: [{ id: 'UC-P8-1', name: 'Artis Uji P8' }],
      albumId: 'MPRE-P8-1',
      durationSeconds: 180,
      thumbnailUrl: null,
      liked: false,
      inLibrary: true,
      totalPlayTimeMs: 0,
      dateAdded: 1791926400000,
      downloaded: false,
      unplayable: false,
    },
    {
      id: 'p8vid-003',
      title: 'Lagu Uji P8 Tiga',
      artists: [{ id: 'UC-P8-2', name: 'Artis Uji P8 Dua' }],
      albumId: null,
      durationSeconds: 240,
      thumbnailUrl: null,
      liked: false,
      inLibrary: true,
      totalPlayTimeMs: 30000,
      dateAdded: 1791926400000,
      downloaded: false,
      unplayable: false,
    },
    {
      id: 'p8vid-004',
      title: 'Lagu Uji P8 Empat',
      artists: [],
      albumId: null,
      durationSeconds: null,
      thumbnailUrl: null,
      liked: false,
      inLibrary: false,
      totalPlayTimeMs: 0,
      dateAdded: null,
      downloaded: false,
      unplayable: false,
    },
    {
      id: 'p8vid-005',
      title: 'Lagu Uji P8 Lima',
      artists: [{ id: 'UC-P8-1', name: 'Artis Uji P8' }],
      albumId: null,
      durationSeconds: 150,
      thumbnailUrl: null,
      liked: false,
      inLibrary: true,
      totalPlayTimeMs: 0,
      dateAdded: 1791926400000,
      downloaded: false,
      unplayable: false,
    },
  ],
  albums: [
    {
      id: 'MPRE-P8-1',
      title: 'Album Uji P8',
      year: 2024,
      thumbnailUrl: null,
      liked: false,
      dateAdded: null,
    },
  ],
  artists: [
    {
      id: 'UC-P8-1',
      name: 'Artis Uji P8',
      thumbnailUrl: null,
      liked: false,
      dateAdded: null,
    },
    {
      id: 'UC-P8-2',
      name: 'Artis Uji P8 Dua',
      thumbnailUrl: null,
      liked: false,
      dateAdded: null,
    },
  ],
  playlists: [
    {
      name: 'Favoritku P8',
      description: 'Playlist uji P8',
      songIds: ['p8vid-001', 'p8vid-002'],
      createdAt: 1792099200000,
    },
  ],
  playEvents: [
    { songId: 'p8vid-001', timestamp: 1792519200000, playTimeMs: 120000 },
    { songId: 'p8vid-003', timestamp: 1792519300000, playTimeMs: 30000 },
  ],
  searchHistory: [
    { query: 'p8 uji', timestamp: 1792515600000 },
    { query: 'artis uji p8', timestamp: 1792515700000 },
  ],
  queue: [
    { songId: 'p8vid-001', source: 'library' },
    { songId: 'p8vid-003', source: null },
  ],
  playbackState: {
    currentIndex: 0,
    positionMs: 30000,
    shuffleEnabled: false,
    repeatMode: 0,
  },
  settings: null,
};

async function readCounts(): Promise<string> {
  const service = await getLibraryService();
  const counts = await service.libraryCounts();
  const queue = await service.loadQueue();
  const downloaded = await service.downloadedSongsList();
  return (
    `Lagu: ${counts.songs} | Playlist: ${counts.playlists} | ` +
    `Favorit: ${counts.favorites} | Riwayat: ${counts.historyEntries} | ` +
    `Antrean: ${queue.length} | Unduhan: ${downloaded.length}`
  );
}

export default function P8TestPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Siap.');
  const [counts, setCounts] = useState('');

  const run = (
    label: string,
    done: string,
    fn: () => Promise<void>,
  ): void => {
    setBusy(true);
    setStatus(label);
    fn()
      .then(async () => {
        setCounts(await readCounts());
        setStatus(done);
      })
      .catch(() => setStatus('Gagal.'))
      .finally(() => setBusy(false));
  };

  const seed = (): void => {
    run('Mengisi data uji P8.', 'Selesai.', async () => {
      const service = await getLibraryService();
      await service.mergeBackupData(SEED);
      // Tanam 1 file unduhan: blob di cache + penanda terunduh.
      // (Jalur unduhan sungguhan ditutup E2E P5; di sini hanya
      //  perlu ada file + penanda untuk diuji ekspor/hapusnya.)
      const blob = new Blob([new Uint8Array(100)], { type: 'audio/webm' });
      await getDownloadStore().putDownload('p8vid-001', blob, 'audio/webm');
      await service.markDownloaded({
        songId: 'p8vid-001',
        filePath: downloadUrl('p8vid-001'),
        fileSizeBytes: 100,
      });
    });
  };

  const clear = (): void => {
    run('Menghapus semua data.', 'Selesai.', async () => {
      await wipeAllData();
    });
  };

  const refresh = (): void => {
    run('Membaca hitungan.', 'Selesai.', async () => {
      // Hitungan dibaca di `run` sesudah fn selesai.
    });
  };

  return (
    <div className="mx-auto max-w-xl p-4">
      <h1 className="text-lg font-bold">Halaman uji P8 (Backup dan Ekspor)</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Halaman ini hanya ada di build dev. Data seed berlabel uji.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={seed}
          disabled={busy}
          data-testid="p8-test-seed"
          className="h-11 rounded-full bg-white px-6 text-sm font-medium text-black disabled:opacity-50"
        >
          Seed data P8
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={busy}
          data-testid="p8-test-clear"
          className="h-11 rounded-full border border-white/15 px-6 text-sm font-medium disabled:opacity-50"
        >
          Bersihkan
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          data-testid="p8-test-refresh"
          className="h-11 rounded-full border border-white/15 px-6 text-sm font-medium disabled:opacity-50"
        >
          Baca hitungan
        </button>
      </div>
      <p data-testid="p8-test-status" className="mt-4 text-sm text-zinc-300">
        {status}
      </p>
      <p data-testid="p8-test-counts" className="mt-2 font-mono text-sm text-zinc-100">
        {counts}
      </p>
    </div>
  );
}
