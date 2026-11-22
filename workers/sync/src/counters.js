// Worker sync — Penghitung baris + rekonsiliasi (S7/S8, Blue 5) (P-SyncSplit).
// Dipindah verbatim dari index.js (P-SyncSplit); logika
// tidak berubah. Impor di bawah dihitung dari graf
// dependensi, bukan tebakan.

import {
  COUNTER_RECONCILE_MAX_AGE_MS,
  COUNTER_RECONCILE_NEAR_CAP,
  COUNTER_RECONCILE_OVER_CAP_SLACK,
} from './constants.js';

// ------------------------------------------------------------------
// Batas total per pengguna (S7, arsitektur §4.3) + kuota (Blue 5)
//
// S7 memakai COUNT(*) per push untuk cek batas. Red 5 (S9)
// membuktikan COUNT itu membuka pembakaran kuota BACA: pengguna
// di batas suka (10.000) membuat tiap push memindai 20.000 baris
// (COUNT + fetchKeys tanpa batas), kuota 5 juta baris/hari habis
// ~8 menit dari satu akun. Blue 5 mengganti kedua sumber baca
// tak terbatas itu:
//   (a) cek batas memakai TABEL PENGHITUNG sync_counts (migrasi
//       0005): 1 baris baca per koleksi per push (lookup PK),
//       diperbarui di batch yang sama dengan upsert, SEBELUM
//       upsert — supaya arah melencengnya AMAN: penghitung yang
//       terlalu tinggi hanya menolak penambahan sah, tidak pernah
//       mengizinkan pelampauan batas.
//   (b) cek kunci-yang-sudah-ada memakai query TERBATAS: hanya
//       kunci dari entri yang didorong (IN (...), maks 100),
//       bukan seluruh koleksi. Baca probe <= jumlah entri di body.
// Keduanya diikat ke anggaran tulis harian S8: tiap entri di body
// membebani anggaran, jadi baca per push tidak bisa dimaksimalkan
// tanpa menghabiskan anggaran — aritmetika lengkap di
// docs/blue5-red5-fixes.md (satu penyerang paling banyak ~6%
// kuota baca per hari). Bila tabel 0005 belum termigrasi, kode
// fail-open ke jalur COUNT S7 (sementara, sampai koordinator
// menerapkan 0005) supaya sync tidak mati total.
// ------------------------------------------------------------------

/**
 * Jumlah baris milik pengguna di satu tabel, TERMASUK
 * tombstone: tombstone tetap baris yang memakan kuota, dan
 * menghitungnya menutup putaran hapus-buat-ulang yang
 * membakar kuota tulis tanpa henti. Dipakai rekonsiliasi
 * penghitung (S9) + jalur fallback bila tabel 0005 belum ada.
 */
export async function countUserRows(db, table, userId) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
    .bind(userId)
    .first();
  return row ? Number(row.n) : 0;
}

/** Jumlah item di SATU playlist milik pengguna (rekonsiliasi). */
export async function countItemsForPlaylist(db, playlistId, userId) {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM sync_playlist_items WHERE playlist_id = ? AND user_id = ?',
    )
    .bind(playlistId, userId)
    .first();
  return row ? Number(row.n) : 0;
}

/**
 * Jumlah item per playlist untuk playlist-playlist yang disentuh
 * push (jalur fallback S7). Difilter user_id milik pendorong
 * (I20): hitungan cap tidak pernah menyentuh baris orang lain.
 */
export async function countItemsPerPlaylist(db, userId, playlistIds) {
  const out = new Map();
  if (playlistIds.length === 0) return out;
  const marks = playlistIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT playlist_id, COUNT(*) AS n FROM sync_playlist_items WHERE user_id = ? AND playlist_id IN (${marks}) GROUP BY playlist_id`,
    )
    .bind(userId, ...playlistIds)
    .all();
  for (const r of rows.results || []) {
    out.set(r.playlist_id, Number(r.n));
  }
  return out;
}

/** Baca penghitung skalar (playlists/likes/history): 1 baris per koleksi. */
export async function readScalarCounters(db, userId, collections) {
  const out = new Map();
  if (collections.length === 0) return out;
  const marks = collections.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT collection, n, updated_at FROM sync_counts WHERE user_id = ? AND playlist_id = '' AND collection IN (${marks})`,
    )
    .bind(userId, ...collections)
    .all();
  for (const r of rows.results || []) {
    out.set(r.collection, { n: Number(r.n), updatedAt: Number(r.updated_at) });
  }
  return out;
}

/** Baca penghitung item per playlist: 1 baris per playlist yang disentuh. */
export async function readItemCounters(db, userId, playlistIds) {
  const out = new Map();
  if (playlistIds.length === 0) return out;
  const marks = playlistIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT playlist_id, n, updated_at FROM sync_counts WHERE user_id = ? AND collection = 'items' AND playlist_id IN (${marks})`,
    )
    .bind(userId, ...playlistIds)
    .all();
  for (const r of rows.results || []) {
    out.set(r.playlist_id, { n: Number(r.n), updatedAt: Number(r.updated_at) });
  }
  return out;
}

/**
 * Simpan nilai penghitung hasil rekonsiliasi. Optimistic
 * concurrency (I21): COUNT + store adalah dua pernyataan, dan
 * bump push bersamaan yang mendarat di antaranya membuat nilai
 * COUNT basi — menimpanya begitu saja MENURUNKAN penghitung di
 * bawah jumlah nyata dan melonggarkan cap (~100 baris per
 * kejadian, terbukti Red 6 di SQLite).
 *   - Bila baris dibaca sebelumnya (expected terisi): simpan
 *     HANYA bila nilai tersimpan belum bergerak sejak dibaca
 *     (WHERE n = ? AND updated_at = ?). Bila CAS gagal (0 baris
 *     berubah), jangan timpa: satu pernyataan MAX atomik
 *     menyimpan max(nilai tersimpan, nilai hitung) — arah
 *     melenceng AMAN (penghitung terlalu tinggi hanya menolak
 *     penambahan sah, tidak pernah mengizinkan pelampauan batas).
 *     DIPILIH MAX + satu percobaan ulang implisit ini (bukan
 *     baca-ulang + hitung-ulang): COUNT ulang sesudah CAS gagal
 *     membuka lagi jendela race yang sama tanpa batas, sementara
 *     MAX satu pernyataan bersifat atomik dan langsung benar
 *     (nilai tersimpan sudah mencakup bump yang menyela; bila
 *     COUNT lebih besar — mis. baris dibuat tanpa bump — MAX
 *     memakai COUNT).
 *   - Bila baris belum ada saat dibaca (expected null): INSERT
 *     biasa; bila baris tercipta di antaranya (bump push lain),
 *     ON CONFLICT memakai MAX yang sama (bump dipertahankan).
 * Koreksi drift ke bawah tetap jalan (CAS sukses menulis nilai
 * COUNT persis, mis. 5.000 -> 100) — hanya penimpaan nilai BASI
 * yang dicegah.
 */
export async function storeCount(db, userId, collection, playlistId, n, now, expected = null) {
  if (expected) {
    const res = await db
      .prepare(
        'INSERT INTO sync_counts (user_id, collection, playlist_id, n, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, collection, playlist_id) DO UPDATE SET n = excluded.n, updated_at = excluded.updated_at WHERE sync_counts.n = ? AND sync_counts.updated_at = ?',
      )
      .bind(userId, collection, playlistId, n, now, expected.n, expected.updatedAt)
      .run();
    if (res.meta?.changes === 1) return;
    await db
      .prepare(
        'UPDATE sync_counts SET n = MAX(n, ?), updated_at = ? WHERE user_id = ? AND collection = ? AND playlist_id = ?',
      )
      .bind(n, now, userId, collection, playlistId)
      .run();
    return;
  }
  await db
    .prepare(
      'INSERT INTO sync_counts (user_id, collection, playlist_id, n, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, collection, playlist_id) DO UPDATE SET n = MAX(sync_counts.n, excluded.n), updated_at = excluded.updated_at',
    )
    .bind(userId, collection, playlistId, n, now)
    .run();
}

/**
 * Hitung ulang satu penghitung dari data nyata (COUNT) lalu simpan.
 * Dipakai saat penghitung basi (n < 0, sesudah hapus riwayat massal),
 * melenceng di atas batas (n > cap + 30 — tidak mungkin tanpa drift,
 * karena guard R19 menahan jumlah nyata di dekat batas), atau sudah
 * tua (> 24 jam) saat sudah dekat batas (dalam 500 baris). Ketiganya
 * terbatas: basi hanya sesudah clear (<= 1/hari), melenceng hanya
 * sesudah race (butuh headroom, yang tidak kembali sesudah cap
 * tercapai kecuali lewat clear), tua hanya 1x/hari/koleksi dan hanya
 * bila sudah dekat batas. Lihat aritmetika di blue5-red5-fixes.md.
 * `row` adalah baris penghitung yang dibaca pemanggil (atau
 * undefined bila belum ada) — diteruskan ke storeCount sebagai
 * ekspektasi CAS (I21).
 */
export async function reconcileCount(db, userId, collection, playlistId, cap, now, row) {
  let n;
  if (collection === 'items') {
    n = await countItemsForPlaylist(db, playlistId, userId);
  } else if (collection === 'playlists') {
    n = await countUserRows(db, 'sync_playlists', userId);
  } else if (collection === 'likes') {
    n = await countUserRows(db, 'sync_likes', userId);
  } else {
    n = await countUserRows(db, 'sync_history', userId);
  }
  await storeCount(db, userId, collection, playlistId, n, now, row || null);
  return n;
}

/**
 * Selesaikan nilai hitung untuk satu koleksi dari baris
 * penghitungnya. Baris tidak ada = hitung sekali + simpan
 * (pengguna/playlist baru memindai 0 baris; pengguna lama yang
 * lolos backfill — baris yang tercipta di jendela antara migrasi
 * 0005 dan deploy Worker — dikoreksi). Penyimpanan membuat COUNT
 * ini terjadi paling banyak sekali per (pengguna, koleksi /
 * playlist) selamanya; tulis simpannya ditagih ke anggaran S8
 * lewat tunjangan pembukuan di handlePush.
 */
export async function resolveCount(
  db,
  userId,
  collection,
  playlistId,
  cap,
  row,
  now,
) {
  if (!row) {
    return reconcileCount(db, userId, collection, playlistId, cap, now, undefined);
  }
  const stale = row.n < 0;
  const overCap = row.n > cap + COUNTER_RECONCILE_OVER_CAP_SLACK;
  const oldNearCap =
    now - row.updatedAt > COUNTER_RECONCILE_MAX_AGE_MS &&
    row.n > cap - COUNTER_RECONCILE_NEAR_CAP;
  if (stale || overCap || oldNearCap) {
    return reconcileCount(db, userId, collection, playlistId, cap, now, row);
  }
  return row.n;
}

/**
 * Saring entri push ke yang muat dalam batas total. Probe kunci
 * SELALU jalan (S9: query TERBATAS — hanya kunci dari entri yang
 * didorong, maks 100) supaya klasifikasi baru-vs-update eksak:
 * klasifikasi itu menentukan delta penghitung + guard R19.
 * Hanya entri BARU yang memakan headroom; duplikat kunci dalam
 * satu push dihitung sekali (yang kedua adalah update).
 * Mengembalikan { kept, newKeys, added, skipped }.
 */
export async function capNewEntries({ count, cap, entries, keyOf, fetchExisting }) {
  const seen = new Set();
  const unique = [];
  for (const e of entries) {
    const k = keyOf(e);
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(e);
    }
  }
  const existing = new Set(await fetchExisting(unique));
  const kept = [];
  const newKeys = new Set();
  let room = cap - count;
  let added = 0;
  let skipped = 0;
  for (const e of entries) {
    const key = keyOf(e);
    if (existing.has(key)) {
      kept.push(e); // Update entri lama: bukan penambahan.
      continue;
    }
    if (room > 0) {
      room -= 1;
      existing.add(key);
      newKeys.add(key);
      added += 1;
      kept.push(e);
    } else {
      skipped += 1;
    }
  }
  return { kept, newKeys, added, skipped };
}
