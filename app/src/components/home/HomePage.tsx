/**
 * Beranda Laras: 6 seksi sesuai PRD B6.1, urutan final:
 * "Baru diputar", "Lagu untukmu", "Sering diputar",
 * "Playlist kamu", "Unduhan", "Jelajah".
 *
 * Seksi lokal selalu tersedia dan tampil dulu dari database;
 * beranda tidak pernah loading penuh. "Jelajah" (browse YouTube
 * Music) terakhir karena butuh jaringan: cache 6 jam dipakai
 * dulu, refresh gagal menampilkan data terakhir (PRD B6.4).
 * Seksi lokal yang kosong tidak tampil. Pengguna baru yang
 * offline melihat pesan jujur + tombol "Cari lagu" (PRD B6.3).
 *
 * Modul jaringan (searchService + parser) diimpor dinamis supaya
 * bundle awal tidak membengkak: hanya diunduh saat Jelajah
 * dimuat.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import {
  BROWSE_CACHE_TTL_MS,
  loadCachedBrowseHome,
  saveCachedBrowseHome,
} from '../../data/browseCache';
import { FOR_YOU_LIMIT } from '../../data/recommendations';
import { getLibraryService } from '../../data/library';
import type {
  PlaylistWithCount,
  SongView,
} from '../../data/types';
import type { BrowsePage } from '../../extractor/searchParser';
import { getPlayerService } from '../../player/service';
import { useLibraryStore } from '../../store/library';
import { strings } from '../../strings/id';
import SkeletonList from '../SkeletonList';
import TrackRow from '../TrackRow';
import BrowseShelves from '../browse/BrowseShelves';
import { tracksFromViews } from '../library/trackFromView';

type BrowseState = 'loading' | 'ready' | 'offline' | 'error';

interface LocalSections {
  recent: SongView[];
  forYou: SongView[];
  mostPlayed: SongView[];
  playlists: PlaylistWithCount[];
  downloaded: SongView[];
}

const EMPTY_LOCAL: LocalSections = {
  recent: [],
  forYou: [],
  mostPlayed: [],
  playlists: [],
  downloaded: [],
};

function Section({
  title,
  testId,
  action,
  children,
}: {
  title: string;
  testId: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} data-testid={testId} className="mt-8">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ViewAllButton({
  onClick,
  testId,
}: {
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="shrink-0 rounded-full px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
    >
      {strings.viewAll}
    </button>
  );
}

function SongList({
  songs,
  testIdPrefix,
}: {
  songs: SongView[];
  testIdPrefix: string;
}) {
  const tracks = tracksFromViews(songs);
  return (
    <ul className="divide-y divide-white/5">
      {songs.map((view, index) => (
        <TrackRow
          key={view.song.id}
          title={view.song.title}
          subtitle={view.artistNames.join(', ') || undefined}
          thumbnailUrl={view.song.thumbnailUrl ?? undefined}
          durationSeconds={view.song.durationSeconds ?? undefined}
          saved={view.song.inLibrary === 1}
          testId={`${testIdPrefix}-${view.song.id}`}
          onClick={() => {
            void getPlayerService().playQueue(tracks, index);
          }}
        />
      ))}
    </ul>
  );
}

export default function HomePage({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const libraryVersion = useLibraryStore((s) => s.version);
  const [local, setLocal] = useState<LocalSections>(EMPTY_LOCAL);
  const [localLoading, setLocalLoading] = useState(true);
  const [localError, setLocalError] = useState(false);
  const [forYouExpanded, setForYouExpanded] = useState(false);

  const [browse, setBrowse] = useState<BrowsePage | null>(null);
  const [browseState, setBrowseState] = useState<BrowseState>('loading');
  const [browseErrorText, setBrowseErrorText] = useState('');
  const [browseStale, setBrowseStale] = useState(false);
  const [browseRefreshing, setBrowseRefreshing] = useState(false);

  // Seksi lokal: muat ulang tiap data library berubah.
  useEffect(() => {
    let alive = true;
    setLocalLoading(true);
    getLibraryService()
      .then(async (service) => {
        const [recent, forYou, mostPlayed, playlists, downloaded] =
          await Promise.all([
            service.recentPlayedSongs({ limit: 10 }),
            service.forYouSongs({ limit: FOR_YOU_LIMIT }),
            service.songsPage({ sort: 'mostPlayed', limit: 10 }),
            service.playlistsPage({ limit: 10 }),
            service.downloadedSongs({ limit: 10 }),
          ]);
        if (!alive) return;
        setLocal({ recent, forYou, mostPlayed, playlists, downloaded });
        setLocalError(false);
      })
      .catch(() => {
        if (alive) setLocalError(true);
      })
      .finally(() => {
        if (alive) setLocalLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [libraryVersion]);

  const loadBrowse = useCallback(
    async (force: boolean): Promise<void> => {
      if (!force) setBrowseState('loading');
      else setBrowseRefreshing(true);
      setBrowseStale(false);
      try {
        const cached = await loadCachedBrowseHome();
        if (cached && !force) {
          setBrowse(cached.page);
          setBrowseState('ready');
          const fresh =
            Date.now() - cached.fetchedAt < BROWSE_CACHE_TTL_MS;
          if (fresh) return;
          // Cache basi: tampilkan dulu, segarkan di latar.
          setBrowseRefreshing(true);
        }
        if (!navigator.onLine && !cached) {
          setBrowseState('offline');
          return;
        }
        const { getSearchService, SEARCH_UI_TIMEOUT_MS } = await import(
          '../../extractor/searchService'
        );
        const page = await getSearchService().browseHome({
          timeoutMs: SEARCH_UI_TIMEOUT_MS,
        });
        setBrowse(page);
        setBrowseState('ready');
        void saveCachedBrowseHome(page);
      } catch (error) {
        const kind = (error as { kind?: string } | null)?.kind;
        const cached = await loadCachedBrowseHome();
        if (cached) {
          // Gagal refresh: tampilkan data terakhir (PRD B6.4).
          setBrowse(cached.page);
          setBrowseState('ready');
          setBrowseStale(true);
          return;
        }
        if (!navigator.onLine || kind === 'network') {
          setBrowseState('offline');
        } else {
          setBrowseState('error');
          setBrowseErrorText(
            kind === 'parse'
              ? strings.browseParseError
              : strings.browseHttpError,
          );
        }
      } finally {
        setBrowseRefreshing(false);
      }
    },
    [],
  );

  // Penjaga StrictMode: di mode dev React menjalankan efek muat
  // Jelajah dua kali (mount → cleanup → mount); tanpa penjaga,
  // browseHome dipanggil dua kali dan E2E melihat 2 request
  // (gagal deterministik sejak E2E pindah ke server dev, Blue 1).
  // Di produksi efek hanya jalan sekali. Ref di-reset tiap remount
  // (instance komponen baru), jadi navigasi pergi-pulang tetap
  // memuat ulang — dan loadBrowse memeriksa cache dulu.
  const browseStarted = useRef(false);
  useEffect(() => {
    if (browseStarted.current) return;
    browseStarted.current = true;
    void loadBrowse(false);
  }, [loadBrowse]);

  const allLocalEmpty =
    local.recent.length === 0 &&
    local.forYou.length === 0 &&
    local.mostPlayed.length === 0 &&
    local.playlists.length === 0 &&
    local.downloaded.length === 0;
  const browseEmpty =
    browseState === 'ready' &&
    (browse == null || browse.shelves.every((s) => s.items.length === 0));
  const showNewUserEmpty =
    !localLoading &&
    allLocalEmpty &&
    (browseState === 'offline' ||
      browseState === 'error' ||
      browseEmpty);

  if (localError) {
    return (
      <div data-testid="home-page" className="pt-4">
        <p className="text-center text-sm text-zinc-400">
          {strings.libraryErrorBody}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="home-page" className="pt-2">
      {showNewUserEmpty ? (
        <div data-testid="home-empty" className="py-16 text-center">
          <h2 className="text-lg font-semibold tracking-tight">
            {strings.homeEmptyTitle}
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
            {strings.homeEmptyBody}
          </p>
          <button
            type="button"
            onClick={() => onNavigate('/search')}
            data-testid="home-empty-find"
            className="mt-6 h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95"
          >
            {strings.findSong}
          </button>
        </div>
      ) : null}

      {localLoading ? (
        <div className="mt-4" data-testid="home-loading">
          <SkeletonList rows={6} testId="home-skeleton" />
        </div>
      ) : (
        <>
          {local.recent.length > 0 ? (
            <Section
              title={strings.sectionRecent}
              testId="home-section-recent"
              action={
                <ViewAllButton
                  testId="home-recent-view-all"
                  onClick={() => onNavigate('/library?tab=history')}
                />
              }
            >
              <SongList songs={local.recent} testIdPrefix="home-recent" />
            </Section>
          ) : null}

          {local.forYou.length > 0 ? (
            <Section
              title={strings.sectionForYou}
              testId="home-section-for-you"
              action={
                local.forYou.length > 10 ? (
                  <button
                    type="button"
                    onClick={() => setForYouExpanded((v) => !v)}
                    data-testid="home-for-you-view-all"
                    className="shrink-0 rounded-full px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
                  >
                    {forYouExpanded ? strings.showFewer : strings.viewAll}
                  </button>
                ) : undefined
              }
            >
              <SongList
                songs={
                  forYouExpanded
                    ? local.forYou
                    : local.forYou.slice(0, 10)
                }
                testIdPrefix="home-for-you"
              />
            </Section>
          ) : null}

          {local.mostPlayed.length > 0 ? (
            <Section
              title={strings.sectionMostPlayed}
              testId="home-section-most-played"
              action={
                <ViewAllButton
                  testId="home-most-played-view-all"
                  onClick={() => {
                    useLibraryStore.getState().setSort('mostPlayed');
                    onNavigate('/library');
                  }}
                />
              }
            >
              <SongList songs={local.mostPlayed} testIdPrefix="home-most-played" />
            </Section>
          ) : null}

          {local.playlists.length > 0 ? (
            <Section
              title={strings.sectionPlaylists}
              testId="home-section-playlists"
              action={
                <ViewAllButton
                  testId="home-playlists-view-all"
                  onClick={() => onNavigate('/library?tab=playlists')}
                />
              }
            >
              <ul className="divide-y divide-white/5">
                {local.playlists.map((p) => (
                  <li key={p.playlist.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate(`/library/playlist/${p.playlist.id}`)
                      }
                      data-testid={`home-playlist-${p.playlist.id}`}
                      className="flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-white/5 active:bg-white/10"
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-sm text-zinc-400"
                      >
                        {p.playlist.name.charAt(0)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-zinc-100">
                          {p.playlist.name}
                        </span>
                        <span className="block text-xs text-zinc-400">
                          {p.songCount} {strings.songsLabel}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {local.downloaded.length > 0 ? (
            <Section
              title={strings.sectionDownloads}
              testId="home-section-downloads"
            >
              <SongList songs={local.downloaded} testIdPrefix="home-downloaded" />
            </Section>
          ) : null}
        </>
      )}

      {/* Jelajah: seksi jaringan terakhir (PRD B6.1). */}
      <Section
        title={strings.sectionBrowse}
        testId="home-section-browse"
        action={
          browseState === 'ready' ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void loadBrowse(true)}
                disabled={browseRefreshing}
                aria-label={strings.browseRefresh}
                data-testid="home-browse-refresh"
                className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95 disabled:opacity-50"
              >
                <ArrowClockwise
                  size={16}
                  className={browseRefreshing ? 'animate-spin' : undefined}
                />
              </button>
              <ViewAllButton
                testId="home-browse-view-all"
                onClick={() => onNavigate('/browse')}
              />
            </span>
          ) : undefined
        }
      >
        {browseState === 'loading' ? (
          <div data-testid="browse-loading">
            <SkeletonList rows={3} testId="browse-skeleton" />
          </div>
        ) : browseState === 'offline' ? (
          <div data-testid="browse-offline" className="py-4">
            <p className="text-sm text-zinc-400">{strings.searchOffline}</p>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">
              {strings.browseOfflineBody}
            </p>
          </div>
        ) : browseState === 'error' ? (
          <div data-testid="browse-error" className="py-4">
            <p className="text-sm leading-relaxed text-zinc-400">
              {browseErrorText}
            </p>
            <button
              type="button"
              onClick={() => void loadBrowse(true)}
              data-testid="browse-retry"
              className="mt-3 h-11 rounded-full border border-white/15 px-5 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
            >
              {strings.retry}
            </button>
          </div>
        ) : browse == null || browse.shelves.length === 0 ? (
          <p data-testid="browse-empty" className="py-4 text-sm text-zinc-400">
            {strings.browseEmptyBody}
          </p>
        ) : (
          <div>
            {browseStale ? (
              <p
                data-testid="browse-stale-notice"
                className="mb-3 text-xs text-zinc-400"
              >
                {strings.browseStaleNotice}
              </p>
            ) : null}
            <BrowseShelves
              shelves={browse.shelves.slice(0, 3)}
              onNavigate={onNavigate}
              maxSongsPerShelf={10}
            />
          </div>
        )}
      </Section>
    </div>
  );
}
