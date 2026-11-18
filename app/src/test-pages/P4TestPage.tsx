/**
 * Halaman uji beranda P4 TERSEMBUNYI (rute /p4-test): mengisi
 * skenario deterministik untuk tes E2E beranda (6 seksi).
 * Tidak ditautkan dari mana pun; hanya untuk verifikasi E2E.
 *
 * Skenario (cermin contoh hitung PRD B6.2):
 * - "Sering Didengar B": 9 putaran bermakna (skor 9).
 * - "Favorit A": 3 putaran + favorit (skor 8).
 * - "Unduhan C": 1 putaran + diunduh (skor 3).
 * - "Baru Saja D": 1 putaran, paling baru (puncak "Baru diputar").
 * - "Lama E": 2 putaran, lebih lama.
 * - "Tanpa Putar F": tanpa putaran, paling baru ditambahkan
 *   (pengisi "Lagu untukmu").
 * Urutan "Lagu untukmu": B, A, C, E, D, F. Urutan "Baru diputar":
 * D, C, B, A, E. Urutan "Sering diputar": B, A, E. Satu playlist
 * "Playlist Uji P4" berisi A + B. Lagu C bertanda terunduh.
 *
 * Data contoh jelas berlabel dan hanya masuk lewat tombol di
 * halaman ini, tidak pernah otomatis.
 */
import { useState } from 'react';
import { deleteDatabase } from '../data/database';
import {
  getLibraryService,
  MEANINGFUL_PLAY_MS,
  resetLibraryService,
} from '../data/library';
import { getDownloadStore } from '../downloads/downloadStore';
import type { SongImport } from '../data/types';

function song(id: string, title: string, dateAdded: number): SongImport {
  return {
    song: {
      id,
      title,
      albumId: null,
      durationSeconds: 200,
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
      dateAdded,
      dateModified: dateAdded,
    },
    artistNames: ['Artis Uji P4'],
  };
}

export default function P4TestPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Siap.');
  // Konfirmasi dua langkah (Red 1 H1): lihat LibraryTestPage.
  const [confirmClear, setConfirmClear] = useState(false);

  const seed = (): void => {
    setBusy(true);
    setStatus('Mengisi skenario beranda.');
    getLibraryService()
      .then(async (service) => {
        const base = Date.now();
        await service.importSongs(
          [
            song('p4-song-a', 'Favorit A', base - 5000),
            song('p4-song-b', 'Sering Didengar B', base - 4000),
            song('p4-song-c', 'Unduhan C', base - 3000),
            song('p4-song-d', 'Baru Saja D', base - 2000),
            song('p4-song-e', 'Lama E', base - 1000),
            song('p4-song-f', 'Tanpa Putar F', base),
          ],
          { addToLibrary: true },
        );
        // Putaran dengan stempel waktu berbeda supaya urutan
        // "Baru diputar" deterministik: D, C, B, A, E.
        const play = async (
          songId: string,
          count: number,
          startOffsetMs: number,
        ): Promise<void> => {
          for (let i = 0; i < count; i++) {
            await service.recordPlay({
              songId,
              timestamp: base - startOffsetMs - i * 1000,
              playTimeMs: MEANINGFUL_PLAY_MS,
            });
          }
        };
        await play('p4-song-d', 1, 1000);
        await play('p4-song-c', 1, 2000);
        await play('p4-song-b', 9, 3000);
        await play('p4-song-a', 3, 12000);
        await play('p4-song-e', 2, 15000);
        await service.toggleLiked('p4-song-a');
        await service.markDownloaded({
          songId: 'p4-song-c',
          filePath: '/dl/p4-song-c',
          fileSizeBytes: 1234,
        });
        // P5: rekonsiliasi saat start membersihkan lagu yang
        // diklaim terunduh tetapi filenya tidak ada di cache —
        // seed wajib menulis file sungguhan (1.234 byte) supaya
        // skenario ini tetap jujur dan seksi Unduhan tampil.
        await getDownloadStore().putDownload(
          'p4-song-c',
          new Blob([new Uint8Array(1234)], { type: 'audio/webm' }),
          'audio/webm',
        );
        const playlistId = await service.createPlaylist('Playlist Uji P4');
        await service.addSongToPlaylist(playlistId, 'p4-song-a');
        await service.addSongToPlaylist(playlistId, 'p4-song-b');
        setStatus('Selesai.');
      })
      .catch(() => setStatus('Gagal mengisi skenario beranda.'))
      .finally(() => setBusy(false));
  };

  const clearAll = (): void => {
    if (!confirmClear) {
      setConfirmClear(true);
      setStatus('Ketuk lagi untuk menghapus database.');
      return;
    }
    setConfirmClear(false);
    setBusy(true);
    setStatus('Menghapus seluruh database.');
    deleteDatabase()
      .then(() => {
        resetLibraryService();
        setStatus('Database dihapus.');
      })
      .catch(() => setStatus('Gagal menghapus database.'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-xl font-bold">Uji Beranda P4</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Halaman uji tersembunyi. Mengisi skenario deterministik 6 lagu,
        1 playlist, 1 unduhan, dan riwayat putar untuk tes beranda.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={seed}
          disabled={busy}
          data-testid="p4-test-seed"
          className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black disabled:opacity-50"
        >
          Isi skenario beranda
        </button>
        <button
          type="button"
          onClick={clearAll}
          disabled={busy}
          data-testid="p4-test-clear"
          className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium disabled:opacity-50"
        >
          {confirmClear ? 'Yakin? Ketuk lagi untuk menghapus' : 'Hapus database'}
        </button>
      </div>
      <p data-testid="p4-test-status" className="mt-4 text-sm text-zinc-400">
        {status}
      </p>
    </div>
  );
}
