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
import { downloadUrl } from '../downloads/constants';
import { getDownloadStore } from '../downloads/downloadStore';
import { getLibraryService, MIN_PLAY_EVENT_MS } from '../data/library';
import {
  classifyPlaybackFailure,
  failureMessage,
} from '../resilience/errors';
import {
  canaryHealthSignal,
  loadCanaryRecord,
  type CanaryHealthSignal,
} from '../resilience/canary';
import {
  advanceLadder,
  BACKGROUND_RETRY_BACKOFF_MS,
  isLadderDue,
  isLoginRequiredOnly,
  startLadder,
  type RetryLadderState,
} from '../resilience/retryLadder';
import {
  causeFromFailureCause,
  kindFromFailureCause,
  recordFailureSnapshot,
  type DiagnosticCause,
  type FailureSnapshot,
} from '../resilience/diagnostics';
import { logPlayer, persistPlayerLog } from '../resilience/playerLog';
import {
  migrateLocalStorageQueue,
  restoreQueueState,
  saveQueueState,
  type QueueStateToSave,
} from '../data/queuePersistence';
import { usePlayerStore, selectCurrentTrack, type PlayerState } from '../store/player';
import { useEqualizerStore, EQ_SETTINGS_KEY } from '../store/equalizer';
import { strings } from '../strings/id';
import { AudioGraphManager } from './audioGraph';
import {
  createEndOfSongTimer,
  createMinutesTimer,
  fadeFactor,
  isTimerExpired,
  SLEEP_TIMER_MINUTES,
} from './sleepTimer';
import type { EqPresetName, EqSettings } from './equalizer';
import { MediaSessionManager } from './mediaSession';
import {
  loadPersistedPlayerState,
  writeQueueSnapshot,
} from './persistence';
import { HtmlAudioPort, isSafeLocalUrl, type AudioPlayerPort } from './port';
import {
  getIframeController,
  shouldEnterIframeFallback,
} from './iframeFallback';
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
  /** Tangga retry latar yang sedang berjalan (null bila tidak ada). */
  retryLadder: {
    videoId: string;
    step: number;
    nextAttemptAt: number;
  } | null;
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
  /** videoId lagu yang sedang diputar dari file unduhan (P5). */
  private playingDownloadedVideoId: string | null = null;
  /** Apakah fallback unduhan-ke-stream sudah dipakai lagu ini. */
  private downloadFallbackUsed = false;
  private initialized = false;
  private detachPort: Array<() => void> = [];
  private persistChain: Promise<void> = Promise.resolve();
  /** Faktor volume fade-out timer tidur saat ini (1 = tanpa fade). */
  private fadeFactorCurrent = 1;
  /**
   * Tangga retry latar yang sedang berjalan (hotfix resolve):
   * percobaan ulang LOGIN_REQUIRED di +60 dtk dan +5 mnt sesudah
   * tangga cepat P6 habis. Hanya di memori (tidak dipersist):
   * reload halaman menghentikan tangga, pengguna menekan putar
   * untuk memulai lagi.
   */
  private backgroundRetry: (RetryLadderState & {
    trackId: string;
    token: number;
  }) | null = null;
  private backgroundRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** True saat satu percobaan latar sedang berjalan. */
  private backgroundRetryRunning = false;
  /** Jeda tangga latar (injeksi tes; produksi memakai konstanta). */
  private ladderBackoffMs: readonly number[];
  private historySession: {
    trackId: string;
    accumulatedMs: number;
    countingSince: number | null;
    upsertDone: Promise<void>;
  } | null = null;

  constructor(
    port: AudioPlayerPort = new HtmlAudioPort(),
    opts: { ladderBackoffMs?: readonly number[] } = {},
  ) {
    this.port = port;
    this.ladderBackoffMs =
      opts.ladderBackoffMs ?? BACKGROUND_RETRY_BACKOFF_MS;
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
    // Pengaturan EQ tersimpan dimuat sekali lalu diterapkan ke
    // graph (graph dibuat malas saat lagu lokal pertama diputar;
    // setEqGains menyimpan nilai walau graph belum ada).
    void useEqualizerStore
      .getState()
      .load()
      .then(() => {
        this.graph.applyEqSettings(
          useEqualizerStore.getState().settings,
        );
      })
      .catch(() => undefined);
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
    // Tab kembali terlihat: cek timer tidur (setInterval
    // di-throttle saat tab di latar, tenggat bisa terlewat).
    if (document.visibilityState === 'visible') {
      this.checkSleepTimer();
      // Tangga retry latar juga dicek di sini: timer setTimeout
      // di-throttle di tab latar (~1/menit), tapi tenggat
      // berbasis stempel waktu tetap bisa dicek saat tab kembali.
      void this.checkBackgroundRetry();
    }
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
      retryLadder: this.backgroundRetry
        ? {
            videoId: this.backgroundRetry.videoId,
            step: this.backgroundRetry.step,
            nextAttemptAt: this.backgroundRetry.nextAttemptAt,
          }
        : null,
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
    // Mode fallback: tombol putar mengarah ke pemutar YouTube
    // (cek ini WAJIB pertama — currentKind sudah 'stream' dan
    // status 'paused' akan salah mengarah ke elemen audio).
    if (state.fallbackMode === 'iframe') {
      usePlayerStore.getState().setPlayerState({
        errorMessage: null,
        notice: null,
      });
      getIframeController()?.play();
      return;
    }
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
    // Pengguna mengambil alih (jeda): tangga retry latar berhenti,
    // supaya lagu tidak mulai sendiri sesudah pengguna menjeda.
    this.cancelBackgroundRetry();
    // Mode fallback: jeda pemutar YouTube, bukan elemen audio.
    if (usePlayerStore.getState().fallbackMode === 'iframe') {
      getIframeController()?.pause();
      const state = usePlayerStore.getState();
      if (state.status === 'playing' || state.status === 'loading') {
        usePlayerStore.getState().setPlayerState({ status: 'paused' });
        this.mediaSession.setPlaybackState('paused');
        this.persistNow();
      }
      return;
    }
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
    // Mode fallback: geser posisi di pemutar YouTube.
    if (state.fallbackMode === 'iframe') {
      getIframeController()?.seekTo(seconds);
      usePlayerStore.getState().setPlayerState({ position: seconds });
      this.mediaSession.setPositionState(
        seconds,
        state.duration,
        state.rate,
      );
      this.persistSoon();
      return;
    }
    this.port.seek(seconds);
    usePlayerStore.getState().setPlayerState({ position: seconds });
    this.mediaSession.setPositionState(
      seconds,
      state.duration,
      state.rate,
    );
    this.persistSoon();
  }

  // ---------- Fallback pemutar YouTube (P3) ----------

  /**
   * Masuk mode fallback: lagu diputar pemutar resmi YouTube di
   * iframe (komponen IframeFallbackPlayer mount dari store).
   * Elemen audio dijeda supaya tidak ada suara ganda; tangga
   * retry latar dibatalkan (fallback ADALAH jalur pemulihannya).
   */
  private enterIframeFallback(videoId: string): void {
    this.cancelBackgroundRetry();
    this.port.pause();
    logPlayer('masuk mode pemutar YouTube (fallback)');
    usePlayerStore.getState().setPlayerState({
      fallbackMode: 'iframe',
      fallbackVideoId: videoId,
      status: 'loading',
      errorMessage: null,
      notice: strings.fallbackNotice,
    });
  }

  /**
   * Keluar dari mode fallback (resolve pulih, atau lagu lokal,
   * atau pengguna kembali ke cara biasa). No-op bila tidak
   * sedang dalam mode fallback. Komponen iframe unmount dari
   * perubahan store ini.
   */
  private exitIframeFallback(): void {
    if (usePlayerStore.getState().fallbackMode === null) return;
    usePlayerStore.getState().setPlayerState({
      fallbackMode: null,
      fallbackVideoId: null,
      notice: null,
    });
  }

  /**
   * Coba cara biasa lagi dari mode fallback (tombol di panel
   * fallback). Keluar dari mode fallback lalu muat ulang lagu
   * saat ini dari posisi terakhir: bila resolve kini berhasil,
   * pemutaran normal berlanjut; bila masih gagal, onResolveFailed
   * mengembalikan lagu ke mode fallback.
   */
  async retryNormalPlayback(): Promise<void> {
    const state = usePlayerStore.getState();
    const track = selectCurrentTrack(state);
    if (!track) return;
    this.exitIframeFallback();
    await this.loadTrack(track, {
      autoplay: true,
      startPosition: state.position,
    });
  }

  /**
   * Notifikasi dari komponen iframe (satu-satunya penulis state
   * untuk mode fallback — komponen tidak menulis store langsung).
   * Masing-masing no-op bila mode fallback sudah berakhir
   * (balapan dengan unmount komponen).
   */
  notifyFallbackPlaying(): void {
    if (usePlayerStore.getState().fallbackMode !== 'iframe') return;
    usePlayerStore.getState().setPlayerState({
      status: 'playing',
      notice: null,
    });
    this.mediaSession.setPlaybackState('playing');
    // Riwayat: mulai hitung waktu putar (cermin event 'play'
    // elemen audio di onPlay).
    if (this.historySession && this.historySession.countingSince === null) {
      this.historySession.countingSince = Date.now();
    }
  }

  notifyFallbackPaused(): void {
    if (usePlayerStore.getState().fallbackMode !== 'iframe') return;
    usePlayerStore.getState().setPlayerState({ status: 'paused' });
    this.mediaSession.setPlaybackState('paused');
    this.accumulateHistory();
    this.persistNow();
  }

  notifyFallbackBuffering(): void {
    if (usePlayerStore.getState().fallbackMode !== 'iframe') return;
    usePlayerStore.getState().setPlayerState({ status: 'loading' });
  }

  notifyFallbackProgress(position: number, duration: number): void {
    if (usePlayerStore.getState().fallbackMode !== 'iframe') return;
    const patch: Partial<PlayerState> = { position };
    if (duration > 0) patch.duration = duration;
    usePlayerStore.getState().setPlayerState(patch);
  }

  /** Lagu selesai di pemutar YouTube: jalur lanjut yang sama. */
  async notifyFallbackEnded(): Promise<void> {
    if (usePlayerStore.getState().fallbackMode !== 'iframe') return;
    await this.onEnded();
  }

  /**
   * Pemutar YouTube melaporkan galat (mis. video tidak bisa
   * diputar): keluar dari mode fallback dan gagalkan lagu
   * seperti biasa (pindah ke lagu berikut).
   */
  notifyFallbackError(): void {
    this.exitIframeFallback();
    void this.failCurrentTrack(strings.resolveFailed);
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
    usePlayerStore.getState().setPlayerState({ volume: v });
    this.applyEffectiveVolume();
    this.persistSoon();
  }

  /**
   * Terapkan volume efektif = volume pengguna dikali faktor fade
   * timer tidur. Semua perubahan volume lewat sini supaya fade
   * tidak pernah tertinggal di satu jalur (graph/stream/lokal).
   */
  private applyEffectiveVolume(): void {
    const v =
      usePlayerStore.getState().volume * this.fadeFactorCurrent;
    this.graph.setVolume(v);
    this.port.setVolume(v, 'stream');
    // Elemen lokal dijaga 1 bila graph tersambung (volume lewat gain).
    this.port.setVolume(this.graph.isAttached ? 1 : v, 'local');
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

  /**
   * Hentikan pemutar TOTAL untuk hapus data (P8): jeda, kosongkan
   * antrean SEPENUHNYA (termasuk lagu yang sedang diputar — beda
   * dengan clearQueue() yang mempertahankan lagu saat ini),
   * batalkan timer tidur, batalkan persist tertunda, lalu tulis
   * keadaan kosong dan TUNGGU sampai rantai tulis IndexedDB
   * selesai.
   *
   * Penantian ini penting: tanpa itu, tulis debounce 500 ms dari
   * clearQueue() bisa mendarat SESUDAH database dihapus dan
   * membangkitkan antrean (bug yang ditemukan E2E P8: antrean
   * tersisa 1 lagu sesudah wipe). Rantai persist mengevaluasi
   * state saat eksekusi, jadi mengosongkan store sebelum menunggu
   * rantai membuat tulis tertunda apa pun menjadi no-op.
   */
  async stopForWipe(): Promise<void> {
    this.pause();
    this.clearSleepTimer();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    usePlayerStore.getState().setPlayerState({
      queue: [],
      order: [],
      orderPos: 0,
    });
    this.persistNow();
    await this.persistChain;
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
   * Info pengatur suara (EQ) untuk UI. EQ 10 band aktif hanya di
   * jalur graph (lokal/unduhan); streaming tidak bisa masuk graph
   * (CORS tertutup, vonis S5) sehingga kontrol menampilkan pesan
   * jujur, bukan slider mati.
   */
  eqInfo(): { available: boolean; note: string } {
    const state = usePlayerStore.getState();
    if (state.audioPath === 'graph') {
      return { available: true, note: '' };
    }
    return {
      available: false,
      note: strings.eqStreamingNote,
    };
  }

  /** Terapkan preset EQ + simpan + teruskan ke graph. */
  async setEqPreset(
    preset: Exclude<EqPresetName, 'custom'>,
  ): Promise<void> {
    await useEqualizerStore.getState().setPreset(preset);
    this.graph.applyEqSettings(useEqualizerStore.getState().settings);
  }

  /** Ubah satu band EQ + simpan + teruskan ke graph. */
  async setEqBand(index: number, db: number): Promise<void> {
    await useEqualizerStore.getState().setBand(index, db);
    this.graph.applyEqSettings(useEqualizerStore.getState().settings);
  }

  /** Kembalikan EQ ke rata + simpan + teruskan ke graph. */
  async resetEq(): Promise<void> {
    await useEqualizerStore.getState().reset();
    this.graph.applyEqSettings(useEqualizerStore.getState().settings);
  }

  /**
   * Terapkan pengaturan EQ dari sinkronisasi (P7): tulis store
   * + simpan + teruskan ke graph (bila sedang memutar lokal).
   * Dipanggil syncService sesudah menarik settings dari server;
   * penanda "pengaturan berubah" TIDAK dicatat di sini (nilai
   * ini asalnya dari server, bukan perubahan lokal).
   */
  async applySyncedEqSettings(settings: EqSettings): Promise<void> {
    useEqualizerStore.getState().setSettingsState(settings);
    try {
      const library = await getLibraryService();
      await library.setMeta(EQ_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Gagal simpan: pengaturan tetap berlaku di sesi ini.
    }
    this.graph.applyEqSettings(settings);
  }

  // ---------- Timer tidur (P7) ----------

  /** Pasang timer menit (5/10/15/30/45/60). */
  setSleepTimerMinutes(minutes: number): void {
    if (
      !(SLEEP_TIMER_MINUTES as readonly number[]).includes(minutes)
    ) {
      return;
    }
    this.fadeFactorCurrent = 1;
    this.applyEffectiveVolume();
    usePlayerStore.getState().setPlayerState({
      sleepTimer: createMinutesTimer(minutes, Date.now()),
    });
  }

  /** Pasang timer akhir-lagu, terkunci ke lagu yang sedang diputar. */
  setSleepTimerEndOfSong(): void {
    const track = selectCurrentTrack(usePlayerStore.getState());
    if (!track) return;
    this.fadeFactorCurrent = 1;
    this.applyEffectiveVolume();
    usePlayerStore.getState().setPlayerState({
      sleepTimer: createEndOfSongTimer(track.id),
    });
  }

  /** Batalkan timer tidur dan kembalikan volume penuh. */
  clearSleepTimer(): void {
    this.fadeFactorCurrent = 1;
    this.applyEffectiveVolume();
    usePlayerStore.getState().setPlayerState({ sleepTimer: null });
  }

  /**
   * Cek timer tidur terhadap tenggat (dipanggil watchdog tiap
   * detik, tiap timeupdate saat lagu jalan, dan saat tab kembali
   * terlihat — tiga pemicu supaya tenggat tidak terlewat saat
   * setInterval di-throttle di latar).
   */
  private checkSleepTimer(): void {
    const timer = usePlayerStore.getState().sleepTimer;
    if (!timer || timer.mode !== 'minutes') return;
    const now = Date.now();
    if (isTimerExpired(timer, now)) {
      this.fireSleepTimer();
      return;
    }
    const factor = fadeFactor(timer, now);
    if (Math.abs(factor - this.fadeFactorCurrent) > 0.01) {
      this.fadeFactorCurrent = factor;
      this.applyEffectiveVolume();
    }
  }

  /** Timer habis: jeda pemutaran, kembalikan volume, hapus timer. */
  private fireSleepTimer(): void {
    this.fadeFactorCurrent = 1;
    usePlayerStore.getState().setPlayerState({ sleepTimer: null });
    this.applyEffectiveVolume();
    this.pause();
    this.persistNow();
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

  /**
   * Resolver bersama untuk kanari (P6): cek latar memakai
   * resolver yang sama dengan pemutaran, bukan instance kedua.
   */
  async getResolver(): Promise<StreamResolver> {
    return this.ensureResolver();
  }

  /**
   * Resolve dengan batas waktu keseluruhan + single-flight.
   * `opts.maxRounds` membatasi putaran cepat P6 (kanari dan
   * percobaan latar memakai 1; tanpa opsi, default 3 putaran).
   */
  private resolveWithTimeout(
    track: Track,
    opts: { maxRounds?: number } = {},
  ): Promise<ResolvedTrack> {
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
          resolver.resolve(
            { videoId, title: track.title },
            {
              ...(opts.maxRounds !== undefined
                ? { maxRounds: opts.maxRounds }
                : {}),
              // Retry lintas waktu (P6): selama menunggu putaran
              // berikut, UI tetap tenang ("mencari jalur lain"),
              // bukan error.
              onRetryRound: (round) => {
                logPlayer(`mencari jalur lain (putaran ${round})`);
                usePlayerStore.getState().setPlayerState({
                  notice: strings.retryLookingForAnotherWay,
                });
              },
            },
          ),
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

  /**
   * URL file unduhan lagu ini, bila terunduh DAN Service Worker
   * mengendalikan halaman (tanpa SW, `/dl/` tidak bisa dilayani).
   * Null berarti pakai jalur stream biasa. Gagal cek apa pun
   * berarti stream (unduhan tidak pernah merusak pemutaran).
   */
  private async downloadedFileUrl(videoId: string): Promise<string | null> {
    try {
      if (!('serviceWorker' in navigator)) return null;
      if (!navigator.serviceWorker.controller) return null;
      const has = await getDownloadStore().hasDownload(videoId);
      return has ? downloadUrl(videoId) : null;
    } catch {
      return null;
    }
  }

  private async loadTrack(
    track: Track,
    opts: { autoplay: boolean; startPosition: number },
  ): Promise<void> {
    const token = ++this.playToken;
    // Ganti lagu (apa pun pemicunya: skip, pilih lagu, coba lagi,
    // hapus dari antrean): tangga retry lagu lama berhenti.
    this.cancelBackgroundRetry();
    // Ganti lagu SELALU keluar dari mode fallback dulu (lagu baru
    // mencoba cara biasa; masuk fallback lagi hanya bila resolve
    // + cache gagal). Tanpa ini, lagu lokal/unduhan akan berbunyi
    // bersamaan dengan pemutar YouTube lagu lama.
    this.exitIframeFallback();
    this.stallTracker.reset();
    this.reResolveCount = 0;
    this.preResolvedUrl = null;
    this.preResolvedFor = null;
    this.pendingSeek = null;
    this.pendingPlay = false;
    this.playingDownloadedVideoId = null;
    this.downloadFallbackUsed = false;
    // Timer akhir-lagu terkunci ke satu lagu: ganti lagu (next,
    // prev, hapus antrean, pilih lagu lain) membatalkannya dengan
    // pesan (PRD B2). Muat ulang lagu yang sama (coba lagi) tidak.
    const sleepTimer = usePlayerStore.getState().sleepTimer;
    if (
      sleepTimer?.mode === 'end-of-song' &&
      sleepTimer.trackId !== track.id
    ) {
      usePlayerStore.getState().setPlayerState({
        sleepTimer: null,
        notice: strings.sleepTimerCancelledOnChange,
      });
    }
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

    // Sumber lokal: track lokal memakai URL-nya sendiri; track
    // streaming memakai file unduhan bila ada (P5: unduhan dulu,
    // lalu stream — urutan sumber arsitektur §3.3).
    let localUrl: string | null = null;
    if (track.source.kind === 'local') {
      localUrl = track.source.url;
    } else {
      localUrl = await this.downloadedFileUrl(track.source.videoId);
      if (token !== this.playToken) return;
      if (localUrl) {
        this.playingDownloadedVideoId = track.source.videoId;
      }
    }
    if (localUrl) {
      // Titik choke (Red 1 I3): tolak URL lokal host asing SEBELUM
      // probe CORS di decidePath menyentuh host itu. port.load
      // memeriksa lagi sebagai pertahanan lapis kedua.
      if (!isSafeLocalUrl(localUrl)) {
        this.onResolveFailed(
          new Error('URL audio lokal tidak diizinkan'),
        );
        return;
      }
      this.currentKind = 'local';
      const path = await this.graph.decidePath(localUrl);
      if (token !== this.playToken) return;
      if (path === 'graph') {
        this.graph.attach(this.port.getLocalElement());
        this.graph.applyEqSettings(
          useEqualizerStore.getState().settings,
        );
        this.applyEffectiveVolume();
        this.port.load(localUrl, 'local');
      } else {
        this.port.load(localUrl, 'stream');
      }
      usePlayerStore.getState().setPlayerState({ audioPath: path });
      this.beginPlayback(token, opts);
      return;
    }

    this.currentKind = 'stream';
    let resolved: ResolvedTrack;
    try {
      // Sinyal kanari (hotfix): kanari gagal BARU-BARU INI karena
      // YouTube menolak berarti jendela buruk sedang berjalan —
      // lewati putaran cepat yang hampir pasti gagal (maxRounds 1)
      // dan tampilkan status jujur sejak awal, bukan sesudah
      // 20 detik putaran yang sia-sia. Sinyal lolos/basi/tidak
      // ada berarti resolve normal (tangga cepat P6 tetap jalan).
      const canarySignal = await this.readCanarySignal();
      if (token !== this.playToken) return;
      const skipFastRounds = canarySignal === 'recent-fail';
      if (skipFastRounds) {
        usePlayerStore.getState().setPlayerState({
          notice: strings.retryLimitingAuto,
        });
      }
      resolved = await this.resolveWithTimeout(
        track,
        skipFastRounds ? { maxRounds: 1 } : undefined,
      );
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
    // Resolve lolos: pesan "mencari jalur lain" tidak berlaku lagi.
    usePlayerStore.getState().setPlayerState({ notice: null });
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
    // Timer tidur dicek juga di sini: timeupdate tetap menyala
    // saat lagu berbunyi walau setInterval di-throttle di latar.
    this.checkSleepTimer();
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
    // Timer akhir-lagu: lagu yang dikunci selesai berarti timer
    // habis — jeda di sini, jangan lanjut ke lagu berikut dan
    // jangan ulangi lagu (repeat one kalah dari timer).
    const timer = state.sleepTimer;
    const track = selectCurrentTrack(state);
    if (
      timer?.mode === 'end-of-song' &&
      track &&
      timer.trackId === track.id
    ) {
      usePlayerStore.getState().setPlayerState({
        sleepTimer: null,
        status: 'paused',
      });
      this.mediaSession.setPlaybackState('paused');
      this.persistNow();
      return;
    }
    if (state.repeat === 'one') {
      this.seek(0);
      // Mode fallback: putar ulang pemutar YouTube (seek di atas
      // sudah mengarah ke iframe; port.play akan memutar elemen
      // audio basi yang tidak bersuara).
      if (state.fallbackMode === 'iframe') {
        getIframeController()?.play();
        return;
      }
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
    // Snapshot ENGINE (P6: menutup celah APK — kegagalan pemutar
    // kini tertangkap, bukan hanya kegagalan resolve). Kode 1
    // (dibatalkan) dilewati: itu efek samping ganti sumber, bukan
    // kegagalan lagu. Tanpa URL, tanpa videoId.
    if (snap.errorCode !== 1) {
      const minutes = Math.floor(state.position / 60);
      const seconds = String(Math.floor(state.position % 60)).padStart(
        2,
        '0',
      );
      logPlayer(
        `pemutar gagal kode ${snap.errorCode} di ${minutes}:${seconds}`,
      );
      // Log bertahan melewati reload (best-effort).
      void persistPlayerLog();
      this.recordEngineSnapshot(snap.errorCode);
    }
    // File unduhan rusak/hilang di tengah jalan: sekali saja,
    // jatuh ke stream (resolve) dari posisi terakhir, bukan
    // langsung pindah lagu. decideOnError tidak mencakup kasus
    // ini (error di posisi 0 langsung 'next').
    if (this.playingDownloadedVideoId && !this.downloadFallbackUsed) {
      this.downloadFallbackUsed = true;
      this.playingDownloadedVideoId = null;
      await this.doReResolve();
      return;
    }
    const decision = decideOnError(state.position, this.reResolveCount);
    if (decision === 'reresolve') {
      await this.doReResolve();
      return;
    }
    await this.failCurrentTrack();
  }

  private onResolveFailed(error: unknown): void {
    // Klasifikasi 6 penyebab (P6): pesan yang tampil disesuaikan
    // dengan penyebabnya, bukan satu pesan generik.
    const classified = classifyPlaybackFailure({
      online: navigator.onLine,
      error,
    });
    const attempts =
      error instanceof ResolveError ? error.attempts : [];
    if (attempts.length > 0) {
      logPlayer(`gagal cari lagu: ${attempts.join(', ')}`);
    } else {
      logPlayer('gagal cari lagu (tanpa rincian upaya)');
    }
    // Log bertahan melewati reload (best-effort).
    void persistPlayerLog();
    this.recordResolveSnapshot(classified.cause, classified.isTimeout);
    // Tangga latar (hotfix): MAYORITAS upaya LOGIN_REQUIRED
    // berarti jendela buruk yang bisa berbalik dalam hitungan
    // menit — jangan langsung pindah lagu; coba lagi di latar
    // (+60 dtk, +5 mnt) sementara lagu tetap di antrean. Galat
    // lain (termasuk UNPLAYABLE murni di semua client, yang bisa
    // berarti lagu yang benar-benar tidak ada) memakai perilaku
    // lama di bawah. Pengecualian: bila pengguna SUDAH menjeda
    // saat resolve gagal (jeda manual atau timer tidur selama
    // tangga cepat), tangga TIDAK mulai — lagu tidak boleh mulai
    // sendiri menit-menit sesudah pengguna menjeda; perilaku lama
    // (failCurrentTrack) yang berlaku.
    if (
      isLoginRequiredOnly(attempts) &&
      usePlayerStore.getState().status !== 'paused'
    ) {
      const track = selectCurrentTrack(usePlayerStore.getState());
      if (
        track &&
        track.source.kind === 'stream' &&
        this.startBackgroundRetry(track, track.source.videoId)
      ) {
        return;
      }
    }
    void this.failCurrentTrack(failureMessage(classified));
  }

  /** Snapshot kegagalan resolve untuk kode diagnostik LRS1. */
  private recordResolveSnapshot(
    cause: Parameters<typeof causeFromFailureCause>[0],
    isTimeout: boolean,
  ): void {
    const last = this.resolver?.lastResolve ?? null;
    const clientsTried = last?.clientsTried ?? [];
    const lastClient = clientsTried[clientsTried.length - 1] ?? null;
    const snapshot: FailureSnapshot = {
      layer: 'resolve',
      kind: kindFromFailureCause(cause, isTimeout),
      cause: causeFromFailureCause(cause),
      failedAt: Date.now(),
      clientsTried,
      lastClient,
      lastPlayability: lastClient
        ? (last?.playabilityByClient[lastClient] ?? null)
        : null,
      playerHash: this.resolver?.playerHash ?? null,
    };
    recordFailureSnapshot(snapshot);
  }

  /**
   * Snapshot kegagalan ENGINE untuk kode diagnostik LRS1.
   * Kode error elemen media: 2 jaringan, 3 decode, 4 sumber tidak
   * didukung (googlevideo 403 mendarat di sini).
   */
  private recordEngineSnapshot(errorCode: number): void {
    const last = this.resolver?.lastResolve ?? null;
    const clientsTried = last?.clientsTried ?? [];
    const lastClient = clientsTried[clientsTried.length - 1] ?? null;
    const cause: DiagnosticCause =
      errorCode === 4 ? 'http-forbidden' : 'unknown';
    const snapshot: FailureSnapshot = {
      layer: 'engine',
      kind: errorCode === 2 ? 'network' : 'engine',
      cause,
      failedAt: Date.now(),
      clientsTried,
      lastClient,
      lastPlayability: lastClient
        ? (last?.playabilityByClient[lastClient] ?? null)
        : null,
      playerHash: this.resolver?.playerHash ?? null,
    };
    recordFailureSnapshot(snapshot);
  }

  // ---------- Tangga retry latar (hotfix resolve) ----------

  /** Baca sinyal kesehatan kanari terakhir (best-effort). */
  private async readCanarySignal(): Promise<CanaryHealthSignal> {
    try {
      const record = await loadCanaryRecord();
      return canaryHealthSignal(record, Date.now());
    } catch {
      return 'unknown';
    }
  }

  /**
   * Mulai tangga retry latar untuk lagu saat ini sesudah tangga
   * cepat P6 gagal mayoritas LOGIN_REQUIRED (Blue 7 R21).
   * Status tetap 'loading'
   * + notice jujur ("YouTube sedang membatasi, mencoba lagi
   * otomatis."); lagu tetap di antrean; pengguna bisa skip kapan
   * saja (skip memanggil loadTrack yang membatalkan tangga).
   * Mengembalikan false bila tangga tidak bisa dimulai (daftar
   * jeda kosong — hanya dipakai tes untuk menonaktifkan tangga).
   */
  private startBackgroundRetry(track: Track, videoId: string): boolean {
    const ladder = startLadder(videoId, Date.now(), this.ladderBackoffMs);
    if (!ladder) return false;
    this.cancelBackgroundRetry();
    this.backgroundRetry = {
      ...ladder,
      trackId: track.id,
      token: this.playToken,
    };
    logPlayer('mencoba lagi di latar (tangga 60 dtk, 5 mnt)');
    usePlayerStore.getState().setPlayerState({
      status: 'loading',
      notice: strings.retryLimitingAuto,
      errorMessage: null,
    });
    this.armBackgroundRetryTimer();
    return true;
  }

  /** Batalkan tangga latar (skip / ganti lagu / jeda / wipe). */
  private cancelBackgroundRetry(): void {
    if (this.backgroundRetryTimer) {
      clearTimeout(this.backgroundRetryTimer);
      this.backgroundRetryTimer = null;
    }
    this.backgroundRetry = null;
  }

  /**
   * Pasang timer setTimeout untuk tenggat berikut. Timer HANYA
   * pemicu cepat: tenggat juga dicek watchdog tiap detik dan
   * saat tab kembali terlihat, jadi throttle timer di tab latar
   * tidak menghentikan tangga.
   */
  private armBackgroundRetryTimer(): void {
    if (this.backgroundRetryTimer) {
      clearTimeout(this.backgroundRetryTimer);
    }
    const retry = this.backgroundRetry;
    if (!retry) return;
    const waitMs = Math.max(0, retry.nextAttemptAt - Date.now());
    this.backgroundRetryTimer = setTimeout(() => {
      this.backgroundRetryTimer = null;
      void this.checkBackgroundRetry();
    }, waitMs);
  }

  /**
   * Cek tenggat tangga latar (watchdog tiap detik, timer, dan
   * visibilitychange). Idempotent dan dijaga dari tumpang
   * tindih: beberapa pemicu boleh memanggil bersamaan, hanya
   * satu percobaan yang jalan.
   */
  private async checkBackgroundRetry(): Promise<void> {
    const retry = this.backgroundRetry;
    if (!retry || this.backgroundRetryRunning) return;
    if (retry.token !== this.playToken) {
      this.cancelBackgroundRetry();
      return;
    }
    if (!isLadderDue(retry, Date.now())) return;
    const track = selectCurrentTrack(usePlayerStore.getState());
    if (!track || track.id !== retry.trackId) {
      this.cancelBackgroundRetry();
      return;
    }
    await this.runBackgroundRetryAttempt(retry, track);
  }

  /**
   * Satu percobaan latar: satu putaran resolve (maxRounds 1,
   * maks 3 request) untuk lagu yang sama. Lolos berarti putar
   * seperti biasa; masih mayoritas LOGIN_REQUIRED berarti maju
   * ke langkah berikut atau habiskan tangga; galat lain berarti
   * berhenti dengan perilaku lama.
   */
  private async runBackgroundRetryAttempt(
    retry: RetryLadderState & { trackId: string; token: number },
    track: Track,
  ): Promise<void> {
    this.backgroundRetryRunning = true;
    try {
      const resolved = await this.resolveWithTimeout(track, {
        maxRounds: 1,
      });
      // Batal di tengah percobaan (skip/jeda/ganti lagu):
      // jangan sentuh pemutar.
      if (
        retry.token !== this.playToken ||
        this.backgroundRetry?.token !== retry.token
      ) {
        return;
      }
      this.cancelBackgroundRetry();
      this.port.load(resolved.url, 'stream');
      usePlayerStore.getState().setPlayerState({ audioPath: 'direct' });
      this.beginPlayback(retry.token, {
        autoplay: true,
        startPosition: 0,
      });
    } catch (error) {
      if (
        retry.token !== this.playToken ||
        this.backgroundRetry?.token !== retry.token
      ) {
        return;
      }
      const attempts =
        error instanceof ResolveError ? error.attempts : [];
      if (isLoginRequiredOnly(attempts)) {
        const next = advanceLadder(
          retry,
          Date.now(),
          this.ladderBackoffMs,
        );
        if (next) {
          this.backgroundRetry = {
            ...next,
            trackId: track.id,
            token: retry.token,
          };
          logPlayer(`mencoba lagi di latar (langkah ${next.step + 1})`);
          this.armBackgroundRetryTimer();
          return;
        }
        this.exhaustBackgroundRetry(attempts);
        return;
      }
      // Bukan mayoritas LOGIN_REQUIRED lagi (internet putus,
      // proxy mati, format tidak ada): berhenti, perilaku lama
      // yang berlaku.
      this.cancelBackgroundRetry();
      const classified = classifyPlaybackFailure({
        online: navigator.onLine,
        error,
      });
      void this.failCurrentTrack(failureMessage(classified));
    } finally {
      this.backgroundRetryRunning = false;
    }
  }

  /**
   * Tangga habis: resolve gagal TOTAL (langsung + cache + dua
   * percobaan latar selama ~6 menit). Perilaku P3: masuk mode
   * fallback pemutar YouTube supaya lagu tetap bisa diputar,
   * bukan berhenti diam — dengan gerbang yang sama dengan
   * tangga (mayoritas LOGIN_REQUIRED + pengguna belum menjeda;
   * jeda manual membatalkan tangga, jadi kasus jeda praktis
   * tidak sampai ke sini, tapi gerbang tetap dicek eksplisit).
   * Bila gerbang tidak lolos, perilaku lama yang berlaku:
   * berhenti DI LAGU INI dengan pesan akhir yang jujur
   * ("YouTube masih membatasi. Coba lagi nanti.") — TIDAK
   * pindah otomatis ke lagu berikut. Selama jendela buruk semua
   * lagu gagal; pindah otomatis hanya membakar antrean dan
   * menyembunyikan pesan akhir. Pengguna bisa menekan "Coba
   * lagi" atau skip sendiri.
   */
  private exhaustBackgroundRetry(attempts: string[]): void {
    this.cancelBackgroundRetry();
    logPlayer('tangga retry habis, YouTube masih membatasi');
    void persistPlayerLog();
    this.failures.recordFailure();
    const state = usePlayerStore.getState();
    const track = selectCurrentTrack(state);
    if (
      track &&
      track.source.kind === 'stream' &&
      shouldEnterIframeFallback({ attempts, status: state.status })
    ) {
      this.enterIframeFallback(track.source.videoId);
      return;
    }
    usePlayerStore.getState().setPlayerState({
      status: 'error',
      errorMessage: strings.retryExhausted,
      notice: null,
    });
    this.mediaSession.setPlaybackState('paused');
    this.persistNow();
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
    logPlayer(`cari ulang lagu (ke-${this.reResolveCount})`);
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
    this.cancelBackgroundRetry();
    this.port.pause();
    this.currentKind = null;
    this.playingDownloadedVideoId = null;
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
    // Timer tidur dicek dulu, tanpa peduli status putar: tenggat
    // menit berjalan walau lagu dijeda.
    this.checkSleepTimer();
    // Tangga retry latar dicek di sini juga: tenggat berbasis
    // stempel waktu, jadi tetap jalan walau timer setTimeout
    // di-throttle saat tab di latar.
    await this.checkBackgroundRetry();
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
    this.cancelBackgroundRetry();
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
