/**
 * Dialog impor playlist Spotify tanpa API (P8, PRD B10.2/B10.4).
 *
 * Dua jalur: file (utama — tempel teks atau pilih file) dan
 * tautan publik (sekunder — hanya 30 lagu pertama terbaca).
 * Sesudah daftar dibaca, pengguna bisa mengubah nama playlist
 * baru, lalu tiap lagu dicocokkan ke YouTube Music satu per
 * satu dengan indikator progres + tombol berhenti. Lagu yang
 * tidak cocok dicatat gagal, tidak pernah ditebak.
 *
 * Tidak ada login Spotify, tidak ada client id/secret, tidak
 * ada panggilan ke api.spotify.com — selamanya.
 */
import { useRef, useState } from 'react';
import type { ImportReport } from '../../backup/report';
import {
  fetchFromLink,
  importDraft,
  parseSpotifyFile,
  SpotifyFileException,
  SpotifyLinkException,
  type SpotifyPlaylistDraft,
} from '../../backup/spotify';
import { strings } from '../../strings/id';
import ImportReportView from './ImportReportView';

function linkErrorText(error: unknown): string {
  if (error instanceof SpotifyLinkException) {
    switch (error.kind) {
      case 'invalidUrl':
        return strings.spotifyErrorInvalidUrl;
      case 'unreadable':
        return strings.spotifyErrorUnreadable;
      case 'empty':
        return strings.spotifyErrorEmpty;
    }
  }
  return strings.spotifyErrorUnreadable;
}

export default function SpotifyImportDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'file' | 'link'>('file');
  const [pasted, setPasted] = useState('');
  const [link, setLink] = useState('');
  const [draft, setDraft] = useState<SpotifyPlaylistDraft | null>(null);
  const [playlistName, setPlaylistName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  const openDraft = (next: SpotifyPlaylistDraft) => {
    setDraft(next);
    setPlaylistName(next.name ?? strings.spotifyNameDefault);
    setError(null);
  };

  const handleReadPasted = () => {
    setError(null);
    try {
      openDraft(
        parseSpotifyFile(new TextEncoder().encode(pasted)),
      );
    } catch (e) {
      setError(
        e instanceof SpotifyFileException
          ? strings.spotifyErrorPasted
          : strings.spotifyErrorFile,
      );
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      openDraft(parseSpotifyFile(bytes, file.name));
    } catch {
      setError(strings.spotifyErrorFile);
    }
  };

  const handleFetchLink = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      openDraft(await fetchFromLink(link));
    } catch (e) {
      setError(linkErrorText(e));
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async () => {
    if (!draft || importing) return;
    const name = playlistName.trim() === '' ? strings.spotifyNameDefault : playlistName.trim();
    cancelledRef.current = false;
    setImporting(true);
    setProgress([0, draft.tracks.length]);
    try {
      const result = await importDraft(
        draft,
        {
          playlistName: name,
          onProgress: (done, total) => setProgress([done, total]),
          isCancelled: () => cancelledRef.current,
        },
      );
      setReport(result);
    } finally {
      setImporting(false);
    }
  };

  const done = report !== null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={strings.spotifyImportTitle}
      data-testid="spotify-import-dialog"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100">
          {done ? strings.spotifyDoneTitle : strings.spotifyImportTitle}
        </h2>

        {!done && draft === null ? (
          <div>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              {strings.spotifyImportBody}
            </p>
            <div
              role="tablist"
              aria-label={strings.spotifyImportTitle}
              className="mt-4 flex gap-2"
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'file'}
                onClick={() => setTab('file')}
                data-testid="spotify-tab-file"
                className={`h-11 rounded-full px-5 text-sm font-medium transition-colors active:scale-95 ${
                  tab === 'file'
                    ? 'bg-white text-black'
                    : 'border border-white/15 text-zinc-300 hover:bg-white/5'
                }`}
              >
                {strings.spotifyTabFile}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'link'}
                onClick={() => setTab('link')}
                data-testid="spotify-tab-link"
                className={`h-11 rounded-full px-5 text-sm font-medium transition-colors active:scale-95 ${
                  tab === 'link'
                    ? 'bg-white text-black'
                    : 'border border-white/15 text-zinc-300 hover:bg-white/5'
                }`}
              >
                {strings.spotifyTabLink}
              </button>
            </div>

            {tab === 'file' ? (
              <div className="mt-4">
                <label
                  htmlFor="spotify-paste"
                  className="text-sm text-zinc-400"
                >
                  {strings.spotifyPasteHint}
                </label>
                <textarea
                  id="spotify-paste"
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  rows={5}
                  data-testid="spotify-paste"
                  className="mt-2 w-full resize-y rounded-xl border border-white/15 bg-black/40 p-3 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:border-white/40 focus:outline-none"
                  placeholder="Peterpan - Semua Tentang Kita"
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.csv,.json,text/plain,text/csv,application/json"
                  className="hidden"
                  data-testid="spotify-file-input"
                  onChange={(e) => void handleFile(e.target.files?.[0])}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleReadPasted}
                    disabled={pasted.trim() === ''}
                    data-testid="spotify-read-pasted"
                    className="h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95 disabled:opacity-50"
                  >
                    {strings.spotifyReadFile}
                  </button>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    data-testid="spotify-choose-file"
                    className="h-11 rounded-full border border-white/15 px-6 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
                  >
                    {strings.spotifyChooseFile}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4">
                <label
                  htmlFor="spotify-link"
                  className="text-sm text-zinc-400"
                >
                  {strings.spotifyLinkHint}
                </label>
                <input
                  id="spotify-link"
                  type="url"
                  inputMode="url"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder={strings.spotifyLinkPlaceholder}
                  data-testid="spotify-link-input"
                  className="mt-2 w-full rounded-xl border border-white/15 bg-black/40 p-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/40 focus:outline-none"
                />
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                  {strings.spotifyLinkLimit}
                </p>
                <button
                  type="button"
                  onClick={() => void handleFetchLink()}
                  disabled={loading || link.trim() === ''}
                  data-testid="spotify-fetch-link"
                  className="mt-3 h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95 disabled:opacity-50"
                >
                  {loading ? strings.spotifyFetching : strings.spotifyFetchLink}
                </button>
              </div>
            )}
            {error ? (
              <p
                data-testid="spotify-error"
                className="mt-3 text-sm text-red-300"
              >
                {error}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                data-testid="spotify-cancel"
                className="h-11 rounded-xl px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
              >
                {strings.cancel}
              </button>
            </div>
          </div>
        ) : null}

        {!done && draft !== null ? (
          <div className="mt-3">
            <p data-testid="spotify-track-count" className="text-sm text-zinc-300">
              {strings.spotifyTrackCount(draft.tracks.length)}
            </p>
            {draft.truncated ? (
              <p
                data-testid="spotify-truncated"
                className="mt-1 text-sm text-amber-200"
              >
                {strings.spotifyLinkTruncated}
              </p>
            ) : null}
            <label
              htmlFor="spotify-name"
              className="mt-4 block text-sm text-zinc-400"
            >
              {strings.spotifyNameLabel}
            </label>
            <input
              id="spotify-name"
              type="text"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              disabled={importing}
              data-testid="spotify-playlist-name"
              className="mt-2 w-full rounded-xl border border-white/15 bg-black/40 p-3 text-sm text-zinc-100 focus:border-white/40 focus:outline-none disabled:opacity-50"
            />
            {importing && progress ? (
              <div className="mt-4">
                <div
                  role="progressbar"
                  aria-valuenow={progress[0]}
                  aria-valuemin={0}
                  aria-valuemax={progress[1]}
                  data-testid="spotify-progress"
                  className="h-2 overflow-hidden rounded-full bg-zinc-700"
                >
                  <div
                    className="h-full bg-white transition-all"
                    style={{
                      width: `${
                        progress[1] === 0
                          ? 0
                          : Math.round((progress[0] / progress[1]) * 100)
                      }%`,
                    }}
                  />
                </div>
                <p className="mt-2 text-sm text-zinc-400">
                  {strings.spotifyProgress(progress[0], progress[1])}
                </p>
              </div>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              {importing ? (
                <button
                  type="button"
                  onClick={() => {
                    cancelledRef.current = true;
                  }}
                  data-testid="spotify-stop"
                  className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
                >
                  {strings.spotifyCancel}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setDraft(null)}
                    data-testid="spotify-back"
                    className="h-11 rounded-xl px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
                  >
                    {strings.back}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleStart()}
                    data-testid="spotify-start"
                    className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform active:scale-95"
                  >
                    {strings.spotifyStart}
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}

        {done && report ? (
          <div className="mt-3">
            <ImportReportView report={report} />
            {report.playlistId === null ? (
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                {strings.spotifyNoMatch}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                data-testid="spotify-close"
                className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform active:scale-95"
              >
                {strings.done}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
