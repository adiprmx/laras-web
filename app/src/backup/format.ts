/**
 * Format file salinan Laras (P8, PRD B10.1).
 *
 * Port `backup_format.dart` APK ke TypeScript — SATU format untuk
 * dua platform. File yang ditulis web bisa diimpor APK, dan
 * sebaliknya. Bentuk JSON-nya identik: nama field, tipe nilai,
 * dan aturan validasi sama persis (dibuktikan tes round-trip
 * lintas format di `format.test.ts`, memakai contoh yang sama
 * dengan tes APK `backup_format_test.dart`).
 *
 * Satu file JSON berversi berisi seluruh data pengguna yang bisa
 * dipindahkan antar perangkat: lagu (metadata saja), album,
 * artis, playlist, favorit, riwayat putar, riwayat pencarian,
 * antrean, posisi pemutar, dan pengaturan.
 *
 * Yang SENGAJA tidak masuk file (dan kenapa):
 * - File audio unduhan: hanya status "pernah diunduh" yang
 *   tersimpan (flag `downloaded` per lagu); lagu harus diunduh
 *   ulang di perangkat baru (PRD B7.6). Tombol "Unduh ulang"
 *   sesudah impor memakai daftar itu.
 * - `formats` (metadata itag per lagu): bisa didapat lagi saat
 *   resolve.
 * - `lyrics`: bisa diambil lagi dari penyedia lirik; teks lirik
 *   besar.
 * - `cache_entries` / `download_jobs`: keadaan sementara sesi ini.
 * - `local_items`: pemutar file lokal adalah v1.1 (PRD B10.2),
 *   tabel kosong di v1.
 * - `sync_tombstones` (web, P7): penanda hapus sinkronisasi
 *   tidak ikut — backup adalah salinan data, bukan keadaan
 *   sinkronisasi. Perangkat tujuan mendapat deviceId baru dan
 *   sinkronisasi dimulai segar.
 * - URL stream TIDAK PERNAH masuk file (juga tidak masuk log
 *   atau laporan): URL stream hanya hidup di memori sesi.
 *
 * Aturan versi (PRD B10.1, berlaku selamanya): tiap file membawa
 * `backupVersion`; impor menjalankan migrator berurutan sampai
 * versi terbaru; file dari app yang LEBIH BARU ditolak (jangan
 * ditebak isinya); dukungan versi lama tidak boleh dicabut
 * diam-diam.
 *
 * Batas ukuran 10.000.000 byte (PRD B10.1: "10 MB" dengan
 * hitungan 10 juta byte / 200 byte per lagu = 50.000 lagu).
 * Batas dicek dari panjang byte SEBELUM parsing penuh, supaya
 * file raksasa tidak sempat menghabiskan memori (aturan
 * anti-OOM arsitektur §4.6).
 */

/** Versi format salinan yang ditulis app ini sekarang. */
export const CURRENT_BACKUP_VERSION = 1;

/** Batas ukuran file salinan yang diterima impor, dalam byte. */
export const MAX_BACKUP_BYTES = 10_000_000;

/** Batas antrean di file salinan (sama dengan batas antrean pemutar). */
export const MAX_BACKUP_QUEUE_ITEMS = 200;

// --- Cap per-field dan per-koleksi (Blue 3, Red 3 R14) ---
// Cap total 10 MB saja tidak cukup: satu judul 5 MB berisi kata
// unik bisa membengkakkan indeks token, dan puluhan ribu playlist
// kosong bisa membengkakkan database. Cap di bawah ini menolak
// file yang melewatinya (BackupException invalidStructure) —
// kecuali nama/deskripsi playlist yang tetap dipotong saat merge
// (100/500 karakter, library.ts), karena file sah dari app yang
// sama tidak pernah melewati angka-ini.
/** Batas panjang satu judul/nama teks (lagu, album, artis). */
export const MAX_BACKUP_TEXT_CHARS = 1000;
/** Batas panjang nama/deskripsi playlist di parser (merge memotong ke 100/500). */
export const MAX_BACKUP_PLAYLIST_TEXT_CHARS = 1000;
/** Batas panjang satu query pencarian. */
export const MAX_BACKUP_QUERY_CHARS = 500;
/** Batas panjang satu id (lagu, album, artis, referensi). */
export const MAX_BACKUP_ID_CHARS = 200;
/** Batas panjang satu URL gambar. */
export const MAX_BACKUP_URL_CHARS = 2048;
/** Batas jumlah artis per lagu. */
export const MAX_BACKUP_SONG_ARTISTS = 50;
/** Batas jumlah lagu per playlist di file (sama dengan batas playlist app). */
export const MAX_BACKUP_PLAYLIST_SONGS = 1000;
/** Batas jumlah lagu (PRD B10.1: 10 MB / 200 byte per lagu). */
export const MAX_BACKUP_SONGS = 50000;
/** Batas jumlah album. */
export const MAX_BACKUP_ALBUMS = 50000;
/** Batas jumlah artis. */
export const MAX_BACKUP_ARTISTS = 50000;
/** Batas jumlah playlist. */
export const MAX_BACKUP_PLAYLISTS = 1000;
/** Batas jumlah entri riwayat putar (sama dengan batas riwayat app). */
export const MAX_BACKUP_PLAY_EVENTS = 10000;
/** Batas jumlah query riwayat pencarian (sama dengan batas app). */
export const MAX_BACKUP_SEARCH_HISTORY = 100;

export type BackupErrorKind =
  | 'tooLarge'
  | 'invalidJson'
  | 'notBackup'
  | 'newerVersion'
  | 'invalidStructure';

/** Kegagalan membaca file salinan (pemetaan ke pesan sehari-hari di UI). */
export class BackupException extends Error {
  readonly kind: BackupErrorKind;
  /** Detail teknis untuk debug (tidak tampil ke pengguna). */
  readonly detail?: string;

  constructor(kind: BackupErrorKind, detail?: string) {
    super(`BackupException(${kind}${detail ? `: ${detail}` : ''})`);
    this.name = 'BackupException';
    this.kind = kind;
    this.detail = detail;
  }
}

/** Satu artis di dalam lagu salinan (id + nama, sesuai urutan). */
export interface BackupArtistRef {
  id: string;
  name: string;
}

/** Satu lagu di file salinan (metadata saja, tanpa file audio). */
export interface BackupSong {
  id: string;
  title: string;
  artists: BackupArtistRef[];
  /** browseId album, atau null bila lagu tidak punya album. */
  albumId: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  liked: boolean;
  inLibrary: boolean;
  totalPlayTimeMs: number;
  /** Milidetik epoch, atau null. */
  dateAdded: number | null;
  /**
   * True bila lagu ini berstatus terunduh saat salinan dibuat.
   * File audionya TIDAK ikut; flag ini menggerakkan tombol
   * "Unduh ulang" sesudah impor.
   */
  downloaded: boolean;
  /** True bila lagu terbukti tidak bisa diputar (P6, B4.7). */
  unplayable: boolean;
}

/** Satu album di file salinan. */
export interface BackupAlbum {
  id: string;
  title: string;
  year: number | null;
  thumbnailUrl: string | null;
  liked: boolean;
  /** Milidetik epoch, atau null. */
  dateAdded: number | null;
}

/** Satu artis di file salinan. */
export interface BackupArtist {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  liked: boolean;
  /** Milidetik epoch, atau null. */
  dateAdded: number | null;
}

/**
 * Satu playlist di file salinan. Lagu disimpan sebagai daftar id
 * berurutan (id playlist di database TIDAK ikut: auto-increment
 * berbeda di tiap perangkat, dan merge mencocokkan berdasarkan
 * nama).
 */
export interface BackupPlaylist {
  name: string;
  description: string | null;
  songIds: string[];
  /** Milidetik epoch, atau null. */
  createdAt: number | null;
}

/** Satu entri riwayat putar di file salinan. */
export interface BackupPlayEvent {
  songId: string;
  /** Milidetik epoch. */
  timestamp: number;
  playTimeMs: number;
}

/** Satu query riwayat pencarian di file salinan. */
export interface BackupSearchQuery {
  query: string;
  /** Milidetik epoch. */
  timestamp: number;
}

/** Satu item antrean di file salinan. Urutan = urutan di daftar. */
export interface BackupQueueItem {
  songId: string;
  source: string | null;
}

/**
 * Posisi pemutar saat salinan dibuat. Dipulihkan hanya bila
 * antrean perangkat tujuan kosong saat impor (supaya posisi lagu
 * yang sedang diputar tidak tertimpa).
 */
export interface BackupPlaybackState {
  currentIndex: number;
  positionMs: number;
  shuffleEnabled: boolean;
  repeatMode: number;
}

/**
 * Pengaturan pengguna di file salinan.
 *
 * Hanya pengaturan BUATAN PENGGUNA yang ikut. Yang tidak ikut
 * (bukan pengaturan, melainkan keadaan layanan): status kanari,
 * config remote + cap waktunya, status layanan, cap waktu muat
 * Jelajah, dan flag first-run. Nilai yang salah tipe diabaikan
 * saat parse (bukan menolak file): pengaturan adalah bagian yang
 * paling mungkin berbeda antar versi, dan satu nilai rusak tidak
 * boleh menggagalkan seluruh impor data.
 *
 * Field APK (`dataSaver` sampai `eqPreset`) dipertahankan apa
 * adanya supaya file web tetap bisa dibaca APK. Tiga field
 * tambahan web (`lyricsEnabled`, `eqPresetName`, `eqGains`)
 * diabaikan APK saat parse (parser APK hanya membaca kunci yang
 * dikenalnya) — kompatibilitas dua arah tetap terjaga.
 *
 * Level equalizer per pita versi APK TIDAK ikut (mengikuti
 * perangkat); web menyimpan gain-nya sendiri di `eqGains`
 * (10 angka dB, urutan pita 31 Hz sampai 16 kHz) karena web
 * tidak punya preset perangkat. `eqPreset` APK (indeks preset
 * perangkat) tidak diterapkan web — indeks yang sama bisa
 * berarti preset berbeda di perangkat lain.
 */
export interface BackupSettings {
  dataSaver: boolean | null;
  /** 'best' | 'balanced' | 'data_saver' (APK). */
  defaultQuality: string | null;
  wifiOnly: boolean | null;
  cacheLimitBytes: number | null;
  playbackSpeed: number | null;
  playbackPitch: number | null;
  skipSilence: boolean | null;
  /** Nama enum SongSort ('newest' | 'byName' | 'mostPlayed'). */
  sortSongs: string | null;
  eqEnabled: boolean | null;
  /** Indeks preset equalizer perangkat APK (-1 = tanpa preset). */
  eqPreset: number | null;
  /** Web saja: saklar tampilkan lirik. */
  lyricsEnabled?: boolean | null;
  /** Web saja: nama preset EQ ('flat' | 'bass' | 'vocal' | 'acoustic' | 'custom'). */
  eqPresetName?: string | null;
  /** Web saja: gain 10 pita dalam dB. */
  eqGains?: number[] | null;
}

/** Seluruh isi satu file salinan, sudah tervalidasi dan sudah dimigrasikan ke versi terbaru. */
export interface BackupData {
  /** Versi format sesudah migrasi (selalu CURRENT_BACKUP_VERSION). */
  version: number;
  /** Versi app yang membuat file (string, mis. "0.9.0"). */
  appVersion: string;
  exportedAt: Date;
  songs: BackupSong[];
  albums: BackupAlbum[];
  artists: BackupArtist[];
  playlists: BackupPlaylist[];
  playEvents: BackupPlayEvent[];
  searchHistory: BackupSearchQuery[];
  queue: BackupQueueItem[];
  playbackState: BackupPlaybackState | null;
  settings: BackupSettings | null;
}

/** Id lagu yang berstatus terunduh saat salinan dibuat (untuk tombol "Unduh ulang" sesudah impor). */
export function downloadedSongIds(data: BackupData): string[] {
  return data.songs.filter((s) => s.downloaded).map((s) => s.id);
}

/** Jumlah lagu favorit di file ini. */
export function favoriteCount(data: BackupData): number {
  return data.songs.filter((s) => s.liked).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** String tak kosong dengan panjang paling banyak `max`. */
function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** String opsional (null/undefined boleh) dengan panjang paling banyak `max`. */
function isOptionalBoundedString(value: unknown, max: number): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.length <= max)
  );
}

function toJsonArtistRef(a: BackupArtistRef): Record<string, unknown> {
  return { id: a.id, name: a.name };
}

function toJsonSong(s: BackupSong): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    artists: s.artists.map(toJsonArtistRef),
    albumId: s.albumId,
    durationSeconds: s.durationSeconds,
    thumbnailUrl: s.thumbnailUrl,
    liked: s.liked,
    inLibrary: s.inLibrary,
    totalPlayTimeMs: s.totalPlayTimeMs,
    dateAdded: s.dateAdded,
    downloaded: s.downloaded,
    unplayable: s.unplayable,
  };
}

function toJsonAlbum(a: BackupAlbum): Record<string, unknown> {
  return {
    id: a.id,
    title: a.title,
    year: a.year,
    thumbnailUrl: a.thumbnailUrl,
    liked: a.liked,
    dateAdded: a.dateAdded,
  };
}

function toJsonArtist(a: BackupArtist): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    thumbnailUrl: a.thumbnailUrl,
    liked: a.liked,
    dateAdded: a.dateAdded,
  };
}

function toJsonPlaylist(p: BackupPlaylist): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    songIds: p.songIds,
    createdAt: p.createdAt,
  };
}

function toJsonPlayEvent(e: BackupPlayEvent): Record<string, unknown> {
  return { songId: e.songId, timestamp: e.timestamp, playTimeMs: e.playTimeMs };
}

function toJsonSearchQuery(q: BackupSearchQuery): Record<string, unknown> {
  return { query: q.query, timestamp: q.timestamp };
}

function toJsonQueueItem(q: BackupQueueItem): Record<string, unknown> {
  return { songId: q.songId, source: q.source };
}

function toJsonPlaybackState(
  s: BackupPlaybackState,
): Record<string, unknown> {
  return {
    currentIndex: s.currentIndex,
    positionMs: s.positionMs,
    shuffleEnabled: s.shuffleEnabled,
    repeatMode: s.repeatMode,
  };
}

function toJsonSettings(s: BackupSettings): Record<string, unknown> {
  return {
    dataSaver: s.dataSaver ?? null,
    defaultQuality: s.defaultQuality ?? null,
    wifiOnly: s.wifiOnly ?? null,
    cacheLimitBytes: s.cacheLimitBytes ?? null,
    playbackSpeed: s.playbackSpeed ?? null,
    playbackPitch: s.playbackPitch ?? null,
    skipSilence: s.skipSilence ?? null,
    sortSongs: s.sortSongs ?? null,
    eqEnabled: s.eqEnabled ?? null,
    eqPreset: s.eqPreset ?? null,
    lyricsEnabled: s.lyricsEnabled ?? null,
    eqPresetName: s.eqPresetName ?? null,
    eqGains: s.eqGains ?? null,
  };
}

/** Bentuk JSON mentah satu file salinan (kunci sesuai format APK). */
export function backupDataToJson(data: BackupData): Record<string, unknown> {
  return {
    backupVersion: data.version,
    appVersion: data.appVersion,
    exportedAt: data.exportedAt.toISOString(),
    songs: data.songs.map(toJsonSong),
    albums: data.albums.map(toJsonAlbum),
    artists: data.artists.map(toJsonArtist),
    playlists: data.playlists.map(toJsonPlaylist),
    playEvents: data.playEvents.map(toJsonPlayEvent),
    searchHistory: data.searchHistory.map(toJsonSearchQuery),
    queue: data.queue.map(toJsonQueueItem),
    playbackState: data.playbackState
      ? toJsonPlaybackState(data.playbackState)
      : null,
    settings: data.settings ? toJsonSettings(data.settings) : null,
  };
}

/** Encode ke teks JSON. */
export function encodeBackupData(data: BackupData): string {
  return JSON.stringify(backupDataToJson(data));
}

/**
 * Parse + validasi + migrasi dari byte file.
 *
 * Urutan: cek ukuran dulu (MAX_BACKUP_BYTES), lalu decode UTF-8,
 * lalu parse JSON, lalu cek versi, lalu migrasi, lalu validasi
 * struktur + referensi. Melempar BackupException dengan jenis
 * yang tepat di tiap langkah; tidak pernah melempar error mentah
 * (SyntaxError dsb.) ke pemanggil.
 */
export function parseBackupBytes(bytes: Uint8Array): BackupData {
  if (bytes.length > MAX_BACKUP_BYTES) {
    throw new BackupException('tooLarge', 'ukuran file melebihi batas');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BackupException('invalidJson', 'bukan UTF-8 valid');
  }
  return parseBackupText(text);
}

/** Parse + validasi + migrasi dari teks JSON. */
export function parseBackupText(text: string): BackupData {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new BackupException('invalidJson', 'bukan JSON valid');
  }
  if (!isRecord(decoded)) {
    throw new BackupException('notBackup', 'akar JSON bukan objek');
  }
  const versionRaw = decoded['backupVersion'];
  if (!isInt(versionRaw)) {
    throw new BackupException(
      'notBackup',
      'backupVersion hilang atau bukan angka',
    );
  }
  if (versionRaw > CURRENT_BACKUP_VERSION) {
    throw new BackupException(
      'newerVersion',
      `backupVersion ${versionRaw} > ${CURRENT_BACKUP_VERSION}`,
    );
  }
  if (versionRaw < 1) {
    throw new BackupException('notBackup', 'backupVersion < 1');
  }
  // Migrasi berurutan sampai versi terbaru. v1 adalah versi
  // pertama, jadi belum ada migrator nyata — dispatch ini yang
  // menjamin file lama tetap bisa dibaca saat v2 lahir (PRD B10.1).
  let migrated: Record<string, unknown> = decoded;
  for (let v = versionRaw; v < CURRENT_BACKUP_VERSION; v++) {
    migrated = migrateOneStep(migrated, v);
  }
  return fromJsonV1(migrated);
}

/**
 * Satu langkah migrasi v -> v+1. Dipanggil berurutan oleh
 * parseBackupText. Menambah versi baru = menambah satu cabang di
 * sini (dan hanya di sini), tanpa mengubah parser v1.
 */
function migrateOneStep(
  _json: Record<string, unknown>,
  fromVersion: number,
): Record<string, unknown> {
  // Belum ada migrator: v1 adalah versi pertama. Cabang ini tidak
  // pernah tercapai selama CURRENT_BACKUP_VERSION == 1.
  throw new BackupException(
    'invalidStructure',
    `tidak ada migrator dari versi ${fromVersion}`,
  );
}

function parseArtistRef(raw: unknown): BackupArtistRef | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  const name = raw['name'];
  if (!isBoundedString(id, MAX_BACKUP_ID_CHARS)) return null;
  if (!isBoundedString(name, MAX_BACKUP_TEXT_CHARS)) return null;
  return { id, name };
}

function parseSong(raw: unknown): BackupSong | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  const title = raw['title'];
  if (!isBoundedString(id, MAX_BACKUP_ID_CHARS)) return null;
  if (!isBoundedString(title, MAX_BACKUP_TEXT_CHARS)) return null;
  const artists: BackupArtistRef[] = [];
  const rawArtists = raw['artists'];
  if (Array.isArray(rawArtists)) {
    if (rawArtists.length > MAX_BACKUP_SONG_ARTISTS) return null;
    for (const item of rawArtists) {
      const ref = parseArtistRef(item);
      if (!ref) return null;
      artists.push(ref);
    }
  } else if (rawArtists !== null && rawArtists !== undefined) {
    return null;
  }
  const albumId = raw['albumId'];
  const durationSeconds = raw['durationSeconds'];
  const thumbnailUrl = raw['thumbnailUrl'];
  const liked = raw['liked'];
  const inLibrary = raw['inLibrary'];
  const totalPlayTimeMs = raw['totalPlayTimeMs'];
  const dateAdded = raw['dateAdded'];
  const downloaded = raw['downloaded'];
  const unplayable = raw['unplayable'];
  if (!isOptionalBoundedString(albumId, MAX_BACKUP_ID_CHARS)) return null;
  if (durationSeconds != null && !isInt(durationSeconds)) return null;
  if (!isOptionalBoundedString(thumbnailUrl, MAX_BACKUP_URL_CHARS)) return null;
  if (liked != null && typeof liked !== 'boolean') return null;
  if (inLibrary != null && typeof inLibrary !== 'boolean') return null;
  if (totalPlayTimeMs != null && !isInt(totalPlayTimeMs)) return null;
  if (dateAdded != null && !isInt(dateAdded)) return null;
  if (downloaded != null && typeof downloaded !== 'boolean') return null;
  if (unplayable != null && typeof unplayable !== 'boolean') return null;
  return {
    id,
    title,
    artists,
    albumId: (albumId as string | null | undefined) ?? null,
    durationSeconds: (durationSeconds as number | null | undefined) ?? null,
    thumbnailUrl: (thumbnailUrl as string | null | undefined) ?? null,
    liked: (liked as boolean | undefined) ?? false,
    inLibrary: (inLibrary as boolean | undefined) ?? false,
    totalPlayTimeMs: (totalPlayTimeMs as number | undefined) ?? 0,
    dateAdded: (dateAdded as number | null | undefined) ?? null,
    downloaded: (downloaded as boolean | undefined) ?? false,
    unplayable: (unplayable as boolean | undefined) ?? false,
  };
}

function parseAlbum(raw: unknown): BackupAlbum | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  const title = raw['title'];
  if (!isBoundedString(id, MAX_BACKUP_ID_CHARS)) return null;
  if (!isBoundedString(title, MAX_BACKUP_TEXT_CHARS)) return null;
  const year = raw['year'];
  const thumbnailUrl = raw['thumbnailUrl'];
  const liked = raw['liked'];
  const dateAdded = raw['dateAdded'];
  if (year != null && !isInt(year)) return null;
  if (!isOptionalBoundedString(thumbnailUrl, MAX_BACKUP_URL_CHARS)) return null;
  if (liked != null && typeof liked !== 'boolean') return null;
  if (dateAdded != null && !isInt(dateAdded)) return null;
  return {
    id,
    title,
    year: (year as number | null | undefined) ?? null,
    thumbnailUrl: (thumbnailUrl as string | null | undefined) ?? null,
    liked: (liked as boolean | undefined) ?? false,
    dateAdded: (dateAdded as number | null | undefined) ?? null,
  };
}

function parseArtist(raw: unknown): BackupArtist | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  const name = raw['name'];
  if (!isBoundedString(id, MAX_BACKUP_ID_CHARS)) return null;
  if (!isBoundedString(name, MAX_BACKUP_TEXT_CHARS)) return null;
  const thumbnailUrl = raw['thumbnailUrl'];
  const liked = raw['liked'];
  const dateAdded = raw['dateAdded'];
  if (!isOptionalBoundedString(thumbnailUrl, MAX_BACKUP_URL_CHARS)) return null;
  if (liked != null && typeof liked !== 'boolean') return null;
  if (dateAdded != null && !isInt(dateAdded)) return null;
  return {
    id,
    name,
    thumbnailUrl: (thumbnailUrl as string | null | undefined) ?? null,
    liked: (liked as boolean | undefined) ?? false,
    dateAdded: (dateAdded as number | null | undefined) ?? null,
  };
}

function parsePlaylist(raw: unknown): BackupPlaylist | null {
  if (!isRecord(raw)) return null;
  const name = raw['name'];
  if (!isBoundedString(name, MAX_BACKUP_PLAYLIST_TEXT_CHARS)) return null;
  const description = raw['description'];
  const songIds = raw['songIds'];
  const createdAt = raw['createdAt'];
  if (!isOptionalBoundedString(description, MAX_BACKUP_PLAYLIST_TEXT_CHARS)) return null;
  if (createdAt != null && !isInt(createdAt)) return null;
  const ids: string[] = [];
  if (Array.isArray(songIds)) {
    if (songIds.length > MAX_BACKUP_PLAYLIST_SONGS) return null;
    for (const item of songIds) {
      if (!isBoundedString(item, MAX_BACKUP_ID_CHARS)) return null;
      ids.push(item);
    }
  } else if (songIds !== null && songIds !== undefined) {
    return null;
  }
  return {
    name,
    description: (description as string | null | undefined) ?? null,
    songIds: ids,
    createdAt: (createdAt as number | null | undefined) ?? null,
  };
}

function parsePlayEvent(raw: unknown): BackupPlayEvent | null {
  if (!isRecord(raw)) return null;
  const songId = raw['songId'];
  const timestamp = raw['timestamp'];
  const playTimeMs = raw['playTimeMs'];
  if (!isBoundedString(songId, MAX_BACKUP_ID_CHARS)) return null;
  if (!isInt(timestamp) || timestamp < 0) return null;
  if (!isInt(playTimeMs) || playTimeMs < 0) return null;
  return { songId, timestamp, playTimeMs };
}

function parseSearchQuery(raw: unknown): BackupSearchQuery | null {
  if (!isRecord(raw)) return null;
  const query = raw['query'];
  const timestamp = raw['timestamp'];
  if (!isBoundedString(query, MAX_BACKUP_QUERY_CHARS)) return null;
  if (!isInt(timestamp) || timestamp < 0) return null;
  return { query, timestamp };
}

function parseQueueItem(raw: unknown): BackupQueueItem | null {
  if (!isRecord(raw)) return null;
  const songId = raw['songId'];
  const source = raw['source'];
  if (!isBoundedString(songId, MAX_BACKUP_ID_CHARS)) return null;
  if (!isOptionalBoundedString(source, MAX_BACKUP_ID_CHARS)) return null;
  return { songId, source: (source as string | null | undefined) ?? null };
}

function parsePlaybackState(raw: unknown): BackupPlaybackState | null {
  if (!isRecord(raw)) return null;
  const currentIndex = raw['currentIndex'];
  const positionMs = raw['positionMs'];
  const shuffleEnabled = raw['shuffleEnabled'];
  const repeatMode = raw['repeatMode'];
  if (!isInt(currentIndex) || currentIndex < 0) return null;
  if (!isInt(positionMs) || positionMs < 0) return null;
  if (typeof shuffleEnabled !== 'boolean') return null;
  if (!isInt(repeatMode) || repeatMode < 0 || repeatMode > 2) return null;
  return { currentIndex, positionMs, shuffleEnabled, repeatMode };
}

function parseSettings(raw: unknown): BackupSettings | null {
  if (raw == null) return null;
  if (!isRecord(raw)) return null;
  // Nilai salah tipe diabaikan (jadi null), bukan menolak file —
  // pengaturan adalah bagian yang paling mungkin berbeda antar
  // versi, dan satu nilai rusak tidak boleh menggagalkan seluruh
  // impor data (port APK).
  const dataSaver = raw['dataSaver'];
  const defaultQuality = raw['defaultQuality'];
  const wifiOnly = raw['wifiOnly'];
  const cacheLimitBytes = raw['cacheLimitBytes'];
  const playbackSpeed = raw['playbackSpeed'];
  const playbackPitch = raw['playbackPitch'];
  const skipSilence = raw['skipSilence'];
  const sortSongs = raw['sortSongs'];
  const eqEnabled = raw['eqEnabled'];
  const eqPreset = raw['eqPreset'];
  const lyricsEnabled = raw['lyricsEnabled'];
  const eqPresetName = raw['eqPresetName'];
  const eqGains = raw['eqGains'];
  return {
    dataSaver: typeof dataSaver === 'boolean' ? dataSaver : null,
    defaultQuality:
      typeof defaultQuality === 'string' && defaultQuality.length <= 100
        ? defaultQuality
        : null,
    wifiOnly: typeof wifiOnly === 'boolean' ? wifiOnly : null,
    cacheLimitBytes: isInt(cacheLimitBytes) ? cacheLimitBytes : null,
    playbackSpeed:
      typeof playbackSpeed === 'number' ? playbackSpeed : null,
    playbackPitch:
      typeof playbackPitch === 'number' ? playbackPitch : null,
    skipSilence: typeof skipSilence === 'boolean' ? skipSilence : null,
    sortSongs:
      typeof sortSongs === 'string' && sortSongs.length <= 100
        ? sortSongs
        : null,
    eqEnabled: typeof eqEnabled === 'boolean' ? eqEnabled : null,
    eqPreset: isInt(eqPreset) ? eqPreset : null,
    lyricsEnabled:
      typeof lyricsEnabled === 'boolean' ? lyricsEnabled : null,
    eqPresetName:
      typeof eqPresetName === 'string' && eqPresetName.length <= 100
        ? eqPresetName
        : null,
    eqGains:
      Array.isArray(eqGains) &&
      eqGains.length <= 10 &&
      eqGains.every((g) => typeof g === 'number' && Number.isFinite(g))
        ? (eqGains as number[])
        : null,
  };
}

function parseList<T>(
  raw: unknown,
  parse: (item: unknown) => T | null,
  section: string,
  maxItems?: number,
): T[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new BackupException(
      'invalidStructure',
      `bagian "${section}" bukan daftar`,
    );
  }
  if (maxItems !== undefined && raw.length > maxItems) {
    throw new BackupException(
      'invalidStructure',
      `bagian "${section}" melebihi ${maxItems} item`,
    );
  }
  const out: T[] = [];
  for (const item of raw) {
    const parsed = parse(item);
    if (parsed === null) {
      throw new BackupException(
        'invalidStructure',
        `item rusak di bagian "${section}"`,
      );
    }
    out.push(parsed);
  }
  return out;
}

function fromJsonV1(json: Record<string, unknown>): BackupData {
  const appVersion = json['appVersion'];
  const exportedAt = json['exportedAt'];
  if (!isBoundedString(appVersion, MAX_BACKUP_ID_CHARS)) {
    throw new BackupException(
      'invalidStructure',
      'appVersion hilang atau bukan string',
    );
  }
  let exported: Date | null = null;
  if (typeof exportedAt === 'string') {
    const ms = Date.parse(exportedAt);
    if (!Number.isNaN(ms)) exported = new Date(ms);
  }
  if (exported === null) {
    throw new BackupException(
      'invalidStructure',
      'exportedAt hilang atau bukan tanggal ISO',
    );
  }
  const songs = parseList(json['songs'], parseSong, 'songs', MAX_BACKUP_SONGS);
  const albums = parseList(json['albums'], parseAlbum, 'albums', MAX_BACKUP_ALBUMS);
  const artists = parseList(json['artists'], parseArtist, 'artists', MAX_BACKUP_ARTISTS);
  const playlists = parseList(
    json['playlists'],
    parsePlaylist,
    'playlists',
    MAX_BACKUP_PLAYLISTS,
  );
  const playEvents = parseList(
    json['playEvents'],
    parsePlayEvent,
    'playEvents',
    MAX_BACKUP_PLAY_EVENTS,
  );
  const searchHistory = parseList(
    json['searchHistory'],
    parseSearchQuery,
    'searchHistory',
    MAX_BACKUP_SEARCH_HISTORY,
  );
  const queue = parseList(
    json['queue'],
    parseQueueItem,
    'queue',
    MAX_BACKUP_QUEUE_ITEMS,
  );
  // Id lagu wajib unik (duplikat = file rusak, bukan merge diam-diam).
  const songIds = new Set<string>();
  for (const song of songs) {
    if (songIds.has(song.id)) {
      throw new BackupException(
        'invalidStructure',
        `id lagu ganda: ${song.id}`,
      );
    }
    songIds.add(song.id);
  }
  const albumIds = new Set(albums.map((a) => a.id));
  // Integritas referensi: semua penunjuk lagu/album harus ada di
  // file. Tanpa cek ini, impor bisa gagal di tengah transaksi —
  // lebih baik ditolak utuh di depan.
  for (const song of songs) {
    if (song.albumId !== null && !albumIds.has(song.albumId)) {
      throw new BackupException(
        'invalidStructure',
        `lagu ${song.id} menunjuk album yang tidak ada: ${song.albumId}`,
      );
    }
  }
  for (const playlist of playlists) {
    for (const songId of playlist.songIds) {
      if (!songIds.has(songId)) {
        throw new BackupException(
          'invalidStructure',
          `playlist "${playlist.name}" menunjuk lagu yang tidak ada: ${songId}`,
        );
      }
    }
  }
  for (const event of playEvents) {
    if (!songIds.has(event.songId)) {
      throw new BackupException(
        'invalidStructure',
        `riwayat menunjuk lagu yang tidak ada: ${event.songId}`,
      );
    }
  }
  for (const item of queue) {
    if (!songIds.has(item.songId)) {
      throw new BackupException(
        'invalidStructure',
        `antrean menunjuk lagu yang tidak ada: ${item.songId}`,
      );
    }
  }
  const playbackState =
    json['playbackState'] == null
      ? null
      : parsePlaybackState(json['playbackState']);
  if (json['playbackState'] != null && playbackState === null) {
    throw new BackupException('invalidStructure', 'playbackState rusak');
  }
  const settings = parseSettings(json['settings']);
  return {
    version: CURRENT_BACKUP_VERSION,
    appVersion,
    exportedAt: exported,
    songs,
    albums,
    artists,
    playlists,
    playEvents,
    searchHistory,
    queue,
    playbackState,
    settings,
  };
}

/**
 * Nama file salinan: `backup-musik-YYYYMMDD-HHmmss.json` (PRD
 * B10.1, waktu lokal perangkat supaya nama file bisa dibaca
 * pengguna). Sama dengan nama file APK — satu format, dua
 * platform.
 */
export function backupFileName(when?: Date): string {
  const at = when ?? new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `backup-musik-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-` +
    `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}.json`
  );
}

/**
 * Tanggal untuk ringkasan impor, mis. "17 Nov 2026, 04.38".
 * Format manual (tanpa paket intl): bulan singkatan Indonesia.
 */
export function formatBackupDate(when: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'Mei',
    'Jun',
    'Jul',
    'Agu',
    'Sep',
    'Okt',
    'Nov',
    'Des',
  ];
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${when.getDate()} ${months[when.getMonth()]} ${when.getFullYear()}, ` +
    `${two(when.getHours())}.${two(when.getMinutes())}`
  );
}
