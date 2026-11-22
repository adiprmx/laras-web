/**
 * Rak-rak halaman browse: daftar lagu vertikal untuk rak lagu,
 * deretan kartu horizontal untuk rak album/artis/playlist/
 * kategori. Dipakai beranda Jelajah (3 rak pertama) dan halaman
 * browse penuh (semua rak).
 */
import type { BrowseShelf } from '../../extractor/searchParser';
import BrowseCard from '../BrowseCard';
import TrackRow from '../TrackRow';
import { playBrowseShelfItems } from './browsePlay';

interface BrowseShelvesProps {
  shelves: BrowseShelf[];
  /** Navigasi ke halaman browse lain (album/artis/playlist/mood). */
  onNavigate: (path: string) => void;
  testIdPrefix?: string;
  /** Batas lagu per rak lagu (undefined = semua). */
  maxSongsPerShelf?: number;
}

export default function BrowseShelves({
  shelves,
  onNavigate,
  testIdPrefix = 'browse',
  maxSongsPerShelf,
}: BrowseShelvesProps) {
  return (
    <div data-testid={`${testIdPrefix}-shelves`}>
      {shelves.map((shelf, shelfIndex) => (
        <div
          key={`${shelf.title}-${shelfIndex}`}
          className="mt-6 first:mt-0"
          data-testid={`${testIdPrefix}-shelf-${shelfIndex}`}
        >
          {shelf.title ? (
            <h3 className="text-base font-semibold tracking-tight">
              {shelf.title}
            </h3>
          ) : null}
          {shelf.isSongList ? (
            <ul className="mt-2 divide-y divide-white/5">
              {shelf.items
                .slice(
                  0,
                  maxSongsPerShelf ?? shelf.items.length,
                )
                .map((item, itemIndex) => (
                <TrackRow
                  key={`${item.videoId ?? item.title}-${itemIndex}`}
                  title={item.title}
                  subtitle={item.subtitle ?? item.artist}
                  thumbnailUrl={item.thumbnailUrl}
                  durationSeconds={item.durationSeconds}
                  testId={`${testIdPrefix}-song-${item.videoId ?? itemIndex}`}
                  onClick={() =>
                    playBrowseShelfItems(shelf.items, itemIndex)
                  }
                />
              ))}
            </ul>
          ) : (
            <div className="mt-2 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
              {shelf.items.map((item, itemIndex) => {
                // P-Links: kartu non-lagu adalah tautan (AppLink
                // lewat prop `to` BrowseCard); lagu tetap tombol
                // putar. browseId dari respons YTM bisa mengandung
                // `/` atau `%` (Red 1 R2): tanpa encode, rute
                // rusak atau parseRoute crash.
                const params = item.browseParams
                  ? `?params=${encodeURIComponent(item.browseParams)}`
                  : '';
                const to =
                  item.kind !== 'song' && item.browseId
                    ? `/browse/${encodeURIComponent(item.browseId)}${params}`
                    : undefined;
                return (
                  <BrowseCard
                    key={`${item.browseId ?? item.videoId ?? item.title}-${itemIndex}`}
                    item={item}
                    testId={`${testIdPrefix}-card-${item.browseId ?? item.videoId ?? itemIndex}`}
                    to={to}
                    onNavigate={onNavigate}
                    onClick={
                      item.kind === 'song'
                        ? () =>
                            playBrowseShelfItems(shelf.items, itemIndex)
                        : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
