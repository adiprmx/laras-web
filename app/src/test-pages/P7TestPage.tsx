/**
 * Halaman uji fitur Should P7 TERSEMBUNYI (rute /p7-test): seed
 * lirik tersinkron + pengaturan EQ untuk tes E2E dan screenshot
 * docs/p7/. Tidak ditautkan dari mana pun; DEV-only (Red 1 H1),
 * hilang total dari build produksi.
 *
 * Tombol:
 * - "Putar nada 60 detik": putar nada lokal lewat jalur graph
 *   (EQ aktif, lirik tersinkron bisa disorot).
 * - "Putar nada 10 detik": untuk uji timer "sampai lagu selesai".
 * - "Seed lirik": tulis lirik tersinkron uji ke store lyrics
 *   untuk nada 60 detik + tandai pemberitahuan privasi sudah
 *   diterima (supaya panel lirik langsung tampil di tes).
 * - "Seed EQ Bass": tulis pengaturan preset Bass ke app_meta.
 * - "Bersihkan": hapus seed P7 (lirik + EQ + penanda lirik).
 *
 * Data seed jelas berlabel uji dan hanya masuk lewat tombol di
 * halaman ini, tidak pernah otomatis.
 */
import { useState } from 'react';
import { getLibraryService } from '../data/library';
import { getPlayerService } from '../player/service';
import { localTrack } from '../player/types';
import { EQ_PRESET_GAINS } from '../player/equalizer';
import { EQ_SETTINGS_KEY } from '../store/equalizer';
import {
  LYRICS_ENABLED_KEY,
  LYRICS_NOTICE_KEY,
} from '../lyrics/lyricsService';

const TONE_60 = '/__player-test__/tone-60s.wav';
const TONE_10 = '/__player-test__/tone-10s.wav';

const TONE_TRACKS = [
  localTrack(TONE_60, 'Nada 60 detik', 60),
  localTrack(TONE_10, 'Nada 10 detik', 10),
];

// Lirik uji (bukan lirik lagu asli): baris-baris pendek dengan
// stempel waktu rapat di awal supaya sorot baris aktif mudah
// diamati dalam hitungan detik.
const TEST_LRC = [
  '[00:00.00]Baris uji satu',
  '[00:02.00]Baris uji dua',
  '[00:05.00]Baris uji tiga',
  '[00:08.00]Baris uji empat',
  '[00:12.00]Baris uji lima',
  '[00:20.00]Baris uji enam',
  '[00:40.00]Baris uji tujuh',
].join('\n');

const TEST_PLAIN = [
  'Baris uji satu',
  'Baris uji dua',
  'Baris uji tiga',
  'Baris uji empat',
  'Baris uji lima',
  'Baris uji enam',
  'Baris uji tujuh',
].join('\n');

export default function P7TestPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Siap.');
  const service = getPlayerService();

  const run = (
    label: string,
    done: string,
    fn: () => Promise<void>,
  ): void => {
    setBusy(true);
    setStatus(label);
    fn()
      .then(() => setStatus(done))
      .catch(() => setStatus('Gagal.'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="min-h-dvh bg-black px-4 py-8 text-zinc-100">
      <h1 className="text-xl font-bold">Uji fitur P7</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Halaman ini hanya untuk tes otomatis. Nada disajikan dari fixture
        lokal, tanpa jaringan.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void service.playQueue(TONE_TRACKS, 0)}
          disabled={busy}
          data-testid="p7-test-play-60"
          className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black disabled:opacity-50"
        >
          Putar nada 60 detik
        </button>
        <button
          type="button"
          onClick={() => void service.playQueue(TONE_TRACKS, 1)}
          disabled={busy}
          data-testid="p7-test-play-10"
          className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium disabled:opacity-50"
        >
          Putar nada 10 detik
        </button>
        <button
          type="button"
          disabled={busy}
          data-testid="p7-test-seed-lyrics"
          onClick={() =>
            run('Menyiapkan lirik.', 'Lirik siap.', async () => {
              const library = await getLibraryService();
              await library.saveLyrics({
                songId: TONE_60,
                lyrics: TEST_PLAIN,
                syncedLyrics: TEST_LRC,
                source: 'lrclib',
              });
              await library.setMeta(LYRICS_NOTICE_KEY, '1');
              await library.setMeta(LYRICS_ENABLED_KEY, '1');
            })
          }
          className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium disabled:opacity-50"
        >
          Seed lirik
        </button>
        <button
          type="button"
          disabled={busy}
          data-testid="p7-test-seed-eq"
          onClick={() =>
            run('Menyiapkan EQ.', 'EQ siap.', async () => {
              const library = await getLibraryService();
              await library.setMeta(
                EQ_SETTINGS_KEY,
                JSON.stringify({
                  preset: 'bass',
                  gains: [...EQ_PRESET_GAINS.bass],
                }),
              );
            })
          }
          className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium disabled:opacity-50"
        >
          Seed EQ Bass
        </button>
        <button
          type="button"
          disabled={busy}
          data-testid="p7-test-clear"
          onClick={() =>
            run('Membersihkan.', 'Bersih.', async () => {
              const library = await getLibraryService();
              const db = await import('../data/database').then((m) =>
                m.openDatabase(),
              );
              await db.lyrics.delete(TONE_60);
              await library.setMeta(LYRICS_NOTICE_KEY, '0');
              await library.setMeta(LYRICS_ENABLED_KEY, '1');
              await library.setMeta(EQ_SETTINGS_KEY, '');
            })
          }
          className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium disabled:opacity-50"
        >
          Bersihkan
        </button>
      </div>
      <p data-testid="p7-test-status" className="mt-6 text-sm text-zinc-400">
        {status}
      </p>
    </div>
  );
}
