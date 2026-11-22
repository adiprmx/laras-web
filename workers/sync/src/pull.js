// Worker sync — Sync tarik /api/sync/pull (P-SyncSplit).
// Dipindah verbatim dari index.js (P-SyncSplit); logika
// tidak berubah. Impor di bawah dihitung dari graf
// dependensi, bukan tebakan.

import { jsonOk, secondsUntilMidnightUtc } from './util.js';
import {
  DAILY_READ_BUDGET,
  DAILY_WRITE_BUDGET,
  MAX_PULL_ROWS,
  PULL_WRITE_CHARGE,
  READ_BUDGET_RESERVE_PER_PULL,
} from './constants.js';
import { jsonError } from '../../shared/http.js';
import { logWarn } from '../../shared/log.js';

// ------------------------------------------------------------------
// Sync: tarik
// ------------------------------------------------------------------

// Paginasi pull (P-Pull, Koordinator #18).
//
// Tiap koleksi diambil LIMIT 1001: baris ke-1001 adalah probe
// pemotongan. Bila ada, halaman dipotong di BATAS GRUP timestamp:
// baris dengan updated_at sama dengan baris ke-1000 TIDAK boleh
// terbelah — kursor adalah timestamp, jadi grup yang terbelah
// berarti baris hilang diam-diam di halaman berikut (bug KRITIS
// yang diperbaiki paket ini: dulu client memajukan kursor ke
// serverTime melewati baris yang tidak pernah dikirim).
//
// Kasus mustahil (seluruh halaman satu grup timestamp, >1000
// baris di 1 ms — push dibatasi 100 entri/koleksi): kembalikan
// 1000 pertama + tieOverflow; client JANGAN majukan kursor dan
// menandai sinkronisasi belum selesai (jujur, bukan hilang diam).
export function pageCollection(rows) {
  if (rows.length <= MAX_PULL_ROWS) {
    return { page: rows, truncated: false, tieOverflow: false };
  }
  // Batas = timestamp baris PROBE (indeks 1000), BUKAN baris
  // ke-1000: hanya grup yang memuat probe yang terbelah. Memakai
  // baris ke-1000 sebagai batas selalu membuang satu baris
  // (off-by-one — ditangkap tes P-Pull).
  const boundary = rows[MAX_PULL_ROWS].updated_at;
  let cut = MAX_PULL_ROWS;
  while (cut > 0 && rows[cut - 1].updated_at === boundary) cut -= 1;
  if (cut === 0) {
    return {
      page: rows.slice(0, MAX_PULL_ROWS),
      truncated: true,
      tieOverflow: true,
    };
  }
  return { page: rows.slice(0, cut), truncated: true, tieOverflow: false };
}

export async function handlePull(env, url, user) {
  const sinceRaw = Number(url.searchParams.get('since') || 0);
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
  const db = env.DB;
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  // ---- S12a: pull DITAGIH ke anggaran TULIS (4 baris/pull).
  // Tanpa ini, anggaran baca saja TIDAK membatasi jumlah pull:
  // pull kosong menagih bersih 1 baris baca (cadangan 4.002
  // dikembalikan 4.001) tapi menulis 3 baris D1 (rate-limit +
  // reservasi baca + refund) — 36.000 pull kosong = 108.000
  // tulis, SATU akun membunuh kuota tulis 100.000 (ditemukan
  // saat verifikasi aritmetika Blue 6, BUKAN di Red 6).
  // Tagihan 4 menutup SEMUA tulis yang disebabkan satu pull:
  // baris rate-limit (1) + cadangan anggaran tulis ini (1) +
  // cadangan anggaran baca (1) + refund (1, bila jalan).
  // Pull yang kembali penuh (refund 0) kelebihan-tagih 1 baris
  // — arah aman, dan hanya ~9 pull/hari yang kena. Pengguna
  // normal (~5 pull/hari = 20 baris dari 20.000) tidak terasa.
  // Cadangan gagal TIDAK di-refund: 4 baris tidak material,
  // dan penyerang yang memicu kegagalan berulang menghabiskan
  // anggarannya sendiri (pra-cek router memblokir sesudahnya).
  try {
    const res = await db
      .prepare(
        'INSERT INTO sync_write_budget (user_id, day, rows_written) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET rows_written = sync_write_budget.rows_written + excluded.rows_written WHERE sync_write_budget.rows_written + excluded.rows_written <= ?',
      )
      .bind(user.id, day, PULL_WRITE_CHARGE, DAILY_WRITE_BUDGET)
      .run();
    if (res.meta?.changes !== 1) {
      const retryAfter = secondsUntilMidnightUtc(now);
      return jsonError(
        429,
        'DAILY_WRITE_BUDGET_EXCEEDED',
        'Batas sinkronisasi harian tercapai. Coba lagi besok.',
        { 'Retry-After': String(retryAfter) },
      );
    }
  } catch (e) {
    logWarn('anggaran tulis: gagal cadang pull, pull diizinkan', { error: e instanceof Error ? e.message : 'unknown' });
  }
  // ---- S11b: anggaran BACA pull harian per akun (atomik, §4.3).
  // Cadangan SEBELUM query jalan (satu upsert berkondisi, seperti
  // anggaran tulis S8b): pull yang melewati anggaran ditolak 429
  // SEBELUM memindai apa pun, jadi tidak ada TOCTOU anggaran
  // (pull bersamaan tidak bisa sama-sama lolos sesudah anggaran
  // habis). Cadangan = maksimum baris satu pull + 1 untuk baris
  // rate-limit pull ini (S12a); selisih yang tidak terpakai
  // dikembalikan sesudah query (refund best-effort — gagal
  // refund hanya kelebihan-tagih, arah aman). Fail-open bila
  // tabel 0006 belum ada (koordinator WAJIB menerapkan 0006
  // sebelum deploy; tanpa tabelnya S11 kembali terbuka).
  let reserved = false;
  try {
    const res = await db
      .prepare(
        'INSERT INTO sync_read_budget (user_id, day, rows_read) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET rows_read = sync_read_budget.rows_read + excluded.rows_read WHERE sync_read_budget.rows_read + excluded.rows_read <= ?',
      )
      .bind(user.id, day, READ_BUDGET_RESERVE_PER_PULL, DAILY_READ_BUDGET)
      .run();
    if (res.meta?.changes !== 1) {
      const retryAfter = secondsUntilMidnightUtc(now);
      return jsonError(
        429,
        'DAILY_READ_BUDGET_EXCEEDED',
        'Batas tarik sinkronisasi harian tercapai. Coba lagi besok.',
        { 'Retry-After': String(retryAfter) },
      );
    }
    reserved = true;
  } catch (e) {
    logWarn('anggaran baca: gagal cadang, pull diizinkan', { error: e instanceof Error ? e.message : 'unknown' });
  }
  const [playlists, items, likes, history, settings] = await Promise.all([
    db
      .prepare(
        'SELECT client_id, nama, deskripsi, updated_at, deleted_at FROM sync_playlists WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ?',
      )
      .bind(user.id, since, MAX_PULL_ROWS + 1)
      .all(),
    db
      // S11a: filter i.user_id LANGSUNG (kolom + indeks
      // idx_items_user dari 0004) sebagai ganti p.user_id.
      // Bentuk lama memakai JOIN + sort yang memindai SEMUA
      // item pengguna (LIMIT baru sesudah sort): 100.000 item
      // = 100.000 baris dipindai per pull, kuota baca 5 juta
      // habis dalam 49 pull. Bentuk baru memakai indeks
      // (user_id, updated_at) yang terurut, LIMIT-bounded di
      // 1.000 tanpa temp b-tree; JOIN ke playlist hanya lookup
      // PK untuk client_id (terverifikasi EXPLAIN QUERY PLAN
      // di SQLite lokal pada 2 skala, lihat
      // docs/blue6-red6-fixes.md §2).
      .prepare(
        'SELECT p.client_id AS playlist_client_id, i.video_id, i.posisi, i.title, i.artist, i.updated_at, i.deleted_at FROM sync_playlist_items i JOIN sync_playlists p ON p.id = i.playlist_id WHERE i.user_id = ? AND i.updated_at > ? ORDER BY i.updated_at ASC LIMIT ?',
      )
      .bind(user.id, since, MAX_PULL_ROWS + 1)
      .all(),
    db
      .prepare(
        'SELECT video_id, liked_at, title, artist, updated_at, deleted_at FROM sync_likes WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ?',
      )
      .bind(user.id, since, MAX_PULL_ROWS + 1)
      .all(),
    db
      .prepare(
        'SELECT video_id, played_at, seconds_played, title, artist, updated_at FROM sync_history WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ?',
      )
      .bind(user.id, since, MAX_PULL_ROWS + 1)
      .all(),
    db
      .prepare('SELECT settings_json, updated_at FROM sync_settings WHERE user_id = ?')
      .bind(user.id)
      .first(),
  ]);
  // P-Pull: paginasi per koleksi (lihat pageCollection).
  const pagedPlaylists = pageCollection(playlists.results || []);
  const pagedItems = pageCollection(items.results || []);
  const pagedLikes = pageCollection(likes.results || []);
  const pagedHistory = pageCollection(history.results || []);
  const paged = [pagedPlaylists, pagedItems, pagedLikes, pagedHistory];
  const hasMore = paged.some((p) => p.truncated);
  const tieOverflow = paged.some((p) => p.tieOverflow);
  // nextSince = MINIMUM maxUpdatedAt koleksi yang terpotong.
  // Maksimum GLOBAL salah: koleksi A terpotong di 100 sementara
  // B sudah sampai 500 — kursor 500 melewatkan sisa A (100..500).
  // Halaman berikut mengambil ulang baris koleksi lain di
  // (nextSince, max] — duplikat yang digabung LWW, tidak berbahaya.
  // maxUpdatedAt = maksimum di 4 koleksi (settings TIDAK ikut:
  // settings selalu dikembalikan utuh, jadi memasukkannya ke
  // watermark akan melewatkan baris koleksi yang lebih lama).
  let nextSince = null;
  let maxUpdatedAt = 0;
  for (const p of paged) {
    for (const r of p.page) {
      if (r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at;
    }
    if (p.truncated && !p.tieOverflow && p.page.length > 0) {
      const m = p.page[p.page.length - 1].updated_at;
      if (nextSince === null || m < nextSince) nextSince = m;
    }
  }
  if (tieOverflow) nextSince = null; // tidak ada kursor aman
  // S11b: kembalikan selisih cadangan yang tidak terpakai.
  // Tagihan akhir = baris dikembalikan + 1 (baris rate-limit).
  // Dihitung dari halaman YANG DIPOTONG (bukan hasil query
  // mentah yang memuat baris probe ke-1001).
  if (reserved) {
    const returned =
      pagedPlaylists.page.length +
      pagedItems.page.length +
      pagedLikes.page.length +
      pagedHistory.page.length +
      (settings ? 1 : 0);
    const refund = READ_BUDGET_RESERVE_PER_PULL - (returned + 1);
    if (refund > 0) {
      try {
        await db
          .prepare(
            'UPDATE sync_read_budget SET rows_read = MAX(0, rows_read - ?) WHERE user_id = ? AND day = ?',
          )
          .bind(refund, user.id, day)
          .run();
      } catch (e) {
        logWarn('anggaran baca: gagal refund (kelebihan-tagih, arah aman)', { error: e instanceof Error ? e.message : 'unknown' });
      }
    }
  }
  return jsonOk({
    serverTime: Date.now(),
    // P-Pull: hasMore + nextSince + maxUpdatedAt + tieOverflow.
    hasMore,
    nextSince,
    maxUpdatedAt,
    tieOverflow,
    playlists: pagedPlaylists.page.map((r) => ({
      clientId: r.client_id,
      nama: r.nama,
      deskripsi: r.deskripsi,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    })),
    playlistItems: pagedItems.page.map((r) => ({
      playlistClientId: r.playlist_client_id,
      videoId: r.video_id,
      posisi: r.posisi,
      title: r.title,
      artist: r.artist,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    })),
    likes: pagedLikes.page.map((r) => ({
      videoId: r.video_id,
      likedAt: r.liked_at,
      title: r.title,
      artist: r.artist,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    })),
    history: pagedHistory.page.map((r) => ({
      videoId: r.video_id,
      playedAt: r.played_at,
      secondsPlayed: r.seconds_played,
      title: r.title,
      artist: r.artist,
      updatedAt: r.updated_at,
    })),
    settings: settings
      ? { settingsJson: settings.settings_json, updatedAt: settings.updated_at }
      : null,
  });
}
