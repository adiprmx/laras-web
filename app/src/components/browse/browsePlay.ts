/**
 * Putar lagu dari rak browse: mengetuk satu lagu memutar lagu itu
 * dan memasukkan sisa lagu rak itu ke antrean (pola yang sama
 * dengan hasil pencarian, PRD B1.1).
 */
import type { BrowseItem } from '../../extractor/searchParser';
import { getPlayerService } from '../../player/service';
import { streamTrack } from '../../player/types';

/** Ubah item lagu browse menjadi Track pemutar. */
export function trackFromBrowseItem(item: BrowseItem) {
  const track = streamTrack(
    item.videoId ?? '',
    item.title,
    item.durationSeconds,
    item.thumbnailUrl,
  );
  if (item.artist) track.artist = item.artist;
  if (item.album) track.album = item.album;
  return track;
}

/**
 * Putar lagu-lagu di satu rak mulai dari item ke-`index` (indeks
 * di dalam daftar item rak, bukan hanya lagu — item bukan lagu
 * dilewati saat menghitung posisi mulai).
 */
export function playBrowseShelfItems(
  items: BrowseItem[],
  index: number,
): void {
  const songs = items.filter((i) => i.kind === 'song');
  const songIndex =
    items.slice(0, index + 1).filter((i) => i.kind === 'song').length - 1;
  if (songs.length === 0 || songIndex < 0) return;
  void getPlayerService().playQueue(
    songs.map(trackFromBrowseItem),
    songIndex,
  );
}

/** Putar semua lagu di satu halaman browse dari awal. */
export function playAllBrowseSongs(songs: BrowseItem[]): void {
  if (songs.length === 0) return;
  void getPlayerService().playQueue(songs.map(trackFromBrowseItem), 0);
}
