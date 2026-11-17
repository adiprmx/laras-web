/**
 * Layar Library: tab Lagu / Album / Artis / Playlist / Favorit /
 * Riwayat + pencarian lokal. Semua daftar memakai pagination
 * 50 per halaman dengan tombol "Muat lagi".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  MagnifyingGlass,
  Playlist as PlaylistIcon,
  Plus,
  Trash,
} from '@phosphor-icons/react';
import {
  PAGE_SIZE,
  getLibraryService,
  type LibraryService,
  type SongSort,
} from '../../data/library';
import type {
  AlbumWithCount,
  ArtistWithCount,
  LibraryCounts,
  LocalSearchResults,
  PlayHistoryEntry,
  PlaylistWithCount,
  SongView,
} from '../../data/types';
import { getPlayerService } from '../../player/service';
import { useLibraryService, useLibraryStore } from '../../store/library';
import { strings } from '../../strings/id';
import ConfirmDialog from './ConfirmDialog';
import PlaylistDialog from './PlaylistDialog';
import SongMenu from './SongMenu';
import SongRow from './SongRow';
import { trackFromView, tracksFromViews } from './trackFromView';

type Tab = 'songs' | 'albums' | 'artists' | 'playlists' | 'favorites' | 'history';

interface Filter {
  kind: 'artist' | 'album';
  id: string;
  name: string;
}

const TABS: Array<{ id: Tab; label: string; testId: string }> = [
  { id: 'songs', label: strings.songsTab, testId: 'tab-songs' },
  { id: 'albums', label: strings.albumsTab, testId: 'tab-albums' },
  { id: 'artists', label: strings.artistsTab, testId: 'tab-artists' },
  { id: 'playlists', label: strings.playlistsTab, testId: 'tab-playlists' },
  { id: 'favorites', label: strings.favoritesTab, testId: 'tab-favorites' },
  { id: 'history', label: strings.historyTab, testId: 'tab-history' },
];

const SORTS: Array<{ id: SongSort; label: string; testId: string }> = [
  { id: 'newest', label: strings.sortNewest, testId: 'sort-newest' },
  { id: 'byName', label: strings.sortByName, testId: 'sort-by-name' },
  { id: 'mostPlayed', label: strings.sortMostPlayed, testId: 'sort-most-played' },
];

function formatCount(n: number): string {
  return n.toLocaleString('id-ID');
}

function formatPlayedAt(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (sameDay) return `Hari ini, ${time}`;
  if (date.toDateString() === yesterday.toDateString()) {
    return `Kemarin, ${time}`;
  }
  return `${date.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
  })}, ${time}`;
}

interface LibraryPageProps {
  onNavigate: (path: string) => void;
}

export default function LibraryPage({ onNavigate }: LibraryPageProps) {
  const { service, dbError } = useLibraryService();
  const version = useLibraryStore((s) => s.version);
  const sort = useLibraryStore((s) => s.sort);
  const setSort = useLibraryStore((s) => s.setSort);

  const [tab, setTab] = useState<Tab>('songs');
  const [filter, setFilter] = useState<Filter | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<LocalSearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);

  const [songs, setSongs] = useState<SongView[]>([]);
  const [artists, setArtists] = useState<ArtistWithCount[]>([]);
  const [albums, setAlbums] = useState<AlbumWithCount[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistWithCount[]>([]);
  const [history, setHistory] = useState<PlayHistoryEntry[]>([]);
  const [counts, setCounts] = useState<LibraryCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);

  const [menuView, setMenuView] = useState<SongView | null>(null);
  const [showCreatePlaylist, setShowCreatePlaylist] = useState(false);
  const [showClearHistory, setShowClearHistory] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const requestRef = useRef(0);
  const searchRef = useRef(0);

  const searchingMode = debouncedQuery.trim().length > 0;

  // Debounce ketikan pencarian 300 ms.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Pesan singkat hilang sendiri setelah 3 detik.
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [message]);

  const loadFirst = useCallback(
    async (svc: LibraryService) => {
      const token = ++requestRef.current;
      setLoading(true);
      setError(false);
      try {
        const [pageCounts] = await Promise.all([svc.libraryCounts()]);
        if (token !== requestRef.current) return;
        setCounts(pageCounts);
        if (filter) {
          const page =
            filter.kind === 'artist'
              ? await svc.songsByArtistPage(filter.id)
              : await svc.songsByAlbumPage(filter.id);
          if (token !== requestRef.current) return;
          setSongs(page);
          setHasMore(page.length === PAGE_SIZE);
        } else if (tab === 'songs') {
          const page = await svc.songsPage({ sort });
          if (token !== requestRef.current) return;
          setSongs(page);
          setHasMore(page.length === PAGE_SIZE);
        } else if (tab === 'favorites') {
          const page = await svc.favoriteSongsPage({});
          if (token !== requestRef.current) return;
          setSongs(page);
          setHasMore(page.length === PAGE_SIZE);
        } else if (tab === 'artists') {
          const page = await svc.artistsPage({});
          if (token !== requestRef.current) return;
          setArtists(page);
          setHasMore(page.length === PAGE_SIZE);
        } else if (tab === 'albums') {
          const page = await svc.albumsPage({});
          if (token !== requestRef.current) return;
          setAlbums(page);
          setHasMore(page.length === PAGE_SIZE);
        } else if (tab === 'playlists') {
          const page = await svc.playlistsPage({});
          if (token !== requestRef.current) return;
          setPlaylists(page);
          setHasMore(page.length === PAGE_SIZE);
        } else {
          const page = await svc.historyPage({});
          if (token !== requestRef.current) return;
          setHistory(page);
          setHasMore(page.length === PAGE_SIZE);
        }
      } catch {
        if (token === requestRef.current) setError(true);
      } finally {
        if (token === requestRef.current) setLoading(false);
      }
    },
    [tab, sort, filter],
  );

  useEffect(() => {
    if (!service) return;
    if (searchingMode) return;
    void loadFirst(service);
  }, [service, version, searchingMode, loadFirst]);

  // Pencarian lokal: jalan saat ketikan berhenti 300 ms.
  useEffect(() => {
    if (!service) return;
    const q = debouncedQuery.trim();
    if (q.length === 0) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    const token = ++searchRef.current;
    setSearching(true);
    service
      .searchLocal(q)
      .then((results) => {
        if (token !== searchRef.current) return;
        setSearchResults(results);
        setSearching(false);
      })
      .catch(() => {
        if (token !== searchRef.current) return;
        setSearching(false);
      });
  }, [service, debouncedQuery]);

  // Riwayat pencarian untuk saran.
  useEffect(() => {
    if (!service) return;
    service
      .recentSearches({ limit: 5 })
      .then(setRecent)
      .catch(() => undefined);
  }, [service, version]);

  const loadMore = (): void => {
    if (!service || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const load = (async (): Promise<void> => {
      if (filter) {
        const last = songs[songs.length - 1];
        const page =
          filter.kind === 'artist'
            ? await service.songsByArtistPage(filter.id, { after: last })
            : await service.songsByAlbumPage(filter.id, { after: last });
        setSongs((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
        return;
      }
      if (tab === 'songs') {
        const last = songs[songs.length - 1];
        const page = await service.songsPage({ sort, after: last });
        setSongs((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      } else if (tab === 'favorites') {
        const last = songs[songs.length - 1];
        const page = await service.favoriteSongsPage({ after: last });
        setSongs((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      } else if (tab === 'artists') {
        const last = artists[artists.length - 1];
        const page = await service.artistsPage({ after: last });
        setArtists((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      } else if (tab === 'albums') {
        const last = albums[albums.length - 1];
        const page = await service.albumsPage({ after: last });
        setAlbums((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      } else if (tab === 'playlists') {
        const last = playlists[playlists.length - 1];
        const page = await service.playlistsPage({ after: last });
        setPlaylists((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      } else {
        const last = history[history.length - 1];
        const page = await service.historyPage({ after: last });
        setHistory((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      }
    })();
    void load
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  };

  const submitSearch = (): void => {
    const q = query.trim();
    if (q.length === 0 || !service) return;
    void service.addSearchQuery(q).catch(() => undefined);
    setDebouncedQuery(q);
  };

  const playSongs = (list: SongView[], index: number): void => {
    void getPlayerService().playQueue(tracksFromViews(list), index);
  };

  const playSingle = (view: SongView): void => {
    submitSearch();
    void getPlayerService().playQueue([trackFromView(view)], 0);
  };

  const openFilter = (next: Filter): void => {
    setFilter(next);
    setQuery('');
  };

  if (dbError) {
    return (
      <div className="mx-auto max-w-2xl px-4 pt-8" data-testid="library-page">
        <h1 className="text-xl font-bold tracking-tight">{strings.library}</h1>
        <div className="mt-6 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-4">
          <p className="text-sm font-medium text-zinc-100">
            {strings.libraryErrorTitle}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">
            {strings.libraryErrorBody}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pt-4" data-testid="library-page">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">{strings.library}</h1>
        {counts != null && counts.songs > 0 && (
          <span className="text-sm tabular-nums text-zinc-400" data-testid="library-song-count">
            {formatCount(counts.songs)} {strings.songsLabel}
          </span>
        )}
      </div>

      {/* Pencarian lokal */}
      <form
        className="mt-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch();
        }}
      >
        <div className="relative flex-1">
          <MagnifyingGlass
            size={18}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
          />
          <input
            type="search"
            value={query}
            placeholder={strings.searchLibraryPlaceholder}
            aria-label={strings.searchLibraryPlaceholder}
            data-testid="library-search"
            onChange={(e) => setQuery(e.target.value)}
            className="h-11 w-full rounded-xl border border-white/10 bg-zinc-900 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          data-testid="library-search-submit"
          className="h-11 shrink-0 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform duration-150 active:scale-95"
        >
          {strings.searchButton}
        </button>
      </form>

      {/* Saran riwayat pencarian (saat kotak kosong). */}
      {!searchingMode && recent.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-400">{strings.recentSearches}:</span>
          {recent.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuery(q)}
              data-testid={`recent-search-${q}`}
              className="h-8 rounded-full border border-white/10 px-3 text-xs text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Tab */}
      {!searchingMode && !filter && (
        <div
          role="tablist"
          aria-label={strings.library}
          className="mt-4 flex gap-2 overflow-x-auto pb-1"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              data-testid={t.testId}
              onClick={() => setTab(t.id)}
              className={`h-10 shrink-0 whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors active:scale-95 ${
                tab === t.id
                  ? 'bg-white text-black'
                  : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Urutan lagu */}
      {!searchingMode && !filter && tab === 'songs' && (
        <div className="mt-4 flex items-center gap-2" role="group" aria-label={strings.sortLabel}>
          <span className="text-xs text-zinc-400">{strings.sortLabel}:</span>
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid={s.testId}
              aria-pressed={sort === s.id}
              onClick={() => setSort(s.id)}
              className={`h-8 shrink-0 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-colors active:scale-95 ${
                sort === s.id
                  ? 'bg-white text-black'
                  : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Header filter artis/album */}
      {filter && !searchingMode && (
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFilter(null)}
            aria-label={strings.backToLibrary}
            data-testid="filter-back"
            className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            <ArrowLeft size={22} />
          </button>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-zinc-100">
              {filter.name}
            </p>
            <p className="text-xs text-zinc-400">
              {filter.kind === 'artist' ? strings.artistsTab : strings.albumsTab}
            </p>
          </div>
        </div>
      )}

      {/* Isi */}
      <div className="mt-4">
        {searchingMode ? (
          <SearchResultsBlock
            searching={searching}
            results={searchResults}
            onPlay={playSingle}
            onMenu={setMenuView}
            onOpenArtist={(id, name) => openFilter({ kind: 'artist', id, name })}
          />
        ) : loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-4">
            <p className="text-sm text-zinc-100">{strings.libraryErrorBody}</p>
            <button
              type="button"
              onClick={() => service && void loadFirst(service)}
              data-testid="library-retry"
              className="mt-3 h-11 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform duration-150 active:scale-95"
            >
              {strings.retry}
            </button>
          </div>
        ) : filter || tab === 'songs' || tab === 'favorites' ? (
          <SongListBlock
            songs={songs}
            emptyTitle={
              filter
                ? strings.libraryEmptyTitle
                : tab === 'favorites'
                  ? strings.favoritesEmptyTitle
                  : strings.libraryEmptyTitle
            }
            emptyBody={
              filter
                ? strings.libraryEmptyBody
                : tab === 'favorites'
                  ? strings.favoritesEmptyBody
                  : strings.libraryEmptyBody
            }
            onPlay={(index) => playSongs(songs, index)}
            onMenu={setMenuView}
            testId="song-list"
          />
        ) : tab === 'artists' ? (
          <ArtistListBlock
            artists={artists}
            onOpen={(a) =>
              openFilter({ kind: 'artist', id: a.artist.id, name: a.artist.name })
            }
          />
        ) : tab === 'albums' ? (
          <AlbumListBlock
            albums={albums}
            onOpen={(a) =>
              openFilter({ kind: 'album', id: a.album.id, name: a.album.title })
            }
          />
        ) : tab === 'playlists' ? (
          <PlaylistListBlock
            playlists={playlists}
            onOpen={(id) => onNavigate(`/library/playlist/${id}`)}
            onCreate={() => setShowCreatePlaylist(true)}
          />
        ) : (
          <HistoryListBlock
            history={history}
            onPlay={(index) =>
              playSongs(
                history.map((h) => h.song),
                index,
              )
            }
            onMenu={(entry) => setMenuView(entry.song)}
            onClear={() => setShowClearHistory(true)}
          />
        )}
      </div>

      {/* Muat lagi */}
      {!searchingMode && !loading && !error && hasMore && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          data-testid="load-more"
          className="mt-4 h-11 w-full rounded-xl border border-white/10 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95 disabled:opacity-50"
        >
          {loadingMore ? strings.loadingMore : strings.loadMore}
        </button>
      )}

      {/* Pesan singkat */}
      {message && (
        <div
          role="status"
          data-testid="library-toast"
          className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-white/10 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 shadow-xl"
        >
          {message}
        </div>
      )}

      {menuView && (
        <SongMenu
          view={menuView}
          onClose={() => setMenuView(null)}
          onMessage={setMessage}
        />
      )}

      {showCreatePlaylist && (
        <PlaylistDialog
          title={strings.newPlaylist}
          submitLabel={strings.createPlaylist}
          onSubmit={(name, description) => {
            setShowCreatePlaylist(false);
            void getLibraryService()
              .then((svc) => svc.createPlaylist(name, { description }))
              .then((id) => onNavigate(`/library/playlist/${id}`))
              .catch(() => undefined);
          }}
          onCancel={() => setShowCreatePlaylist(false)}
        />
      )}

      {showClearHistory && (
        <ConfirmDialog
          title={strings.clearHistoryTitle}
          body={strings.clearHistoryBody}
          confirmLabel={strings.delete}
          onConfirm={() => {
            setShowClearHistory(false);
            void getLibraryService()
              .then((svc) => svc.clearHistory())
              .catch(() => undefined);
          }}
          onCancel={() => setShowClearHistory(false)}
        />
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Memuat" data-testid="library-loading">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="flex items-center gap-3 px-2 py-3">
          <span className="h-12 w-12 shrink-0 animate-pulse rounded-lg bg-zinc-900" />
          <span className="flex-1">
            <span className="block h-4 w-2/3 animate-pulse rounded bg-zinc-900" />
            <span className="mt-2 block h-3 w-1/3 animate-pulse rounded bg-zinc-900" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900/50 px-4 py-8 text-center" data-testid="library-empty">
      <p className="text-base font-semibold text-zinc-100">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
        {body}
      </p>
    </div>
  );
}

function SearchResultsBlock({
  searching,
  results,
  onPlay,
  onMenu,
  onOpenArtist,
}: {
  searching: boolean;
  results: LocalSearchResults | null;
  onPlay: (view: SongView) => void;
  onMenu: (view: SongView) => void;
  onOpenArtist: (id: string, name: string) => void;
}) {
  if (searching || results === null) {
    return <LoadingSkeleton />;
  }
  if (results.songs.length === 0 && results.artists.length === 0) {
    return (
      <EmptyState
        title={strings.searchNoResultsTitle}
        body={strings.searchNoResultsBody}
      />
    );
  }
  return (
    <div data-testid="search-results">
      {results.artists.length > 0 && (
        <div>
          <h2 className="px-2 text-sm font-semibold text-zinc-100">
            {strings.artistsTab}
          </h2>
          <ul className="mt-2 divide-y divide-white/5">
            {results.artists.map((artist) => (
              <li key={artist.id}>
                <button
                  type="button"
                  onClick={() => onOpenArtist(artist.id, artist.name)}
                  data-testid={`search-artist-${artist.id}`}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/5 active:scale-[0.98]"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-lg font-bold text-zinc-400"
                  >
                    {artist.name.charAt(0)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-zinc-100">
                    {artist.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {results.songs.length > 0 && (
        <div className="mt-4">
          <h2 className="px-2 text-sm font-semibold text-zinc-100">
            {strings.songsTab}
          </h2>
          <ul className="mt-2 divide-y divide-white/5">
            {results.songs.map((view) => (
              <SongRow
                key={view.song.id}
                view={view}
                onPlay={() => onPlay(view)}
                onMenu={() => onMenu(view)}
                testId={`search-song-${view.song.id}`}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SongListBlock({
  songs,
  emptyTitle,
  emptyBody,
  onPlay,
  onMenu,
  testId,
}: {
  songs: SongView[];
  emptyTitle: string;
  emptyBody: string;
  onPlay: (index: number) => void;
  onMenu: (view: SongView) => void;
  testId: string;
}) {
  if (songs.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} />;
  }
  return (
    <ul className="divide-y divide-white/5" data-testid={testId}>
      {songs.map((view, index) => (
        <SongRow
          key={view.song.id}
          view={view}
          onPlay={() => onPlay(index)}
          onMenu={() => onMenu(view)}
          testId={`song-${view.song.id}`}
        />
      ))}
    </ul>
  );
}

function ArtistListBlock({
  artists,
  onOpen,
}: {
  artists: ArtistWithCount[];
  onOpen: (a: ArtistWithCount) => void;
}) {
  if (artists.length === 0) {
    return (
      <EmptyState
        title={strings.artistsEmptyTitle}
        body={strings.artistsEmptyBody}
      />
    );
  }
  return (
    <ul className="divide-y divide-white/5" data-testid="artist-list">
      {artists.map((a) => (
        <li key={a.artist.id}>
          <button
            type="button"
            onClick={() => onOpen(a)}
            data-testid={`artist-${a.artist.id}`}
            className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/5 active:scale-[0.98]"
          >
            {a.artist.thumbnailUrl ? (
              <img
                src={a.artist.thumbnailUrl}
                alt=""
                width={48}
                height={48}
                loading="lazy"
                className="h-12 w-12 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-lg font-bold text-zinc-400"
              >
                {a.artist.name.charAt(0)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-zinc-100">
                {a.artist.name}
              </span>
              <span className="block text-[13px] text-zinc-400">
                {formatCount(a.songCount)} {strings.songsLabel}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AlbumListBlock({
  albums,
  onOpen,
}: {
  albums: AlbumWithCount[];
  onOpen: (a: AlbumWithCount) => void;
}) {
  if (albums.length === 0) {
    return (
      <EmptyState
        title={strings.albumsEmptyTitle}
        body={strings.albumsEmptyBody}
      />
    );
  }
  return (
    <ul className="divide-y divide-white/5" data-testid="album-list">
      {albums.map((a) => (
        <li key={a.album.id}>
          <button
            type="button"
            onClick={() => onOpen(a)}
            data-testid={`album-${a.album.id}`}
            className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/5 active:scale-[0.98]"
          >
            {a.album.thumbnailUrl ? (
              <img
                src={a.album.thumbnailUrl}
                alt=""
                width={48}
                height={48}
                loading="lazy"
                className="h-12 w-12 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-lg font-bold text-zinc-400"
              >
                {a.album.title.charAt(0)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-zinc-100">
                {a.album.title}
              </span>
              <span className="block text-[13px] text-zinc-400">
                {formatCount(a.songCount)} {strings.songsLabel}
                {a.album.year ? ` · ${a.album.year}` : ''}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PlaylistListBlock({
  playlists,
  onOpen,
  onCreate,
}: {
  playlists: PlaylistWithCount[];
  onOpen: (id: number) => void;
  onCreate: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onCreate}
        data-testid="create-playlist"
        className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-white text-sm font-medium text-black transition-transform duration-150 active:scale-95"
      >
        <Plus size={18} weight="bold" />
        {strings.newPlaylist}
      </button>
      {playlists.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title={strings.playlistsEmptyTitle}
            body={strings.playlistsEmptyBody}
          />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-white/5" data-testid="playlist-list">
          {playlists.map(({ playlist, songCount }) => (
            <li key={playlist.id}>
              <button
                type="button"
                onClick={() => onOpen(playlist.id)}
                data-testid={`playlist-${playlist.id}`}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/5 active:scale-[0.98]"
              >
                <span
                  aria-hidden="true"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-zinc-400"
                >
                  <PlaylistIcon size={22} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-zinc-100">
                    {playlist.name}
                  </span>
                  <span className="block truncate text-[13px] text-zinc-400">
                    {formatCount(songCount)} {strings.songsLabel}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryListBlock({
  history,
  onPlay,
  onMenu,
  onClear,
}: {
  history: PlayHistoryEntry[];
  onPlay: (index: number) => void;
  onMenu: (entry: PlayHistoryEntry) => void;
  onClear: () => void;
}) {
  if (history.length === 0) {
    return (
      <EmptyState
        title={strings.historyEmptyTitle}
        body={strings.historyEmptyBody}
      />
    );
  }
  return (
    <div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClear}
          data-testid="clear-history"
          className="flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-red-400 transition-colors hover:bg-white/5 active:scale-95"
        >
          <Trash size={18} />
          {strings.clearHistory}
        </button>
      </div>
      <ul className="divide-y divide-white/5" data-testid="history-list">
        {history.map((entry, index) => (
          <SongRow
            key={entry.event.id}
            view={entry.song}
            subtitle={formatPlayedAt(entry.event.timestamp)}
            onPlay={() => onPlay(index)}
            onMenu={() => onMenu(entry)}
            testId={`history-${entry.event.id}`}
          />
        ))}
      </ul>
    </div>
  );
}
