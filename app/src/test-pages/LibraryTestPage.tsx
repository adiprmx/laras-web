/**
 * Halaman uji library TERSEMBUNYI (rute /library-test): mengisi
 * 1.000 lagu contoh, menampilkan hitungan database, dan
 * mengosongkan library. Tidak ditautkan dari mana pun; hanya
 * untuk verifikasi E2E dan demo internal.
 *
 * Data contoh jelas berlabel "Contoh" dan hanya masuk lewat
 * tombol di halaman ini, tidak pernah otomatis.
 */
import { useEffect, useState } from 'react';
import { deleteDatabase } from '../data/database';
import { getLibraryService, resetLibraryService } from '../data/library';
import { generateSampleSongs } from '../data/sampleData';
import type { LibraryCounts } from '../data/types';
import { useLibraryStore } from '../store/library';

export default function LibraryTestPage() {
  const version = useLibraryStore((s) => s.version);
  const [counts, setCounts] = useState<LibraryCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Siap.');
  // Konfirmasi dua langkah (Red 1 H1): satu ketukan tidak boleh
  // menghapus seluruh library — ketukan pertama mengaktifkan mode
  // konfirmasi, ketukan kedua baru menghapus.
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let alive = true;
    getLibraryService()
      .then((service) => service.libraryCounts())
      .then((c) => {
        if (alive) setCounts(c);
      })
      .catch(() => {
        if (alive) setStatus('Database tidak bisa dibuka.');
      });
    return () => {
      alive = false;
    };
  }, [version]);

  const seed = (count: number): void => {
    setBusy(true);
    setStatus(`Mengisi ${count} lagu contoh.`);
    const started = Date.now();
    getLibraryService()
      .then(async (service) => {
        await service.importSongs(generateSampleSongs(count), {
          addToLibrary: true,
        });
        const next = await service.libraryCounts();
        setCounts(next);
        setStatus(
          `Selesai dalam ${((Date.now() - started) / 1000).toFixed(1)} detik.`,
        );
      })
      .catch(() => setStatus('Gagal mengisi lagu contoh.'))
      .finally(() => setBusy(false));
  };

  const clearAll = (): void => {
    if (!confirmClear) {
      setConfirmClear(true);
      setStatus('Ketuk lagi untuk menghapus seluruh database.');
      return;
    }
    setConfirmClear(false);
    setBusy(true);
    setStatus('Menghapus seluruh database.');
    deleteDatabase()
      .then(() => {
        resetLibraryService();
        setCounts({
          songs: 0,
          artists: 0,
          albums: 0,
          playlists: 0,
          favorites: 0,
          historyEntries: 0,
        });
        setStatus('Database dihapus.');
      })
      .catch(() => setStatus('Gagal menghapus database.'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="min-h-dvh bg-black px-4 py-8 text-zinc-100">
      <h1 className="text-xl font-bold">Uji library (data contoh)</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Halaman ini hanya untuk tes otomatis. Data contoh jelas
        berlabel Contoh dan tidak masuk Library tanpa tombol ini.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => seed(1000)}
          data-testid="library-test-seed-1000"
          className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black disabled:opacity-50"
        >
          Isi 1.000 lagu contoh
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => seed(120)}
          data-testid="library-test-seed-120"
          className="h-11 rounded-xl border border-white/10 px-4 text-sm font-medium disabled:opacity-50"
        >
          Isi 120 lagu contoh
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={clearAll}
          data-testid="library-test-clear"
          className="h-11 rounded-xl border border-red-500/30 px-4 text-sm font-medium text-red-400 disabled:opacity-50"
        >
          {confirmClear
            ? 'Yakin? Ketuk lagi untuk menghapus'
            : 'Hapus seluruh database'}
        </button>
      </div>
      <dl className="mt-6 space-y-1 text-sm" data-testid="library-test-counts">
        <div>
          <dt className="inline text-zinc-400">Lagu: </dt>
          <dd className="inline tabular-nums" data-testid="library-test-songs">
            {counts?.songs ?? '-'}
          </dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">Artis: </dt>
          <dd className="inline tabular-nums" data-testid="library-test-artists">
            {counts?.artists ?? '-'}
          </dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">Album: </dt>
          <dd className="inline tabular-nums" data-testid="library-test-albums">
            {counts?.albums ?? '-'}
          </dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">Playlist: </dt>
          <dd className="inline tabular-nums" data-testid="library-test-playlists">
            {counts?.playlists ?? '-'}
          </dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">Favorit: </dt>
          <dd className="inline tabular-nums" data-testid="library-test-favorites">
            {counts?.favorites ?? '-'}
          </dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">Riwayat: </dt>
          <dd className="inline tabular-nums" data-testid="library-test-history">
            {counts?.historyEntries ?? '-'}
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-zinc-400" data-testid="library-test-status">
        {status}
      </p>
    </div>
  );
}
