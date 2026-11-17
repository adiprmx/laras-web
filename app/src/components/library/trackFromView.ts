/** Ubah satu lagu dari database menjadi Track pemutar. */
import { localTrack, streamTrack, type Track } from '../../player/types';
import type { SongView } from '../../data/types';

export function trackFromView(view: SongView): Track {
  const { song } = view;
  const artist = view.artistNames.join(', ');
  // Lagu lokal antrean memakai URL http(s) sebagai id.
  const isLocal =
    song.id.startsWith('http://') || song.id.startsWith('https://');
  const track = isLocal
    ? localTrack(song.id, song.title, song.durationSeconds ?? undefined)
    : streamTrack(
        song.id,
        song.title,
        song.durationSeconds ?? undefined,
        song.thumbnailUrl ?? undefined,
      );
  if (artist) track.artist = artist;
  if (isLocal && song.thumbnailUrl) track.artwork = song.thumbnailUrl;
  return track;
}

export function tracksFromViews(views: SongView[]): Track[] {
  return views.map((v) => trackFromView(v));
}
