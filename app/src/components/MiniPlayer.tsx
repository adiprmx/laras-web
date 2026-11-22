/**
 * Bar putar bawah (64 px + garis progres). Titik fokus: tombol
 * putar/jeda. Bar ini tidak ditampilkan bila antrean kosong.
 * Juga me-mount IframeFallbackPlayer (P3): MiniPlayer dirender
 * di semua rute, jadi pemutar iframe hanya mount sekali dan
 * tidak ikut terbuang saat pindah halaman. Saat mode fallback
 * aktif, bar ini diganti panel fallback.
 */
import { Pause, Play } from '@phosphor-icons/react';
import { selectCurrentTrack, usePlayerStore } from '../store/player';
import { getPlayerService } from '../player/service';
import { strings } from '../strings/id';
import IframeFallbackPlayer from '../player/IframeFallbackPlayer';
import { coverSrcSet } from './coverSrc';

export default function MiniPlayer({
  withNav = false,
}: {
  /** Benar bila navigasi bawah/rail tampil (bar putar duduk di atasnya). */
  withNav?: boolean;
}) {
  const track = usePlayerStore(selectCurrentTrack);
  const status = usePlayerStore((s) => s.status);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const fallbackMode = usePlayerStore((s) => s.fallbackMode);
  const setFullPlayerOpen = usePlayerStore((s) => s.setFullPlayerOpen);

  if (!track) return null;

  const cover = coverSrcSet(track.artwork, '48px');
  const playing = status === 'playing';
  const progress = duration > 0 ? (position / duration) * 100 : 0;

  // Satu tree stabil: panel fallback SELALU mount di sini (ia
  // mengembalikan null saat tidak aktif), bar biasa disembunyikan
  // kondisional saat mode fallback aktif. Dua cabang return yang
  // berbeda akan me-remount panel saat mode berubah.
  return (
    <>
    <IframeFallbackPlayer withNav={withNav} />
    {fallbackMode !== 'iframe' && (
    <div
      data-testid="mini-player"
      className={`fixed inset-x-0 z-40 border-t border-white/10 bg-black/95 backdrop-blur-md ${
        withNav ? 'mini-player-nav-offset' : 'bottom-0'
      }`}
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {/* Garis progres: motif identitas pemutar. */}
      <div className="h-[2px] w-full bg-white/10" aria-hidden="true">
        <div
          className="h-full bg-white transition-[width] duration-200"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
      <div className="flex h-16 items-center gap-3 px-3">
        <button
          type="button"
          onClick={() => setFullPlayerOpen(true)}
          aria-label={strings.openPlayer}
          data-testid="mini-open"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          {track.artwork ? (
            <img
              src={track.artwork}
              srcSet={cover?.srcSet}
              sizes={cover?.sizes}
              alt=""
              width={48}
              height={48}
              className="h-12 w-12 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-xs text-zinc-400"
            >
              {track.title.charAt(0)}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-zinc-100">
              {track.title}
            </span>
            <span className="block truncate text-xs text-zinc-400">
              {track.artist ?? strings.nowPlaying}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => void getPlayerService().toggle()}
          aria-label={playing ? strings.pause : strings.play}
          data-testid="mini-play"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-black transition-transform duration-150 active:scale-95"
        >
          {playing ? (
            <Pause size={22} weight="fill" />
          ) : (
            <Play size={22} weight="fill" className="ml-0.5" />
          )}
        </button>
      </div>
    </div>
    )}
    </>
  );
}
