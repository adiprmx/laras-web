/**
 * Dialog "Tambah ke playlist": daftar playlist + buat baru.
 * Menambah lagu juga memasukkannya ke Library (aturan port APK).
 */
import { useEffect, useState } from 'react';
import { Plus } from '@phosphor-icons/react';
import { getLibraryService } from '../../data/library';
import type { PlaylistWithCount } from '../../data/types';
import { strings } from '../../strings/id';
import Dialog from '../Dialog';
import PlaylistDialog from './PlaylistDialog';

interface AddToPlaylistDialogProps {
  songId: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}

export default function AddToPlaylistDialog({
  songId,
  onDone,
  onCancel,
}: AddToPlaylistDialogProps) {
  const [playlists, setPlaylists] = useState<PlaylistWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    getLibraryService()
      .then((service) => service.playlistsPage({}))
      .then((page) => {
        if (alive) {
          setPlaylists(page);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const addTo = (playlistId: number, playlistName: string): void => {
    setBusyId(playlistId);
    void getLibraryService()
      .then((service) => service.addSongToPlaylist(playlistId, songId))
      .then((added) => {
        onDone(
          added
            ? `${strings.addedToPlaylist}: ${playlistName}`
            : strings.alreadyInPlaylist,
        );
      })
      .catch(() => onDone(strings.addedToPlaylist))
      .finally(() => setBusyId(null));
  };

  const createAndAdd = (name: string, description: string | null): void => {
    void getLibraryService()
      .then(async (service) => {
        const id = await service.createPlaylist(name, { description });
        await service.addSongToPlaylist(id, songId);
        return name;
      })
      .then((name) => onDone(`${strings.addedToPlaylist}: ${name}`))
      .catch(() => onDone(strings.addedToPlaylist));
  };

  if (showCreate) {
    return (
      <PlaylistDialog
        title={strings.newPlaylist}
        submitLabel={strings.createPlaylist}
        onSubmit={createAndAdd}
        onCancel={() => setShowCreate(false)}
      />
    );
  }

  return (
    <Dialog
      title={strings.addToPlaylist}
      onClose={onCancel}
      testId="add-to-playlist-dialog"
      maxHeight="80dvh"
    >
        <h2 className="text-base font-semibold text-zinc-100">
          {strings.addToPlaylist}
        </h2>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          data-testid="add-to-playlist-new"
          className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-white text-sm font-medium text-black transition-transform duration-150 active:scale-95"
        >
          <Plus size={18} weight="bold" />
          {strings.newPlaylist}
        </button>
        {loading ? (
          <p className="mt-4 text-center text-sm text-zinc-400">
            {strings.loadingMore}
          </p>
        ) : playlists.length === 0 ? (
          <p className="mt-4 text-center text-sm text-zinc-400">
            {strings.playlistsEmptyBody}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-white/5">
            {playlists.map(({ playlist, songCount }) => (
              <li key={playlist.id}>
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => addTo(playlist.id, playlist.name)}
                  data-testid={`add-to-playlist-${playlist.id}`}
                  className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/5 disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium text-zinc-100">
                      {playlist.name}
                    </span>
                    <span className="block text-[13px] text-zinc-400">
                      {songCount} {strings.songsLabel}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            data-testid="add-to-playlist-cancel"
            className="h-11 rounded-xl px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            {strings.cancel}
          </button>
        </div>
    </Dialog>
  );
}
