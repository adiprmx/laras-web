// Worker sync — Tombstone identitas terhapus + sapu tombstone lama (P-SyncSplit).
// Dipindah verbatim dari index.js (P-SyncSplit); logika
// tidak berubah. Impor di bawah dihitung dari graf
// dependensi, bukan tebakan.

import { sha256Hex } from './util.js';
import {
  DAILY_WRITE_BUDGET,
  RE_REGISTER_COOLDOWN_MAX_DAYS,
  RE_REGISTER_COOLDOWN_MS,
  RE_REGISTER_COOLDOWN_ROWS_FREE,
  RE_REGISTER_COOLDOWN_ROWS_PER_DAY,
  TOMBSTONE_PRUNE_AGE_MS,
  TOMBSTONE_PRUNE_MAX_ROWS_PER_PUSH,
  TOMBSTONE_PRUNE_PER_PUSH,
} from './constants.js';
import { logWarn } from '../../shared/log.js';

// ------------------------------------------------------------------
// Tombstone identitas terhapus (Blue 6, Red 6 S10)
//
// Anggaran tulis + stempel clear terikat `user_id`, sementara
// identitas itu bisa didaur ulang gratis (hapus akun + daftar
// lagi = UUID baru + anggaran penuh). Satu manusia + satu akun
// Google menguras kuota tulis 100.000 dalam 6-10 menit.
// Perbaikan berlapis:
//   (a) rate limit ketat di /api/auth/delete (router);
//   (b) anggaran + stempel diikat ke IDENTITAS provider yang
//       stabil (hash provider+provider_id) lewat tombstone:
//       daftar ulang mewarisi pemakaian + stempel lama;
//   (c) cooldown daftar ulang 24 jam (daftar ulang dalam masa
//       cooldown DITOLAK dengan pesan jelas).
// PRIVASI: tombstone HANYA menyimpan hash identitas + angka
// (waktu hapus, pemakaian anggaran, stempel clear) — tanpa nama,
// email, atau data pengguna apa pun. Hapus akun tetap
// benar-benar menghapus data pribadi; hash satu arah tidak bisa
// dipakai memulihkan provider_id.
// Fail-open: bila tabel 0006 belum termigrasi, baca/tulis
// tombstone gagal diam-diam dan alur kembali ke perilaku Blue 5
// (koordinator WAJIB menerapkan 0006 sebelum deploy).
// ------------------------------------------------------------------

/** Hash identitas stabil: SHA-256 dari "provider:provider_id". */
export async function identityHashFor(provider, providerId) {
  return sha256Hex(`${provider}:${providerId}`);
}

/**
 * Cooldown daftar ulang sebanding ukuran akun (Blue 7, S13):
 * 24 jam + 1 hari per 20.000 baris di atas 20.000, maks 30 hari.
 * Akun normal (<=20.000 baris) tetap 24 jam; akun penuh ~111.210
 * baris mendapat 6 hari (24 jam + 5 hari). Baris 0 / tidak ada
 * (tombstone pra-0007) berarti 24 jam.
 */
export function reRegisterCooldownMs(deletedRows) {
  const extra = Math.max(0, (deletedRows || 0) - RE_REGISTER_COOLDOWN_ROWS_FREE);
  const extraDays = Math.ceil(extra / RE_REGISTER_COOLDOWN_ROWS_PER_DAY);
  const days = Math.min(1 + extraDays, RE_REGISTER_COOLDOWN_MAX_DAYS);
  return days * RE_REGISTER_COOLDOWN_MS;
}

/** Baca tombstone identitas; null bila tidak ada / tabel belum ada. */
export async function readDeletedIdentity(env, identityHash) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT deleted_at, budget_day, budget_rows, read_rows, history_cleared_at, deleted_rows FROM sync_deleted_identities WHERE identity_hash = ?',
    )
      .bind(identityHash)
      .first();
    if (!row) return null;
    return {
      deletedAt: Number(row.deleted_at),
      budgetDay: String(row.budget_day),
      budgetRows: Number(row.budget_rows),
      readRows: Number(row.read_rows),
      historyClearedAt:
        row.history_cleared_at === null || row.history_cleared_at === undefined
          ? null
          : Number(row.history_cleared_at),
      // Blue 7 (S13): baris yang dihapus akun itu (migrasi 0007).
      // Tombstone pra-0007 tidak punya kolom ini (fail-open: 0
      // berarti cooldown dasar 24 jam).
      deletedRows: Number(row.deleted_rows ?? 0),
    };
  } catch (e) {
    logWarn('tombstone identitas: gagal baca (fail-open, daftar diizinkan)', { error: e instanceof Error ? e.message : 'unknown' });
    return null;
  }
}

/**
 * Wariskan anggaran + stempel dari tombstone ke akun baru
 * (S10b), lalu konsumsi tombstone (hapus) supaya tidak dipakai
 * dua kali. Pemakaian anggaran hanya diwariskan bila tombstone
 * dari hari UTC yang SAMA — sesudah cooldown 24 jam hari selalu
 * sudah berganti, jadi cabang ini hanya jalan bila cooldown
 * gagal ditegakkan (pertahanan berlapis). Stempel clear selalu
 * diwariskan (bila lebih tua dari 24 jam, gerbang S8a toh
 * mengizinkan clear berikutnya). Best-effort: gagal restore =
 * anggaran segar (fail-open; cooldown sudah bekerja utama).
 */
export async function restoreFromTombstone(env, userId, identityHash, tombstone, now) {
  try {
    const day = new Date(now).toISOString().slice(0, 10);
    const stmts = [];
    if (tombstone.budgetDay === day && tombstone.budgetRows > 0) {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO sync_write_budget (user_id, day, rows_written) VALUES (?, ?, ?)',
        ).bind(userId, day, tombstone.budgetRows),
      );
    }
    if (tombstone.budgetDay === day && tombstone.readRows > 0) {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO sync_read_budget (user_id, day, rows_read) VALUES (?, ?, ?)',
        ).bind(userId, day, tombstone.readRows),
      );
    }
    if (tombstone.historyClearedAt !== null) {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO sync_user_meta (user_id, history_cleared_at) VALUES (?, ?)',
        ).bind(userId, tombstone.historyClearedAt),
      );
    }
    stmts.push(
      env.DB.prepare(
        'DELETE FROM sync_deleted_identities WHERE identity_hash = ?',
      ).bind(identityHash),
    );
    await env.DB.batch(stmts);
  } catch (e) {
    logWarn('tombstone identitas: gagal wariskan (fail-open)', { error: e instanceof Error ? e.message : 'unknown' });
  }
}

/**
 * Sapu tombstone malas (I22, diperkuat Blue 7: S14 + I25 + I26):
 * hapus tombstone berumur >30 hari per koleksi yang disentuh push
 * ini, lalu kurangi penghitung koleksi itu sejumlah yang terhapus
 * (supaya cap kembali longgar — tombstone dihitung di sync_counts).
 * Hanya koleksi yang disentuh yang disapu: sapu memakai 1 SELECT
 * per koleksi, dan koleksi yang tidak didorong tidak butuh
 * dilonggarkan cap-nya.
 *
 * Blue 7 (S14): tulis sapu DITAGIH ke anggaran tulis — sesudah
 * sampling, biaya PERSIS (baris yang dihapus + UPDATE penghitung
 * + 1 upsert cadangan) dicadangkan secara atomik (upsert
 * berkondisi yang sama seperti reservasi push, SEBELUM DELETE
 * apa pun). Bila cadangan gagal (anggaran habis), sapu push ini
 * DILEWATI (tombstone menunggu besok; push sendiri tetap jalan).
 * Tanpa ini, stok tombstone 110.100 baris bisa disapu dalam
 * sehari tanpa anggaran (~210.200 tulis termasuk UPDATE
 * penghitung). Sesudah ini, invarian "semua tulis ditagih"
 * pulih penuh: total tulis per akun/hari kembali dibatasi
 * anggaran 20.000.
 *
 * Blue 7 (I25): decrement penghitung memakai `meta.changes` dari
 * DELETE (baris yang BENAR-BENAR terhapus), bukan ukuran sampel.
 * Dua push bersamaan yang menyampel tombstone yang sama tidak
 * lagi mengurangi dua kali (yang kalah balapan menghapus 0 baris
 * dan mengurangi 0). Item dihapus per playlist (satu DELETE per
 * playlist, lewat db.batch) supaya decrement per playlist eksak.
 *
 * Blue 7 (I26): cabang sapu playlist ikut menghapus ITEM dari
 * playlist yang disapu (item yatim: tidak pernah kembali lewat
 * pull, tidak pernah disapu cabang item, tidak terhapus saat
 * hapus akun) + mengurangi penghitung items per playlist.
 * Total baris yang disapu satu push dibatasi
 * TOMBSTONE_PRUNE_MAX_ROWS_PER_PUSH (1.000, termasuk item);
 * satu playlist penuh (1.000 item) selalu disapu utuh (1.001
 * baris) supaya tidak macet di cap.
 *
 * Mengembalikan jumlah baris yang disapu (0 bila tidak ada yang
 * disapu / cadangan gagal / sapu gagal). Best-effort total:
 * gagal sapu tidak menggagalkan push; penghitung yang tidak
 * dikurangi hanya kelebihan-hitung (arah aman). Cadangan yang
 * sudah sukses TIDAK di-refund bila eksekusi gagal di tengah
 * (sebagian baris sudah terhapus — refund penuh akan
 * kekurangan-tagih; arah kelebihan-tagih yang aman).
 */
export async function pruneOldTombstones(db, userId, now, day, collections) {
  const cutoff = now - TOMBSTONE_PRUNE_AGE_MS;
  try {
    // ---- Fase 1: sampling (tanpa tulis apa pun). ----
    // Playlist dulu: himpunan playlist yang disapu menentukan
    // sampel item (item dari playlist yang disapu ikut terhapus
    // cabang playlist, jadi tidak boleh ikut tersampel cabang
    // item — kalau tidak, biaya yang sama dihitung dua kali).
    let playlistIds = [];
    // playlistId -> jumlah item (hidup + tombstone) di playlist
    // yang disapu; dipakai cap + cadangan + decrement.
    const playlistItemCounts = new Map();
    if (collections.includes('playlists')) {
      const rows = await db
        .prepare(
          'SELECT id FROM sync_playlists WHERE user_id = ? AND deleted_at < ? LIMIT ?',
        )
        .bind(userId, cutoff, TOMBSTONE_PRUNE_PER_PUSH)
        .all();
      playlistIds = (rows.results || []).map((r) => r.id);
      if (playlistIds.length > 0) {
        const marks = playlistIds.map(() => '?').join(', ');
        const counts = await db
          .prepare(
            `SELECT playlist_id, COUNT(*) AS n FROM sync_playlist_items WHERE user_id = ? AND playlist_id IN (${marks}) GROUP BY playlist_id`,
          )
          .bind(userId, ...playlistIds)
          .all();
        for (const r of counts.results || []) {
          playlistItemCounts.set(r.playlist_id, Number(r.n));
        }
        // Cap total sapu: ambil playlist berurutan sampai total
        // baris (playlist + itemnya) mencapai cap; selalu ambil
        // minimal 1 supaya playlist penuh tidak macet.
        const taken = [];
        let takenRows = 0;
        for (const id of playlistIds) {
          const cost = 1 + (playlistItemCounts.get(id) ?? 0);
          if (
            taken.length > 0 &&
            takenRows + cost > TOMBSTONE_PRUNE_MAX_ROWS_PER_PUSH
          ) {
            break;
          }
          taken.push(id);
          takenRows += cost;
        }
        playlistIds = taken;
      }
    }
    let likeIds = [];
    if (collections.includes('likes')) {
      const rows = await db
        .prepare(
          'SELECT video_id FROM sync_likes WHERE user_id = ? AND deleted_at < ? LIMIT ?',
        )
        .bind(userId, cutoff, TOMBSTONE_PRUNE_PER_PUSH)
        .all();
      likeIds = (rows.results || []).map((r) => r.video_id);
    }
    let itemPairs = [];
    if (collections.includes('items')) {
      // Kecualikan item dari playlist yang disapu push ini
      // (sudah dihitung cabang playlist — lihat atas).
      const excludeMarks =
        playlistIds.length > 0
          ? ` AND playlist_id NOT IN (${playlistIds.map(() => '?').join(', ')})`
          : '';
      const rows = await db
        .prepare(
          `SELECT playlist_id, video_id FROM sync_playlist_items WHERE user_id = ? AND deleted_at < ?${excludeMarks} LIMIT ?`,
        )
        .bind(userId, cutoff, ...playlistIds, TOMBSTONE_PRUNE_PER_PUSH)
        .all();
      itemPairs = rows.results || [];
    }
    // Cap sisa untuk suka + item (playlist sudah dicap di atas).
    let playlistRows = playlistIds.length;
    for (const id of playlistIds) {
      playlistRows += playlistItemCounts.get(id) ?? 0;
    }
    let remaining = TOMBSTONE_PRUNE_MAX_ROWS_PER_PUSH - playlistRows;
    if (remaining < 0) remaining = 0;
    likeIds = likeIds.slice(0, remaining);
    remaining -= likeIds.length;
    itemPairs = itemPairs.slice(0, remaining);

    // ---- Fase 2: biaya PERSIS + cadangan atomik (S14). ----
    // hapus = tombstone playlist + itemnya + tombstone suka +
    // tombstone item; UPDATE = 1 per penghitung yang disentuh
    // (playlist 1 + items per playlist yang disapu + suka 1 +
    // items per playlist cabang item); +1 = upsert cadangan ini
    // sendiri (satu baris tulis, seperti tunjangan push S8b).
    const itemPlaylists = new Set(itemPairs.map((r) => r.playlist_id));
    let sweptWithItems = 0;
    for (const id of playlistIds) {
      if ((playlistItemCounts.get(id) ?? 0) > 0) sweptWithItems += 1;
    }
    const deletes =
      playlistRows + likeIds.length + itemPairs.length;
    const updates =
      (playlistIds.length > 0 ? 1 : 0) +
      sweptWithItems +
      (likeIds.length > 0 ? 1 : 0) +
      itemPlaylists.size;
    const sweepCharge = deletes + updates + 1;
    if (deletes === 0) return 0;
    const reserve = await db
      .prepare(
        'INSERT INTO sync_write_budget (user_id, day, rows_written) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET rows_written = sync_write_budget.rows_written + excluded.rows_written WHERE sync_write_budget.rows_written + excluded.rows_written <= ?',
      )
      .bind(userId, day, sweepCharge, DAILY_WRITE_BUDGET)
      .run();
    if (reserve.meta?.changes !== 1) {
      // Anggaran habis: lewati sapu push ini (tombstone menunggu
      // besok). Push sendiri TETAP jalan — sapu adalah optimasi
      // cap, bukan bagian dari data push.
      return 0;
    }

    // ---- Fase 3: eksekusi (decrement pakai meta.changes, I25). ----
    let swept = 0;
    if (playlistIds.length > 0) {
      const marks = playlistIds.map(() => '?').join(', ');
      const del = await db
        .prepare(
          `DELETE FROM sync_playlists WHERE user_id = ? AND id IN (${marks})`,
        )
        .bind(userId, ...playlistIds)
        .run();
      const deletedPlaylists = del.meta?.changes ?? 0;
      swept += deletedPlaylists;
      // I26a: hapus item dari playlist yang disapu (per playlist,
      // supaya decrement penghitung items per playlist eksak).
      const withItems = playlistIds.filter(
        (id) => (playlistItemCounts.get(id) ?? 0) > 0,
      );
      if (withItems.length > 0) {
        const results = await db.batch(
          withItems.map((id) =>
            db
              .prepare(
                'DELETE FROM sync_playlist_items WHERE user_id = ? AND playlist_id = ?',
              )
              .bind(userId, id),
          ),
        );
        for (let i = 0; i < withItems.length; i++) {
          const n = results[i]?.meta?.changes ?? 0;
          swept += n;
          if (n > 0) {
            await db
              .prepare(
                'UPDATE sync_counts SET n = MAX(0, n - ?), updated_at = ? WHERE user_id = ? AND collection = ? AND playlist_id = ?',
              )
              .bind(n, now, userId, 'items', withItems[i])
              .run();
          }
        }
      }
      if (deletedPlaylists > 0) {
        await db
          .prepare(
            'UPDATE sync_counts SET n = MAX(0, n - ?), updated_at = ? WHERE user_id = ? AND collection = ? AND playlist_id = ?',
          )
          .bind(deletedPlaylists, now, userId, 'playlists', '')
          .run();
      }
    }
    if (likeIds.length > 0) {
      const marks = likeIds.map(() => '?').join(', ');
      const del = await db
        .prepare(
          `DELETE FROM sync_likes WHERE user_id = ? AND video_id IN (${marks})`,
        )
        .bind(userId, ...likeIds)
        .run();
      const deletedLikes = del.meta?.changes ?? 0;
      swept += deletedLikes;
      if (deletedLikes > 0) {
        await db
          .prepare(
            'UPDATE sync_counts SET n = MAX(0, n - ?), updated_at = ? WHERE user_id = ? AND collection = ? AND playlist_id = ?',
          )
          .bind(deletedLikes, now, userId, 'likes', '')
          .run();
      }
    }
    if (itemPairs.length > 0) {
      // Satu DELETE per playlist (lewat db.batch = satu round
      // trip) supaya decrement per playlist memakai meta.changes
      // yang PERSIS (I25), bukan alokasi dari total.
      const byPlaylist = new Map();
      for (const r of itemPairs) {
        const list = byPlaylist.get(r.playlist_id) || [];
        list.push(r.video_id);
        byPlaylist.set(r.playlist_id, list);
      }
      const playlistList = [...byPlaylist.keys()];
      const results = await db.batch(
        playlistList.map((pid) => {
          const vids = byPlaylist.get(pid);
          const marks = vids.map(() => '(?, ?)').join(', ');
          const binds = vids.flatMap((vid) => [pid, vid]);
          return db
            .prepare(
              `DELETE FROM sync_playlist_items WHERE user_id = ? AND (playlist_id, video_id) IN (${marks})`,
            )
            .bind(userId, ...binds);
        }),
      );
      for (let i = 0; i < playlistList.length; i++) {
        const n = results[i]?.meta?.changes ?? 0;
        swept += n;
        if (n > 0) {
          await db
            .prepare(
              'UPDATE sync_counts SET n = MAX(0, n - ?), updated_at = ? WHERE user_id = ? AND collection = ? AND playlist_id = ?',
            )
            .bind(n, now, userId, 'items', playlistList[i])
            .run();
        }
      }
    }
    return swept;
  } catch (e) {
    // Best-effort: sapu gagal (mis. tabel 0006 belum ada / D1
    // sesaat) tidak menggagalkan push; penghitung yang tidak
    // dikurangi hanya kelebihan-hitung (arah aman).
    logWarn('sapu tombstone: gagal (best-effort)', { error: e instanceof Error ? e.message : 'unknown' });
    return 0;
  }
}
