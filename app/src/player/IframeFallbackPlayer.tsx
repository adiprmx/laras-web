/**
 * Panel fallback pemutar YouTube (P3).
 *
 * Mount SEKALI di dalam MiniPlayer (yang dirender di semua rute):
 * satu instance YT.Player untuk seluruh sesi fallback — pindah
 * rute atau buka/tutup pemutar penuh TIDAK me-remount iframe
 * (remount = lagu mulai dari awal). Karena itu elemen host iframe
 * HANYA ADA SATU dan tidak pernah di-unmount kondisional: pindah
 * wujud docked/expanded hanya mengganti class CSS-nya.
 *
 * Dua wujud, satu pemain:
 * - Docked (pemutar penuh tertutup): bar bawah di atas navigasi,
 *   video 200x200 + judul + kontrol. 200x200 adalah ukuran
 *   viewport MINIMUM yang disyaratkan dokumen resmi YouTube —
 *   jangan diperkecil.
 * - Expanded (pemutar penuh terbuka): lembar atas (z-60, di atas
 *   FullPlayer z-50), video selebar layar 16:9 + kontrol +
 *   penjelasan. Konten FullPlayer di bawahnya tetap bisa
 *   di-scroll; tombol tutup kembali ke wujud docked.
 *
 * Kepatuhan kebijakan YouTube (dokumen resmi IFrame Player API):
 * pemutar selalu terlihat (tidak pernah display:none/ukuran 0),
 * kontrol app sendiri berada DI LUAR iframe (di bawahnya, bukan
 * overlay di atas video), dan kontrol bawaan YouTube dibiarkan
 * tampil (controls: 1).
 *
 * Batasan jujur (juga tertulis di docs/iframe-fallback.md):
 * tanpa putar latar/layar kunci, tanpa unduh, tanpa pengatur
 * suara, tanpa antrean mulus (pindah lagu mencoba cara biasa
 * dulu, lalu kembali ke sini bila masih gagal).
 */
import { useEffect, useRef, useState } from 'react';
import { CaretDown, Pause, Play } from '@phosphor-icons/react';
import { selectCurrentTrack, usePlayerStore } from '../store/player';
import { getPlayerService } from '../player/service';
import { formatTime } from '../player/format';
import { strings } from '../strings/id';
import {
  loadYouTubeIframeApi,
  registerIframeController,
  YT_PLAYER_STATE,
  type YoutubePlayer,
} from '../player/iframeFallback';

/** Interval baca posisi/durasi dari pemutar (milidetik). */
const PROGRESS_POLL_MS = 500;

export default function IframeFallbackPlayer({
  withNav = false,
}: {
  /** Benar bila navigasi bawah/rail tampil (panel duduk di atasnya). */
  withNav?: boolean;
}) {
  const fallbackMode = usePlayerStore((s) => s.fallbackMode);
  const fallbackVideoId = usePlayerStore((s) => s.fallbackVideoId);
  const fullPlayerOpen = usePlayerStore((s) => s.fullPlayerOpen);
  const status = usePlayerStore((s) => s.status);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const track = usePlayerStore(selectCurrentTrack);
  const setFullPlayerOpen = usePlayerStore((s) => s.setFullPlayerOpen);
  const [apiFailed, setApiFailed] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YoutubePlayer | null>(null);
  const videoIdRef = useRef<string | null>(null);

  const active = fallbackMode === 'iframe' && fallbackVideoId !== null;

  // Buat pemutar sekali saat mode fallback aktif; hancurkan saat
  // mode berakhir. Ganti lagu memakai loadVideoById (tanpa
  // membuat pemutar baru).
  useEffect(() => {
    if (!active || !fallbackVideoId) return;
    let cancelled = false;
    if (!hostRef.current) return;
    setApiFailed(false);
    setPlayerReady(false);
    void loadYouTubeIframeApi()
      .then((api) => {
        if (cancelled || !hostRef.current) return;
        const player = new api.Player(hostRef.current, {
          videoId: fallbackVideoId,
          playerVars: {
            autoplay: 1,
            controls: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (cancelled) return;
              setPlayerReady(true);
              registerIframeController({
                play: () => playerRef.current?.playVideo(),
                pause: () => playerRef.current?.pauseVideo(),
                seekTo: (seconds: number) =>
                  playerRef.current?.seekTo(seconds, true),
              });
            },
            onStateChange: (event) => {
              if (cancelled) return;
              const service = getPlayerService();
              if (event.data === YT_PLAYER_STATE.PLAYING) {
                service.notifyFallbackPlaying();
              } else if (event.data === YT_PLAYER_STATE.PAUSED) {
                service.notifyFallbackPaused();
              } else if (event.data === YT_PLAYER_STATE.BUFFERING) {
                service.notifyFallbackBuffering();
              } else if (event.data === YT_PLAYER_STATE.ENDED) {
                service.notifyFallbackEnded();
              }
            },
            onError: () => {
              if (cancelled) return;
              // Galat pemutar (mis. video tidak bisa diputar):
              // keluar dari mode fallback, biarkan service
              // menangani kegagalan seperti biasa.
              getPlayerService().notifyFallbackError();
            },
          },
        });
        playerRef.current = player;
        videoIdRef.current = fallbackVideoId;
      })
      .catch(() => {
        if (!cancelled) setApiFailed(true);
      });
    return () => {
      cancelled = true;
      registerIframeController(null);
      try {
        playerRef.current?.destroy();
      } catch {
        // destroy sesudah iframe dilepas bisa melempar; abaikan.
      }
      playerRef.current = null;
      videoIdRef.current = null;
      setPlayerReady(false);
    };
    // Sengaja hanya bergantung pada `active`: ganti lagu ditangani
    // efek di bawah (loadVideoById), bukan membuat pemutar baru.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Ganti lagu di pemutar yang sama (tanpa remount).
  useEffect(() => {
    if (!active || !fallbackVideoId) return;
    if (playerRef.current && videoIdRef.current !== fallbackVideoId) {
      videoIdRef.current = fallbackVideoId;
      try {
        playerRef.current.loadVideoById(fallbackVideoId);
      } catch {
        // loadVideoById sebelum ready bisa melempar; pemutar
        // sudah membawa videoId terbaru saat dibuat.
      }
    }
  }, [active, fallbackVideoId]);

  // Baca posisi/durasi berkala untuk bilah progres + store.
  useEffect(() => {
    if (!active || !playerReady) return;
    const id = window.setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      let pos = 0;
      let dur = 0;
      try {
        pos = player.getCurrentTime() || 0;
        dur = player.getDuration() || 0;
      } catch {
        return;
      }
      getPlayerService().notifyFallbackProgress(pos, dur);
    }, PROGRESS_POLL_MS);
    return () => window.clearInterval(id);
  }, [active, playerReady]);

  if (!active) return null;

  const playing = status === 'playing';
  const service = getPlayerService();
  const expanded = fullPlayerOpen;

  // Pemutar gagal dimuat (API tidak bisa diunduh): tampilkan
  // pesan + tombol kembali ke cara biasa, tanpa iframe kosong.
  // Cabang ini aman dari aturan satu-host: belum ada pemutar
  // yang dibuat saat API gagal.
  if (apiFailed) {
    return (
      <div
        data-testid="iframe-fallback"
        className={`fixed inset-x-0 z-40 border-t border-white/10 bg-black/95 backdrop-blur-md ${
          withNav ? 'mini-player-nav-offset' : 'bottom-0'
        }`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="mx-auto max-w-md px-4 py-4">
          <p className="text-sm text-zinc-100">{strings.fallbackFailed}</p>
          <button
            type="button"
            onClick={() => void service.retryNormalPlayback()}
            data-testid="fallback-retry-normal"
            className="mt-3 rounded-full border border-white/15 px-3 py-2 text-xs font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            {strings.fallbackRetryNormal}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="iframe-fallback"
      className={
        expanded
          ? 'fixed inset-x-0 top-0 z-[60] border-b border-white/10 bg-black/95 backdrop-blur-md'
          : `fixed inset-x-0 z-40 border-t border-white/10 bg-black/95 backdrop-blur-md ${
              withNav ? 'mini-player-nav-offset' : 'bottom-0'
            }`
      }
      style={
        expanded
          ? undefined
          : { paddingBottom: 'env(safe-area-inset-bottom, 0px)' }
      }
    >
      <div
        className={
          expanded
            ? 'mx-auto w-full max-w-md px-4 pb-4 pt-3 sm:max-w-lg'
            : 'mx-auto flex w-full max-w-md gap-3 px-3 py-3'
        }
      >
        {expanded && (
          <div
            key="fallback-header"
            className="mb-3 flex items-center justify-between"
          >
            <p className="text-sm font-medium text-zinc-100">
              {strings.fallbackTitle}
            </p>
            <button
              type="button"
              onClick={() => setFullPlayerOpen(false)}
              aria-label={strings.closePlayer}
              data-testid="fallback-collapse"
              className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
            >
              <CaretDown size={24} aria-hidden="true" />
            </button>
          </div>
        )}
        {/*
          SATU-SATUNYA host iframe. Pindah wujud hanya mengganti
          class ukuran — elemen ini tidak pernah di-unmount
          kondisional selama mode fallback aktif. Ketiga anak
          container memakai key stabil supaya header kondisional
          (expanded) tidak menggeser posisi host di rekonsiliasi
          React (tanpa key, iframe ikut terbuang saat wujud
          berubah dan lagu mulai dari awal).
          Docked 200x200 = viewport minimum syarat YouTube;
          expanded 16:9 selebar layar (>= 200x200).
        */}
        <div
          key="fallback-host"
          ref={hostRef}
          data-testid="fallback-player-host"
          className={
            expanded
              ? 'aspect-video w-full overflow-hidden rounded-xl bg-zinc-900'
              : 'h-[200px] w-[200px] shrink-0 overflow-hidden rounded-xl bg-zinc-900'
          }
        />
        <div
          key="fallback-controls"
          className={expanded ? 'mt-3' : 'min-w-0 flex-1 py-1'}
        >
          {!playerReady && (
            <p className="mb-2 text-xs text-zinc-400">
              {strings.fallbackLoading}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void service.toggle()}
              disabled={!playerReady}
              aria-label={playing ? strings.pause : strings.play}
              data-testid="fallback-toggle"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-black transition-transform duration-150 active:scale-95 disabled:opacity-60"
            >
              {playing ? (
                <Pause size={24} weight="fill" aria-hidden="true" />
              ) : (
                <Play size={24} weight="fill" aria-hidden="true" />
              )}
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-zinc-100">
                {track?.title ?? fallbackVideoId}
              </p>
              <p className="truncate text-xs text-zinc-400">
                {strings.fallbackPlayingVia}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void service.retryNormalPlayback()}
              data-testid="fallback-retry-normal"
              className="shrink-0 rounded-full border border-white/15 px-3 py-2 text-xs font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
            >
              {strings.fallbackRetryNormal}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-zinc-400">
              {formatTime(Math.floor(position))}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0, Math.floor(duration))}
              value={Math.min(Math.floor(position), Math.floor(duration))}
              onChange={(e) => service.seek(Number(e.target.value))}
              disabled={!playerReady || duration <= 0}
              aria-label={strings.seek}
              data-testid="fallback-seek"
              className="h-1 min-w-0 flex-1 accent-white"
            />
            <span className="w-10 shrink-0 text-[11px] tabular-nums text-zinc-400">
              {formatTime(Math.floor(duration))}
            </span>
          </div>
          {expanded ? (
            <p className="mt-3 text-xs leading-relaxed text-zinc-400">
              {strings.fallbackLimits}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setFullPlayerOpen(true)}
              aria-label={strings.openPlayer}
              data-testid="fallback-expand"
              className="mt-2 text-xs font-medium text-zinc-300 underline decoration-white/30 underline-offset-2"
            >
              {strings.fallbackExpand}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
