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

interface TrackRowProps {
  title: string;
  /** Keterangan di bawah judul (artis, album, jumlah putar). */
  subtitle?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  /** Tampilkan penanda "Tersimpan" (lagu sudah di Library/unduhan). */
  saved?: boolean;
  onClick: () => void;
  testId?: string;
}

export default function TrackRow({
  title,
  subtitle,
  thumbnailUrl,
  durationSeconds,
  saved,
  onClick,
  testId,
}: TrackRowProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = thumbnailUrl != null && !imgFailed;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className="flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-white/5 active:bg-white/10"
      >
        {showImg ? (
          <img
            src={thumbnailUrl}
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
      </button>
    </li>
  );
}
