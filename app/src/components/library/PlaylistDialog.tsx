/** Dialog buat / ubah playlist: nama + deskripsi. */
import { useState } from 'react';
import {
  MAX_PLAYLIST_DESCRIPTION_LENGTH,
  MAX_PLAYLIST_NAME_LENGTH,
} from '../../data/library';
import { strings } from '../../strings/id';

interface PlaylistDialogProps {
  title: string;
  submitLabel: string;
  initialName?: string;
  initialDescription?: string | null;
  onSubmit: (name: string, description: string | null) => void;
  onCancel: () => void;
}

export default function PlaylistDialog({
  title,
  submitLabel,
  initialName = '',
  initialDescription = null,
  onSubmit,
  onCancel,
}: PlaylistDialogProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Nama playlist tidak boleh kosong.');
      return;
    }
    if (trimmed.length > MAX_PLAYLIST_NAME_LENGTH) {
      setError(`Nama playlist paling panjang ${MAX_PLAYLIST_NAME_LENGTH} karakter.`);
      return;
    }
    if (description.trim().length > MAX_PLAYLIST_DESCRIPTION_LENGTH) {
      setError(
        `Deskripsi paling panjang ${MAX_PLAYLIST_DESCRIPTION_LENGTH} karakter.`,
      );
      return;
    }
    onSubmit(trimmed, description.trim() || null);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="playlist-dialog"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
        <label
          htmlFor="playlist-name"
          className="mt-4 block text-sm font-medium text-zinc-100"
        >
          {strings.playlistName}
        </label>
        <input
          id="playlist-name"
          type="text"
          value={name}
          maxLength={MAX_PLAYLIST_NAME_LENGTH}
          placeholder={strings.playlistNamePlaceholder}
          autoFocus
          data-testid="playlist-name-input"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          className="mt-1 h-11 w-full rounded-xl border border-white/10 bg-black px-4 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
        />
        <label
          htmlFor="playlist-description"
          className="mt-4 block text-sm font-medium text-zinc-100"
        >
          {strings.playlistDescription}
        </label>
        <textarea
          id="playlist-description"
          value={description}
          maxLength={MAX_PLAYLIST_DESCRIPTION_LENGTH}
          placeholder={strings.playlistDescriptionPlaceholder}
          rows={2}
          data-testid="playlist-description-input"
          onChange={(e) => setDescription(e.target.value)}
          className="mt-1 w-full resize-none rounded-xl border border-white/10 bg-black px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="playlist-cancel"
            className="h-11 rounded-xl px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            {strings.cancel}
          </button>
          <button
            type="button"
            onClick={submit}
            data-testid="playlist-submit"
            className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform duration-150 active:scale-95"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
