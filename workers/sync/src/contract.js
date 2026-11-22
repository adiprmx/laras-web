// Kontrak API sync (P-Types, Koordinator #18): SATU-SATUNYA sumber
// kebenaran runtime untuk bentuk wire push/pull.
//
// Dipakai DUA sisi: worker (push.js memvalidasi body push masuk
// dengan validatePushBody) DAN app (syncClient.ts memvalidasi body
// push SEBELUM kirim + respons pull/push sesudah terima). Bila
// bentuk wire berubah, ubah DI SINI + tipe di contract.d.ts —
// jangan di dua tempat terpisah (itulah drift yang ditutup paket
// ini).
//
// Modul ini MURNI: tanpa API Worker, tanpa D1, tanpa env — hanya
// fungsi validasi + konstanta batas. Aman diimpor app (Vite
// membundelnya) maupun worker (esbuild membundelnya).
//
// Tipe TypeScript pendamping: contract.d.ts (bentuk yang sama,
// untuk app). Validator mengembalikan pesan galat (string) atau
// null bila valid — pola yang sama dengan validatePushBody lama.

import {
  MAX_META_CHARS,
  MAX_PUSH_ENTRIES,
  MAX_SETTINGS_BYTES,
} from './constants.js';

export function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

export function isOptionalString(v, maxLen) {
  return v === null || v === undefined || (typeof v === 'string' && v.length <= maxLen);
}

export function isSafeInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Validasi satu entri push; mengembalikan pesan galat atau null. */
export function validatePushBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Body harus objek JSON';
  }
  if (!isNonEmptyString(body.deviceId, 100)) {
    return 'deviceId wajib diisi';
  }
  const collections = [
    'playlists',
    'playlistItems',
    'likes',
    'history',
    'deletedPlaylists',
    'deletedPlaylistItems',
    'deletedLikes',
  ];
  for (const name of collections) {
    const arr = body[name];
    if (arr === undefined || arr === null) continue;
    if (!Array.isArray(arr)) return `${name} harus array`;
    if (arr.length > MAX_PUSH_ENTRIES) return `${name} melebihi 100 entri`;
  }
  for (const p of body.playlists || []) {
    if (!isNonEmptyString(p.clientId, 200)) return 'playlist.clientId tidak valid';
    if (!isNonEmptyString(p.nama, 100)) return 'playlist.nama tidak valid';
    if (!isOptionalString(p.deskripsi, 500)) return 'playlist.deskripsi tidak valid';
  }
  for (const item of body.playlistItems || []) {
    if (!isNonEmptyString(item.playlistClientId, 200)) return 'item.playlistClientId tidak valid';
    if (!isNonEmptyString(item.videoId, 50)) return 'item.videoId tidak valid';
    if (!isSafeInt(item.posisi)) return 'item.posisi tidak valid';
    if (!isOptionalString(item.title, MAX_META_CHARS)) return 'item.title tidak valid';
    if (!isOptionalString(item.artist, MAX_META_CHARS)) return 'item.artist tidak valid';
  }
  for (const like of body.likes || []) {
    if (!isNonEmptyString(like.videoId, 50)) return 'like.videoId tidak valid';
    if (!isSafeInt(like.likedAt)) return 'like.likedAt tidak valid';
    if (!isOptionalString(like.title, MAX_META_CHARS)) return 'like.title tidak valid';
    if (!isOptionalString(like.artist, MAX_META_CHARS)) return 'like.artist tidak valid';
  }
  for (const h of body.history || []) {
    if (!isNonEmptyString(h.videoId, 50)) return 'history.videoId tidak valid';
    if (!isSafeInt(h.playedAt)) return 'history.playedAt tidak valid';
    if (!isSafeInt(h.secondsPlayed)) return 'history.secondsPlayed tidak valid';
    if (!isOptionalString(h.title, MAX_META_CHARS)) return 'history.title tidak valid';
    if (!isOptionalString(h.artist, MAX_META_CHARS)) return 'history.artist tidak valid';
  }
  for (const d of body.deletedPlaylists || []) {
    if (!isNonEmptyString(d.clientId, 200)) return 'deletedPlaylists.clientId tidak valid';
  }
  for (const d of body.deletedPlaylistItems || []) {
    if (!isNonEmptyString(d.playlistClientId, 200)) return 'deletedPlaylistItems.playlistClientId tidak valid';
    if (!isNonEmptyString(d.videoId, 50)) return 'deletedPlaylistItems.videoId tidak valid';
  }
  for (const d of body.deletedLikes || []) {
    if (!isNonEmptyString(d.videoId, 50)) return 'deletedLikes.videoId tidak valid';
  }
  if (body.settings !== undefined && body.settings !== null) {
    if (typeof body.settings !== 'object' || typeof body.settings.settingsJson !== 'string') {
      return 'settings.settingsJson tidak valid';
    }
    if (new TextEncoder().encode(body.settings.settingsJson).length > MAX_SETTINGS_BYTES) {
      return 'settings melebihi 4 KB';
    }
  }
  if (
    body.historyClearedBefore !== undefined &&
    body.historyClearedBefore !== null &&
    !isSafeInt(body.historyClearedBefore)
  ) {
    return 'historyClearedBefore tidak valid';
  }
  return null;
}

function isNullableSafeInt(v) {
  return v === null || isSafeInt(v);
}

/**
 * Validasi respons pull (dipakai APP, bukan worker): server adalah
 * pihak tepercaya, jadi yang dicek adalah BENTUK — keberadaan +
 * tipe field wajib per entri — bukan panjang string. Tujuannya
 * menangkap drift (server lama/baru, deploy setengah jalan), bukan
 * serangan. Mengembalikan pesan galat atau null.
 */
export function validatePullResponse(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'Pull harus objek JSON';
  }
  if (!isSafeInt(data.serverTime)) return 'pull.serverTime tidak valid';
  for (const name of ['playlists', 'playlistItems', 'likes', 'history']) {
    if (!Array.isArray(data[name])) return `pull.${name} harus array`;
  }
  if (data.hasMore !== undefined && typeof data.hasMore !== 'boolean') {
    return 'pull.hasMore harus boolean';
  }
  if (
    data.nextSince !== undefined &&
    data.nextSince !== null &&
    !isSafeInt(data.nextSince)
  ) {
    return 'pull.nextSince tidak valid';
  }
  if (data.maxUpdatedAt !== undefined && !isSafeInt(data.maxUpdatedAt)) {
    return 'pull.maxUpdatedAt tidak valid';
  }
  if (data.tieOverflow !== undefined && typeof data.tieOverflow !== 'boolean') {
    return 'pull.tieOverflow harus boolean';
  }
  for (const p of data.playlists) {
    if (typeof p !== 'object' || p === null) return 'pull.playlist harus objek';
    if (!isNonEmptyString(p.clientId, 200)) return 'pull.playlist.clientId tidak valid';
    if (typeof p.nama !== 'string') return 'pull.playlist.nama tidak valid';
    if (!isOptionalString(p.deskripsi, 500)) return 'pull.playlist.deskripsi tidak valid';
    if (!isSafeInt(p.updatedAt)) return 'pull.playlist.updatedAt tidak valid';
    if (!isNullableSafeInt(p.deletedAt)) return 'pull.playlist.deletedAt tidak valid';
  }
  for (const item of data.playlistItems) {
    if (typeof item !== 'object' || item === null) return 'pull.item harus objek';
    if (!isNonEmptyString(item.playlistClientId, 200)) return 'pull.item.playlistClientId tidak valid';
    if (!isNonEmptyString(item.videoId, 50)) return 'pull.item.videoId tidak valid';
    if (!isSafeInt(item.posisi)) return 'pull.item.posisi tidak valid';
    if (!isOptionalString(item.title, MAX_META_CHARS)) return 'pull.item.title tidak valid';
    if (!isOptionalString(item.artist, MAX_META_CHARS)) return 'pull.item.artist tidak valid';
    if (!isSafeInt(item.updatedAt)) return 'pull.item.updatedAt tidak valid';
    if (!isNullableSafeInt(item.deletedAt)) return 'pull.item.deletedAt tidak valid';
  }
  for (const like of data.likes) {
    if (typeof like !== 'object' || like === null) return 'pull.like harus objek';
    if (!isNonEmptyString(like.videoId, 50)) return 'pull.like.videoId tidak valid';
    if (!isSafeInt(like.likedAt)) return 'pull.like.likedAt tidak valid';
    if (!isOptionalString(like.title, MAX_META_CHARS)) return 'pull.like.title tidak valid';
    if (!isOptionalString(like.artist, MAX_META_CHARS)) return 'pull.like.artist tidak valid';
    if (!isSafeInt(like.updatedAt)) return 'pull.like.updatedAt tidak valid';
    if (!isNullableSafeInt(like.deletedAt)) return 'pull.like.deletedAt tidak valid';
  }
  for (const h of data.history) {
    if (typeof h !== 'object' || h === null) return 'pull.history harus objek';
    if (!isNonEmptyString(h.videoId, 50)) return 'pull.history.videoId tidak valid';
    if (!isSafeInt(h.playedAt)) return 'pull.history.playedAt tidak valid';
    if (!isSafeInt(h.secondsPlayed)) return 'pull.history.secondsPlayed tidak valid';
    if (!isOptionalString(h.title, MAX_META_CHARS)) return 'pull.history.title tidak valid';
    if (!isOptionalString(h.artist, MAX_META_CHARS)) return 'pull.history.artist tidak valid';
    if (!isSafeInt(h.updatedAt)) return 'pull.history.updatedAt tidak valid';
  }
  // settings WAJIB ada (null atau objek) — worker selalu
  // mengembalikannya sejak P7; ketiadaan kunci = drift.
  if (data.settings === undefined) return 'pull.settings tidak valid';
  if (data.settings !== null) {
    if (
      typeof data.settings !== 'object' ||
      typeof data.settings.settingsJson !== 'string' ||
      !isSafeInt(data.settings.updatedAt)
    ) {
      return 'pull.settings tidak valid';
    }
  }
  return null;
}

/**
 * Validasi respons push (dipakai APP): bentuk ringan — serverTime +
 * applied wajib; field opsional dicek tipenya bila ada.
 */
export function validatePushData(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'Push harus objek JSON';
  }
  if (!isSafeInt(data.serverTime)) return 'push.serverTime tidak valid';
  if (!isSafeInt(data.applied)) return 'push.applied tidak valid';
  if (data.pruned !== undefined && !isSafeInt(data.pruned)) return 'push.pruned tidak valid';
  if (data.skippedNotOwned !== undefined && !isSafeInt(data.skippedNotOwned)) {
    return 'push.skippedNotOwned tidak valid';
  }
  if (data.skippedOverLimit !== undefined) {
    const s = data.skippedOverLimit;
    if (
      typeof s !== 'object' ||
      s === null ||
      !isSafeInt(s.playlists) ||
      !isSafeInt(s.playlistItems) ||
      !isSafeInt(s.likes) ||
      !isSafeInt(s.history)
    ) {
      return 'push.skippedOverLimit tidak valid';
    }
  }
  if (data.limits !== undefined) {
    const l = data.limits;
    if (
      typeof l !== 'object' ||
      l === null ||
      !isSafeInt(l.playlists) ||
      !isSafeInt(l.itemsPerPlaylist) ||
      !isSafeInt(l.likes) ||
      !isSafeInt(l.history)
    ) {
      return 'push.limits tidak valid';
    }
  }
  if (data.historyClearIgnored !== undefined && typeof data.historyClearIgnored !== 'boolean') {
    return 'push.historyClearIgnored harus boolean';
  }
  if (
    data.historyClearRetryAfterSeconds !== undefined &&
    !isSafeInt(data.historyClearRetryAfterSeconds)
  ) {
    return 'push.historyClearRetryAfterSeconds tidak valid';
  }
  return null;
}
