/**
 * Halaman Jelajah penuh (`/browse`) dan halaman detail browse
 * (`/browse/:browseId`): artis, album, playlist, kategori
 * mood/genre.
 *
 * Beranda Jelajah memakai cache 6 jam yang sama dengan seksi
 * Jelajah di beranda (PRD B6.4): cache segar tampil langsung,
 * cache basi tampil dulu lalu disegarkan di latar, gagal refresh
 * menampilkan data terakhir. Halaman detail selalu memuat segar
 * (tanpa cache) karena isinya spesifik per halaman.
 *
 * Galat diklasifikasikan (PRD B6.5): parse gagal berarti YouTube
 * mungkin mengubah layanannya; galat lain berarti coba lagi
 * nanti. Tanpa detail teknis di pesan.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Play } from '@phosphor-icons/react';
import {
  BROWSE_CACHE_TTL_MS,
  loadCachedBrowseHome,
  saveCachedBrowseHome,
} from '../../data/browseCache';
import {
  browsePageAllSongs,
  type BrowsePage as BrowsePageData,
} from '../../extractor/searchParser';
import {
  SEARCH_UI_TIMEOUT_MS,
  getSearchService,
  type SearchErrorKind,
} from '../../extractor/searchService';
import { strings } from '../../strings/id';
import AppLink from '../AppLink';
import { coverSrcSet } from '../coverSrc';
import SkeletonList from '../SkeletonList';
import BrowseShelves from './BrowseShelves';
import { playAllBrowseSongs } from './browsePlay';

type BrowseState = 'loading' | 'ready' | 'offline' | 'error';

export default function BrowsePage({
  browseId,
  browseParams,
  onNavigate,
}: {
  /** Undefined berarti beranda Jelajah (FEmusic_home). */
  browseId?: string;
  browseParams?: string;
  onNavigate: (path: string) => void;
}) {
  const isHome = browseId == null;
  const [page, setPage] = useState<BrowsePageData | null>(null);
  const [state, setState] = useState<BrowseState>('loading');
  const [errorText, setErrorText] = useState('');
  const [stale, setStale] = useState(false);
  const [headerImgFailed, setHeaderImgFailed] = useState(false);

  const load = useCallback(
    async (force: boolean): Promise<void> => {
      setState('loading');
      setStale(false);
      if (isHome) {
        const cached = await loadCachedBrowseHome();
        if (cached && !force) {
          setPage(cached.page);
          setState('ready');
          const fresh =
            Date.now() - cached.fetchedAt < BROWSE_CACHE_TTL_MS;
          if (fresh) return;
          // Cache basi: tampilkan dulu, segarkan di latar.
        }
        if (!navigator.onLine && !cached) {
          setState('offline');
          return;
        }
      }
      if (!navigator.onLine && !isHome) {
        setState('offline');
        return;
      }
      try {
        const loaded = isHome
          ? await getSearchService().browseHome({
              timeoutMs: SEARCH_UI_TIMEOUT_MS,
            })
          : await getSearchService().browse(browseId ?? '', {
              params: browseParams,
              timeoutMs: SEARCH_UI_TIMEOUT_MS,
            });
        setPage(loaded);
        setState('ready');
        if (isHome) void saveCachedBrowseHome(loaded);
      } catch (error) {
        const kind = (error as { kind?: SearchErrorKind } | null)?.kind;
        if (isHome) {
          const cached = await loadCachedBrowseHome();
          if (cached) {
            setPage(cached.page);
            setState('ready');
            setStale(true);
            return;
          }
        }
        if (!navigator.onLine || kind === 'network') {
          setState('offline');
        } else {
          setState('error');
          setErrorText(
            kind === 'parse'
              ? strings.browseParseError
              : strings.browseHttpError,
          );
        }
      }
    },
    [browseId, browseParams, isHome],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const songs = page ? browsePageAllSongs(page) : [];
  const headerCover = coverSrcSet(page?.thumbnailUrl, '96px');

  return (
    <div data-testid="browse-page" className="pt-2">
      <div className="flex items-center gap-2">
        <AppLink
          to={isHome ? '/' : '/browse'}
          onNavigate={onNavigate}
          ariaLabel={strings.browseBack}
          testId="browse-back"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-100 transition-colors hover:bg-white/5 active:scale-95"
        >
          <ArrowLeft size={20} />
        </AppLink>
        <h2 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
          {isHome ? strings.browseTitle : (page?.title ?? strings.browseTitle)}
        </h2>
      </div>

      {state === 'loading' && page == null ? (
        <div className="mt-6" data-testid="browse-loading">
          <SkeletonList rows={6} testId="browse-skeleton" />
        </div>
      ) : null}

      {state === 'offline' ? (
        <div data-testid="browse-offline" className="py-12 text-center">
          <h3 className="text-lg font-semibold tracking-tight">
            {strings.searchOffline}
          </h3>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
            {strings.browseOfflineBody}
          </p>
        </div>
      ) : null}

      {state === 'error' ? (
        <div data-testid="browse-error" className="py-12 text-center">
          <h3 className="text-lg font-semibold tracking-tight">
            {strings.browseErrorTitle}
          </h3>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
            {errorText}
          </p>
          <button
            type="button"
            onClick={() => void load(true)}
            data-testid="browse-retry"
            className="mt-6 h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95"
          >
            {strings.retry}
          </button>
        </div>
      ) : null}

      {state === 'ready' && page != null ? (
        <div data-testid="browse-content">
          {stale ? (
            <p
              data-testid="browse-stale-notice"
              className="mt-4 text-xs text-zinc-400"
            >
              {strings.browseStaleNotice}
            </p>
          ) : null}
          {!isHome && (page.title || page.thumbnailUrl) ? (
            <div className="mt-4 flex items-start gap-4">
              {page.thumbnailUrl && !headerImgFailed ? (
                <img
                  src={page.thumbnailUrl}
                  srcSet={headerCover?.srcSet}
                  sizes={headerCover?.sizes}
                  alt=""
                  width={96}
                  height={96}
                  onError={() => setHeaderImgFailed(true)}
                  className="h-24 w-24 shrink-0 rounded-xl object-cover"
                />
              ) : null}
              <div className="min-w-0 flex-1 pt-1">
                <p className="text-lg font-semibold leading-snug tracking-tight">
                  {page.title}
                </p>
                {page.subtitle ? (
                  <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                    {page.subtitle}
                  </p>
                ) : null}
                {songs.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => playAllBrowseSongs(songs)}
                    data-testid="browse-play-all"
                    className="mt-3 flex h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-medium text-black transition-transform active:scale-95"
                  >
                    <Play size={16} weight="fill" aria-hidden="true" />
                    {strings.playAll}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {page.shelves.length === 0 ? (
            <div data-testid="browse-empty" className="py-12 text-center">
              <h3 className="text-lg font-semibold tracking-tight">
                {strings.browseEmptyTitle}
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
                {strings.browseEmptyBody}
              </p>
            </div>
          ) : (
            <div className="mt-6">
              <BrowseShelves shelves={page.shelves} onNavigate={onNavigate} />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
