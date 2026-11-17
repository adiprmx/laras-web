/**
 * Tombol hati: suka / batal suka satu lagu. Bila lagu belum ada
 * di database (mis. baru diputar dari beranda), lagunya disimpan
 * dulu lalu difavoritkan.
 */
import { useEffect, useState } from 'react';
import { Heart } from '@phosphor-icons/react';
import { getLibraryService } from '../../data/library';
import { useLibraryStore } from '../../store/library';
import { strings } from '../../strings/id';

interface FavoriteButtonProps {
  songId: string;
  title: string;
  artist?: string;
  durationSeconds?: number | null;
  artwork?: string | null;
  size?: number;
  testId?: string;
}

export default function FavoriteButton({
  songId,
  title,
  artist,
  durationSeconds,
  artwork,
  size = 22,
  testId,
}: FavoriteButtonProps) {
  const version = useLibraryStore((s) => s.version);
  const [liked, setLiked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getLibraryService()
      .then((service) => service.isLiked(songId))
      .then((value) => {
        if (alive) setLiked(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [songId, version]);

  const toggle = (): void => {
    if (busy) return;
    setBusy(true);
    void getLibraryService()
      .then(async (service) => {
        try {
          return await service.toggleLiked(songId);
        } catch {
          // Lagu belum ada di database: simpan dulu, lalu suka.
          await service.upsertSong(
            {
              id: songId,
              title,
              albumId: null,
              durationSeconds: durationSeconds ?? null,
              thumbnailUrl: artwork ?? null,
              liked: 0,
              totalPlayTimeMs: 0,
              inLibrary: 0,
              downloadState: 0,
              filePath: null,
              fileSizeBytes: null,
              downloadedAt: null,
              formatId: null,
              unplayable: 0,
            },
            { artistNames: artist ? [artist] : [], addToLibrary: false },
          );
          return service.toggleLiked(songId);
        }
      })
      .then((value) => setLiked(value))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-label={liked ? strings.unlike : strings.like}
      aria-pressed={liked}
      data-testid={testId ?? `favorite-${songId}`}
      className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors active:scale-95 disabled:opacity-50 ${
        liked ? 'text-white' : 'text-zinc-400 hover:text-zinc-100'
      }`}
    >
      <Heart size={size} weight={liked ? 'fill' : 'regular'} />
    </button>
  );
}
