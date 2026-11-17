/**
 * Persistensi antrean di IndexedDB (menggantikan localStorage
 * P2) + migrasi satu kali dari kunci localStorage lama.
 *
 * Isi yang disimpan:
 * - `queue_items`: urutan lagu antrean (posisi, id lagu, jenis).
 * - `songs`: metadata lagu antrean (upsert dengan
 *   `addToLibrary=false`, supaya antrean tidak mengotori
 *   Library; lagu antrean tetap bisa ditemukan pencarian lokal,
 *   sama seperti lagu yang pernah diputar).
 * - `playback_state` baris id 1: indeks lagu saat ini, posisi,
 *   acak, ulang, urutan putar, kecepatan, volume.
 *
 * URL stream TIDAK PERNAH disimpan (hanya videoId; resolve
 * ulang tiap giliran, seperti aturan P2). Lagu lokal blob/data
 * tidak disimpan (sudah disaring `sanitizeQueueForSave`).
 */
import {
  clearPersistedPlayerState,
  loadPersistedPlayerState,
  sanitizeQueueForSave,
  type PersistedPlayerState,
} from '../player/persistence';
import {
  PLAYBACK_RATES,
  localTrack,
  streamTrack,
  type RepeatMode,
  type Track,
} from '../player/types';
import type { LibraryService } from './library';
import { repeatModeFromValue, repeatModeToValue } from './types';

/** Kunci meta penanda migrasi localStorage sudah jalan. */
export const LS_QUEUE_MIGRATED_KEY = 'lsQueueMigrated';

export interface QueueStateToSave {
  tracks: Track[];
  order: number[];
  orderPos: number;
  positionSeconds: number;
  shuffle: boolean;
  repeat: RepeatMode;
  rate: number;
  volume: number;
}

export interface RestoredQueueState {
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
 * Simpan antrean + status pemutar ke IndexedDB. Dipanggil
 * pemutar saat antrean berubah (debounce 500 ms, seperti P2).
 * Gagal simpan melempar; pemanggil menangkap dan mencoba lagi
 * di kesempatan berikutnya (tidak pernah merusak pemutaran).
 */
export async function saveQueueState(
  service: LibraryService,
  state: QueueStateToSave,
): Promise<void> {
  const sanitized = sanitizeQueueForSave(
    state.tracks,
    state.order,
    state.orderPos,
  );
  if (!sanitized) {
    // Antrean kosong atau lagu saat ini terbuang: kosongkan.
    await service.replaceQueue([]);
    await service.clearPlaybackState();
    return;
  }
  const { queue: tracks, order, orderPos } = sanitized;
  const positionSeconds = state.positionSeconds;
  await service.importSongs(
    tracks.map((track) => trackToSongImport(track)),
    { addToLibrary: false },
  );
  await service.replaceQueue(
    tracks.map((track) => ({
      songId: track.id,
      source: null,
      kind: track.source.kind,
    })),
  );
  await service.savePlaybackState({
    currentIndex: orderPos,
    positionMs: Math.round(positionSeconds * 1000),
    shuffleEnabled: state.shuffle,
    repeatMode: repeatModeToValue(state.repeat),
    order,
    rate: state.rate,
    volume: state.volume,
  });
}

function trackToSongImport(track: Track): {
  song: {
    id: string;
    title: string;
    albumId: null;
    durationSeconds: number | null;
    thumbnailUrl: string | null;
    liked: 0;
    totalPlayTimeMs: 0;
    inLibrary: 0;
    downloadState: 0;
    filePath: null;
    fileSizeBytes: null;
    downloadedAt: null;
    formatId: null;
    unplayable: 0;
  };
  artistNames: string[];
} {
  return {
    song: {
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
    artistNames: track.artist ? [track.artist] : [],
  };
}

/**
 * Muat antrean + status pemutar dari IndexedDB. Mengembalikan
 * null bila tidak ada antrean tersimpan. Lagu yang barisnya
 * hilang (mis. dihapus massal sebagai tidak bisa diputar)
 * dilewati dan urutan putar dipetakan ulang.
 */
export async function restoreQueueState(
  service: LibraryService,
): Promise<RestoredQueueState | null> {
  const items = await service.loadQueue();
  if (items.length === 0) return null;
  const stored = await service.loadPlaybackState();
  const views = await service.songsByIds(items.map((i) => i.songId));
  const byId = new Map(views.map((v) => [v.song.id, v]));
  const tracks: Track[] = [];
  const keptPositions: number[] = [];
  for (const item of items) {
    const view = byId.get(item.songId);
    if (!view) continue;
    const artist = view.artistNames.join(', ');
    const duration = view.song.durationSeconds ?? undefined;
    const artwork = view.song.thumbnailUrl ?? undefined;
    const track =
      item.kind === 'local'
        ? localTrack(item.songId, view.song.title, duration)
        : streamTrack(item.songId, view.song.title, duration, artwork);
    if (artist) track.artist = artist;
    if (item.kind === 'local' && artwork) track.artwork = artwork;
    tracks.push(track);
    keptPositions.push(item.position);
  }
  if (tracks.length === 0) return null;
  const order = remapOrder(
    stored?.order ?? [],
    keptPositions,
    tracks.length,
  );
  const currentStored = stored?.currentIndex ?? 0;
  let orderPos = 0;
  if (currentStored >= 0 && currentStored < (stored?.order ?? []).length) {
    const currentOriginal = (stored?.order ?? [])[currentStored] as number;
    const newIndex = keptPositions.indexOf(currentOriginal);
    if (newIndex !== -1) {
      orderPos = order.indexOf(newIndex);
      if (orderPos === -1) orderPos = 0;
    }
  }
  const positionSeconds = Math.max(0, (stored?.positionMs ?? 0) / 1000);
  const rate =
    stored != null &&
    (PLAYBACK_RATES as readonly number[]).includes(stored.rate)
      ? stored.rate
      : 1;
  const volume =
    stored != null && stored.volume >= 0 && stored.volume <= 1
      ? stored.volume
      : 1;
  return {
    tracks,
    order,
    orderPos,
    positionSeconds,
    shuffle: stored?.shuffleEnabled ?? false,
    repeat: repeatModeFromValue(stored?.repeatMode ?? 0),
    rate,
    volume,
  };
}

/**
 * Petakan ulang urutan putar setelah beberapa lagu hilang.
 * Posisi yang hilang dibuang; indeks di atasnya digeser turun.
 * Bila urutan tersimpan bukan permutasi yang sah, kembali ke
 * urutan asli (identitas).
 */
export function remapOrder(
  storedOrder: number[],
  keptPositions: number[],
  trackCount: number,
): number[] {
  const mapped: number[] = [];
  for (const original of storedOrder) {
    const newIndex = keptPositions.indexOf(original);
    if (newIndex !== -1) mapped.push(newIndex);
  }
  const isPermutation =
    mapped.length === trackCount &&
    new Set(mapped).size === trackCount &&
    mapped.every((i) => i >= 0 && i < trackCount);
  if (isPermutation) return mapped;
  return Array.from({ length: trackCount }, (_, i) => i);
}

/**
 * Migrasi satu kali antrean localStorage lama (kunci
 * `laras.player.v1` P2) ke IndexedDB. Dijalankan sekali saat
 * pemutar mulai, SEBELUM restore dari IndexedDB.
 *
 * - Bila antrean IndexedDB sudah berisi, antrean localStorage
 *   TIDAK menimpanya (data IndexedDB lebih baru).
 * - Kunci localStorage dihapus setelah migrasi (atau bila
 *   isinya tidak valid), supaya tidak terbaca dua kali.
 * - Hasil dicatat di `app_meta`, jadi migrasi tidak diulang.
 */
export async function migrateLocalStorageQueue(
  service: LibraryService,
): Promise<'migrated' | 'skipped' | 'empty' | 'unavailable'> {
  let migrated: string | null = null;
  try {
    migrated = await service.getMeta(LS_QUEUE_MIGRATED_KEY);
  } catch {
    return 'unavailable';
  }
  if (migrated === '1') return 'skipped';
  let state: PersistedPlayerState | null = null;
  try {
    state = loadPersistedPlayerState();
  } catch {
    state = null;
  }
  if (!state) {
    try {
      clearPersistedPlayerState();
    } catch {
      // localStorage tidak tersedia: tidak ada yang dimigrasi.
    }
    await service.setMeta(LS_QUEUE_MIGRATED_KEY, '1');
    return 'empty';
  }
  const existing = await service.loadQueue();
  if (existing.length > 0) {
    try {
      clearPersistedPlayerState();
    } catch {
      // Abaikan: kunci lama tidak penting lagi.
    }
    await service.setMeta(LS_QUEUE_MIGRATED_KEY, '1');
    return 'skipped';
  }
  await saveQueueState(service, {
    tracks: state.queue,
    order: state.order,
    orderPos: state.orderPos,
    positionSeconds: state.positionSeconds,
    shuffle: state.shuffle,
    repeat: state.repeat,
    rate: state.rate,
    volume: state.volume,
  });
  try {
    clearPersistedPlayerState();
  } catch {
    // Abaikan: migrasi sudah tersimpan di IndexedDB.
  }
  await service.setMeta(LS_QUEUE_MIGRATED_KEY, '1');
  return 'migrated';
}
