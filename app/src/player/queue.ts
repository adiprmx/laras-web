/**
 * Logika antrean murni (tanpa DOM, tanpa audio). Semua fungsi
 * mengembalikan state baru; tidak ada mutasi.
 *
 * Model: `items` adalah urutan asli antrean, `order` adalah urutan
 * putar (daftar indeks ke `items`), `orderPos` adalah posisi lagu
 * yang sedang diputar di dalam `order`. Bila shuffle mati, `order`
 * adalah identitas (0, 1, 2, ...). Mematikan shuffle mengembalikan
 * urutan asli (PRD B2).
 */
import {
  MAX_QUEUE_ITEMS,
  PREV_THRESHOLD_SECONDS,
  type RepeatMode,
  type Track,
} from './types';

export interface QueueState {
  items: Track[];
  order: number[];
  orderPos: number;
}

export const EMPTY_QUEUE: QueueState = {
  items: [],
  order: [],
  orderPos: -1,
};

/** Indeks lagu yang sedang diputar di `items`, atau -1 bila kosong. */
export function currentQueueIndex(queue: QueueState): number {
  if (queue.orderPos < 0 || queue.orderPos >= queue.order.length) return -1;
  return queue.order[queue.orderPos];
}

/** Lagu yang sedang diputar, atau null bila antrean kosong. */
export function currentTrack(queue: QueueState): Track | null {
  const idx = currentQueueIndex(queue);
  return idx >= 0 ? queue.items[idx] : null;
}

/** Apakah shuffle aktif (urutan putar bukan identitas). */
export function isShuffled(queue: QueueState): boolean {
  return queue.order.some((value, i) => value !== i);
}

function identityOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function shuffledOrder(
  n: number,
  keepFirst: number,
  random: () => number,
): number[] {
  const rest: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i !== keepFirst) rest.push(i);
  }
  // Fisher-Yates dengan RNG yang bisa diinjeksikan (tes deterministik).
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [keepFirst, ...rest];
}

/**
 * Buat antrean baru dari daftar lagu. Daftar dipotong ke
 * MAX_QUEUE_ITEMS; lagu mulai dari `startIndex` (dibatasi).
 */
export function createQueue(
  tracks: Track[],
  startIndex = 0,
  shuffle = false,
  random: () => number = Math.random,
): QueueState {
  const items = tracks.slice(0, MAX_QUEUE_ITEMS);
  if (items.length === 0) return EMPTY_QUEUE;
  const start = Math.min(Math.max(0, startIndex), items.length - 1);
  const order = shuffle
    ? shuffledOrder(items.length, start, random)
    : identityOrder(items.length);
  const orderPos = shuffle ? 0 : start;
  return { items, order, orderPos };
}

export type AdvanceDecision =
  | { action: 'advance'; orderPos: number }
  | { action: 'replay' }
  | { action: 'stop' };

/**
 * Keputusan saat lagu habis (ended) atau tombol next ditekan.
 * `manual` true berarti next ditekan pengguna: repeat one tidak
 * menahan next manual, yang maju tetap ke lagu berikut.
 */
export function decideNext(
  queue: QueueState,
  repeat: RepeatMode,
  manual: boolean,
): AdvanceDecision {
  if (queue.order.length === 0) return { action: 'stop' };
  if (!manual && repeat === 'one') return { action: 'replay' };
  const atEnd = queue.orderPos >= queue.order.length - 1;
  if (atEnd) {
    if (repeat === 'all') return { action: 'advance', orderPos: 0 };
    return { action: 'stop' };
  }
  return { action: 'advance', orderPos: queue.orderPos + 1 };
}

export type PrevDecision =
  | { action: 'restart' }
  | { action: 'advance'; orderPos: number };

/**
 * Keputusan tombol prev. Posisi di atas ambang 3 detik kembali ke
 * awal lagu yang sama; posisi 3 detik atau kurang pindah ke lagu
 * sebelumnya (PRD B2, ambang port APK).
 */
export function decidePrev(
  queue: QueueState,
  positionSeconds: number,
  repeat: RepeatMode,
): PrevDecision {
  if (queue.order.length === 0) return { action: 'restart' };
  if (positionSeconds > PREV_THRESHOLD_SECONDS) {
    return { action: 'restart' };
  }
  if (queue.orderPos <= 0) {
    if (repeat === 'all' && queue.order.length > 1) {
      return { action: 'advance', orderPos: queue.order.length - 1 };
    }
    return { action: 'restart' };
  }
  return { action: 'advance', orderPos: queue.orderPos - 1 };
}

/**
 * Nyalakan atau matikan shuffle. Menyalakan: lagu yang sedang
 * diputar tetap pertama, sisanya diacak. Mematikan: urutan asli
 * kembali, posisi putar mengikuti indeks lagu di antrean asli.
 */
export function setShuffle(
  queue: QueueState,
  enable: boolean,
  random: () => number = Math.random,
): QueueState {
  const current = currentQueueIndex(queue);
  if (current < 0) return queue;
  if (enable) {
    if (isShuffled(queue)) return queue;
    return {
      ...queue,
      order: shuffledOrder(queue.items.length, current, random),
      orderPos: 0,
    };
  }
  if (!isShuffled(queue)) return queue;
  return {
    ...queue,
    order: identityOrder(queue.items.length),
    orderPos: current,
  };
}

/** Tambah lagu di akhir antrean. Kelebihan di atas 200 dibuang. */
export function addToQueue(
  queue: QueueState,
  tracks: Track[],
): { queue: QueueState; dropped: number } {
  const room = MAX_QUEUE_ITEMS - queue.items.length;
  const accepted = tracks.slice(0, Math.max(0, room));
  const dropped = tracks.length - accepted.length;
  if (accepted.length === 0) return { queue, dropped };
  const items = [...queue.items, ...accepted];
  const order = [...queue.order];
  for (let i = 0; i < accepted.length; i++) {
    order.push(queue.items.length + i);
  }
  return { queue: { items, order, orderPos: queue.orderPos }, dropped };
}

/**
 * Sisipkan lagu tepat sesudah lagu yang sedang diputar ("Putar
 * berikutnya", PRD B2). Bila antrean kosong, lagu menjadi antrean.
 */
export function playNext(
  queue: QueueState,
  tracks: Track[],
): { queue: QueueState; dropped: number } {
  if (queue.items.length === 0 || queue.orderPos < 0) {
    const created = createQueue(tracks, 0);
    return { queue: created, dropped: tracks.length - created.items.length };
  }
  const room = MAX_QUEUE_ITEMS - queue.items.length;
  const accepted = tracks.slice(0, Math.max(0, room));
  const dropped = tracks.length - accepted.length;
  if (accepted.length === 0) return { queue, dropped };
  const current = currentQueueIndex(queue);
  const insertAt = current + 1;
  const items = [
    ...queue.items.slice(0, insertAt),
    ...accepted,
    ...queue.items.slice(insertAt),
  ];
  // Indeks lama >= insertAt bergeser sejumlah lagu baru.
  const shift = accepted.length;
  const order: number[] = [];
  for (const idx of queue.order) {
    order.push(idx >= insertAt ? idx + shift : idx);
  }
  // Sisipkan indeks lagu baru sesudah posisi putar di urutan putar.
  const newIndices = accepted.map((_, i) => insertAt + i);
  order.splice(queue.orderPos + 1, 0, ...newIndices);
  return { queue: { items, order, orderPos: queue.orderPos }, dropped };
}

/**
 * Hapus satu lagu dari antrean (berdasarkan indeks di `items`).
 * Bila lagu yang dihapus adalah lagu yang sedang diputar, posisi
 * putar menunjuk lagu berikut di urutan putar.
 */
export function removeFromQueue(
  queue: QueueState,
  queueIndex: number,
): QueueState {
  if (queueIndex < 0 || queueIndex >= queue.items.length) return queue;
  const items = queue.items.filter((_, i) => i !== queueIndex);
  if (items.length === 0) return EMPTY_QUEUE;
  const current = currentQueueIndex(queue);
  const order: number[] = [];
  let orderPos = queue.orderPos;
  for (const idx of queue.order) {
    if (idx === queueIndex) {
      // Lagu terhapus ada di urutan putar: bila posisinya sebelum
      // atau sama dengan posisi putar, posisi putar mundur satu.
      if (order.length <= queue.orderPos) orderPos -= 1;
      continue;
    }
    order.push(idx > queueIndex ? idx - 1 : idx);
  }
  // Bila lagu yang dihapus adalah lagu saat ini, orderPos yang
  // sudah dimundurkan menunjuk lagu berikut (indeks baru sama).
  if (queueIndex === current) orderPos += 1;
  orderPos = Math.min(Math.max(0, orderPos), order.length - 1);
  return { items, order, orderPos };
}

/** Kosongkan antrean kecuali lagu yang sedang diputar. */
export function clearExceptCurrent(queue: QueueState): QueueState {
  const track = currentTrack(queue);
  if (!track) return EMPTY_QUEUE;
  return { items: [track], order: [0], orderPos: 0 };
}

/**
 * Total durasi sisa: sisa lagu saat ini (dari posisi) ditambah
 * durasi lagu-lagu berikut di urutan putar. Lagu tanpa durasi
 * yang diketahui dihitung 0 dan dilaporkan lewat `unknown`.
 */
export function remainingDuration(
  queue: QueueState,
  positionSeconds: number,
): { seconds: number; unknown: number } {
  let seconds = 0;
  let unknown = 0;
  for (let p = queue.orderPos; p < queue.order.length; p++) {
    const track = queue.items[queue.order[p]];
    if (!track) continue;
    const dur = track.durationSeconds;
    if (typeof dur !== 'number' || Number.isNaN(dur)) {
      unknown += 1;
      continue;
    }
    if (p === queue.orderPos) {
      seconds += Math.max(0, dur - positionSeconds);
    } else {
      seconds += dur;
    }
  }
  return { seconds, unknown };
}
