import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPersistedPlayerState,
  loadPersistedPlayerState,
  parsePersistedPlayerState,
  PLAYER_STORAGE_KEY,
  sanitizeQueueForSave,
  savePersistedPlayerState,
  writeQueueSnapshot,
  type PersistedPlayerState,
  type QueueSnapshotInput,
} from './persistence';
import { localTrack, streamTrack } from './types';

function validState(): PersistedPlayerState {
  return {
    version: 1,
    queue: [
      streamTrack('vid0', 'Lagu 0', 200),
      streamTrack('vid1', 'Lagu 1', 180),
    ],
    order: [0, 1],
    orderPos: 1,
    positionSeconds: 42,
    shuffle: false,
    repeat: 'all',
    rate: 1.25,
    volume: 0.8,
    updatedAt: 1700000000000,
  };
}

describe('parsePersistedPlayerState', () => {
  it('memparse state valid apa adanya', () => {
    const parsed = parsePersistedPlayerState(JSON.stringify(validState()));
    expect(parsed).toEqual(validState());
  });

  it('menolak JSON rusak, versi lain, dan antrean kosong', () => {
    expect(parsePersistedPlayerState('bukan json')).toBeNull();
    expect(parsePersistedPlayerState(null)).toBeNull();
    expect(
      parsePersistedPlayerState(
        JSON.stringify({ ...validState(), version: 99 }),
      ),
    ).toBeNull();
    expect(
      parsePersistedPlayerState(
        JSON.stringify({ ...validState(), queue: [] }),
      ),
    ).toBeNull();
  });

  it('menolak urutan putar yang tidak lengkap atau duplikat', () => {
    expect(
      parsePersistedPlayerState(
        JSON.stringify({ ...validState(), order: [0] }),
      ),
    ).toBeNull();
    expect(
      parsePersistedPlayerState(
        JSON.stringify({ ...validState(), order: [0, 0] }),
      ),
    ).toBeNull();
    expect(
      parsePersistedPlayerState(
        JSON.stringify({ ...validState(), orderPos: 2 }),
      ),
    ).toBeNull();
  });

  it('menolak nilai pengaturan di luar batas', () => {
    expect(
      parsePersistedPlayerState(
        JSON.stringify({ ...validState(), volume: 1.5 }),
      ),
    ).toBeNull();
    expect(
      parsePersistedPlayerState(
        JSON.stringify({ ...validState(), repeat: 'acak' }),
      ),
    ).toBeNull();
    expect(
      parsePersistedPlayerState(
        JSON.stringify({ ...validState(), positionSeconds: -1 }),
      ),
    ).toBeNull();
  });

  it('menolak seluruh state bila ada lagu lokal blob di dalamnya', () => {
    const state = validState();
    state.queue = [
      streamTrack('vid0', 'Lagu 0', 200),
      localTrack('blob:http://localhost/abc', 'Nada blob'),
      localTrack('/nada.wav', 'Nada lokal'),
    ];
    state.order = [0, 1, 2];
    // Memfilter lagu blob di tengah daftar akan menggeser indeks
    // urutan putar; seluruh state ditolak dan app mulai dari kosong.
    expect(parsePersistedPlayerState(JSON.stringify(state))).toBeNull();
  });

  it('memotong antrean ke 200 item beserta urutan putarnya', () => {
    const state = validState();
    state.queue = Array.from({ length: 250 }, (_, i) =>
      streamTrack(`vid${i}`, `Lagu ${i}`, 200),
    );
    state.order = state.queue.map((_, i) => i);
    const parsed = parsePersistedPlayerState(JSON.stringify(state));
    expect(parsed?.queue).toHaveLength(200);
    expect(parsed?.order).toHaveLength(200);
    expect(parsed?.order[199]).toBe(199);
  });
});

describe('sanitizeQueueForSave', () => {
  it('membuang lagu blob dan memetakan ulang urutan putar', () => {
    const queue = [
      streamTrack('vid0', 'Lagu 0', 200),
      localTrack('blob:http://localhost/abc', 'Nada blob'),
      streamTrack('vid2', 'Lagu 2', 180),
    ];
    const result = sanitizeQueueForSave(queue, [2, 0, 1], 0);
    expect(result?.queue.map((t) => t.title)).toEqual(['Lagu 0', 'Lagu 2']);
    expect(result?.order).toEqual([1, 0]);
    expect(result?.orderPos).toBe(0);
  });

  it('mengembalikan null bila lagu saat ini adalah blob', () => {
    const queue = [
      streamTrack('vid0', 'Lagu 0', 200),
      localTrack('blob:http://localhost/abc', 'Nada blob'),
    ];
    expect(sanitizeQueueForSave(queue, [0, 1], 1)).toBeNull();
  });

  it('mengembalikan null bila antrean kosong sesudah dibersihkan', () => {
    const queue = [localTrack('blob:http://localhost/abc', 'Nada blob')];
    expect(sanitizeQueueForSave(queue, [0], 0)).toBeNull();
  });
});

describe('save dan load localStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('simpan lalu muat mengembalikan state yang sama', () => {
    expect(savePersistedPlayerState(validState())).toBe(true);
    expect(loadPersistedPlayerState()).toEqual(validState());
  });

  it('hapus mengosongkan penyimpanan', () => {
    savePersistedPlayerState(validState());
    clearPersistedPlayerState();
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
    expect(loadPersistedPlayerState()).toBeNull();
  });

  it('menolak menulis nilai di atas cap 100 KB', () => {
    const state = validState();
    state.queue = [
      streamTrack('vid0', 'x'.repeat(200 * 1024), 200),
    ];
    state.order = [0];
    state.orderPos = 0;
    expect(savePersistedPlayerState(state)).toBe(false);
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
  });
});

describe('writeQueueSnapshot (write-ahead sinkron)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  function snapshotInput(): QueueSnapshotInput {
    const state = validState();
    return {
      tracks: state.queue,
      order: state.order,
      orderPos: state.orderPos,
      positionSeconds: state.positionSeconds,
      shuffle: state.shuffle,
      repeat: state.repeat,
      rate: state.rate,
      volume: state.volume,
    };
  }

  it('round-trip: snapshot bisa dibaca kembali sama persis', () => {
    writeQueueSnapshot(snapshotInput());
    const loaded = loadPersistedPlayerState();
    expect(loaded).not.toBeNull();
    expect(loaded?.queue).toEqual(snapshotInput().tracks);
    expect(loaded?.order).toEqual([0, 1]);
    expect(loaded?.orderPos).toBe(1);
    expect(loaded?.positionSeconds).toBe(42);
    expect(loaded?.repeat).toBe('all');
    expect(loaded?.rate).toBe(1.25);
    expect(loaded?.volume).toBe(0.8);
  });

  it('sinkron: langsung tersedia tanpa await sesudah kembali', () => {
    writeQueueSnapshot(snapshotInput());
    // Tanpa await apa pun di antara: setItem sudah selesai.
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).not.toBeNull();
  });

  it('null menghapus snapshot lama', () => {
    writeQueueSnapshot(snapshotInput());
    expect(loadPersistedPlayerState()).not.toBeNull();
    writeQueueSnapshot(null);
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
    expect(loadPersistedPlayerState()).toBeNull();
  });

  it('antrean kosong menghapus snapshot lama', () => {
    writeQueueSnapshot(snapshotInput());
    writeQueueSnapshot({
      ...snapshotInput(),
      tracks: [],
      order: [],
      orderPos: 0,
    });
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
  });

  it('lagu saat ini blob menghapus snapshot lama', () => {
    writeQueueSnapshot(snapshotInput());
    const blob = localTrack('blob:https://laras.test/123', 'Lokal Blob', 100);
    writeQueueSnapshot({
      ...snapshotInput(),
      tracks: [blob, streamTrack('vid1', 'Lagu 1', 180)],
      order: [0, 1],
      orderPos: 0,
    });
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
  });
});
