/**
 * Halaman spike integrasi P1 (rute /spike, TERSEMBUNYI).
 *
 * Bukti integrasi ujung ke ujung: lima lagu kanari di-resolve lewat
 * proxy lalu diputar dari URL googlevideo langsung sampai habis.
 * Halaman ini HANYA untuk verifikasi; UI pemutar sesungguhnya
 * adalah P2. Tidak ada tautan ke halaman ini dari beranda.
 *
 * Dua mode: "Periksa cepat" (30 detik per lagu) dan "Putar penuh"
 * (5 lagu sampai habis). URL stream hanya ada di memori dan tidak
 * pernah tampil di layar, log, atau laporan.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CANARY_SONGS,
  MAX_MID_SONG_RETRY,
  PROXY_BASE_URL,
  QUICK_CHECK_SECONDS,
  STALL_TIMEOUT_MS,
} from './config';
import {
  ResolveError,
  StreamResolver,
  type ResolvedTrack,
} from '../extractor/resolve';
import {
  formatDurationMs,
  formatReport,
  formatSeconds,
  statusLabel,
  summarize,
  type ReportMeta,
  type SongResult,
  type SpikeMode,
} from './report';

type Phase = 'idle' | 'running' | 'done' | 'stopped';

function freshResults(): SongResult[] {
  return CANARY_SONGS.map((song) => ({
    videoId: song.videoId,
    title: song.title,
    lengthSeconds: song.lengthSeconds,
    status: 'menunggu',
    client: null,
    itag: null,
    usedSolver: false,
    resolveMs: null,
    heardSeconds: 0,
    audioDuration: null,
    retries: 0,
    failCause: null,
    failDetail: null,
    fromCache: false,
    mediaErrorCode: null,
    mediaErrorMessage: null,
  }));
}

function mediaErrorCause(code: number | null): string {
  switch (code) {
    case 1:
      return 'Pemutaran dibatalkan.';
    case 2:
      return 'Jaringan terputus saat memutar.';
    case 3:
      return 'File audio rusak saat diputar.';
    case 4:
      return 'Format audio tidak didukung browser ini.';
    default:
      return 'Pemutaran gagal tanpa keterangan.';
  }
}

declare global {
  interface Window {
    __larasSpike?: {
      getReport: () => string;
      getSummary: () => { done: number; total: number; failed: number };
      phase: Phase;
      mode: SpikeMode | null;
    };
  }
}

export default function SpikePage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<SpikeMode | null>(null);
  const [results, setResults] = useState<SongResult[]>(freshResults);
  const [generalNote, setGeneralNote] = useState<string | null>(null);
  const [report, setReport] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resultsRef = useRef<SongResult[]>(freshResults());
  const runRef = useRef({ cancelled: false, runId: 0 });
  const resolverRef = useRef<StreamResolver | null>(null);
  const cancelWaitRef = useRef<(() => void) | null>(null);
  const metaRef = useRef<{
    startedAt: string;
    playerHash: string | null;
    usedRemoteConfig: boolean;
  }>({ startedAt: '', playerHash: null, usedRemoteConfig: false });
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  const updateResult = useCallback((index: number, patch: Partial<SongResult>) => {
    resultsRef.current = resultsRef.current.map((item, i) =>
      i === index ? { ...item, ...patch } : item,
    );
    setResults(resultsRef.current);
  }, []);

  // Timer waktu jalan selama uji berjalan.
  useEffect(() => {
    if (phase !== 'running') return;
    const started = Date.now() - elapsedMs;
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - started);
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Ekspos hasil untuk dibaca dari konsol browser bila perlu.
  useEffect(() => {
    window.__larasSpike = {
      getReport: () => report,
      getSummary: () => {
        const summary = summarize(resultsRef.current);
        return { done: summary.done, total: summary.total, failed: summary.failed };
      },
      phase,
      mode,
    };
    return () => {
      delete window.__larasSpike;
    };
  }, [report, phase, mode]);

  const buildReport = useCallback(
    (currentMode: SpikeMode, startedAt: string, totalMs: number): string => {
      const meta: ReportMeta = {
        mode: currentMode,
        startedAt,
        finishedAt: new Date().toISOString(),
        totalMs,
        proxyUrl: PROXY_BASE_URL,
        playerHash: metaRef.current.playerHash,
        usedRemoteConfig: metaRef.current.usedRemoteConfig,
        userAgent: navigator.userAgent,
      };
      return formatReport(resultsRef.current, meta);
    },
    [],
  );

  /**
   * Balap sebuah promise melawan tombol Hentikan: bila pengguna
   * menekan Hentikan saat jaringan masih menunggu, promise langsung
   * ditolak supaya ringkasan segera muncul (tanpa ini, Hentikan
   * harus menunggu timeout jaringan sampai 60 detik).
   */
  const withCancel = useCallback(<T,>(promise: Promise<T>): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        cancelWaitRef.current = () => reject(new Error('__cancelled'));
      }),
    ]);
  }, []);

  const stopRun = useCallback(() => {
    runRef.current.cancelled = true;
    cancelWaitRef.current?.();
    cancelWaitRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    resolverRef.current?.dispose();
    resolverRef.current = null;
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }, []);

  /**
   * Putar satu lagu sampai target tercapai (30 detik untuk mode
   * cepat, sampai habis untuk mode penuh). Mengembalikan hasil
   * putaran beserta posisi terakhir yang terdengar.
   */
  const playTrack = useCallback(
    async (
      track: ResolvedTrack,
      index: number,
      runMode: SpikeMode,
      runId: number,
    ): Promise<{
      ok: boolean;
      cause: string | null;
      heard: number;
      mediaError: { code: number | null; message: string | null } | null;
    }> => {
      const audio = audioRef.current;
      if (!audio) {
        return { ok: false, cause: 'Pemutar tidak tersedia.', heard: 0, mediaError: null };
      }
      const resolver = resolverRef.current;
      const song = CANARY_SONGS[index];
      let currentUrl = track.url;
      let retries = 0;
      let heard = 0;
      let lastPosition = 0;
      // MediaError terakhir yang tertangkap elemen audio. Dipasang
      // SEBELUM play() pertama supaya gagal start awal (yang dulu
      // tidak pernah tercatat karena listener baru dipasang sesudah
      // play() sukses) ikut tertangkap dan masuk laporan.
      let lastMediaError: { code: number | null; message: string | null } | null = null;
      const captureMediaError = () => {
        lastMediaError = {
          code: audio.error?.code ?? null,
          message: audio.error?.message ?? null,
        };
      };

      const setSourceAndPlay = async (): Promise<'playing' | 'blocked' | 'failed'> => {
        audio.src = currentUrl;
        audio.load();
        try {
          await audio.play();
          return 'playing';
        } catch (error) {
          if (error instanceof DOMException && error.name === 'NotAllowedError') {
            return 'blocked';
          }
          return 'failed';
        }
      };

      // Bila browser memblokir putar otomatis, tunggu pengguna menekan
      // tombol putar pada pemutar (maks 120 detik).
      const waitForUserPlay = async (): Promise<boolean> => {
        setGeneralNote(
          'Browser meminta ketukan. Tekan tombol putar pada pemutar di bawah.',
        );
        return new Promise((resolveWait) => {
          const onPlaying = () => {
            cleanup();
            resolveWait(true);
          };
          const timer = window.setTimeout(() => {
            cleanup();
            resolveWait(false);
          }, 120000);
          const cleanup = () => {
            window.clearTimeout(timer);
            audio.removeEventListener('playing', onPlaying);
          };
          audio.addEventListener('playing', onPlaying);
        });
      };

      const resumeAfterRetry = async (): Promise<boolean> => {
        if (!resolver || retries >= MAX_MID_SONG_RETRY) return false;
        retries += 1;
        updateResult(index, { retries });
        setGeneralNote(
          `Lagu ${song.title} macet, mencoba jalur baru (${retries}x).`,
        );
        try {
          const fresh = await resolver.resolve(song);
          currentUrl = fresh.url;
          updateResult(index, {
            client: fresh.client,
            itag: fresh.itag,
            usedSolver: fresh.usedSolver,
            fromCache: fresh.fromCache ?? false,
          });
        } catch {
          return false;
        }
        const state = await setSourceAndPlay();
        if (state === 'blocked') {
          const resumed = await waitForUserPlay();
          if (!resumed) return false;
        } else if (state === 'failed') {
          return false;
        }
        try {
          audio.currentTime = lastPosition;
        } catch {
          // Seek gagal: lanjut dari awal, bukan alasan gagal total.
        }
        return true;
      };

      // Pasang penangkap SEBELUM play() pertama: inti perbaikan ini.
      audio.addEventListener('error', captureMediaError);
      const state = await setSourceAndPlay();
      if (state === 'blocked') {
        const resumed = await waitForUserPlay();
        if (!resumed) {
          audio.removeEventListener('error', captureMediaError);
          return {
            ok: false,
            cause: 'Browser memblokir putar otomatis dan tombol putar tidak ditekan.',
            heard,
            mediaError: lastMediaError,
          };
        }
        setGeneralNote(null);
      } else if (state === 'failed') {
        audio.removeEventListener('error', captureMediaError);
        return {
          ok: false,
          cause: 'Pemutar gagal memulai lagu.',
          heard,
          mediaError: lastMediaError,
        };
      } else {
        setGeneralNote(null);
      }

      return new Promise((resolvePlay) => {
        let settled = false;
        let lastProgressAt = Date.now();
        let lastSeenTime = 0;
        let lastShownSecond = -1;

        const finish = (ok: boolean, cause: string | null) => {
          if (settled) return;
          settled = true;
          window.clearInterval(poller);
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onError);
          audio.removeEventListener('error', captureMediaError);
          resolvePlay({ ok, cause, heard, mediaError: lastMediaError });
        };

        const onEnded = () => {
          heard = audio.duration && Number.isFinite(audio.duration)
            ? Math.floor(audio.duration)
            : heard;
          updateResult(index, {
            heardSeconds: heard,
            audioDuration: Number.isFinite(audio.duration) ? audio.duration : null,
          });
          finish(true, null);
        };

        const onError = () => {
          const code = audio.error?.code ?? null;
          void (async () => {
            if (heard > 5 && (await resumeAfterRetry())) {
              lastProgressAt = Date.now();
              return;
            }
            // Pakai kode SEGAR dari penangkap media error (S-1): bila
            // retry ikut gagal dengan kode berbeda, penyebab harus
            // cocok dengan baris Media error di laporan — baris itu
            // juga dibaca dari lastMediaError. `code` hanya fallback
            // bila belum ada MediaError yang tertangkap.
            finish(false, mediaErrorCause(lastMediaError?.code ?? code));
          })();
        };

        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);

        const poller = window.setInterval(() => {
          if (runRef.current.cancelled || runRef.current.runId !== runId) {
            finish(false, 'Uji dihentikan.');
            return;
          }
          const current = audio.currentTime;
          if (Number.isFinite(current) && current > 0) {
            heard = Math.max(heard, Math.floor(current));
            lastPosition = current;
            const second = Math.floor(current);
            if (second !== lastShownSecond) {
              lastShownSecond = second;
              updateResult(index, {
                heardSeconds: heard,
                audioDuration: Number.isFinite(audio.duration)
                  ? audio.duration
                  : null,
              });
            }
          }
          if (Math.abs(current - lastSeenTime) > 0.5) {
            lastSeenTime = current;
            lastProgressAt = Date.now();
          }
          if (runMode === 'cepat' && current >= QUICK_CHECK_SECONDS) {
            audio.pause();
            finish(true, null);
            return;
          }
          if (
            !audio.paused &&
            !audio.ended &&
            Date.now() - lastProgressAt > STALL_TIMEOUT_MS
          ) {
            void (async () => {
              lastProgressAt = Date.now();
              const resumed = await resumeAfterRetry();
              if (!resumed) {
                finish(false, 'Lagu macet dan tidak bisa dilanjutkan.');
              }
            })();
          }
        }, 500);
      });
    },
    [updateResult],
  );

  const startRun = useCallback(
    async (runMode: SpikeMode) => {
      const runId = runRef.current.runId + 1;
      runRef.current = { cancelled: false, runId };
      const startedAt = new Date().toISOString();
      const runStartedAt = Date.now();
      metaRef.current = { startedAt, playerHash: null, usedRemoteConfig: false };
      resultsRef.current = freshResults();
      setResults(resultsRef.current);
      setReport('');
      setCopied(false);
      setElapsedMs(0);
      setMode(runMode);
      setPhase('running');
      setGeneralNote('Menyiapkan uji, memuat pengaturan lagu.');

      // Jaga layar tetap menyala selama uji penuh bila browser mengizinkan.
      try {
        const wakeLock = navigator.wakeLock;
        if (wakeLock) {
          wakeLockRef.current = await wakeLock.request('screen');
        }
      } catch {
        // Wake lock tidak tersedia: uji tetap jalan.
      }

      const resolver = new StreamResolver();
      resolverRef.current = resolver;
      try {
        const config = await withCancel(resolver.init());
        metaRef.current.playerHash = resolver.playerHash;
        metaRef.current.usedRemoteConfig = config.fromRemote;
      } catch {
        // init tidak pernah melempar (config punya nilai bawaan dan
        // visitorData bersifat best-effort); cabang ini hanya pengaman
        // dan jalan keluar bila uji dihentikan saat menyiapkan.
      }
      cancelWaitRef.current = null;
      setGeneralNote(null);

      for (let i = 0; i < CANARY_SONGS.length; i++) {
        if (runRef.current.cancelled || runRef.current.runId !== runId) break;
        const song = CANARY_SONGS[i];
        updateResult(i, { status: 'mencari' });
        let track: ResolvedTrack;
        try {
          track = await withCancel(resolver.resolve(song));
        } catch (error) {
          cancelWaitRef.current = null;
          if (runRef.current.cancelled || runRef.current.runId !== runId) break;
          const cause =
            error instanceof ResolveError
              ? error.causeText
              : 'Lagu tidak bisa dicari karena gangguan jaringan.';
          // Detail teknis (attempts per client + playability) masuk
          // laporan, BUKAN layar: tanpa ini §5 tidak bisa didiagnosis
          // dari laporan saja (18 Nov 2026: semua lagu hanya tampil
          // pesan generik padahal penyebabnya LOGIN_REQUIRED).
          const detail =
            error instanceof ResolveError
              ? error.message
              : error instanceof Error
                ? `jaringan: ${error.message}`
                : 'jaringan: galat tidak dikenal';
          updateResult(i, { status: 'gagal', failCause: cause, failDetail: detail });
          continue;
        }
        cancelWaitRef.current = null;
        if (runRef.current.cancelled || runRef.current.runId !== runId) break;
        updateResult(i, {
          status: 'memutar',
          client: track.client,
          itag: track.itag,
          usedSolver: track.usedSolver,
          resolveMs: track.resolveMs,
          fromCache: track.fromCache ?? false,
        });
        if ('mediaSession' in navigator) {
          try {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: track.title,
              artist: 'Laras (uji)',
              album: 'Uji putar lagu',
            });
            navigator.mediaSession.playbackState = 'playing';
          } catch {
            // MediaSession opsional di halaman uji.
          }
        }
        const played = await playTrack(track, i, runMode, runId);
        if (runRef.current.cancelled || runRef.current.runId !== runId) break;
        updateResult(i, {
          status: played.ok ? 'selesai' : 'gagal',
          failCause: played.cause,
          heardSeconds: Math.max(
            resultsRef.current[i].heardSeconds,
            played.heard,
          ),
          mediaErrorCode: played.mediaError?.code ?? null,
          mediaErrorMessage: played.mediaError?.message ?? null,
        });
      }

      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      resolver.dispose();
      resolverRef.current = null;
      void wakeLockRef.current?.release().catch(() => undefined);
      wakeLockRef.current = null;
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'none';
        } catch {
          // Abaikan.
        }
      }

      const totalMs = Date.now() - runStartedAt;
      setReport(buildReport(runMode, startedAt, totalMs));
      setElapsedMs(totalMs);
      setPhase(runRef.current.cancelled ? 'stopped' : 'done');
      setGeneralNote(null);
    },
    [buildReport, playTrack, updateResult, withCancel],
  );

  const handleStop = useCallback(() => {
    stopRun();
    setGeneralNote('Uji dihentikan. Laporan berisi hasil sampai titik ini.');
  }, [stopRun]);

  const handleCopy = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      return;
    } catch {
      // Fallback untuk browser tanpa izin clipboard.
    }
    try {
      const area = document.createElement('textarea');
      area.value = report;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
      setCopied(true);
    } catch {
      setGeneralNote('Salin gagal. Blok teks laporan lalu salin manual.');
    }
  }, [report]);

  const summary = summarize(results);
  const running = phase === 'running';

  return (
    <div className="min-h-dvh bg-black text-zinc-100">
      <header className="flex items-center justify-between px-4 py-3">
        <h1 className="text-xl font-bold tracking-tight">Laras</h1>
        <span className="rounded-full border border-white/10 px-2 py-1 text-[11px] text-zinc-400">
          Uji putar lagu
        </span>
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-16">
        <h2 className="text-2xl font-semibold tracking-tight">
          Uji putar lima lagu
        </h2>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-zinc-400">
          Halaman ini memeriksa apakah lima lagu bisa dicari lalu diputar
          sampai habis di browser ini. Pilih satu mode, lalu biarkan uji
          berjalan. Jangan tutup tab sampai hasil akhir muncul.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void startRun('cepat')}
            disabled={running}
            data-testid="spike-mode-cepat"
            className="rounded-xl border border-white/10 bg-zinc-900 p-4 text-left transition-all duration-150 active:scale-[0.98] disabled:opacity-50"
          >
            <span className="block text-base font-medium">Periksa cepat</span>
            <span className="mt-1 block text-sm text-zinc-400">
              30 detik per lagu. Total sekitar 3 menit.
            </span>
          </button>
          <button
            type="button"
            onClick={() => void startRun('penuh')}
            disabled={running}
            data-testid="spike-mode-penuh"
            className="rounded-xl border border-white/10 bg-zinc-900 p-4 text-left transition-all duration-150 active:scale-[0.98] disabled:opacity-50"
          >
            <span className="block text-base font-medium">Putar penuh</span>
            <span className="mt-1 block text-sm text-zinc-400">
              5 lagu sampai habis. Total sekitar 23 menit.
            </span>
          </button>
        </div>

        {running && (
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-sm text-zinc-400" data-testid="spike-elapsed">
              Waktu jalan: {formatDurationMs(elapsedMs)}
            </p>
            <button
              type="button"
              onClick={handleStop}
              data-testid="spike-stop"
              className="h-11 rounded-xl border border-white/10 bg-zinc-900 px-4 text-sm font-medium"
            >
              Hentikan
            </button>
          </div>
        )}

        {generalNote && (
          <p
            role="status"
            className="mt-4 rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-400"
          >
            {generalNote}
          </p>
        )}

        <audio
          ref={audioRef}
          controls
          preload="auto"
          data-testid="spike-audio"
          className="mt-6 w-full"
        />

        <ol className="mt-6 space-y-3" data-testid="spike-song-list">
          {results.map((result, index) => {
            const active = result.status === 'mencari' || result.status === 'memutar';
            const progress =
              result.lengthSeconds > 0
                ? Math.min(100, (result.heardSeconds / result.lengthSeconds) * 100)
                : 0;
            return (
              <li
                key={result.videoId}
                data-testid={`spike-song-${index}`}
                data-status={result.status}
                className="rounded-xl border border-white/10 bg-zinc-900 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-base font-medium">
                    {index + 1}. {result.title}
                  </p>
                  <span
                    className={
                      result.status === 'selesai'
                        ? 'shrink-0 text-sm font-medium text-emerald-400'
                        : result.status === 'gagal'
                          ? 'shrink-0 text-sm font-medium text-rose-400'
                          : active
                            ? 'shrink-0 text-sm font-medium text-blue-400'
                            : 'shrink-0 text-sm text-zinc-400'
                    }
                  >
                    {statusLabel(result.status)}
                  </span>
                </div>
                <p className="mt-1 text-sm tabular-nums text-zinc-400">
                  {formatSeconds(result.heardSeconds)} dari{' '}
                  {formatSeconds(result.lengthSeconds)}
                  {result.resolveMs !== null &&
                    ` . Cari lagu ${(result.resolveMs / 1000).toFixed(1)} detik`}
                  {result.client &&
                    ` . ${result.client}${result.usedSolver ? ' (lewat solver)' : ''}`}
                  {result.retries > 0 && ` . Coba ulang ${result.retries}x`}
                </p>
                <div
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800"
                  aria-hidden="true"
                >
                  <div
                    className={
                      result.status === 'gagal'
                        ? 'h-full bg-rose-400'
                        : result.status === 'selesai'
                          ? 'h-full bg-emerald-400'
                          : 'h-full bg-white'
                    }
                    style={{ width: `${progress}%` }}
                  />
                </div>
                {result.failCause && (
                  <p className="mt-2 text-sm text-rose-400">{result.failCause}</p>
                )}
              </li>
            );
          })}
        </ol>

        {(phase === 'done' || phase === 'stopped') && (
          <section
            className="mt-6 rounded-xl border border-white/10 bg-zinc-900 p-4"
            data-testid="spike-summary"
          >
            <h3 className="text-base font-medium">
              Hasil: {summary.done}/{summary.total} lagu selesai
            </h3>
            <p className="mt-1 text-sm text-zinc-400">
              {phase === 'done'
                ? 'Uji selesai. Salin laporan di bawah lalu tempel kembali ke tim.'
                : 'Uji dihentikan sebelum semua lagu dicoba. Laporan berisi hasil sampai titik ini.'}
            </p>
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={!report}
              data-testid="spike-copy"
              className="mt-4 h-11 rounded-xl bg-white px-4 text-sm font-medium text-black disabled:opacity-50"
            >
              {copied ? 'Hasil tersalin' : 'Salin hasil'}
            </button>
            <pre
              data-testid="spike-report"
              className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg bg-black p-3 text-xs leading-relaxed text-zinc-300"
            >
              {report}
            </pre>
          </section>
        )}
      </main>
    </div>
  );
}
