/**
 * Baris lagu generik (hasil cari, rak browse, seksi beranda):
 * sampul, judul, keterangan, durasi, penanda "Tersimpan".
 *
 * Berbeda dengan SongRow Library (yang membawa menu konteks +
 * data database), baris ini hanya menampilkan data tampil dan
 * satu aksi ketuk. Dipakai hasil jaringan (SearchSong/BrowseItem)
 * maupun lagu database (SongView) lewat props yang sama.
 *
 * Bila sampul gagal dimuat (offline / host gambar lambat),
 * tampil ubin huruf awal — bukan kotak kosong.
 */
import { useState } from 'react';
import { formatTime } from '../player/format';
import { strings } from '../strings/id';
import AppLink from './AppLink';
import { coverSrcSet } from './coverSrc';

interface TrackRowProps {
  title: string;
  /** Keterangan di bawah judul (artis, album, jumlah putar). */
  subtitle?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  /** Tampilkan penanda "Tersimpan" (lagu sudah di Library/unduhan). */
  saved?: boolean;
  /** Aksi ketuk (putar). Bila `to` diisi, baris adalah tautan. */
  onClick?: () => void;
  /** P-Links: tujuan tautan (album/artis/playlist hasil cari). */
  to?: string;
  onNavigate?: (path: string) => void;
  testId?: string;
}

export default function TrackRow({
  title,
  subtitle,
  thumbnailUrl,
  durationSeconds,
  saved,
  onClick,
  to,
  onNavigate,
  testId,
}: TrackRowProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = thumbnailUrl != null && !imgFailed;
  const cover = coverSrcSet(thumbnailUrl, '48px');
  const rowClass =
    'flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-white/5 active:bg-white/10';
  // P-Links: baris tautan memakai AppLink (<a href> semantik);
  // baris aksi tetap <button>. Isi di dalam identik.
  const inner = (
    <>
      {showImg ? (
        <img
          src={thumbnailUrl}
          srcSet={cover?.srcSet}
          sizes={cover?.sizes}
          alt=""
          width={48}
          height={48}
          loading="lazy"
          decoding="async"
          onError={() => setImgFailed(true)}
          className="h-12 w-12 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-sm text-zinc-400"
        >
          {title.charAt(0)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-zinc-100">
          {title}
        </span>
        {subtitle ? (
          <span className="block truncate text-xs text-zinc-400">
            {subtitle}
          </span>
        ) : null}
        {saved ? (
          <span className="mt-0.5 inline-block rounded-full border border-white/15 px-2 py-px text-[11px] text-zinc-400">
            {strings.savedLabel}
          </span>
        ) : null}
      </span>
      {durationSeconds != null && durationSeconds > 0 ? (
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">
          {formatTime(durationSeconds)}
        </span>
      ) : null}
    </>
  );
  return (
    <li>
      {to && onNavigate ? (
        <AppLink to={to} onNavigate={onNavigate} testId={testId} className={rowClass}>
          {inner}
        </AppLink>
      ) : (
        <button
          type="button"
          onClick={onClick}
          data-testid={testId}
          className={rowClass}
        >
          {inner}
        </button>
      )}
    </li>
  );
}
