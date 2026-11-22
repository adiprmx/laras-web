/**
 * Kartu browse (rak Jelajah, rak album/artis/playlist): sampul
 * persegi + judul + keterangan. Diketuk untuk membuka halaman
 * atau memutar lagu, sesuai jenis item.
 *
 * Bila sampul gagal dimuat (offline / host gambar lambat),
 * tampil ubin huruf awal — bukan kotak kosong.
 *
 * P-Links: kartu yang membuka halaman memakai `to` (AppLink
 * <a href> semantik); kartu lagu tetap <button> (aksi putar).
 */
import { useState } from 'react';
import { Play } from '@phosphor-icons/react';
import type { BrowseItem } from '../extractor/searchParser';
import AppLink from './AppLink';
import { coverSrcSet } from './coverSrc';

interface BrowseCardProps {
  item: BrowseItem;
  /** Aksi ketuk (putar lagu). Bila `to` diisi, kartu adalah tautan. */
  onClick?: () => void;
  /** P-Links: tujuan tautan (halaman browse album/artis/playlist). */
  to?: string;
  onNavigate?: (path: string) => void;
  testId?: string;
}

export default function BrowseCard({
  item,
  onClick,
  to,
  onNavigate,
  testId,
}: BrowseCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = item.thumbnailUrl != null && !imgFailed;
  // Kartu 132px (HP) / 148px (sm+).
  const cover = coverSrcSet(
    item.thumbnailUrl,
    '(min-width: 640px) 148px, 132px',
  );
  const cardClass =
    'w-[132px] shrink-0 snap-start text-left transition-colors active:bg-white/5 sm:w-[148px]';
  const inner = (
    <>
      <span className="relative block">
        {showImg ? (
          <img
            src={item.thumbnailUrl}
            srcSet={cover?.srcSet}
            sizes={cover?.sizes}
            alt=""
            width={148}
            height={148}
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
            className="aspect-square w-full rounded-xl object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex aspect-square w-full items-center justify-center rounded-xl bg-zinc-900 text-2xl text-zinc-400"
          >
            {item.title.charAt(0)}
          </span>
        )}
        {item.kind === 'song' ? (
          <span
            aria-hidden="true"
            className="absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-white text-black"
          >
            <Play size={16} weight="fill" />
          </span>
        ) : null}
      </span>
      <span className="mt-2 block truncate text-sm font-medium text-zinc-100">
        {item.title}
      </span>
      {item.subtitle ? (
        <span className="block truncate text-xs text-zinc-400">
          {item.subtitle}
        </span>
      ) : null}
    </>
  );
  if (to && onNavigate) {
    return (
      <AppLink to={to} onNavigate={onNavigate} testId={testId} className={cardClass}>
        {inner}
      </AppLink>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cardClass}
    >
      {inner}
    </button>
  );
}
