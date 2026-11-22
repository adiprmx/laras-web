// Worker sync — Sync dorong /api/sync/push (P-SyncSplit).
// Dipindah verbatim dari index.js (P-SyncSplit); logika
// tidak berubah. Impor di bawah dihitung dari graf
// dependensi, bukan tebakan. Validasi body tinggal di
// contract.js (P-Types) — bukan di sini lagi.

import { jsonOk, secondsUntilMidnightUtc } from './util.js';
import {
  capNewEntries,
  countItemsPerPlaylist,
  countUserRows,
  readItemCounters,
  readScalarCounters,
  resolveCount,
} from './counters.js';
import { failCountsUnavailable, refundWriteBudget } from './budgets.js';
import { pruneOldTombstones } from './tombstones.js';
// Kontrak (P-Types): validator push tinggal di contract.js —
// satu sumber kebenaran dengan app (syncClient.ts).
import { validatePushBody } from './contract.js';
import {
  DAILY_WRITE_BUDGET,
  HISTORY_CLEAR_MIN_INTERVAL_MS,
  MAX_HISTORY_PER_USER,
  MAX_ITEMS_PER_PLAYLIST,
  MAX_LIKES_PER_USER,
  MAX_PLAYLISTS_PER_USER,
} from './constants.js';
import { MAX_BODY_BYTES, jsonError, readCapped } from '../../shared/http.js';
import { logWarn } from '../../shared/log.js';

// ------------------------------------------------------------------
// Sync: dorong
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Helper push Blue 6 (S12a pra-cek anggaran, I23 refund, I22 sapu)
// ------------------------------------------------------------------

/**
 * Baca + validasi body push. Dipanggil router SEBELUM rate limit
 * (S12a) supaya pra-cek anggaran memakai tagihan persis push ini:
 * tanpa ini, push yang pasti ditolak anggaran tetap menulis baris
 * rate-limit (43.200 baris/hari/akun di luar anggaran 20.000).
 * Mengembalikan { body } atau { error } (Response 400/413).
 */
export async function parsePushBody(request) {
  const declaredLen = Number(request.headers.get('Content-Length') || 0);
  if (declaredLen > MAX_BODY_BYTES) {
    return { error: jsonError(413, 'BODY_TOO_BIG', 'Body request melewati 1 MB') };
  }
  const read = request.body
    ? await readCapped(request.body, MAX_BODY_BYTES)
    : { tooBig: false, bytes: new Uint8Array(0) };
  if (read.tooBig) {
    return { error: jsonError(413, 'BODY_TOO_BIG', 'Body request melewati 1 MB') };
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch {
    return { error: jsonError(400, 'BAD_JSON', 'Body bukan JSON yang valid') };
  }
  const invalid = validatePushBody(body);
  if (invalid) return { error: jsonError(400, 'INVALID_BODY', invalid) };
  return { body };
}

/**
 * Tagihan anggaran tulis satu push, dari ISI BODY (lihat S8b).
 * clearBillable: true bila DELETE hapus-riwayat ditagih 1.000
 * (router memakai batas atas — clear diminta; handlePush memakai
 * nilai persis — clear dihonori). Selalu ditambah 1 untuk baris
 * rate-limit push ini (S12a). Tagihan maks per push 1.911
 * (700 + 1 + 1.000 + 2x(3+100) + 3 + 1).
 */
export function computePushCharge(body, clearBillable) {
  const playlistsIn = body.playlists || [];
  const itemsIn = body.playlistItems || [];
  const likesIn = body.likes || [];
  const historyIn = body.history || [];
  const deletedPlaylistsIn = body.deletedPlaylists || [];
  const deletedItemsIn = body.deletedPlaylistItems || [];
  const deletedLikesIn = body.deletedLikes || [];
  const nonEmptyScalar =
    (playlistsIn.length > 0 ? 1 : 0) +
    (likesIn.length > 0 ? 1 : 0) +
    (historyIn.length > 0 ? 1 : 0);
  const distinctItemPlaylists = new Set(
    itemsIn.map((i) => i.playlistClientId),
  ).size;
  return (
    playlistsIn.length +
    itemsIn.length +
    likesIn.length +
    historyIn.length +
    deletedPlaylistsIn.length +
    deletedItemsIn.length +
    deletedLikesIn.length +
    (body.settings ? 1 : 0) +
    (clearBillable ? MAX_HISTORY_PER_USER : 0) +
    2 * (nonEmptyScalar + distinctItemPlaylists) +
    3 +
    1
  );
}

export async function handlePush(env, user, body) {
  const db = env.DB;
  // Satu stempel server untuk seluruh push (protokol S8:
  // updated_at dari server, bukan jam perangkat).
  const now = Date.now();
  const deviceId = body.deviceId;
  const stmts = [];
  const playlistsIn = body.playlists || [];
  const itemsIn = body.playlistItems || [];
  const likesIn = body.likes || [];
  const historyIn = body.history || [];
  const deletedPlaylistsIn = body.deletedPlaylists || [];
  const deletedItemsIn = body.deletedPlaylistItems || [];
  const deletedLikesIn = body.deletedLikes || [];

  // ---- S8a: gerbang frekuensi hapus riwayat (maks 1x per 24 jam).
  // Riwayat satu-satunya koleksi tanpa tombstone: tanpa gerbang
  // ini satu push memasukkan 100 baris lalu DELETE keras menghapus
  // semuanya, dan COUNT push berikutnya selalu 0 — putaran
  // hapus-buat-ulang menguras kuota tulis bersama dalam 17-33
  // menit. Clear yang terlalu sering DIABAIKAN dengan respons
  // jelas (bukan diam-diam): klien menyimpan penandanya dan
  // mencoba lagi di sinkronisasi berikut.
  const clearRequested =
    body.historyClearedBefore !== undefined &&
    body.historyClearedBefore !== null;
  let clearHonored = false;
  let clearRetryAfterSeconds = 0;
  let metaWritable = false; // true bila tabel meta terbukti ada
  if (clearRequested) {
    try {
      const row = await db
        .prepare(
          'SELECT history_cleared_at FROM sync_user_meta WHERE user_id = ?',
        )
        .bind(user.id)
        .first();
      metaWritable = true;
      const last = row ? Number(row.history_cleared_at) : 0;
      if (now - last >= HISTORY_CLEAR_MIN_INTERVAL_MS) {
        clearHonored = true;
      } else {
        clearRetryAfterSeconds = Math.ceil(
          (last + HISTORY_CLEAR_MIN_INTERVAL_MS - now) / 1000,
        );
      }
    } catch (e) {
      logWarn('history clear: gagal baca stempel, clear diizinkan', { error: e instanceof Error ? e.message : 'unknown' });
      clearHonored = true; // Fail-open: tabel belum termigrasi.
    }
  }

  // ---- S8b: anggaran tulis harian per akun (atomik, §4.3).
  // Tagihan dihitung dari ISI BODY (bukan dari pernyataan yang
  // lolos cap): entri yang dilewati cap / bukan milik pendorong
  // TETAP ditagih, supaya penyerang tidak bisa memakai push
  // "gratis" untuk membakar kuota BACA (S9) lewat probe kunci +
  // cek kepemilikan. DELETE hapus-riwayat ditagih sebesar
  // MAKSIMUM baris yang bisa dihapusnya (1.000) karena jumlah
  // pastinya baru diketahui sesudah dieksekusi. Tunjangan
  // pembukuan menutup tulis yang BUKAN entri: per koleksi yang
  // disentuh paling banyak 1 increment penghitung + 1 simpan
  // rekonsiliasi (2x jumlah koleksi), + 3 untuk sentinel clear,
  // stempel meta, dan upsert cadangan anggaran itu sendiri,
  // + 1 untuk baris rate-limit push ini (S12a).
  // Dengan tunjangan ini tagihan TIDAK PERNAH kurang dari tulis
  // sebenarnya yang ditimbulkan push (maks 1.911/push).
  // Cadangan bersifat atomik (satu upsert berkondisi): push
  // bersamaan tidak bisa sama-sama lolos sesudah anggaran habis.
  const charge = computePushCharge(body, clearHonored);
  // Tagihan selalu >= 4 (tunjangan pembukuan + baris rate-limit),
  // jadi cadangan selalu jalan — termasuk push kosong, supaya
  // push kosong pun tidak bisa dipakai membakar kuota baca tanpa
  // batas.
  const day = new Date(now).toISOString().slice(0, 10);
  // Reservasi yang berhasil (0 bila fail-open): dipakai refund
  // I23b bila push gagal sesudah titik ini.
  let reservedCharge = 0;
  try {
    const res = await db
      .prepare(
        'INSERT INTO sync_write_budget (user_id, day, rows_written) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET rows_written = sync_write_budget.rows_written + excluded.rows_written WHERE sync_write_budget.rows_written + excluded.rows_written <= ?',
      )
      .bind(user.id, day, charge, DAILY_WRITE_BUDGET)
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
    reservedCharge = charge;
  } catch (e) {
    logWarn('anggaran tulis: gagal cadang, push diizinkan', { error: e instanceof Error ? e.message : 'unknown' });
  }

  // ---- I22: sapu tombstone malas (SEBELUM fase cap, supaya cap
  // memakai penghitung yang sudah dikurangi). Hanya koleksi yang
  // disentuh push ini (lihat pruneOldTombstones). Blue 7 (S14):
  // sapu ditagih ke anggaran lewat cadangan atomik di dalam
  // prune; bila cadangan gagal, sapu dilewati dan push tetap
  // jalan (prunedRows 0). Jumlah yang disapu dilaporkan di
  // respons untuk observabilitas.
  const touchedCollections = [];
  if (playlistsIn.length > 0 || deletedPlaylistsIn.length > 0) {
    touchedCollections.push('playlists');
  }
  if (likesIn.length > 0 || deletedLikesIn.length > 0) {
    touchedCollections.push('likes');
  }
  if (itemsIn.length > 0 || deletedItemsIn.length > 0) {
    touchedCollections.push('items');
  }
  let prunedRows = 0;
  if (touchedCollections.length > 0) {
    prunedRows = await pruneOldTombstones(
      db,
      user.id,
      now,
      day,
      touchedCollections,
    );
  }

  // ---- S7 + S9: tegakkan batas TOTAL per pengguna (§4.3)
  // SEBELUM membangun pernyataan upsert. Kelebihan DILEWATI per
  // koleksi dan dilaporkan di respons (bukan gagal diam-diam,
  // bukan gagal total — sisa push yang sah tetap diterapkan).
  // Tombstone tidak pernah ditolak batas: tombstone memakai
  // UPDATE yang hanya menyentuh baris yang sudah ada (lihat
  // bawah), jadi tidak bisa menambah baris.
  const skippedOverLimit = {
    playlists: 0,
    playlistItems: 0,
    likes: 0,
    history: 0,
  };
  // Klasifikasi baru-vs-update per koleksi (untuk delta
  // penghitung + guard R19); diisi fase cap di bawah.
  let playlistNewKeys = new Set();
  let playlistAdded = 0;
  let likesNewKeys = new Set();
  let likesAdded = 0;
  let historyNewKeys = new Set();
  let historyAdded = 0;
  const itemNewKeys = new Map(); // playlistId -> Set<videoId>
  const itemAdded = new Map(); // playlistId -> jumlah entri baru
  // Hitungan batas: dari penghitung (S9), atau COUNT (fallback
  // S7 bila tabel 0005 belum termigrasi).
  let countersOk = true;
  let playlistCount = 0;
  let likesCount = 0;
  let historyCount = 0;
  const needScalar = [
    ...(playlistsIn.length > 0 ? ['playlists'] : []),
    ...(likesIn.length > 0 ? ['likes'] : []),
    ...(historyIn.length > 0 ? ['history'] : []),
  ];
  try {
    const rows = await readScalarCounters(db, user.id, needScalar);
    if (playlistsIn.length > 0) {
      playlistCount = await resolveCount(
        db,
        user.id,
        'playlists',
        '',
        MAX_PLAYLISTS_PER_USER,
        rows.get('playlists'),
        now,
      );
    }
    if (likesIn.length > 0) {
      likesCount = await resolveCount(
        db,
        user.id,
        'likes',
        '',
        MAX_LIKES_PER_USER,
        rows.get('likes'),
        now,
      );
    }
    if (historyIn.length > 0) {
      historyCount = await resolveCount(
        db,
        user.id,
        'history',
        '',
        MAX_HISTORY_PER_USER,
        rows.get('history'),
        now,
      );
    }
  } catch (e) {
    // Tabel penghitung belum ada (0005 belum diterapkan):
    // fail-open ke COUNT S7 supaya sync tetap jalan. S9 kembali
    // terbuka di jendela ini — koordinator WAJIB menerapkan 0005
    // sebelum deploy (lihat README + migrasi 0005).
    logWarn('penghitung: gagal baca, fallback ke COUNT', { error: e instanceof Error ? e.message : 'unknown' });
    countersOk = false;
    try {
      [playlistCount, likesCount, historyCount] = await Promise.all([
        playlistsIn.length > 0
          ? countUserRows(db, 'sync_playlists', user.id)
          : 0,
        likesIn.length > 0 ? countUserRows(db, 'sync_likes', user.id) : 0,
        historyIn.length > 0
          ? countUserRows(db, 'sync_history', user.id)
          : 0,
      ]);
    } catch (e2) {
      // I23a: COUNT juga gagal (D1 mati sesaat) — tolak dengan
      // 500 yang JELAS + kembalikan anggaran (bukan 500 generik
      // sesudah anggaran dipotong).
      return failCountsUnavailable(db, user.id, day, reservedCharge);
    }
  }
  // I24: fase cap/probe dibungkus try/catch — bila satu query
  // probe (fetchExisting / playlistOwned) melempar galat D1
  // transien SESUDAH reservasi anggaran, push gagal dengan 500
  // yang JELAS + anggaran dikembalikan (pola I23 yang sama
  // persis), bukan 500 generik tanpa refund. skippedNotOwned
  // dideklarasikan di luar try karena dipakai respons di bawah.
  let skippedNotOwned = 0;
  try {
    if (playlistsIn.length > 0) {
      const result = await capNewEntries({
        count: playlistCount,
        cap: MAX_PLAYLISTS_PER_USER,
        entries: playlistsIn,
        keyOf: (p) => p.clientId,
        // S9: hanya cek kunci yang didorong (maks 100), bukan
        // seluruh koleksi milik pengguna.
        fetchExisting: async (unique) => {
          const marks = unique.map(() => '?').join(', ');
          const rows = await db
            .prepare(
              `SELECT client_id FROM sync_playlists WHERE user_id = ? AND client_id IN (${marks})`,
            )
            .bind(
              user.id,
              ...unique.map((p) => p.clientId),
            )
            .all();
          return (rows.results || []).map((r) => r.client_id);
        },
      });
      body.playlists = result.kept;
      skippedOverLimit.playlists = result.skipped;
      playlistNewKeys = result.newKeys;
      playlistAdded = result.added;
    }
    // Cap item ada di bawah (sesudah cek kepemilikan, I20):
    // hitungan cap tidak boleh menyentuh playlist orang lain.
    if (likesIn.length > 0) {
      const result = await capNewEntries({
        count: likesCount,
        cap: MAX_LIKES_PER_USER,
        entries: likesIn,
        keyOf: (l) => l.videoId,
        // S9: hanya cek kunci yang didorong (maks 100).
        fetchExisting: async (unique) => {
          const marks = unique.map(() => '?').join(', ');
          const rows = await db
            .prepare(
              `SELECT video_id FROM sync_likes WHERE user_id = ? AND video_id IN (${marks})`,
            )
            .bind(
              user.id,
              ...unique.map((l) => l.videoId),
            )
            .all();
          return (rows.results || []).map((r) => r.video_id);
        },
      });
      body.likes = result.kept;
      skippedOverLimit.likes = result.skipped;
      likesNewKeys = result.newKeys;
      likesAdded = result.added;
    }
    if (historyIn.length > 0) {
      const result = await capNewEntries({
        count: historyCount,
        cap: MAX_HISTORY_PER_USER,
        entries: historyIn,
        keyOf: (h) => `${h.videoId}|${h.playedAt}`,
        // S9: hanya cek pasangan (videoId, playedAt) yang didorong
        // (row-value IN, maks 100) — bukan seluruh riwayat.
        fetchExisting: async (unique) => {
          const marks = unique.map(() => '(?, ?)').join(', ');
          const binds = unique.flatMap((h) => [h.videoId, h.playedAt]);
          const rows = await db
            .prepare(
              `SELECT video_id, played_at FROM sync_history WHERE user_id = ? AND (video_id, played_at) IN (${marks})`,
            )
            .bind(user.id, ...binds)
            .all();
          return (rows.results || []).map(
            (r) => `${r.video_id}|${r.played_at}`,
          );
        },
      });
      body.history = result.kept;
      skippedOverLimit.history = result.skipped;
      historyNewKeys = result.newKeys;
      historyAdded = result.added;
    }
    // R11 + I20: verifikasi kepemilikan playlist untuk item
    // SEBELUM cap item dihitung. Playlist yang sudah ada di D1
    // harus milik pendorong; playlist baru (belum ada di D1)
    // diizinkan hanya bila ikut dibuat di push ini (di
    // body.playlists yang lolos cap) — jadi item yatim dan item ke
    // playlist orang lain ditolak, sementara push "playlist baru +
    // lagunya sekaligus" tetap jalan. Urutan ini penting (I20):
    // item ke playlist orang lain ditolak sebagai notOwned TANPA
    // menyentuh perhitungan cap, jadi skippedOverLimit tidak
    // pernah membocorkan perkiraan jumlah item playlist orang lain.
    const newPlaylistIds = new Set(
      (body.playlists || []).map((p) => p.clientId),
    );
    const ownedCache = new Map();
    async function playlistOwned(clientId) {
      if (ownedCache.has(clientId)) return ownedCache.get(clientId);
      const row = await db
        .prepare('SELECT user_id FROM sync_playlists WHERE id = ?')
        .bind(clientId)
        .first();
      const owned = row
        ? row.user_id === user.id
        : newPlaylistIds.has(clientId);
      ownedCache.set(clientId, owned);
      return owned;
    }
    const ownedItems = [];
    for (const item of itemsIn) {
      if (await playlistOwned(item.playlistClientId)) {
        ownedItems.push(item);
      } else {
        skippedNotOwned += 1;
      }
    }
    const ownedDeletedItems = [];
    for (const d of deletedItemsIn) {
      if (await playlistOwned(d.playlistClientId)) {
        ownedDeletedItems.push(d);
      } else {
        skippedNotOwned += 1;
      }
    }
    // Cap item (batas 1.000 berlaku PER playlist, bukan total),
    // hanya untuk item ke playlist milik pendorong.
    if (ownedItems.length > 0) {
      const touchedIds = [
        ...new Set(ownedItems.map((i) => i.playlistClientId)),
      ];
      let itemCounts;
      if (countersOk) {
        // I23a: blok penghitung ITEM dibungkus try/catch yang sama
        // dengan blok skalar — galat D1 sesaat di sini dulu
        // menggagalkan SELURUH push dengan 500 (fail-closed),
        // padahal galat yang sama di jalur skalar hanya fail-open
        // ke COUNT. Bila COUNT juga gagal, tolak dengan 500 yang
        // JELAS + kembalikan anggaran (bukan diam-diam).
        try {
          const rows = await readItemCounters(db, user.id, touchedIds);
          const resolved = await Promise.all(
            touchedIds.map((pid) =>
              resolveCount(
                db,
                user.id,
                'items',
                pid,
                MAX_ITEMS_PER_PLAYLIST,
                rows.get(pid),
                now,
              ),
            ),
          );
          itemCounts = new Map(touchedIds.map((pid, i) => [pid, resolved[i]]));
        } catch (e) {
          logWarn('penghitung item: gagal baca, fallback ke COUNT', { error: e instanceof Error ? e.message : 'unknown' });
          countersOk = false;
          try {
            itemCounts = await countItemsPerPlaylist(db, user.id, touchedIds);
          } catch (e2) {
            return failCountsUnavailable(db, user.id, day, reservedCharge);
          }
        }
      } else {
        try {
          itemCounts = await countItemsPerPlaylist(db, user.id, touchedIds);
        } catch (e) {
          return failCountsUnavailable(db, user.id, day, reservedCharge);
        }
      }
      const byPlaylist = new Map();
      for (const item of ownedItems) {
        const list = byPlaylist.get(item.playlistClientId) || [];
        list.push(item);
        byPlaylist.set(item.playlistClientId, list);
      }
      const keptItems = [];
      for (const [playlistId, entries] of byPlaylist) {
        const result = await capNewEntries({
          count: itemCounts.get(playlistId) || 0,
          cap: MAX_ITEMS_PER_PLAYLIST,
          entries,
          keyOf: (i) => i.videoId,
          // S9: hanya cek kunci yang didorong di playlist ini.
          fetchExisting: async (unique) => {
            const marks = unique.map(() => '?').join(', ');
            const rows = await db
              .prepare(
                `SELECT video_id FROM sync_playlist_items WHERE playlist_id = ? AND user_id = ? AND video_id IN (${marks})`,
              )
              .bind(
                playlistId,
                user.id,
                ...unique.map((i) => i.videoId),
              )
              .all();
            return (rows.results || []).map((r) => r.video_id);
          },
        });
        keptItems.push(...result.kept);
        skippedOverLimit.playlistItems += result.skipped;
        itemNewKeys.set(playlistId, result.newKeys);
        itemAdded.set(playlistId, result.added);
      }
      body.playlistItems = keptItems;
    } else {
      body.playlistItems = [];
    }
    body.deletedPlaylistItems = ownedDeletedItems;
  } catch (e) {
    // I24: probe/kepemilikan gagal sesudah reservasi — kembalikan
    // anggaran + 500 yang JELAS (pola I23 yang sama persis).
    // Cadangan sapu (S14) TIDAK di-refund di sini: sapu sudah
    // jalan dan barisnya benar-benar terhapus.
    logWarn('push: fase cap/probe gagal, anggaran dikembalikan', { error: e instanceof Error ? e.message : 'unknown' });
    return failCountsUnavailable(db, user.id, day, reservedCharge);
  }

  // ---- S9: pembaruan penghitung — PALING AWAL di batch.
  // Penghitung ditambah delta push ini SEBELUM upsert, supaya
  // (1) guard R19 di bawah membaca nilai yang sudah mencakup
  // push ini, dan (2) arah melencengnya aman bila batch gagal di
  // tengah (penghitung terlalu tinggi hanya menolak penambahan
  // sah, tidak pernah mengizinkan pelampauan batas; pulih lewat
  // rekonsiliasi). Pernyataan pembukuan ini TIDAK dihitung di
  // `applied` (bukan entri pengguna).
  if (countersOk) {
    const bump = (collection, playlistId, delta) => {
      if (delta <= 0) return;
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_counts (user_id, collection, playlist_id, n, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, collection, playlist_id) DO UPDATE SET n = sync_counts.n + excluded.n, updated_at = excluded.updated_at',
          )
          .bind(user.id, collection, playlistId, delta, now),
      );
    };
    bump('playlists', '', playlistAdded);
    for (const [playlistId, delta] of itemAdded) {
      bump('items', playlistId, delta);
    }
    bump('likes', '', likesAdded);
    bump('history', '', historyAdded);
    // S8a: clear riwayat menghapus jumlah baris yang tidak
    // diketahui tanpa COUNT — tandai penghitung riwayat BASI
    // (n = -1) sesudah increment, supaya push berikut menghitung
    // ulang dari data nyata.
    if (clearHonored) {
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_counts (user_id, collection, playlist_id, n, updated_at) VALUES (?, ?, ?, -1, ?) ON CONFLICT(user_id, collection, playlist_id) DO UPDATE SET n = -1, updated_at = excluded.updated_at',
          )
          .bind(user.id, 'history', '', now),
      );
    }
  }
  // S8a: stempel clear terakhir (hanya bila tabel meta ada).
  if (clearHonored && metaWritable) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO sync_user_meta (user_id, history_cleared_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET history_cleared_at = excluded.history_cleared_at',
        )
        .bind(user.id, now),
    );
  }
  const bookkeepingStmts = stmts.length;

  // Playlist: id server = clientId (deterministik per perangkat
  // pembuat; LWW + tiebreak device_id seperti yang terbukti S8).
  // R11: upsert hanya menimpa bila baris yang ada milik pendorong
  // (user_id cocok) — clientId orang lain tidak bisa ditimpa.
  // R19: entri BARU memakai INSERT terjaga (guard-WHERE berbasis
  // penghitung); update entri lama memakai upsert biasa karena
  // tidak menambah baris. Guard: (penghitung - delta + k) adalah
  // jumlah nyata sebelum insert ke-k push ini, termasuk kontribusi
  // push bersamaan yang mendarat duluan — bila sudah di batas,
  // SELECT mengembalikan 0 baris dan INSERT menjadi no-op.
  let playlistK = 0;
  for (const p of body.playlists || []) {
    if (countersOk && playlistNewKeys.has(p.clientId)) {
      const k = playlistK;
      playlistK += 1;
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_playlists (id, user_id, client_id, nama, deskripsi, device_id, updated_at, deleted_at) SELECT ?, ?, ?, ?, ?, ?, ?, NULL WHERE (SELECT COALESCE(n, 0) FROM sync_counts WHERE user_id = ? AND collection = ? AND playlist_id = ?) - ? + ? < ? ON CONFLICT(id) DO UPDATE SET nama = excluded.nama, deskripsi = excluded.deskripsi, device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = NULL WHERE (excluded.updated_at > sync_playlists.updated_at OR (excluded.updated_at = sync_playlists.updated_at AND excluded.device_id > sync_playlists.device_id)) AND sync_playlists.user_id = excluded.user_id',
          )
          .bind(p.clientId, user.id, p.clientId, p.nama, p.deskripsi ?? null, deviceId, now, user.id, 'playlists', '', playlistAdded, k, MAX_PLAYLISTS_PER_USER),
      );
    } else {
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_playlists (id, user_id, client_id, nama, deskripsi, device_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET nama = excluded.nama, deskripsi = excluded.deskripsi, device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = NULL WHERE (excluded.updated_at > sync_playlists.updated_at OR (excluded.updated_at = sync_playlists.updated_at AND excluded.device_id > sync_playlists.device_id)) AND sync_playlists.user_id = excluded.user_id',
          )
          .bind(p.clientId, user.id, p.clientId, p.nama, p.deskripsi ?? null, deviceId, now),
      );
    }
  }
  // S7: tombstone memakai UPDATE (bukan INSERT ... ON
  // CONFLICT): tombstone untuk baris yang tidak ada adalah
  // no-op, bukan baris baru — penghapusan tidak pernah
  // menambah baris, tidak pernah ditolak batas total, dan
  // tidak bisa dipakai membuat baris tombstone tanpa batas.
  // Semantik LWW + kepemilikan R11 dipertahankan di WHERE.
  for (const d of body.deletedPlaylists || []) {
    stmts.push(
      db
        .prepare(
          'UPDATE sync_playlists SET device_id = ?, updated_at = ?, deleted_at = ? WHERE id = ? AND user_id = ? AND (updated_at < ? OR (updated_at = ? AND device_id < ?))',
        )
        .bind(deviceId, now, now, d.clientId, user.id, now, now, deviceId),
    );
  }
  // Item sudah difilter kepemilikan di atas (I20): tidak ada cek
  // ulang di sini. Guard R19 per playlist (k dihitung per playlist).
  const itemK = new Map();
  for (const item of body.playlistItems || []) {
    const keys = itemNewKeys.get(item.playlistClientId);
    if (countersOk && keys && keys.has(item.videoId)) {
      const k = itemK.get(item.playlistClientId) || 0;
      itemK.set(item.playlistClientId, k + 1);
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_playlist_items (playlist_id, video_id, posisi, added_at, device_id, updated_at, deleted_at, title, artist, user_id) SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?, ? WHERE (SELECT COALESCE(n, 0) FROM sync_counts WHERE user_id = ? AND collection = ? AND playlist_id = ?) - ? + ? < ? ON CONFLICT(playlist_id, video_id) DO UPDATE SET posisi = excluded.posisi, device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = NULL, title = excluded.title, artist = excluded.artist, user_id = excluded.user_id WHERE excluded.updated_at > sync_playlist_items.updated_at OR (excluded.updated_at = sync_playlist_items.updated_at AND excluded.device_id > sync_playlist_items.device_id)',
          )
          .bind(item.playlistClientId, item.videoId, item.posisi, now, deviceId, now, item.title ?? null, item.artist ?? null, user.id, user.id, 'items', item.playlistClientId, itemAdded.get(item.playlistClientId) || 0, k, MAX_ITEMS_PER_PLAYLIST),
      );
    } else {
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_playlist_items (playlist_id, video_id, posisi, added_at, device_id, updated_at, deleted_at, title, artist, user_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(playlist_id, video_id) DO UPDATE SET posisi = excluded.posisi, device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = NULL, title = excluded.title, artist = excluded.artist, user_id = excluded.user_id WHERE excluded.updated_at > sync_playlist_items.updated_at OR (excluded.updated_at = sync_playlist_items.updated_at AND excluded.device_id > sync_playlist_items.device_id)',
          )
          .bind(item.playlistClientId, item.videoId, item.posisi, now, deviceId, now, item.title ?? null, item.artist ?? null, user.id),
      );
    }
  }
  for (const d of body.deletedPlaylistItems || []) {
    stmts.push(
      db
        .prepare(
          'UPDATE sync_playlist_items SET device_id = ?, updated_at = ?, deleted_at = ? WHERE playlist_id = ? AND video_id = ? AND user_id = ? AND (updated_at < ? OR (updated_at = ? AND device_id < ?))',
        )
        .bind(deviceId, now, now, d.playlistClientId, d.videoId, user.id, now, now, deviceId),
    );
  }
  let likeK = 0;
  for (const like of body.likes || []) {
    if (countersOk && likesNewKeys.has(like.videoId)) {
      const k = likeK;
      likeK += 1;
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_likes (user_id, video_id, liked_at, device_id, updated_at, deleted_at, title, artist) SELECT ?, ?, ?, ?, ?, NULL, ?, ? WHERE (SELECT COALESCE(n, 0) FROM sync_counts WHERE user_id = ? AND collection = ? AND playlist_id = ?) - ? + ? < ? ON CONFLICT(user_id, video_id) DO UPDATE SET liked_at = excluded.liked_at, device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = NULL, title = excluded.title, artist = excluded.artist WHERE excluded.updated_at > sync_likes.updated_at OR (excluded.updated_at = sync_likes.updated_at AND excluded.device_id > sync_likes.device_id)',
          )
          .bind(user.id, like.videoId, like.likedAt, deviceId, now, like.title ?? null, like.artist ?? null, user.id, 'likes', '', likesAdded, k, MAX_LIKES_PER_USER),
      );
    } else {
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_likes (user_id, video_id, liked_at, device_id, updated_at, deleted_at, title, artist) VALUES (?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(user_id, video_id) DO UPDATE SET liked_at = excluded.liked_at, device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = NULL, title = excluded.title, artist = excluded.artist WHERE excluded.updated_at > sync_likes.updated_at OR (excluded.updated_at = sync_likes.updated_at AND excluded.device_id > sync_likes.device_id)',
          )
          .bind(user.id, like.videoId, like.likedAt, deviceId, now, like.title ?? null, like.artist ?? null),
      );
    }
  }
  for (const d of body.deletedLikes || []) {
    stmts.push(
      db
        .prepare(
          'UPDATE sync_likes SET device_id = ?, updated_at = ?, deleted_at = ? WHERE user_id = ? AND video_id = ? AND (updated_at < ? OR (updated_at = ? AND device_id < ?))',
        )
        .bind(deviceId, now, now, user.id, d.videoId, now, now, deviceId),
    );
  }
  let historyK = 0;
  for (const h of body.history || []) {
    if (countersOk && historyNewKeys.has(`${h.videoId}|${h.playedAt}`)) {
      const k = historyK;
      historyK += 1;
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_history (user_id, video_id, played_at, seconds_played, device_id, updated_at, title, artist) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COALESCE(n, 0) FROM sync_counts WHERE user_id = ? AND collection = ? AND playlist_id = ?) - ? + ? < ? ON CONFLICT(user_id, video_id, played_at) DO UPDATE SET seconds_played = max(sync_history.seconds_played, excluded.seconds_played), device_id = excluded.device_id, updated_at = excluded.updated_at, title = excluded.title, artist = excluded.artist',
          )
          .bind(user.id, h.videoId, h.playedAt, h.secondsPlayed, deviceId, now, h.title ?? null, h.artist ?? null, user.id, 'history', '', historyAdded, k, MAX_HISTORY_PER_USER),
      );
    } else {
      stmts.push(
        db
          .prepare(
            'INSERT INTO sync_history (user_id, video_id, played_at, seconds_played, device_id, updated_at, title, artist) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, video_id, played_at) DO UPDATE SET seconds_played = max(sync_history.seconds_played, excluded.seconds_played), device_id = excluded.device_id, updated_at = excluded.updated_at, title = excluded.title, artist = excluded.artist',
          )
          .bind(user.id, h.videoId, h.playedAt, h.secondsPlayed, deviceId, now, h.title ?? null, h.artist ?? null),
      );
    }
  }
  if (body.settings) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO sync_settings (user_id, settings_json, device_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, device_id = excluded.device_id, updated_at = excluded.updated_at WHERE excluded.updated_at > sync_settings.updated_at OR (excluded.updated_at = sync_settings.updated_at AND excluded.device_id > sync_settings.device_id)',
        )
        .bind(user.id, body.settings.settingsJson, deviceId, now),
    );
  }
  // S8a: DELETE hanya bila clear dihonori (sekali per 24 jam).
  if (clearHonored) {
    stmts.push(
      db
        .prepare('DELETE FROM sync_history WHERE user_id = ? AND played_at <= ?')
        .bind(user.id, body.historyClearedBefore),
    );
  }

  if (stmts.length > 0) {
    try {
      await db.batch(stmts);
    } catch (e) {
      // I23b: anggaran TIDAK hangus bila batch gagal — kembalikan
      // TEPAT sebesar reservasi push ini (sekali, tanpa retry,
      // dijaga lantai 0 di refundWriteBudget). DIPILIH refund
      // (bukan "pindahkan pemotongan ke sesudah batch sukses"):
      // reservasi HARUS sebelum batch supaya push bersamaan tidak
      // bisa sama-sama lolos sesudah anggaran habis (TOCTOU S8b);
      // memindahkannya ke belakang membuka lagi race itu.
      // Catatan: db.batch bukan transaksi atomik (I16) — bila
      // batch gagal DI TENGAH, sebagian pernyataan sudah
      // diterapkan sementara anggaran dikembalikan penuh. Itu
      // diterima: kegagalan mid-batch adalah galat D1
      // (transien/kuota), bukan sesuatu yang bisa dipicu
      // penyerang per pernyataan (validasi body + guard-WHERE
      // membuat pernyataan gagal validasi tidak pernah masuk
      // batch), dan "gratis" yang didapat dibatasi satu push
      // per kegagalan.
      logWarn('push: batch gagal, anggaran dikembalikan', { error: e instanceof Error ? e.message : 'unknown' });
      await refundWriteBudget(db, user.id, day, reservedCharge);
      return jsonError(
        500,
        'SYNC_TEMPORARILY_UNAVAILABLE',
        'Sinkronisasi gagal sesaat. Coba lagi.',
      );
    }
  }
  return jsonOk({
    serverTime: now,
    // `applied` hanya menghitung pernyataan data (bukan
    // pembukuan penghitung/stempel) supaya artinya tetap
    // "entri yang diterapkan".
    applied: stmts.length - bookkeepingStmts,
    skippedNotOwned,
    // Blue 7 (S14): baris tombstone/item yang disapu push ini
    // (0 bila tidak ada / cadangan sapu gagal).
    pruned: prunedRows,
    // S7: kelebihan di atas batas total, per koleksi, + nilai
    // batasnya — klien bisa menampilkan pesan yang jelas
    // tanpa menebak angka dari server.
    skippedOverLimit,
    limits: {
      playlists: MAX_PLAYLISTS_PER_USER,
      itemsPerPlaylist: MAX_ITEMS_PER_PLAYLIST,
      likes: MAX_LIKES_PER_USER,
      history: MAX_HISTORY_PER_USER,
    },
    // S8a: clear yang diabaikan dilaporkan eksplisit (klien
    // menyimpan penandanya dan mencoba lagi nanti).
    ...(clearRequested && !clearHonored
      ? {
          historyClearIgnored: true,
          historyClearRetryAfterSeconds: clearRetryAfterSeconds,
        }
      : {}),
  });
}
