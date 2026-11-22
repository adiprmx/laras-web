/**
 * Layar Cari: pencarian YouTube Music + pencarian Library lokal.
 *
 * Aturan yang mengikat (PRD B1.1): pencarian JARINGAN hanya jalan
 * saat pengguna mengirim kueri secara eksplisit (tombol Cari /
 * Enter / ketuk saran / ketuk riwayat). Mengetik TIDAK PERNAH
 * memicu request search — yang muncul saat mengetik hanyalah
 * saran (riwayat + judul lokal + saran jaringan sesudah debounce
 * 300 ms, kegagalan saran hilang diam-diam).
 *
 * Hasil: kelompok "Dari Library-mu" dulu (jalan penuh saat
 * offline), lalu kelompok jaringan (lagu, album, artis,
 * playlist) masing-masing paling banyak 10 item dengan tombol
 * "Lihat semua". Mengetuk lagu memutar lagu itu dan memasukkan
 * sisa hasil lagu ke antrean. Query yang gagal total karena
 * jaringan tidak masuk riwayat.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { Clock, MagnifyingGlass, MusicNote, X } from '@phosphor-icons/react';
import {
  getLibraryService,
  type LibraryService,
} from '../../data/library';
import type {
  LocalSearchResults,
} from '../../data/types';
import { DownloadState } from '../../data/types';
import {
  SEARCH_UI_TIMEOUT_MS,
  SearchError,
  getSearchService,
  type SearchErrorKind,
} from '../../extractor/searchService';
import type {
  GroupedSearchResults,
  SearchAlbum,
  SearchArtist,
  SearchPlaylist,
  SearchSong,
} from '../../extractor/searchParser';
import { getPlayerService } from '../../player/service';
import { streamTrack, type Track } from '../../player/types';
import { strings } from '../../strings/id';
import SkeletonList from '../SkeletonList';
import TrackRow from '../TrackRow';
import ConfirmDialog from '../library/ConfirmDialog';
import { tracksFromViews } from '../library/trackFromView';

/** Jeda debounce saran pencarian (PRD B1.2: 300 ms). */
export const SUGGESTION_DEBOUNCE_MS = 300;

/** Jumlah saran paling banyak tampil (PRD B1.2: 8). */
export const MAX_SUGGESTIONS_SHOWN = 8;

/** Jumlah item per kelompok sebelum "Lihat semua" (PRD B1.1: 10). */
export const GROUP_PREVIEW_COUNT = 10;

/** Jumlah item per kelompok sesudah "Lihat semua" (50/halaman). */
export const GROUP_FULL_COUNT = 50;

type SearchState = 'idle' | 'loading' | 'ready' | 'error';

interface Suggestion {
  text: string;
  kind: 'history' | 'local' | 'network';
}

interface GroupExpansion {
  /** Item penuh sesudah "Lihat semua" (undefined = belum dimuat). */
  songs?: SearchSong[];
  albums?: SearchAlbum[];
  artists?: SearchArtist[];
  playlists?: SearchPlaylist[];
  /** Kelompok yang sedang memuat daftar penuh. */
  loading: string | null;
}

const EMPTY_GROUPED: GroupedSearchResults = {
  songs: [],
  albums: [],
  artists: [],
  playlists: [],
  filterParams: {},
};

function trackFromSearchSong(song: SearchSong): Track {
  const track = streamTrack(
    song.videoId,
    song.title,
    song.durationSeconds,
    song.thumbnailUrl,
  );
  if (song.artist) track.artist = song.artist;
  if (song.album) track.album = song.album;
  return track;
}

function GroupHeader({
  title,
  count,
  onViewAll,
  viewAllTestId,
  expanded,
  loading,
}: {
  title: string;
  count: number;
  onViewAll?: () => void;
  viewAllTestId?: string;
  expanded?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      {count > GROUP_PREVIEW_COUNT && onViewAll ? (
        <button
          type="button"
          onClick={onViewAll}
          disabled={loading}
          data-testid={viewAllTestId}
          className="shrink-0 rounded-full px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95 disabled:opacity-50"
        >
          {loading
            ? strings.loadingMore
            : expanded
              ? strings.showFewer
              : strings.viewAll}
        </button>
      ) : null}
    </div>
  );
}

export default function SearchPage({
  initialQuery,
  onNavigate,
}: {
  initialQuery: string;
  onNavigate: (path: string) => void;
}) {
  const [input, setInput] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [state, setState] = useState<SearchState>(
    initialQuery ? 'loading' : 'idle',
  );
  const [errorKind, setErrorKind] = useState<SearchErrorKind | null>(null);
  const [errorText, setErrorText] = useState('');
  const [offline, setOffline] = useState(false);
  const [local, setLocal] = useState<LocalSearchResults | null>(null);
  const [grouped, setGrouped] = useState<GroupedSearchResults>(EMPTY_GROUPED);
  const [expansion, setExpansion] = useState<GroupExpansion>({ loading: null });
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [recent, setRecent] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // P-React19: commit hasil cari (s.d. 250 baris) dibungkus
  // transition supaya ketikan tetap responsif selama React
  // me-render daftar baru — input tidak tersendat.
  const [, startTransition] = useTransition();
  const runIdRef = useRef(0);
  const suggestIdRef = useRef(0);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshRecent = useCallback(async () => {
    try {
      const service = await getLibraryService();
      setRecent(await service.recentSearches({ limit: 10 }));
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  const runSearch = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return;
      const runId = ++runIdRef.current;
      setSubmittedQuery(trimmed);
      setState('loading');
      setOffline(!navigator.onLine);
      setErrorKind(null);
      setErrorText('');
      setExpansion({ loading: null });
      setShowSuggestions(false);
      let service: LibraryService;
      try {
        service = await getLibraryService();
      } catch {
        if (runId !== runIdRef.current) return;
        setState('error');
        setErrorText(strings.libraryErrorBody);
        return;
      }
      // Pencarian lokal selalu jalan (offline-safe) dan tampil dulu.
      let localResults: LocalSearchResults = { songs: [], artists: [] };
      try {
        localResults = await service.searchLocal(trimmed, {
          limit: GROUP_FULL_COUNT,
        });
      } catch {
        localResults = { songs: [], artists: [] };
      }
      if (runId !== runIdRef.current) return;
      startTransition(() => {
        setLocal(localResults);
      });
      const localNonEmpty =
        localResults.songs.length > 0 || localResults.artists.length > 0;

      // Pencarian jaringan: hanya bila online.
      if (!navigator.onLine) {
        startTransition(() => {
          setGrouped(EMPTY_GROUPED);
        });
        setState('ready');
        // Offline bukan "gagal total" bila hasil lokal ada.
        if (localNonEmpty) {
          void service.addSearchQuery(trimmed).then(() => {
            void refreshRecent();
          });
        }
        return;
      }
      try {
        const results = await getSearchService().search(trimmed, {
          timeoutMs: SEARCH_UI_TIMEOUT_MS,
        });
        if (runId !== runIdRef.current) return;
        startTransition(() => {
          setGrouped(results);
        });
        setState('ready');
        // Simpan riwayat: jaringan sukses (atau hasil lokal ada).
        void service.addSearchQuery(trimmed).then(() => {
          void refreshRecent();
        });
        // Penanda "Tersimpan" untuk lagu hasil jaringan.
        const ids = results.songs.map((s) => s.videoId);
        if (ids.length > 0) {
          try {
            const views = await service.songsByIds(ids);
            if (runId !== runIdRef.current) return;
            const saved = new Set<string>();
            for (const view of views) {
              if (
                view.song.inLibrary === 1 ||
                view.song.downloadState === DownloadState.downloaded
              ) {
                saved.add(view.song.id);
              }
            }
            setSavedIds(saved);
          } catch {
            // Penanda gagal dimuat: hasil tetap tampil tanpa penanda.
            setSavedIds(new Set());
          }
        } else {
          setSavedIds(new Set());
        }
      } catch (error) {
        if (runId !== runIdRef.current) return;
        const kind =
          error instanceof SearchError ? error.kind : 'network';
        const causeText =
          error instanceof SearchError
            ? error.causeText
            : strings.searchRetryHint;
        setErrorKind(kind);
        setErrorText(causeText);
        if (localNonEmpty) {
          // Hasil lokal tetap tampil; galat jaringan jadi banner.
          startTransition(() => {
            setGrouped(EMPTY_GROUPED);
          });
          setState('ready');
          void service.addSearchQuery(trimmed).then(() => {
            void refreshRecent();
          });
        } else {
          // Gagal total: query TIDAK masuk riwayat (PRD B1.1).
          setState('error');
        }
      }
    },
    [refreshRecent],
  );

  // Jalankan pencarian saat kueri awal berubah (navigasi /search?q=).
  useEffect(() => {
    setInput(initialQuery);
    if (initialQuery.trim().length > 0) {
      void runSearch(initialQuery);
    } else {
      setSubmittedQuery('');
      setState('idle');
      setLocal(null);
      setGrouped(EMPTY_GROUPED);
    }
    // runSearch stabil (useCallback, dep refreshRecent stabil).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  // Saran saat mengetik: riwayat + judul lokal + jaringan (debounce
  // 300 ms). TIDAK PERNAH memicu request search.
  useEffect(() => {
    const prefix = input.trim();
    if (prefix.length === 0 || prefix === submittedQuery) {
      setSuggestions([]);
      return;
    }
    const suggestId = ++suggestIdRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        const seen = new Set<string>([prefix.toLowerCase()]);
        const merged: Suggestion[] = [];
        const push = (text: string, kind: Suggestion['kind']): void => {
          const key = text.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          if (merged.length < MAX_SUGGESTIONS_SHOWN) {
            merged.push({ text, kind });
          }
        };
        try {
          const service = await getLibraryService();
          const history = await service.searchHistoryMatching(prefix, {
            limit: 4,
          });
          for (const q of history) push(q, 'history');
          const localResults = await service.searchLocal(prefix, {
            limit: 4,
          });
          for (const view of localResults.songs) {
            push(view.song.title, 'local');
          }
        } catch {
          // Saran lokal gagal: lanjut ke saran jaringan.
        }
        if (navigator.onLine) {
          try {
            const network = await getSearchService().suggestions(prefix);
            for (const text of network) push(text, 'network');
          } catch {
            // Kegagalan saran hilang diam-diam (PRD B1.2).
          }
        }
        if (suggestId !== suggestIdRef.current) return;
        setSuggestions(merged);
      })();
    }, SUGGESTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, submittedQuery]);

  const submit = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return;
      setShowSuggestions(false);
      onNavigate(`/search?q=${encodeURIComponent(trimmed)}`);
    },
    [onNavigate],
  );

  const viewAll = useCallback(
    async (group: 'songs' | 'albums' | 'artists' | 'playlists') => {
      // Sudah diperluas: ciutkan kembali.
      if (expansion[group] !== undefined) {
        setExpansion((prev) => {
          const next = { ...prev };
          delete next[group];
          return next;
        });
        return;
      }
      const params = grouped.filterParams[group];
      const current = grouped[group];
      // Tanpa parameter filter: perluas dari hasil yang sudah ada.
      if (!params) {
        setExpansion((prev) => ({ ...prev, [group]: current }));
        return;
      }
      setExpansion((prev) => ({ ...prev, loading: group }));
      try {
        const full = await getSearchService().search(submittedQuery, {
          params,
          timeoutMs: SEARCH_UI_TIMEOUT_MS,
        });
        setExpansion((prev) => ({
          ...prev,
          [group]: full[group],
          loading: null,
        }));
      } catch {
        // Gagal memuat daftar penuh: perluas dari hasil yang ada.
        setExpansion((prev) => ({
          ...prev,
          [group]: current,
          loading: null,
        }));
      }
    },
    [expansion, grouped, submittedQuery],
  );

  const playSongs = useCallback(
    (songs: SearchSong[], index: number) => {
      const tracks = songs.map(trackFromSearchSong);
      void getPlayerService().playQueue(tracks, index);
    },
    [],
  );

  const deleteRecent = useCallback(
    async (query: string) => {
      try {
        const service = await getLibraryService();
        await service.deleteSearchQuery(query);
        await refreshRecent();
      } catch {
        // Gagal hapus: riwayat tetap tampil, bukan galat fatal.
      }
    },
    [refreshRecent],
  );

  const clearAllRecent = useCallback(async () => {
    setConfirmClear(false);
    try {
      const service = await getLibraryService();
      await service.clearSearchHistory();
      await refreshRecent();
    } catch {
      // Gagal hapus: riwayat tetap tampil, bukan galat fatal.
    }
  }, [refreshRecent]);

  const songsShown = expansion.songs ?? grouped.songs;
  const albumsShown = expansion.albums ?? grouped.albums;
  const artistsShown = expansion.artists ?? grouped.artists;
  const playlistsShown = expansion.playlists ?? grouped.playlists;
  const songsTotal = grouped.songs.length;
  const albumsTotal = grouped.albums.length;
  const artistsTotal = grouped.artists.length;
  const playlistsTotal = grouped.playlists.length;
  const anyResults =
    (local != null &&
      (local.songs.length > 0 || local.artists.length > 0)) ||
    songsTotal > 0 ||
    albumsTotal > 0 ||
    artistsTotal > 0 ||
    playlistsTotal > 0;

  const showRecentList =
    state === 'idle' && input.trim().length === 0 && recent.length > 0;
  const showSuggestionList =
    showSuggestions &&
    inputFocused &&
    input.trim().length > 0 &&
    suggestions.length > 0;

  return (
    <div data-testid="search-page" className="pt-2">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submit(input);
        }}
        className="relative"
      >
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlass
              size={18}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
            />
            <input
              type="search"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => {
                setInputFocused(true);
                if (input.trim().length > 0) setShowSuggestions(true);
              }}
              onBlur={() => {
                blurTimerRef.current = setTimeout(() => {
                  setInputFocused(false);
                  setShowSuggestions(false);
                }, 150);
              }}
              placeholder={strings.searchPlaceholder}
              aria-label={strings.searchPlaceholder}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-testid="search-input"
              className="h-11 w-full rounded-xl border border-white/10 bg-zinc-900 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            data-testid="search-submit"
            className="h-11 shrink-0 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform active:scale-95"
          >
            {strings.searchButton}
          </button>
        </div>

        {showSuggestionList ? (
          <ul
            data-testid="search-suggestions"
            className="absolute inset-x-0 top-12 z-30 overflow-hidden rounded-xl border border-white/10 bg-zinc-900 shadow-xl"
          >
            {suggestions.map((suggestion, index) => (
              <li key={`${suggestion.kind}-${suggestion.text}`}>
                <button
                  type="button"
                  data-testid={`search-suggestion-${index}`}
                  onMouseDown={(event) => {
                    // Cegah blur input sebelum klik diproses.
                    event.preventDefault();
                  }}
                  onClick={() => submit(suggestion.text)}
                  className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-white/5 active:bg-white/10"
                >
                  {suggestion.kind === 'history' ? (
                    <Clock
                      size={16}
                      aria-hidden="true"
                      className="shrink-0 text-zinc-400"
                    />
                  ) : suggestion.kind === 'local' ? (
                    <MusicNote
                      size={16}
                      aria-hidden="true"
                      className="shrink-0 text-zinc-400"
                    />
                  ) : (
                    <MagnifyingGlass
                      size={16}
                      aria-hidden="true"
                      className="shrink-0 text-zinc-400"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {suggestion.text}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </form>

      {offline && state === 'ready' ? (
        <p
          data-testid="search-offline"
          className="mt-3 rounded-xl border border-white/10 bg-zinc-900 px-3 py-2 text-xs text-zinc-400"
        >
          {strings.searchOffline}
        </p>
      ) : null}

      {errorKind != null && state === 'ready' ? (
        <div
          data-testid="search-network-note"
          className="mt-3 rounded-xl border border-white/10 bg-zinc-900 px-3 py-2"
        >
          <p className="text-xs leading-relaxed text-zinc-400">{errorText}</p>
          <button
            type="button"
            onClick={() => void runSearch(submittedQuery)}
            data-testid="search-retry"
            className="mt-2 h-9 rounded-full border border-white/15 px-4 text-xs font-medium transition-colors hover:bg-white/5 active:scale-95"
          >
            {strings.retry}
          </button>
        </div>
      ) : null}

      {showRecentList ? (
        <div data-testid="search-recent" className="mt-6">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold tracking-tight">
              {strings.recentSearches}
            </h2>
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              data-testid="search-clear-history"
              className="shrink-0 rounded-full px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
            >
              {strings.clearSearchHistory}
            </button>
          </div>
          <ul className="mt-2 divide-y divide-white/5">
            {recent.map((query, index) => (
              <li key={query} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => submit(query)}
                  data-testid={`search-recent-${index}`}
                  className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left text-sm transition-colors hover:bg-white/5"
                >
                  <Clock
                    size={16}
                    aria-hidden="true"
                    className="shrink-0 text-zinc-400"
                  />
                  <span className="min-w-0 flex-1 truncate">{query}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void deleteRecent(query)}
                  aria-label={`${strings.removeFromHistory}: ${query}`}
                  data-testid={`search-recent-delete-${index}`}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state === 'loading' ? (
        <div className="mt-6" data-testid="search-loading">
          <SkeletonList rows={6} testId="search-skeleton" />
        </div>
      ) : null}

      {state === 'error' ? (
        <div data-testid="search-error" className="py-12 text-center">
          <h2 className="text-lg font-semibold tracking-tight">
            {strings.searchNetworkErrorTitle}
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
            {errorText}
          </p>
          <button
            type="button"
            onClick={() => void runSearch(submittedQuery)}
            data-testid="search-retry"
            className="mt-6 h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95"
          >
            {strings.retry}
          </button>
        </div>
      ) : null}

      {state === 'ready' && !anyResults ? (
        <div data-testid="search-empty" className="py-12 text-center">
          <h2 className="text-lg font-semibold tracking-tight">
            {strings.searchNoResultsTitle}
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
            {strings.searchNoResultsFor(submittedQuery)}{' '}
            {strings.searchNoResultsBody}
          </p>
        </div>
      ) : null}

      {state === 'ready' && anyResults ? (
        <div data-testid="search-results" className="mt-6 space-y-8">
          {local != null &&
          (local.songs.length > 0 || local.artists.length > 0) ? (
            <section
              aria-label={strings.searchFromLibrary}
              data-testid="search-group-local"
            >
              <h3 className="text-base font-semibold tracking-tight">
                {strings.searchFromLibrary}
              </h3>
              <ul className="mt-2 divide-y divide-white/5">
                {local.songs
                  .slice(0, GROUP_PREVIEW_COUNT)
                  .map((view, index) => (
                    <TrackRow
                      key={view.song.id}
                      title={view.song.title}
                      subtitle={view.artistNames.join(', ') || undefined}
                      thumbnailUrl={view.song.thumbnailUrl ?? undefined}
                      durationSeconds={view.song.durationSeconds ?? undefined}
                      saved
                      testId={`search-local-song-${view.song.id}`}
                      onClick={() => {
                        void getPlayerService().playQueue(
                          tracksFromViews(
                            local.songs.slice(0, GROUP_PREVIEW_COUNT),
                          ),
                          index,
                        );
                      }}
                    />
                  ))}
                {local.artists
                  .slice(0, GROUP_PREVIEW_COUNT)
                  .map((artist) => (
                    <li key={artist.id}>
                      <button
                        type="button"
                        onClick={() => submit(artist.name)}
                        data-testid={`search-local-artist-${artist.id}`}
                        className="flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-white/5 active:bg-white/10"
                      >
                        <span
                          aria-hidden="true"
                          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm text-zinc-400"
                        >
                          {artist.name.charAt(0)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-zinc-100">
                            {artist.name}
                          </span>
                          <span className="block text-xs text-zinc-400">
                            {strings.artistsTab}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}

          {songsTotal > 0 ? (
            <section
              aria-label={strings.searchSongsGroup}
              data-testid="search-group-songs"
            >
              <GroupHeader
                title={strings.searchSongsGroup}
                count={songsTotal}
                expanded={expansion.songs !== undefined}
                loading={expansion.loading === 'songs'}
                viewAllTestId="search-view-all-songs"
                onViewAll={() => void viewAll('songs')}
              />
              <ul className="mt-2 divide-y divide-white/5">
                {(expansion.songs !== undefined
                  ? songsShown.slice(0, GROUP_FULL_COUNT)
                  : songsShown.slice(0, GROUP_PREVIEW_COUNT)
                ).map((song, index) => (
                  <TrackRow
                    key={song.videoId}
                    title={song.title}
                    subtitle={song.artist}
                    thumbnailUrl={song.thumbnailUrl}
                    durationSeconds={song.durationSeconds}
                    saved={savedIds.has(song.videoId)}
                    testId={`search-song-${song.videoId}`}
                    onClick={() =>
                      playSongs(
                        expansion.songs !== undefined
                          ? songsShown.slice(0, GROUP_FULL_COUNT)
                          : songsShown.slice(0, GROUP_PREVIEW_COUNT),
                        index,
                      )
                    }
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {albumsTotal > 0 ? (
            <section
              aria-label={strings.searchAlbumsGroup}
              data-testid="search-group-albums"
            >
              <GroupHeader
                title={strings.searchAlbumsGroup}
                count={albumsTotal}
                expanded={expansion.albums !== undefined}
                loading={expansion.loading === 'albums'}
                viewAllTestId="search-view-all-albums"
                onViewAll={() => void viewAll('albums')}
              />
              <ul className="mt-2 divide-y divide-white/5">
                {(expansion.albums !== undefined
                  ? albumsShown.slice(0, GROUP_FULL_COUNT)
                  : albumsShown.slice(0, GROUP_PREVIEW_COUNT)
                ).map((album) => (
                  <TrackRow
                    key={album.browseId}
                    title={album.title}
                    subtitle={[
                      album.artists.join(', '),
                      album.year != null ? String(album.year) : '',
                    ]
                      .filter((s) => s.length > 0)
                      .join(' • ')}
                    thumbnailUrl={album.thumbnailUrl}
                    testId={`search-album-${album.browseId}`}
                    to={`/browse/${album.browseId}`}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {artistsTotal > 0 ? (
            <section
              aria-label={strings.searchArtistsGroup}
              data-testid="search-group-artists"
            >
              <GroupHeader
                title={strings.searchArtistsGroup}
                count={artistsTotal}
                expanded={expansion.artists !== undefined}
                loading={expansion.loading === 'artists'}
                viewAllTestId="search-view-all-artists"
                onViewAll={() => void viewAll('artists')}
              />
              <ul className="mt-2 divide-y divide-white/5">
                {(expansion.artists !== undefined
                  ? artistsShown.slice(0, GROUP_FULL_COUNT)
                  : artistsShown.slice(0, GROUP_PREVIEW_COUNT)
                ).map((artist) => (
                  <TrackRow
                    key={artist.channelId}
                    title={artist.name}
                    subtitle={artist.subscribersText}
                    thumbnailUrl={artist.thumbnailUrl}
                    testId={`search-artist-${artist.channelId}`}
                    to={`/browse/${artist.channelId}`}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {playlistsTotal > 0 ? (
            <section
              aria-label={strings.searchPlaylistsGroup}
              data-testid="search-group-playlists"
            >
              <GroupHeader
                title={strings.searchPlaylistsGroup}
                count={playlistsTotal}
                expanded={expansion.playlists !== undefined}
                loading={expansion.loading === 'playlists'}
                viewAllTestId="search-view-all-playlists"
                onViewAll={() => void viewAll('playlists')}
              />
              <ul className="mt-2 divide-y divide-white/5">
                {(expansion.playlists !== undefined
                  ? playlistsShown.slice(0, GROUP_FULL_COUNT)
                  : playlistsShown.slice(0, GROUP_PREVIEW_COUNT)
                ).map((playlist) => (
                  <TrackRow
                    key={playlist.browseId}
                    title={playlist.title}
                    subtitle={playlist.subtitle}
                    thumbnailUrl={playlist.thumbnailUrl}
                    testId={`search-playlist-${playlist.browseId}`}
                    to={`/browse/${playlist.browseId}`}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

      {confirmClear ? (
        <ConfirmDialog
          title={strings.clearSearchHistoryTitle}
          body={strings.clearSearchHistoryBody}
          confirmLabel={strings.delete}
          onConfirm={() => void clearAllRecent()}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}
    </div>
  );
}
