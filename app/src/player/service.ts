/**
 * PlayerService: orkestrator pemutar. Satu-satunya kode yang
 * memegang elemen audio (lewat port), resolver, MediaSession,
 * graph Web Audio, dan penyimpanan antrean.
 *
 * Komponen UI memanggil metode service ini dan membaca state dari
 * store Zustand. Service tidak mengimpor komponen apa pun.
 *
 * Alur stream: resolve via proxy + solver (StreamResolver) lalu
 * `<audio>` langsung ke googlevideo. Alur lokal: URL same-origin
 * lewat graph Web Audio (EQ) bila lolos CORS, tanpa graph bila
 * tidak. Re-resolve tengah lagu memakai mekanisme yang terbukti
 * S3 (ganti src, kembali ke posisi yang sama).
 */
import {
  ResolveError,
  StreamResolver,
  type ResolvedTrack,
} from '../extractor/resolve';
import { getLibraryService, MIN_PLAY_EVENT_MS } from '../data/library';
import {
  migrateLocalStorageQueue,
  restoreQueueState,
  saveQueueState,
  type QueueStateToSave,
} from '../data/queuePersistence';
import { usePlayerStore, selectCurrentTrack, type PlayerState } from '../store/player';
import { strings } from '../strings/id';
import { AudioGraphManager } from './audioGraph';
import { MediaSessionManager } from './mediaSession';
import {
  loadPersistedPlayerState,
  writeQueueSnapshot,
} from './persistence';
import { HtmlAudioPort, type AudioPlayerPort } from './port';
import {
  decideOnError,
  decideRestorePosition,
  FailureCounter,
  MAX_RERESOLVE_PER_TRACK,
  PRERESOLVE_AT_SECONDS,
  RESOLVE_OVERALL_TIMEOUT_MS,
  StallTracker,
} from './recovery';
import {
  addToQueue,
  clearExceptCurrent,
  createQueue,
  currentTrack,
  decideNext,
  decidePrev,
  playNext,
  removeFromQueue,
  setShuffle,
  type QueueState,
} from './queue';
import { PLAYBACK_RATES, type RepeatMode, type Track } from './types';

const WATCHDOG_INTERVAL_MS = 1000;
const PERSIST_DEBOUNCE_MS = 500;
const POSITION_PERSIST_EVERY_MS = 5000;

export interface PlayerDebugState {
  status: string;
  currentVideoId: string | null;
  audioPath: string | null;
  reResolveCount: number;
  consecutiveFailures: number;
  playbackRate: number;
  position: number;
  duration: number;
}

declare global {
  interface Window {
    __larasPlayer?: {
      getState: () => PlayerDebugState;
    };
  }
}

function queueFromStore(): QueueState {
  const s = usePlayerStore.getState();
  return { items: s.queue, order: s.order, orderPos: s.orderPos };
}

export class PlayerService {
  private port: AudioPlayerPort;
  private mediaSession = new MediaSessionManager();
  private graph = new AudioGraphManager();
  private resolver: StreamResolver | null = null;
  private resolverInit: Promise<void> | null = null;
  private inFlightResolve = new Map<string, Promise<ResolvedTrack>>();
  private stallTracker = new StallTracker();
  private failures = new FailureCounter();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersistAt = 0;
  private lastPositionStateAt = 0;
  private playToken = 0;
  private pendingSeek: number | null = null;
  private pendingPlay = false;
  private reResolveCount = 0;
  private preResolvedUrl: string | null = null;
  private preResolvedFor: string | null = null;
  private currentKind: 'stream' | 'local' | null = null;
  private initialized = false;
  private detachPort: Array<() => void> = [];
  private persistChain: Promise<void> = Promise.resolve();
  private historySession: {
    trackId: string;
    accumulatedMs: number;
    countingSince: number | null;
    upsertDone: Promise<void>;
  } | null = null;

  constructor(port: AudioPlayerPort = new HtmlAudioPort()) {
    this.port = port;
  }

  /** Inisialisasi sekali: pulihkan antrean, pasang listener, watchdog. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    void this.restore();
    this.mediaSession.setHandlers({
      onPlay: () => void this.play(),
      onPause: () => this.pause(),
      onNext: () => void this.next(),
      onPrev: () => void this.prev(),
      onSeekTo: (seconds) => this.seek(seconds),
    });
    this.detachPort = [
      this.port.on('loadedmetadata', () => this.onLoadedMetadata()),
      this.port.on('timeupdate', () => this.onTimeUpdate()),
      this.port.on('playing', () => this.onPlaying()),
      this.port.on('pause', () => this.onPaused()),
      this.port.on('ended', () => void this.onEnded()),
      this.port.on('error', () => void this.onError()),
      this.port.on('seeked', () => this.stallTracker.reset()),
    ];
    this.watchdog = setInterval(() => void this.watchdogTick(), WATCHDOG_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    // pagehide lebih andal dari beforeunload di mobile (tab
    // ditutup dari pengalih tugas); tulis IndexedDB bersifat
    // async, jadi ini hanya kesempatan terakhir — simpan berkala
    // 5 detik + saat jeda adalah pengaman utamanya.
    window.addEventListener('pagehide', this.onPageHide);
    window.__larasPlayer = { getState: () => this.debugState() };
  }

  private onPageHide = (): void => {
    this.persistNow();
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.persistNow();
  };

  private onBeforeUnload = (): void => {
    this.persistNow();
  };

  debugState(): PlayerDebugState {
    const s = usePlayerStore.getState();
    const track = selectCurrentTrack(s);
    return {
      status: s.status,
      currentVideoId:
        track && track.source.kind === 'stream'
          ? track.source.videoId
          : null,
      audioPath: s.audioPath,
      reResolveCount: this.reResolveCount,
      consecutiveFailures: this.failures.failures,
      playbackRate: this.port.snapshot().playbackRate,
      position: s.position,
      duration: s.duration,
    };
  }

  // ---------- Antrean dan pemutaran ----------

  /** Ganti seluruh antrean dan putar lagu di `startIndex`. */
  async playQueue(tracks: Track[], startIndex = 0): Promise<void> {
    const queue = createQueue(tracks, startIndex);
    usePlayerStore.getState().setPlayerState({
      queue: queue.items,
      order: queue.order,
      orderPos: queue.orderPos,
      shuffle: false,
      errorMessage: null,
      notice: null,
    });
    this.persistSoon();
    await this.playAt(queue.orderPos);
  }

  /** Putar lagu di posisi urutan putar tertentu. */
  async playAt(orderPos: number): Promise<void> {
    const state = usePlayerStore.getState();
    if (orderPos < 0 || orderPos >= state.order.length) return;
    const track = state.queue[state.order[orderPos]];
    if (!track) return;
    usePlayerStore.getState().setPlayerState({ orderPos });
    await this.loadTrack(track, { autoplay: true, startPosition: 0 });
  }

  async play(): Promise<void> {
    const state = usePlayerStore.getState();
    const track = selectCurrentTrack(state);
    if (!track) return;
    // Lagu sudah dimuat (status paused): lanjutkan saja.
    if (state.status === 'paused' && this.currentKind !== null) {
      usePlayerStore.getState().setPlayerState({
        errorMessage: null,
        notice: null,
      });
      try {
        await this.graph.resume();
        await this.port.play();
      } catch (error) {
        this.handlePlayRejection(error);
      }
      return;
    }
    // Lagu belum dimuat (sesudah pulih dari penyimpanan): muat
    // lalu putar dari posisi tersimpan.
    if (state.status === 'idle' || state.status === 'error') {
      this.failures.recordSuccess();
      await this.loadTrack(track, {
        autoplay: true,
        startPosition: state.position,
      });
    }
  }

  pause(): void {
    this.port.pause();
    // Event 'pause' juga memperbarui state; setel eksplisit supaya
    // UI merespons seketika tanpa menunggu event.
    const state = usePlayerStore.getState();
    if (state.status === 'playing' || state.status === 'loading') {
      usePlayerStore.getState().setPlayerState({ status: 'paused' });
      this.mediaSession.setPlaybackState('paused');
      this.persistNow();
    }
  }

  async toggle(): Promise<void> {
    const state = usePlayerStore.getState();
    if (state.status === 'playing' || state.status === 'loading') {
      this.pause();
    } else {
      await this.play();
    }
  }

  async next(): Promise<void> {
    const queue = queueFromStore();
    const state = usePlayerStore.getState();
    const decision = decideNext(queue, state.repeat, true);
    if (decision.action === 'advance') {
      await this.playAt(decision.orderPos);
    }
    // Di ujung antrean dengan repeat mati, next tidak berbuat apa-apa.
  }

  async prev(): Promise<void> {
    const queue = queueFromStore();
    const state = usePlayerStore.getState();
    const decision = decidePrev(queue, state.position, state.repeat);
    if (decision.action === 'restart') {
      this.seek(0);
      return;
    }
    await this.playAt(decision.orderPos);
  }

  seek(seconds: number): void {
    const state = usePlayerStore.getState();
    if (state.status === 'idle') return;
    this.stallTracker.reset();
    this.port.seek(seconds);
    usePlayerStore.getState().setPlayerState({ position: seconds });
    this.mediaSession.setPositionState(
      seconds,
      state.duration,
      state.rate,
    );
    this.persistSoon();
  }

  // ---------- Pengaturan putar ----------

  setShuffle(enable: boolean): void {
    const queue = setShuffle(queueFromStore(), enable);
    usePlayerStore.getState().setPlayerState({
      queue: queue.items,
      order: queue.order,
      orderPos: queue.orderPos,
      shuffle: enable,
    });
    this.persistSoon();
  }

  setRepeat(mode: RepeatMode): void {
    usePlayerStore.getState().setPlayerState({ repeat: mode });
    this.persistSoon();
  }

  cycleRepeat(): void {
    const current = usePlayerStore.getState().repeat;
    const next: RepeatMode =
      current === 'off' ? 'all' : current === 'all' ? 'one' : 'off';
    this.setRepeat(next);
  }

  setRate(rate: number): void {
    if (!PLAYBACK_RATES.includes(rate as (typeof PLAYBACK_RATES)[number])) {
      return;
    }
    this.port.setRate(rate);
    usePlayerStore.getState().setPlayerState({ rate });
    this.persistSoon();
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    this.graph.setVolume(v);
    this.port.setVolume(v, 'stream');
    // Elemen lokal dijaga 1 bila graph tersambung (volume lewat gain).
    this.port.setVolume(this.graph.isAttached ? 1 : v, 'local');
    usePlayerStore.getState().setPlayerState({ volume: v });
    this.persistSoon();
  }

  // ---------- Kelola antrean ----------

  addToQueue(tracks: Track[]): number {
    const { queue, dropped } = addToQueue(queueFromStore(), tracks);
    usePlayerStore.getState().setPlayerState({
      queue: queue.items,
      order: queue.order,
      orderPos: queue.orderPos,
    });
    this.persistSoon();
    return dropped;
  }

  playNext(tracks: Track[]): number {
    const { queue, dropped } = playNext(queueFromStore(), tracks);
    usePlayerStore.getState().setPlayerState({
      queue: queue.items,
      order: queue.order,
      orderPos: queue.orderPos,
    });
    this.persistSoon();
    return dropped;
  }

  async removeFromQueue(queueIndex: number): Promise<void> {
    const before = queueFromStore();
    const state = usePlayerStore.getState();
    const wasCurrent =
      before.order[before.orderPos] === queueIndex;
    const wasPlaying = state.status === 'playing';
    const queue = removeFromQueue(before, queueIndex);
    usePlayerStore.getState().setPlayerState({
      queue: queue.items,
      order: queue.order,
      orderPos: queue.orderPos,
    });
    this.persistSoon();
    if (queue.items.length === 0) {
      this.stopPlayback();
      return;
    }
    if (wasCurrent) {
      const track = currentTrack(queue);
      if (!track) return;
      await this.loadTrack(track, {
        autoplay: wasPlaying,
        startPosition: 0,
      });
    }
  }

  clearQueue(): void {
    const queue = clearExceptCurrent(queueFromStore());
    usePlayerStore.getState().setPlayerState({
      queue: queue.items,
      order: queue.order,
      orderPos: queue.orderPos,
    });
    this.persistSoon();
  }

  /** Coba lagi lagu yang gagal (tombol "Coba lagi"). */
  async retry(): Promise<void> {
    const track = selectCurrentTrack(usePlayerStore.getState());
    if (!track) return;
    this.failures.recordSuccess();
    this.reResolveCount = 0;
    await this.loadTrack(track, { autoplay: true, startPosition: 0 });
  }

  /**
   * Info pengatur suara (EQ) untuk UI. EQ 10 band adalah fitur P7;
   * P2 hanya menyampaikan keadaan dengan jujur: streaming tidak
   * bisa masuk graph (CORS tertutup, vonis S5), lokal bisa tetapi
   * kontrolnya belum dibangun.
   */
  eqInfo(): { available: boolean; note: string } {
    const state = usePlayerStore.getState();
    if (state.audioPath === 'graph') {
      return {
        available: false,
        note: strings.eqLocalNote,
      };
    }
    return {
      available: false,
      note: strings.eqStreamingNote,
    };
  }

  // ---------- Muat lagu ----------

  private async ensureResolver(): Promise<StreamResolver> {
    if (!this.resolver) {
      this.resolver = new StreamResolver();
    }
    if (!this.resolverInit) {
      this.resolverInit = this.resolver
        .init()
        .then(() => undefined)
        .catch(() => undefined);
    }
    await this.resolverInit;
    return this.resolver;
  }

  /** Resolve dengan batas waktu keseluruhan + single-flight. */
  private resolveWithTimeout(track: Track): Promise<ResolvedTrack> {
    if (track.source.kind !== 'stream') {
      return Promise.reject(
        new ResolveError('bukan lagu streaming', 'Bukan lagu streaming.'),
      );
    }
    const videoId = track.source.videoId;
    const existing = this.inFlightResolve.get(videoId);
    if (existing) return existing;
    const promise = (async (): Promise<ResolvedTrack> => {
      const resolver = await this.ensureResolver();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ResolveError(
                  'resolve melewati batas 90 detik',
                  strings.resolveSlow,
                ),
              ),
            RESOLVE_OVERALL_TIMEOUT_MS,
          );
        });
        return await Promise.race([
          resolver.resolve({ videoId, title: track.title }),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        this.inFlightResolve.delete(videoId);
      }
    })();
    this.inFlightResolve.set(videoId, promise);
    return promise;
  }

  private async loadTrack(
    track: Track,
    opts: { autoplay: boolean; startPosition: number },
  ): Promise<void> {
    const token = ++this.playToken;
    this.stallTracker.reset();
    this.reResolveCount = 0;
    this.preResolvedUrl = null;
    this.preResolvedFor = null;
    this.pendingSeek = null;
    this.pendingPlay = false;
    // Ganti lagu: tutup sesi riwayat lagu sebelumnya, lalu mulai
    // sesi baru + simpan metadata lagu ini (bukan ke Library).
    void this.finishHistorySession(false);
    this.startHistorySession(track);
    usePlayerStore.getState().setPlayerState({
      status: 'loading',
      position: opts.startPosition,
      duration: track.durationSeconds ?? 0,
      bufferedEnd: 0,
      errorMessage: null,
      notice: null,
      audioPath: null,
    });
    this.mediaSession.setTrack(track);
    this.mediaSession.setPlaybackState('none');

    if (track.source.kind === 'local') {
      this.currentKind = 'local';
      const path = await this.graph.decidePath(track.source.url);
      if (token !== this.playToken) return;
      if (path === 'graph') {
        this.graph.attach(this.port.getLocalElement());
        this.graph.setVolume(usePlayerStore.getState().volume);
        this.port.load(track.source.url, 'local');
      } else {
        this.port.load(track.source.url, 'stream');
      }
      usePlayerStore.getState().setPlayerState({ audioPath: path });
      this.beginPlayback(token, opts);
      return;
    }

    this.currentKind = 'stream';
    let resolved: ResolvedTrack;
    try {
      resolved = await this.resolveWithTimeout(track);
    } catch (error) {
      if (token !== this.playToken) return;
      this.onResolveFailed(error);
      return;
    }
    if (token !== this.playToken) return;
    this.port.load(resolved.url, 'stream');
    usePlayerStore.getState().setPlayerState({ audioPath: 'direct' });
    this.beginPlayback(token, opts);
  }

  /** Lanjutkan pemutaran sesudah src dimuat: seek lalu putar. */
  private beginPlayback(
    token: number,
    opts: { autoplay: boolean; startPosition: number },
  ): void {
    if (opts.startPosition > 0) {
      this.pendingSeek = opts.startPosition;
    }
    this.pendingPlay = opts.autoplay;
    // Bila metadata sudah tersedia (jarang), loadedmetadata tidak
    // selalu menyala lagi; coba putar langsung sebagai cadangan.
    if (opts.autoplay) {
      void this.attemptPlay(token);
    } else {
      usePlayerStore.getState().setPlayerState({ status: 'paused' });
    }
  }

  private async attemptPlay(token: number): Promise<void> {
    try {
      await this.graph.resume();
      await this.port.play();
    } catch (error) {
      if (token !== this.playToken) return;
      this.handlePlayRejection(error);
    }
  }

  private handlePlayRejection(error: unknown): void {
    const name =
      error instanceof Error ? error.name : '';
    // AbortError berarti play() disela muatan baru: bukan galat.
    if (name === 'AbortError') return;
    if (name === 'NotAllowedError') {
      usePlayerStore.getState().setPlayerState({
        status: 'paused',
        notice: strings.autoplayBlocked,
      });
      this.mediaSession.setPlaybackState('paused');
      return;
    }
    void this.onError();
  }

  // ---------- Event elemen audio ----------

  private onLoadedMetadata(): void {
    const snap = this.port.snapshot();
    const state = usePlayerStore.getState();
    const patch: Partial<PlayerState> = {};
    if (snap.duration > 0) {
      patch.duration = snap.duration;
      // Perbarui durasi lagu di antrean (untuk hitungan sisa antrean).
      const track = selectCurrentTrack(state);
      if (track && track.durationSeconds !== snap.duration) {
        const queue = state.queue.map((t) =>
          t.id === track.id ? { ...t, durationSeconds: snap.duration } : t,
        );
        patch.queue = queue;
      }
    }
    usePlayerStore.getState().setPlayerState(patch);
    if (this.pendingSeek !== null) {
      this.port.seek(this.pendingSeek);
      usePlayerStore.getState().setPlayerState({
        position: this.pendingSeek,
      });
      this.pendingSeek = null;
    }
    if (this.pendingPlay) {
      this.pendingPlay = false;
      void this.attemptPlay(this.playToken);
    }
  }

  private onTimeUpdate(): void {
    const snap = this.port.snapshot();
    usePlayerStore.getState().setPlayerState({
      position: snap.position,
      duration: snap.duration > 0 ? snap.duration : usePlayerStore.getState().duration,
      bufferedEnd: snap.bufferedEnd,
    });
    const now = Date.now();
    if (now - this.lastPositionStateAt >= 1000) {
      this.lastPositionStateAt = now;
      const state = usePlayerStore.getState();
      this.mediaSession.setPositionState(
        snap.position,
        snap.duration,
        state.rate,
      );
    }
  }

  private onPlaying(): void {
    this.failures.recordSuccess();
    usePlayerStore.getState().setPlayerState({
      status: 'playing',
      errorMessage: null,
    });
    this.mediaSession.setPlaybackState('playing');
    if (this.historySession && this.historySession.countingSince === null) {
      this.historySession.countingSince = Date.now();
    }
  }

  private onPaused(): void {
    const state = usePlayerStore.getState();
    if (state.status === 'playing') {
      usePlayerStore.getState().setPlayerState({ status: 'paused' });
      this.mediaSession.setPlaybackState('paused');
      this.persistNow();
    }
    this.accumulateHistory();
  }

  private async onEnded(): Promise<void> {
    // Lagu selesai diputar: catat sesi riwayat (PRD B2.7:
    // selesai dihitung walau di bawah ambang 10 detik).
    await this.finishHistorySession(true);
    const queue = queueFromStore();
    const state = usePlayerStore.getState();
    if (state.repeat === 'one') {
      this.seek(0);
      try {
        await this.port.play();
      } catch (error) {
        this.handlePlayRejection(error);
      }
      return;
    }
    const decision = decideNext(queue, state.repeat, false);
    if (decision.action === 'advance') {
      await this.playAt(decision.orderPos);
      return;
    }
    usePlayerStore.getState().setPlayerState({ status: 'paused' });
    this.mediaSession.setPlaybackState('paused');
    this.persistNow();
  }

  private async onError(): Promise<void> {
    const snap = this.port.snapshot();
    if (snap.errorCode === 0) return;
    const state = usePlayerStore.getState();
    if (state.status === 'idle' || state.status === 'error') return;
    const decision = decideOnError(state.position, this.reResolveCount);
    if (decision === 'reresolve') {
      await this.doReResolve();
      return;
    }
    await this.failCurrentTrack();
  }

  private onResolveFailed(error: unknown): void {
    const message =
      error instanceof ResolveError ? error.causeText : strings.resolveFailed;
    void this.failCurrentTrack(message);
  }

  // ---------- Pemulihan ----------

  /** Resolve ulang lagu saat ini dan lanjut dari posisi terakhir. */
  private async doReResolve(): Promise<void> {
    const track = selectCurrentTrack(usePlayerStore.getState());
    if (!track || track.source.kind !== 'stream') {
      await this.failCurrentTrack();
      return;
    }
    const token = this.playToken;
    const state = usePlayerStore.getState();
    const resumeAt = state.position;
    this.reResolveCount += 1;
    this.stallTracker.reset();
    usePlayerStore.getState().setPlayerState({ status: 'loading' });

    let url: string | null = null;
    if (
      this.preResolvedFor === track.source.videoId &&
      this.preResolvedUrl
    ) {
      url = this.preResolvedUrl;
      this.preResolvedUrl = null;
      this.preResolvedFor = null;
    } else {
      try {
        const resolved = await this.resolveWithTimeout(track);
        if (token !== this.playToken) return;
        url = resolved.url;
      } catch {
        if (token !== this.playToken) return;
        await this.failCurrentTrack();
        return;
      }
    }
    if (token !== this.playToken) return;
    this.port.load(url, 'stream');
    this.beginPlayback(token, { autoplay: true, startPosition: resumeAt });
  }

  /** Lagu saat ini gagal total: pindah ke berikut atau berhenti. */
  private async failCurrentTrack(message?: string): Promise<void> {
    const count = this.failures.recordFailure();
    const state = usePlayerStore.getState();
    const queue = queueFromStore();
    const stopMessage = strings.playbackError;
    if (
      this.failures.shouldStop ||
      state.repeat === 'one' ||
      decideNext(queue, state.repeat, false).action === 'stop'
    ) {
      usePlayerStore.getState().setPlayerState({
        status: 'error',
        errorMessage: count >= 3 ? stopMessage : (message ?? stopMessage),
      });
      this.mediaSession.setPlaybackState('paused');
      this.persistNow();
      return;
    }
    const decision = decideNext(queue, state.repeat, false);
    if (decision.action === 'advance') {
      await this.playAt(decision.orderPos);
    }
  }

  private stopPlayback(): void {
    this.port.pause();
    this.currentKind = null;
    this.mediaSession.clear();
    void this.finishHistorySession(false);
    usePlayerStore.getState().setPlayerState({
      status: 'idle',
      position: 0,
      duration: 0,
      bufferedEnd: 0,
      audioPath: null,
      errorMessage: null,
      notice: null,
    });
    this.clearStoredQueue();
  }

  /** Kosongkan antrean + status pemutar tersimpan di IndexedDB. */
  private clearStoredQueue(): void {
    void getLibraryService()
      .then(async (service) => {
        await service.clearQueue();
        await service.clearPlaybackState();
      })
      .catch(() => {
        // IndexedDB tidak tersedia: tidak ada yang perlu dibersihkan.
      });
  }

  // ---------- Watchdog + pra-resolve ----------

  private async watchdogTick(): Promise<void> {
    const state = usePlayerStore.getState();
    const track = selectCurrentTrack(state);
    if (!track) return;
    if (state.status === 'playing') {
      const action = this.stallTracker.feed(
        state.position,
        Date.now(),
        true,
      );
      if (action === 'resume') {
        try {
          await this.port.play();
        } catch (error) {
          this.handlePlayRejection(error);
        }
        return;
      }
      if (action === 'reresolve') {
        if (this.reResolveCount < MAX_RERESOLVE_PER_TRACK) {
          await this.doReResolve();
        } else {
          await this.failCurrentTrack();
        }
        return;
      }
      // Pra-resolve: siapkan URL segar sebelum dinding 1 MiB.
      if (
        track.source.kind === 'stream' &&
        state.position >= PRERESOLVE_AT_SECONDS &&
        this.preResolvedFor !== track.source.videoId &&
        !this.inFlightResolve.has(track.source.videoId)
      ) {
        // Tangkap videoId di sini: narrowing hilang di dalam callback.
        const videoId = track.source.videoId;
        void this.resolveWithTimeout(track)
          .then((resolved) => {
            this.preResolvedUrl = resolved.url;
            this.preResolvedFor = videoId;
          })
          .catch(() => {
            // Pra-resolve gagal diam-diam: resolve ulang reaktif
            // tetap jalan bila stream benar-benar putus.
          });
      }
      if (Date.now() - this.lastPersistAt >= POSITION_PERSIST_EVERY_MS) {
        this.persistNow();
      }
    } else {
      this.stallTracker.feed(state.position, Date.now(), false);
    }
  }

  // ---------- Pulih + simpan (IndexedDB, P3) ----------

  /**
   * Pulihkan antrean dari IndexedDB. Sebelum itu, migrasi satu
   * kali antrean localStorage lama (P2) bila masih ada. Gagal
   * buka database (mode privat) berarti mulai kosong, bukan crash.
   * Restore hanya diterapkan bila antrean masih kosong, supaya
   * tidak menimpa antrean yang sudah dibuat pengguna.
   */
  private async restore(): Promise<void> {
    let restored: Awaited<ReturnType<typeof restoreQueueState>> = null;
    try {
      const service = await getLibraryService();
      try {
        await migrateLocalStorageQueue(service);
      } catch {
        // Migrasi gagal: lanjut restore IndexedDB apa adanya.
      }
      restored = await restoreQueueState(service);
    } catch {
      restored = null;
    }
    let fromWal = false;
    if (!restored) {
      // Cadangan write-ahead: bila tulis IndexedDB belum selesai
      // saat tab ditutup/dimuat ulang, snapshot localStorage
      // sinkron menyelamatkan antrean (balapan P3: simpan async
      // terpotong teardown halaman bila jeda langsung diikuti
      // muat ulang — terbukti di CI, run 44201352963).
      const snapshot = loadPersistedPlayerState();
      if (snapshot) {
        restored = {
          tracks: snapshot.queue,
          order: snapshot.order,
          orderPos: snapshot.orderPos,
          positionSeconds: snapshot.positionSeconds,
          shuffle: snapshot.shuffle,
          repeat: snapshot.repeat,
          rate: snapshot.rate,
          volume: snapshot.volume,
        };
        fromWal = true;
      }
    }
    if (!restored) {
      this.port.setRate(1);
      this.port.setVolume(1);
      return;
    }
    if (usePlayerStore.getState().queue.length > 0) return;
    let { orderPos } = restored;
    let position = restored.positionSeconds;
    const track =
      restored.tracks[restored.order[orderPos]] ?? null;
    const decision = decideRestorePosition(
      restored.positionSeconds,
      track?.durationSeconds,
    );
    if (decision.action === 'next') {
      if (orderPos < restored.order.length - 1) {
        orderPos += 1;
        position = 0;
      } else {
        position = 0;
      }
    } else {
      position = decision.position;
    }
    const restoredTrack = restored.tracks[restored.order[orderPos]] ?? null;
    usePlayerStore.getState().setPlayerState({
      queue: restored.tracks,
      order: restored.order,
      orderPos,
      status: 'paused',
      position,
      duration: restoredTrack?.durationSeconds ?? 0,
      shuffle: restored.shuffle,
      repeat: restored.repeat,
      rate: restored.rate,
      volume: restored.volume,
    });
    this.port.setRate(restored.rate);
    this.graph.setVolume(restored.volume);
    this.port.setVolume(restored.volume);
    if (restoredTrack) {
      this.mediaSession.setTrack(restoredTrack);
      this.mediaSession.setPlaybackState('paused');
    }
    // Konvergensi: antrean dari WAL ditulis balik ke IndexedDB
    // supaya kedua store sinkron lagi (store sudah berisi antrean
    // di titik ini, jadi persistNow menulis state yang benar).
    if (fromWal) this.persistNow();
  }

  private buildQueueState(): QueueStateToSave | null {
    const s = usePlayerStore.getState();
    if (s.queue.length === 0) return null;
    return {
      tracks: s.queue,
      order: s.order,
      orderPos: s.orderPos,
      positionSeconds: s.position,
      shuffle: s.shuffle,
      repeat: s.repeat,
      rate: s.rate,
      volume: s.volume,
    };
  }

  private persistSoon(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Simpan antrean ke IndexedDB. Tulis dirantai berurutan supaya
   * dua simpan tidak saling menyela (transaksi Dexie berurutan).
   * State dibaca saat giliran tulis tiba, jadi simpan yang
   * menumpuk otomatis memakai state terbaru. Gagal simpan tidak
   * pernah merusak pemutaran; kesempatan berikutnya mencoba lagi.
   */
  private persistNow(): void {
    // Write-ahead SINKRON ke localStorage sebelum rantai tulis
    // IndexedDB yang async: bila tab ditutup/dimuat ulang sebelum
    // tulis IndexedDB selesai, snapshot ini yang dipakai restore.
    // (localStorage.setItem selesai sebelum fungsi kembali.)
    writeQueueSnapshot(this.buildQueueState());
    this.persistChain = this.persistChain
      .then(async () => {
        const state = this.buildQueueState();
        if (!state) return;
        try {
          const service = await getLibraryService();
          await saveQueueState(service, state);
          this.lastPersistAt = Date.now();
        } catch {
          // Simpan gagal (mis. IndexedDB penuh): abaikan, coba lagi
          // di kesempatan berikutnya.
        }
      })
      .catch(() => undefined);
  }

  // ---------- Riwayat putar (P3) ----------

  /**
   * Mulai sesi riwayat untuk lagu yang akan diputar + simpan
   * metadata lagunya (bukan ke Library). Lagu lokal blob/data
   * dilewati: id-nya tidak bisa dipulihkan sesudah tutup browser.
   */
  private startHistorySession(track: Track): void {
    const isRestorableLocal =
      track.source.kind === 'local' &&
      !track.source.url.startsWith('blob:') &&
      !track.source.url.startsWith('data:');
    const upsertDone =
      track.source.kind === 'stream' || isRestorableLocal
        ? getLibraryService()
            .then((service) =>
              service.upsertSong(
                {
                  id: track.id,
                  title: track.title,
                  albumId: null,
                  durationSeconds: track.durationSeconds ?? null,
                  thumbnailUrl: track.artwork ?? null,
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
                {
                  artistNames: track.artist ? [track.artist] : [],
                  addToLibrary: false,
                },
              ),
            )
            .catch(() => undefined)
        : Promise.resolve();
    this.historySession = {
      trackId: track.id,
      accumulatedMs: 0,
      countingSince: null,
      upsertDone,
    };
  }

  /** Akumulasikan waktu putar sejak terakhir dihitung. */
  private accumulateHistory(): void {
    const session = this.historySession;
    if (!session || session.countingSince === null) return;
    session.accumulatedMs += Date.now() - session.countingSince;
    session.countingSince = null;
  }

  /**
   * Tutup sesi riwayat lagu saat ini. Dicatat bila lagu diputar
   * minimal 10 detik (PRD B2.7) atau sampai selesai (`completed`).
   * Menunggu upsert metadata selesai dulu supaya total waktu
   * putar lagu ikut terhitung.
   */
  private async finishHistorySession(completed: boolean): Promise<void> {
    const session = this.historySession;
    if (!session) return;
    // Akumulasi DULU selagi sesi masih terpasang, baru lepas.
    this.accumulateHistory();
    this.historySession = null;
    const playTimeMs = Math.round(session.accumulatedMs);
    if (playTimeMs <= 0) return;
    if (!completed && playTimeMs < MIN_PLAY_EVENT_MS) return;
    try {
      await session.upsertDone;
      const service = await getLibraryService();
      await service.recordPlay({
        songId: session.trackId,
        timestamp: Date.now(),
        playTimeMs,
      });
    } catch {
      // Gagal catat riwayat tidak boleh merusak pemutaran.
    }
  }

  dispose(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    for (const fn of this.detachPort) fn();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('pagehide', this.onPageHide);
    this.port.dispose();
    this.initialized = false;
  }
}

let instance: PlayerService | null = null;

/** Singleton service pemutar (dibuat malas di browser). */
export function getPlayerService(): PlayerService {
  if (!instance) instance = new PlayerService();
  return instance;
}
