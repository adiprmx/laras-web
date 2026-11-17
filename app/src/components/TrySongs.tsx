/**
 * Seksi "Coba pemutar" di beranda: lima lagu kanari nyata (judul +
 * durasi terverifikasi dari probe APK; tanpa nama artis karena
 * tidak terverifikasi). Ketuk satu lagu untuk memutar seluruh
 * daftar mulai dari lagu itu.
 */
import { CANARY_SONGS } from '../spike/config';
import { streamTrack } from '../player/types';
import { getPlayerService } from '../player/service';
import { formatTime } from '../player/format';
import { strings } from '../strings/id';

export default function TrySongs() {
  const tracks = CANARY_SONGS.map((song) =>
    streamTrack(song.videoId, song.title, song.lengthSeconds),
  );

  return (
    <section aria-label={strings.tryPlayerTitle} className="mt-12 text-left">
      <h2 className="text-xl font-semibold tracking-tight">
        {strings.tryPlayerTitle}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        {strings.tryPlayerBody}
      </p>
      <ul className="mt-6 divide-y divide-white/5" data-testid="try-songs">
        {tracks.map((track, index) => (
          <li key={track.id}>
            <button
              type="button"
              onClick={() =>
                void getPlayerService().playQueue(tracks, index)
              }
              data-testid={`try-song-${track.source.kind === 'stream' ? track.source.videoId : track.id}`}
              className="flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-white/5 active:bg-white/10"
            >
              {track.artwork && (
                <img
                  src={track.artwork}
                  alt=""
                  width={120}
                  height={90}
                  loading="lazy"
                  className="h-12 w-16 shrink-0 rounded-lg object-cover"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-100">
                  {track.title}
                </span>
                <span className="block text-xs text-zinc-400">
                  {formatTime(track.durationSeconds ?? 0)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
