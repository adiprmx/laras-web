/**
 * Antrean persisten P2: localStorage.
 *
 * Catatan arsitektur: aturan anti-OOM (§5.4 arsitektur) melarang
 * koleksi di localStorage; antrean adalah store IndexedDB di P3.
 * P2 memakai localStorage dulu sesuai rencana-fase-2, dengan dua
 * pengaman: satu nilai JSON berversi yang divalidasi saat dibaca,
 * dan cap ukuran 100 KB (antrean 200 item metadata tidak sampai
 * ke angka itu: sekitar 40 KB pada metadata terpanjang yang wajar).
 * P3 memindahkan penyimpanan ini ke IndexedDB tanpa mengubah
 * bentuk state-nya.
 */
import { MAX_QUEUE_ITEMS, type RepeatMode, type Track } from './types';

export const PLAYER_STORAGE_KEY = 'laras.player.v1';
export const PLAYER_STORAGE_VERSION = 1;

/** Cap ukuran nilai tersimpan (byte). Lebih dari ini tidak ditulis. */
export const PLAYER_STORAGE_MAX_BYTES = 100 * 1024;

export interface PersistedPlayerState {
  version: number;
  queue: Track[];
  order: number[];
  orderPos: number;
  positionSeconds: number;
  shuffle: boolean;
  repeat: RepeatMode;
  rate: number;
  volume: number;
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidTrack(value: unknown): value is Track {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.title !== 'string' || value.title.length === 0) return false;
  if (!isRecord(value.source)) return false;
  if (value.source.kind === 'stream') {
    return typeof value.source.videoId === 'string';
  }
  if (value.source.kind === 'local') {
    // URL blob tidak bisa dipulihkan sesudah browser ditutup:
    // lagu lokal seperti itu dibuang saat pemulihan, bukan disimpan.
    return (
      typeof value.source.url === 'string' &&
      !value.source.url.startsWith('blob:') &&
      !value.source.url.startsWith('data:')
    );
  }
  return false;
}

/** Validasi + normalisasi state tersimpan. Null bila tidak bisa dipakai. */
export function parsePersistedPlayerState(
  raw: string | null,
): PersistedPlayerState | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  if (json.version !== PLAYER_STORAGE_VERSION) return null;
  if (!Array.isArray(json.queue)) return null;
  // Satu lagu tak valid menolak seluruh state: memfilter lagu di
  // tengah daftar akan menggeser indeks dan membuat urutan putar
  // menunjuk lagu yang salah. Mulai dari kosong lebih aman.
  if ((json.queue as unknown[]).some((t) => !isValidTrack(t))) return null;
  const queue = (json.queue as Track[]).slice(0, MAX_QUEUE_ITEMS);
  if (queue.length === 0) return null;
  if (!Array.isArray(json.order)) return null;
  const order = (json.order as unknown[]).filter(
    (n): n is number =>
      typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < queue.length,
  );
  // Urutan putar harus memuat tiap indeks antrean tepat sekali.
  if (order.length !== queue.length) return null;
  if (new Set(order).size !== order.length) return null;
  const orderPos = json.orderPos;
  if (
    typeof orderPos !== 'number' ||
    !Number.isInteger(orderPos) ||
    orderPos < 0 ||
    orderPos >= order.length
  ) {
    return null;
  }
  const positionSeconds = json.positionSeconds;
  const repeat = json.repeat;
  const rate = json.rate;
  const volume = json.volume;
  if (
    typeof positionSeconds !== 'number' ||
    !Number.isFinite(positionSeconds) ||
    positionSeconds < 0
  ) {
    return null;
  }
  if (repeat !== 'off' && repeat !== 'all' && repeat !== 'one') return null;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  if (
    typeof volume !== 'number' ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    volume > 1
  ) {
    return null;
  }
  return {
    version: PLAYER_STORAGE_VERSION,
    queue,
    order,
    orderPos,
    positionSeconds,
    shuffle: json.shuffle === true,
    repeat,
    rate,
    volume,
    updatedAt: typeof json.updatedAt === 'number' ? json.updatedAt : 0,
  };
}

/**
 * Siapkan antrean untuk disimpan: buang lagu yang tidak bisa
 * dipulihkan (URL blob) dan petakan ulang urutan putar. Null bila
 * lagu yang sedang diputar ikut terbuang (pemulihan tidak mungkin
 * menunjuk lagu itu, jadi lebih baik tidak menyimpan sama sekali).
 */
export function sanitizeQueueForSave(
  queue: Track[],
  order: number[],
  orderPos: number,
): { queue: Track[]; order: number[]; orderPos: number } | null {
  const keep = new Map<number, number>();
  const saved: Track[] = [];
  queue.forEach((track, index) => {
    if (isValidTrack(track)) {
      keep.set(index, saved.length);
      saved.push(track);
    }
  });
  if (saved.length === 0) return null;
  const current = order[orderPos];
  if (current === undefined || !keep.has(current)) return null;
  const savedOrder: number[] = [];
  for (const index of order) {
    const mapped = keep.get(index);
    if (mapped !== undefined) savedOrder.push(mapped);
  }
  const savedPos = savedOrder.indexOf(keep.get(current) as number);
  if (savedPos < 0) return null;
  return { queue: saved, order: savedOrder, orderPos: savedPos };
}

export function loadPersistedPlayerState(): PersistedPlayerState | null {
  try {
    return parsePersistedPlayerState(
      window.localStorage.getItem(PLAYER_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

/**
 * Simpan state pemutar. Mengembalikan false bila nilai melewati
 * cap ukuran atau storage tidak bisa ditulis (kuota penuh, mode
 * privat); kegagalan simpan tidak pernah melempar.
 */
export function savePersistedPlayerState(
  state: PersistedPlayerState,
): boolean {
  let raw: string;
  try {
    raw = JSON.stringify(state);
  } catch {
    return false;
  }
  if (new TextEncoder().encode(raw).length > PLAYER_STORAGE_MAX_BYTES) {
    return false;
  }
  try {
    window.localStorage.setItem(PLAYER_STORAGE_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

export function clearPersistedPlayerState(): void {
  try {
    window.localStorage.removeItem(PLAYER_STORAGE_KEY);
  } catch {
    // Menghapus state yang sudah tidak ada bukan galat.
  }
}

/** Input snapshot antrean (bentuk sama dengan QueueStateToSave di data/). */
export interface QueueSnapshotInput {
  tracks: Track[];
  order: number[];
  orderPos: number;
  positionSeconds: number;
  shuffle: boolean;
  repeat: RepeatMode;
  rate: number;
  volume: number;
}

/**
 * Tulis snapshot antrean ke localStorage SECARA SINKRON
 * (write-ahead untuk IndexedDB). Dipanggil setiap kali pemutar
 * menyimpan state, SEBELUM rantai tulis IndexedDB yang async.
 * Bila tab ditutup/dimuat ulang sebelum tulis IndexedDB selesai,
 * snapshot inilah yang dipakai restore sebagai cadangan
 * (memperbaiki balapan P3: tes jeda-lalu-muat-ulang gagal di CI
 * karena simpan async terpotong teardown halaman).
 * Antrean kosong / lagu saat ini tak bisa dipulihkan -> hapus
 * snapshot (konsisten dengan saveQueueState di IndexedDB).
 */
export function writeQueueSnapshot(state: QueueSnapshotInput | null): void {
  if (!state || state.tracks.length === 0) {
    clearPersistedPlayerState();
    return;
  }
  const sanitized = sanitizeQueueForSave(
    state.tracks,
    state.order,
    state.orderPos,
  );
  if (!sanitized) {
    clearPersistedPlayerState();
    return;
  }
  savePersistedPlayerState({
    version: PLAYER_STORAGE_VERSION,
    queue: sanitized.queue,
    order: sanitized.order,
    orderPos: sanitized.orderPos,
    positionSeconds: state.positionSeconds,
    shuffle: state.shuffle,
    repeat: state.repeat,
    rate: state.rate,
    volume: state.volume,
    updatedAt: Date.now(),
  });
}
