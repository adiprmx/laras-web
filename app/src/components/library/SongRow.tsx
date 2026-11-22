/** Satu baris lagu di daftar: sampul, judul, artis, durasi, menu. */
import { DotsThreeVertical } from '@phosphor-icons/react';
import type { SongView } from '../../data/types';
import { formatTime } from '../../player/format';
import { coverSrcSet } from '../coverSrc';

interface SongRowProps {
  view: SongView;
  onPlay: () => void;
  onMenu: () => void;
  /** Teks kecil di bawah judul selain nama artis (mis. waktu putar). */
  subtitle?: string;
  testId?: string;
}

export default function SongRow({
  view,
  onPlay,
  onMenu,
  subtitle,
  testId,
}: SongRowProps) {
  const { song, artistNames } = view;
  const artist = artistNames.join(', ');
  // srcset 48px: browser 1x mengunduh 120px, bukan 480px.
  const cover = coverSrcSet(song.thumbnailUrl, '48px');
  return (
    <li className="flex items-center gap-3 py-1" data-testid={testId}>
      <button
        type="button"
        onClick={onPlay}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/5 active:scale-[0.98]"
      >
        {song.thumbnailUrl ? (
          <img
            src={song.thumbnailUrl}
            srcSet={cover?.srcSet}
            sizes={cover?.sizes}
            alt=""
            width={48}
            height={48}
            loading="lazy"
            className="h-12 w-12 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-lg font-bold text-zinc-400"
          >
            {song.title.charAt(0)}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-zinc-100">
            {song.title}
          </span>
          <span className="block truncate text-[13px] text-zinc-400">
            {subtitle ?? artist}
          </span>
        </span>
        {song.durationSeconds != null && song.durationSeconds > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-zinc-400">
            {formatTime(song.durationSeconds)}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onMenu}
        aria-label="Pilihan lagu"
        data-testid={testId ? `${testId}-menu` : undefined}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 active:scale-95"
      >
        <DotsThreeVertical size={24} weight="bold" />
      </button>
    </li>
  );
}
