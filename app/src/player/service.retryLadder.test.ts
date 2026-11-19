/**
 * Tes tangga retry latar (hotfix resolve) di tingkat service:
 * tangga mulai sesudah tangga cepat P6 gagal LOGIN_REQUIRED
 * murni, percobaan latar di +60 dtk dan +5 mnt, pembatalan saat
 * skip/jeda, sinyal kanari, dan tenggat tab-latar.
 *
 * Jam palsu (vi.useFakeTimers): tangga 5 dtk/15 dtk/60 dtk/5 mnt
 * diuji tanpa tidur sungguhan. IndexedDB memakai fake-indexeddb;
 * operasinya dijadwalkan lewat setImmediate (yang ikut dipalsukan
 * jam), jadi tiap operasi async yang menyentuh Dexie dijalankan
 * bersama advanceTimersByTimeAsync (lihat `drive`).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerService } from './service';
import { usePlayerStore } from '../store/player';
import { deleteDatabase, LARAS_DB_NAME, openDatabase } from '../data/database';
import { resetLibraryService } from '../data/library';
import {
  CANARY_RECORD_KEY,
  type CanaryRecord,
} from '../resilience/canary';
import { CONFIG_URL } from '../spike/config';
import { strings } from '../strings/id';
import type {
  AudioPlayerPort,
  AudioPortEvent,
  AudioPortSnapshot,
} from './port';
import type { Track } from './types';

const CONFIG_JSON = {
  clients: [
    { clientId: '67', name: 'WEB_REMIX', version: '1.20261110.04.00' },
    { clientId: '2', name: 'MWEB', version: '2.20260708.05.00' },
    {
      clientId: '14',
      name: 'ANDROID_VR',
      requiresScript: false,
      version: '1.65.10',
    },
  ],
  playerHashes: { b559f50c: { signatureTimestamp: 20770 } },
  version: 1,
};

const STREAM_URL =
  'https://rr1---sn-a.googlevideo.com/videoplayback?expire=1999999999&itag=251';

const TRACK_1: Track = {
  id: 'vid11111111',
  title: 'Lagu Satu',
  source: { kind: 'stream', videoId: 'vid11111111' },
};

const TRACK_2: Track = {
  id: 'vid22222222',
  title: 'Lagu Dua',
  source: { kind: 'stream', videoId: 'vid22222222' },
};

interface PlayerCall {
  index: number;
  videoId: string;
  clientId: string;
}

type PlayerBehavior = (
  call: PlayerCall,
) => { playability: string; withUrl: boolean; httpStatus?: number };

function playerBody(
  playability: string,
  withUrl: boolean,
): Record<string, unknown> {
  return {
    playabilityStatus: { status: playability },
    streamingData: {
      adaptiveFormats: withUrl
        ? [
            {
              itag: 251,
              mimeType: 'audio/webm; codecs="opus"',
              bitrate: 160000,
              url: STREAM_URL,
            },
          ]
        : [],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Port palsu: load/play langsung memicu event elemen. */
class FakePort implements AudioPlayerPort {
  loadedUrls: string[] = [];
  playCalls = 0;
  private listeners = new Map<AudioPortEvent, Set<() => void>>();
  private playStartedAt: number | null = null;
  private frozenPosition = 0;
  private timeupdateTimer: ReturnType<typeof setInterval> | null = null;

  load(url: string): void {
    this.loadedUrls.push(url);
    this.playStartedAt = null;
    this.frozenPosition = 0;
    this.emit('loadedmetadata');
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    if (this.playStartedAt === null) {
      this.playStartedAt = Date.now();
    }
    // Elemen nyata memicu timeupdate berkala saat berbunyi:
    // tanpa ini watchdog mengira stream macet (posisi diam)
    // dan me-resolve ulang (STALL_RERESOLVE_AFTER_MS 10 dtk).
    if (!this.timeupdateTimer) {
      this.timeupdateTimer = setInterval(
        () => this.emit('timeupdate'),
        1000,
      );
    }
    this.emit('playing');
  }

  pause(): void {
    if (this.playStartedAt !== null) {
      this.frozenPosition +=
        (Date.now() - this.playStartedAt) / 1000;
      this.playStartedAt = null;
    }
    if (this.timeupdateTimer) {
      clearInterval(this.timeupdateTimer);
      this.timeupdateTimer = null;
    }
    this.emit('pause');
  }

  seek(): void {}
  setRate(): void {}
  setVolume(): void {}

  getLocalElement(): HTMLAudioElement {
    return document.createElement('audio');
  }

  snapshot(): AudioPortSnapshot {
    const position =
      this.playStartedAt !== null
        ? this.frozenPosition +
          (Date.now() - this.playStartedAt) / 1000
        : this.frozenPosition;
    return {
      position,
      duration: 180,
      bufferedEnd: 0,
      paused: false,
      playbackRate: 1,
      volume: 1,
      errorCode: 0,
    };
  }

  on(event: AudioPortEvent, cb: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  dispose(): void {
    if (this.timeupdateTimer) {
      clearInterval(this.timeupdateTimer);
      this.timeupdateTimer = null;
    }
    this.listeners.clear();
  }

  private emit(event: AudioPortEvent): void {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }
}

/** Jalankan promise async sambil memajukan jam palsu. */
async function drive<T>(promise: Promise<T>, ms: number): Promise<T> {
  const done = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const result = await done;
  if (!result.ok) throw result.error;
  return result.value;
}

/** Majukan jam sedikit supaya operasi Dexie (setImmediate) jalan. */
async function flushDb(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000);
}

async function seedCanary(record: CanaryRecord): Promise<void> {
  const done = (async () => {
    const db = await openDatabase();
    await db.app_meta.put({
      key: CANARY_RECORD_KEY,
      value: JSON.stringify(record),
    });
  })();
  await vi.advanceTimersByTimeAsync(5000);
  await done;
}

function canaryRecord(overrides: Partial<CanaryRecord>): CanaryRecord {
  return {
    checkedAt: Date.now(),
    succeeded: 5,
    failed: 0,
    networkFailures: 0,
    dominantCause: null,
    status: 'ok',
    streak: 0,
    streakCause: null,
    ...overrides,
  };
}

describe('PlayerService tangga retry latar (hotfix resolve)', () => {
  let service: PlayerService;
  let port: FakePort;
  let playerCalls: PlayerCall[];
  let behavior: PlayerBehavior;
  let visibility = 'visible';

  beforeEach(async () => {
    // Reset DB dengan jam ASLI (Dexie butuh setImmediate nyata).
    resetLibraryService();
    await deleteDatabase(LARAS_DB_NAME);
    vi.useFakeTimers();
    usePlayerStore.getState().setPlayerState({
      queue: [],
      order: [],
      orderPos: -1,
      status: 'idle',
      position: 0,
      duration: 0,
      bufferedEnd: 0,
      shuffle: false,
      repeat: 'off',
      rate: 1,
      volume: 1,
      audioPath: null,
      errorMessage: null,
      notice: null,
      fullPlayerOpen: false,
      sleepTimer: null,
    });
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    playerCalls = [];
    // Default: semua client LOGIN_REQUIRED (jendela buruk).
    behavior = () => ({ playability: 'LOGIN_REQUIRED', withUrl: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const urlText = String(url);
        if (urlText === CONFIG_URL) return jsonResponse(CONFIG_JSON);
        if (urlText.includes('/api/innertube/search')) {
          return jsonResponse({});
        }
        if (urlText.includes('/api/innertube/player')) {
          let videoId = '?';
          try {
            videoId = (
              JSON.parse(String(init?.body ?? '{}')) as {
                videoId?: string;
              }
            ).videoId ?? '?';
          } catch {
            videoId = '?';
          }
          const headers = (init?.headers ?? {}) as Record<string, string>;
          const call: PlayerCall = {
            index: playerCalls.length,
            videoId,
            clientId: headers['X-YouTube-Client-Name'] ?? '?',
          };
          playerCalls.push(call);
          const outcome = behavior(call);
          if (outcome.httpStatus && outcome.httpStatus !== 200) {
            return jsonResponse(
              { error: { code: 'MOCK_FAIL' } },
              outcome.httpStatus,
            );
          }
          return jsonResponse(
            playerBody(outcome.playability, outcome.withUrl),
          );
        }
        throw new Error(`fetch tak terduga: ${urlText}`);
      }),
    );
    port = new FakePort();
    service = new PlayerService(port);
    service.init();
    await flushDb();
  });

  afterEach(async () => {
    service.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetLibraryService();
    await deleteDatabase(LARAS_DB_NAME);
  });

  /** Putar antrean sampai resolve pertama selesai (cepat + latar). */
  async function playQueue(tracks: Track[]): Promise<void> {
    await drive(service.playQueue(tracks), 30_000);
  }

  function callsFor(videoId: string): PlayerCall[] {
    return playerCalls.filter((c) => c.videoId === videoId);
  }

  it('tangga latar mulai sesudah tangga cepat gagal LOGIN_REQUIRED murni', async () => {
    const startedAt = Date.now();
    await playQueue([TRACK_1, TRACK_2]);
    // Tangga cepat P6: 3 putaran x 3 client = 9 request.
    expect(playerCalls).toHaveLength(9);
    expect(callsFor('vid11111111')).toHaveLength(9);
    const state = usePlayerStore.getState();
    // Lagu TETAP di antrean + tetap lagu saat ini, status jujur.
    expect(state.queue).toHaveLength(2);
    expect(state.orderPos).toBe(0);
    expect(state.status).toBe('loading');
    expect(state.notice).toBe(strings.retryLimitingAuto);
    expect(state.errorMessage).toBeNull();
    // Tangga latar dijadwalkan: langkah 0, tenggat +60 dtk.
    const ladder = service.debugState().retryLadder;
    expect(ladder).not.toBeNull();
    expect(ladder?.videoId).toBe('vid11111111');
    expect(ladder?.step).toBe(0);
    expect(ladder!.nextAttemptAt).toBeGreaterThanOrEqual(startedAt + 60_000);
    expect(ladder!.nextAttemptAt).toBeLessThanOrEqual(
      startedAt + 30_000 + 60_000,
    );
  });

  it('percobaan latar +60 dtk lolos: lagu diputar, notice hilang', async () => {
    behavior = (call) =>
      call.index < 9
        ? { playability: 'LOGIN_REQUIRED', withUrl: false }
        : { playability: 'OK', withUrl: true };
    await playQueue([TRACK_1]);
    expect(service.debugState().retryLadder).not.toBeNull();
    // Majukan 61 dtk: percobaan latar 1 jalan dan lolos.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(callsFor('vid11111111')).toHaveLength(10);
    expect(port.loadedUrls).toEqual([STREAM_URL]);
    const state = usePlayerStore.getState();
    expect(state.status).toBe('playing');
    expect(state.notice).toBeNull();
    expect(state.errorMessage).toBeNull();
    expect(service.debugState().retryLadder).toBeNull();
  });

  it('percobaan +60 dtk gagal, +5 mnt lolos', async () => {
    behavior = (call) =>
      call.index < 12
        ? { playability: 'LOGIN_REQUIRED', withUrl: false }
        : { playability: 'OK', withUrl: true };
    await playQueue([TRACK_1]);
    await vi.advanceTimersByTimeAsync(61_000);
    // Percobaan latar 1 gagal (3 request): tangga maju ke langkah 5 mnt.
    expect(callsFor('vid11111111')).toHaveLength(12);
    const ladder = service.debugState().retryLadder;
    expect(ladder?.step).toBe(1);
    expect(usePlayerStore.getState().status).toBe('loading');
    expect(usePlayerStore.getState().notice).toBe(
      strings.retryLimitingAuto,
    );
    await vi.advanceTimersByTimeAsync(301_000);
    expect(callsFor('vid11111111')).toHaveLength(13);
    expect(port.loadedUrls).toEqual([STREAM_URL]);
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(service.debugState().retryLadder).toBeNull();
  }, 20000);

  it('tangga habis sesudah +5 mnt gagal: pesan akhir jujur, lagu TIDAK pindah', async () => {
    await playQueue([TRACK_1, TRACK_2]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(callsFor('vid11111111')).toHaveLength(12);
    await vi.advanceTimersByTimeAsync(301_000);
    // Total maks 15 request/lagu (9 cepat + 3 + 3 latar).
    expect(callsFor('vid11111111')).toHaveLength(15);
    const state = usePlayerStore.getState();
    expect(state.status).toBe('error');
    expect(state.errorMessage).toBe(strings.retryExhausted);
    expect(state.notice).toBeNull();
    // TIDAK pindah otomatis: lagu yang sama tetap di depan.
    expect(state.orderPos).toBe(0);
    expect(state.queue).toHaveLength(2);
    expect(service.debugState().retryLadder).toBeNull();
    // "Coba lagi" manual tetap jalan sesudah jendela pulih.
    behavior = () => ({ playability: 'OK', withUrl: true });
    await drive(service.retry(), 30_000);
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(port.loadedUrls).toEqual([STREAM_URL]);
  }, 30000);

  it('skip saat tangga berjalan membatalkan retry lagu itu', async () => {
    behavior = (call) =>
      call.videoId === 'vid22222222'
        ? { playability: 'OK', withUrl: true }
        : { playability: 'LOGIN_REQUIRED', withUrl: false };
    await playQueue([TRACK_1, TRACK_2]);
    expect(service.debugState().retryLadder).not.toBeNull();
    // Skip melewati tenggat lama (+80 dtk): tidak ada percobaan
    // latar untuk lagu 1, lagu 2 langsung diputar.
    await drive(service.next(), 80_000);
    expect(callsFor('vid11111111')).toHaveLength(9);
    // Lagu 2: 1 resolve awal + 1 pra-resolve di detik ke-45
    // (perilaku P2 yang sudah ada, bukan tangga retry).
    expect(callsFor('vid22222222')).toHaveLength(2);
    expect(port.loadedUrls).toEqual([STREAM_URL]);
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(service.debugState().retryLadder).toBeNull();
  });

  it('jeda saat tangga berjalan membatalkan retry', async () => {
    await playQueue([TRACK_1]);
    expect(service.debugState().retryLadder).not.toBeNull();
    service.pause();
    expect(service.debugState().retryLadder).toBeNull();
    expect(usePlayerStore.getState().status).toBe('paused');
    // Melewati kedua tenggat: tidak ada percobaan lagi.
    await vi.advanceTimersByTimeAsync(400_000);
    expect(callsFor('vid11111111')).toHaveLength(9);
    expect(port.loadedUrls).toHaveLength(0);
  }, 20000);

  it('jeda saat tangga cepat berjalan: tangga latar TIDAK mulai', async () => {
    const p = service.playQueue([TRACK_1]);
    await vi.advanceTimersByTimeAsync(1000);
    service.pause();
    expect(usePlayerStore.getState().status).toBe('paused');
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    // Lagu tidak boleh mulai sendiri menit kemudian sesudah
    // pengguna menjeda: perilaku lama (gagal + pesan) berlaku.
    expect(service.debugState().retryLadder).toBeNull();
    expect(usePlayerStore.getState().status).toBe('error');
  });

  it('TIDAK ada tangga untuk OK tanpa format (perilaku lama)', async () => {
    behavior = () => ({ playability: 'OK', withUrl: false });
    await playQueue([TRACK_1]);
    // Tanpa retry cepat (OK tanpa format tidak akan muncul).
    expect(playerCalls).toHaveLength(3);
    expect(service.debugState().retryLadder).toBeNull();
    const state = usePlayerStore.getState();
    expect(state.status).toBe('error');
    expect(state.errorMessage).toContain('tidak tersedia');
  });

  it('TIDAK ada tangga untuk UNPLAYABLE murni (tangga cepat tetap jalan)', async () => {
    behavior = () => ({ playability: 'UNPLAYABLE', withUrl: false });
    await playQueue([TRACK_1]);
    // Tangga cepat P6 TETAP me-retry UNPLAYABLE (perilaku lama).
    expect(playerCalls).toHaveLength(9);
    // Tapi tangga LATAR tidak mulai: UNPLAYABLE bisa permanen.
    expect(service.debugState().retryLadder).toBeNull();
    expect(usePlayerStore.getState().status).toBe('error');
  });

  it('TIDAK ada tangga untuk campuran LOGIN_REQUIRED + UNPLAYABLE', async () => {
    behavior = (call) =>
      call.clientId === '67'
        ? { playability: 'LOGIN_REQUIRED', withUrl: false }
        : { playability: 'UNPLAYABLE', withUrl: false };
    await playQueue([TRACK_1]);
    expect(playerCalls).toHaveLength(9);
    expect(service.debugState().retryLadder).toBeNull();
    expect(usePlayerStore.getState().status).toBe('error');
  });

  it('percobaan latar gagal BUKAN LOGIN_REQUIRED: tangga berhenti, perilaku lama', async () => {
    behavior = (call) =>
      call.index < 9
        ? { playability: 'LOGIN_REQUIRED', withUrl: false }
        : { playability: 'OK', withUrl: false, httpStatus: 500 };
    await playQueue([TRACK_1]);
    expect(service.debugState().retryLadder).not.toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    // Proxy mati di tengah tangga: berhenti, pesan proxy.
    expect(service.debugState().retryLadder).toBeNull();
    const state = usePlayerStore.getState();
    expect(state.status).toBe('error');
    expect(state.errorMessage).toContain('Server perantara');
  });

  it('kanari gagal baru-baru ini: putaran cepat dilewati + status awal', async () => {
    await seedCanary(
      canaryRecord({
        status: 'broken',
        succeeded: 0,
        failed: 5,
        dominantCause: 'refused',
        streak: 1,
        streakCause: 'refused',
      }),
    );
    await playQueue([TRACK_1]);
    // Hanya 1 putaran (3 request), bukan 9: putaran cepat yang
    // hampir pasti gagal tidak dibuang.
    expect(playerCalls).toHaveLength(3);
    expect(usePlayerStore.getState().notice).toBe(
      strings.retryLimitingAuto,
    );
    // Tangga latar tetap mulai dari percobaan pertama yang gagal.
    expect(service.debugState().retryLadder).not.toBeNull();
  });

  it('kanari lolos baru-baru ini: resolve normal (tangga cepat jalan)', async () => {
    await seedCanary(canaryRecord({}));
    await playQueue([TRACK_1]);
    expect(playerCalls).toHaveLength(9);
    expect(service.debugState().retryLadder).not.toBeNull();
  });

  it('kanari gagal basi (> 1 jam): resolve normal', async () => {
    await seedCanary(
      canaryRecord({
        checkedAt: Date.now() - 2 * 60 * 60 * 1000,
        status: 'broken',
        succeeded: 0,
        failed: 5,
        dominantCause: 'refused',
        streak: 1,
        streakCause: 'refused',
      }),
    );
    await playQueue([TRACK_1]);
    expect(playerCalls).toHaveLength(9);
    expect(service.debugState().retryLadder).not.toBeNull();
  });

  it('tab latar: tenggat + visibilitychange menjalankan percobaan walau timer tertahan', async () => {
    behavior = (call) =>
      call.index < 9
        ? { playability: 'LOGIN_REQUIRED', withUrl: false }
        : { playability: 'OK', withUrl: true };
    await playQueue([TRACK_1]);
    expect(service.debugState().retryLadder).not.toBeNull();
    // Simulasi tab di latar: jam sistem melompat melewati tenggat
    // TANPA memajukan timer (setTimeout di-throttle browser).
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    vi.setSystemTime(Date.now() + 61_000);
    // Timer belum jalan: belum ada percobaan latar.
    expect(callsFor('vid11111111')).toHaveLength(9);
    // Tab kembali terlihat: cek tenggat menjalankan percobaan.
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    // Hanya microtask (tanpa majukan timer): percobaan JALAN —
    // bukti jalurnya visibilitychange, bukan setTimeout. Tunggu
    // sampai status 'playing' (load terjadi beberapa microtask
    // sebelum attemptPlay selesai).
    for (
      let i = 0;
      i < 500 && usePlayerStore.getState().status !== 'playing';
      i++
    ) {
      await Promise.resolve();
    }
    expect(callsFor('vid11111111')).toHaveLength(10);
    expect(port.loadedUrls).toEqual([STREAM_URL]);
    expect(usePlayerStore.getState().status).toBe('playing');
  });
});
