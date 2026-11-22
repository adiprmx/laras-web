// Laras Web — Worker sinkronisasi + auth (P7).
//
// Peran: OAuth Google/GitHub (tukar kode di server, client secret
// tidak pernah menyentuh browser) + API sinkronisasi D1 mengikuti
// protokol S8 yang sudah terbukti (docs/spikes/s8-s10-data.md):
// last-write-wins + tiebreak device_id deterministik, tombstone
// hapus, hash sesi SHA-256, sinkronisasi inkremental 2 arah,
// settings 4 KB.
//
// SKEMA: workers/sync/migrations/0001_init.sql (7 tabel) + migrations/0002_ratelimit.sql
// + migrations/0003_item_meta.sql + migrations/0004_oauth_states_item_owner.sql
// (tabel oauth_states + kolom user_id di sync_playlist_items)
// + migrations/0005_sync_quotas.sql (tabel sync_counts,
// sync_write_budget, sync_user_meta — penghitung batas, anggaran
// tulis harian, stempel hapus riwayat)
// + migrations/0006_blue6_quotas.sql (tabel
// sync_deleted_identities, sync_read_budget, indeks sapu
// tombstone — tombstone identitas terhapus, anggaran baca pull
// harian, sapu tombstone malas).
// Worker ini WAJIB di-deploy sesudah keenam migrasi diterapkan
// (SQL push/pull memakai kolom title/artist dari 0003, SQL
// callback memakai tabel oauth_states dari 0004, SQL push item
// memakai kolom user_id dari 0004, SQL kuota memakai tabel 0005,
// SQL tombstone/anggaran-baca memakai tabel 0006).
// Tanpa 0005, Worker fail-open ke perilaku Blue 4 (COUNT per push
// + tanpa anggaran tulis) supaya sync tidak mati — tetapi S8/S9
// kembali terbuka sampai 0005 diterapkan. Tanpa 0006, Worker
// fail-open ke perilaku Blue 5 (anggaran tulis tetap jalan, tetapi
// S10/S11 kembali terbuka: daftar ulang me-reset anggaran dan
// pull tanpa anggaran baca) sampai 0006 diterapkan.
//
// KREDENSIAL (langkah owner, belum ada saat P7 ditulis):
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID,
// GITHUB_CLIENT_SECRET sebagai Worker secrets (wrangler secret
// put / dashboard). Tanpa secret, /api/auth/login membalas 503
// dengan halaman penjelasan — bukan crash, bukan login palsu.
// Redirect URI yang didaftarkan di kedua aplikasi OAuth:
//   https://<worker>/api/auth/callback
// (satu URI untuk kedua provider; provider disimpan di cookie
// state, bukan di URL).
//
// SESI: token acak 256-bit, disimpan sebagai hash SHA-256 di D1,
// dikirim sebagai cookie HttpOnly + Secure, kedaluwarsa 30 hari.
// PENYIMPANGAN TERCATAT dari arsitektur §4.3: cookie memakai
// SameSite=None (bukan Lax) karena Worker tinggal di domain
// workers.dev sementara app di adipmusic.my.id — cookie Lax
// tidak dikirim fetch lintas situs, sehingga auth akan rusak
// total. Mitigasi CSRF: semua endpoint yang mengubah state
// (POST) memvalidasi header Origin terhadap allowlist; GET
// bersifat baca-saja dan responsnya tidak bisa dibaca lintas
// origin tanpa CORS. Bila Worker suatu hari pindah ke subdomain
// app yang sama (same-site), set env COOKIE_SAMESITE=Lax untuk
// memperketat kembali.
//
// Batas yang ditegakkan:
//   body push maks 1 MB, maks 100 entri per koleksi per push,
//   settings_json maks 4 KB (CHECK di D1 + cek eksplisit),
//   tarik maks 1000 baris per koleksi, rate limit D1 (fail-open),
//   batas TOTAL per pengguna (arsitektur §4.3, S7): maks 100
//   playlist, 1.000 item per playlist, 10.000 suka, 1.000
//   riwayat — dihitung dari TABEL PENGHITUNG (S9, 1 baris baca
//   per koleksi), kelebihan dilewati per koleksi dan dilaporkan
//   di respons push. Tombstone memakai UPDATE (bukan INSERT)
//   sehingga tidak pernah menambah baris dan tidak pernah
//   ditolak batas. Anggaran tulis harian per akun 20.000 baris
//   (S8b, §4.3 — maks 20% kuota tulis bersama per akun per hari;
//   push yang melewatinya ditolak 429 + Retry-After). Hapus
//   riwayat dihonori paling sering sekali per 24 jam per pengguna
//   (S8a); clear yang terlalu sering diabaikan dengan respons
//   jelas (historyClearIgnored + Retry-After dalam detik).
//   Tiap INSERT entri baru dijaga klausa guard-WHERE berbasis
//   penghitung (R19) sehingga batas ditegakkan per pernyataan
//   secara atomik, bukan hanya check-then-act di level push.
//   Anggaran BACA pull harian per akun 40.000 baris (S11b —
//   maks 0,8% kuota baca bersama per akun per hari; pull
//   mencadangkan maks 4.002 baris SEBELUM query jalan, selisih
//   yang tidak terpakai dikembalikan). Hapus akun dibatasi
//   3/jam/IP + 1/jam/akun (S10a) dan daftar ulang sesudah hapus
//   dibatasi cooldown 24 jam per identitas provider (S10c);
//   anggaran + stempel clear diwariskan lewat tombstone identitas
//   (hash saja, tanpa data pribadi) supaya hapus + daftar lagi
//   tidak me-reset apa pun (S10b). Baris rate-limit sync
//   dibebankan ke anggaran akun (S12a) dan request yang sudah
//   dibatasi tidak menulis baris (S12b). Tombstone server
//   disapu malas tiap push (maks 100/koleksi, umur >30 hari,
//   I22) supaya cap tidak tersumbat permanen.
// Tanpa log isi: Worker tidak mencatat body, token, atau data
// pengguna; hanya metrik agregat di console (jumlah request
// per endpoint per jam) bila dibutuhkan.
//
// Login TIDAK PERNAH wajib untuk memutar lagu (aturan permanen):
// Worker ini hanya melayani pengguna yang memilih masuk dari
// Pengaturan; app jalan penuh tanpa sesi.

// Helper bersama (P-Shared): HTTP, log/observabilitas, rate limit.
// Dibundel esbuild saat deploy (deploy_sync.py), jadi impor
// lintas direktori aman. Sebelumnya helper ini diduplikasi di
// proxy dan sync (drift: nosniff hanya di sync).

// Helper bersama (P-Shared) + modul domain (P-SyncSplit).
// index.js kini hanya router: isAllowedOrigin + fetch.
import {
  authUser,
  clearSessionCookieHeader,
  deleteAllSessions,
  handleCallback,
  handleLogin,
} from './auth.js';
import { handlePull } from './pull.js';
import { computePushCharge, handlePush, parsePushBody } from './push.js';
import { readBudgetExhausted, writeBudgetExhausted } from './budgets.js';
import { identityHashFor } from './tombstones.js';
import { clientIp, jsonOk, secondsUntilMidnightUtc } from './util.js';
import {
  DELETE_RATE_WINDOW_MS,
  PULL_WRITE_CHARGE,
  RATE_AUTH_PER_MIN,
  RATE_DELETE_PER_HOUR_ACCOUNT,
  RATE_DELETE_PER_HOUR_IP,
  RATE_ME_PER_MIN,
  RATE_SYNC_PER_MIN,
} from './constants.js';
import { corsHeaders, jsonError, parseAllowedOrigins } from '../../shared/http.js';
import { checkDb, logInfo, logWarn, newRequestId } from '../../shared/log.js';
import { checkRateLimit } from '../../shared/rateLimit.js';

// Versi worker — naikkan saat perilaku berubah (dilaporkan /health).
const WORKER_VERSION = '1.1.0';

/** Apakah Origin request ada di allowlist (pertahanan CSRF untuk POST). */
function isAllowedOrigin(env, request) {
  const origin = request.headers.get('Origin') || '';
  return parseAllowedOrigins(env).includes(origin);
}

// P-SameSite: untuk GET, Origin yang TIDAK ADA berarti navigasi
// langsung (pengguna membuka URL di address bar, curl) —
// diizinkan. Yang ditolak hanyalah Origin yang ADA tapi tidak
// di allowlist: fetch lintas situs dari halaman jahat yang
// memakai sesi korban (cookie SameSite=None ikut terkirim).
// CORS memang sudah mencegah halaman itu MEMBACA respons,
// tetapi tanpa cek ini request-nya tetap membakar anggaran
// baca/tulis korban di D1.
function isForbiddenOrigin(env, request) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return false;
  return !parseAllowedOrigins(env).includes(origin);
}

// ------------------------------------------------------------------
// Router
// ------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // credentials: true — sync memakai cookie sesi (berbeda dari
    // proxy yang tanpa kredensial).
    const cors = corsHeaders(env, request, { credentials: true });
    const requestId = newRequestId(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      // Satu baris log per request (P-Health). Path saja — query TIDAK.
      logInfo('request', { requestId, method: request.method, path: url.pathname });

      // ---- /health: liveness + status dependensi (P-Health) ----
      // Tanpa rate limit, tanpa auth, tanpa sesi — monitor uptime
      // harus bisa menjangkaunya bebas. Selalu 200 bila worker
      // merespons; field `db` melaporkan D1 (fail-open bila bukan ok).
      if (url.pathname === '/health') {
        if (request.method !== 'GET') {
          return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
        }
        const db = await checkDb(env);
        return jsonOk(
          {
            ok: true,
            worker: 'sync',
            version: WORKER_VERSION,
            db,
            failOpen: db !== 'ok',
            time: new Date().toISOString(),
          },
          { ...cors, 'x-request-id': requestId },
        );
      }

      // ---- Auth: alur login (navigasi top-level, tanpa CORS) ----
      if (url.pathname === '/api/auth/login') {
        if (request.method !== 'GET') {
          return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan');
        }
        return handleLogin(request, env, url);
      }
      if (url.pathname === '/api/auth/callback') {
        if (request.method !== 'GET') {
          return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan');
        }
        // S6: callback adalah endpoint terakhir tanpa rate limit —
        // tanpa ini satu IP bisa membakar kuota harian akun lewat
        // tukar kode berulang. Dicek SEBELUM tukar kode.
        const ip = clientIp(env, request);
        if (
          await checkRateLimit(env, `auth-callback:${ip}`, RATE_AUTH_PER_MIN)
        ) {
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak percobaan masuk');
          r.headers.set('Retry-After', '60');
          return r;
        }
        return handleCallback(request, env, url);
      }

      // ---- Auth: status sesi ----
      if (url.pathname === '/api/auth/me') {
        if (request.method !== 'GET') {
          return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
        }
        const ip = clientIp(env, request);
        if (await checkRateLimit(env, `me:${ip}`, RATE_ME_PER_MIN)) {
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak request', cors);
          r.headers.set('Retry-After', '60');
          return r;
        }
        const user = await authUser(env, request);
        if (!user) return jsonError(401, 'UNAUTHORIZED', 'Belum masuk', cors);
        return jsonOk(
          { displayName: user.display_name, provider: user.provider },
          cors,
        );
      }

      // ---- Auth: keluar ----
      if (url.pathname === '/api/auth/logout') {
        if (request.method !== 'POST') {
          return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
        }
        if (!isAllowedOrigin(env, request)) {
          return jsonError(403, 'ORIGIN_NOT_ALLOWED', 'Origin tidak diizinkan', cors);
        }
        const user = await authUser(env, request);
        if (user && env.DB) {
          await env.DB.prepare('DELETE FROM sessions WHERE id = ?')
            .bind(user.sessionId)
            .run();
        }
        const res = jsonOk({ loggedOut: true }, cors);
        res.headers.set('Set-Cookie', clearSessionCookieHeader(env));
        return res;
      }

      // ---- Auth: keluar dari SEMUA perangkat (P-Auth) ----
      // Berbeda dari /logout (hanya sesi ini): menghapus semua
      // baris sesi milik pengguna — dipakai saat pengguna merasa
      // akunnya dipakai orang lain. WAJIB masuk dulu (401 bila
      // tidak), supaya endpoint ini tidak bisa dipakai mematikan
      // sesi orang lain tanpa tokennya.
      if (url.pathname === '/api/auth/logout-all') {
        if (request.method !== 'POST') {
          return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
        }
        if (!isAllowedOrigin(env, request)) {
          return jsonError(403, 'ORIGIN_NOT_ALLOWED', 'Origin tidak diizinkan', cors);
        }
        const user = await authUser(env, request);
        if (!user) return jsonError(401, 'UNAUTHORIZED', 'Belum masuk', cors);
        const revoked = await deleteAllSessions(env, user.id);
        const res = jsonOk({ loggedOutEverywhere: true, revoked }, cors);
        res.headers.set('Set-Cookie', clearSessionCookieHeader(env));
        return res;
      }

      // ---- Auth: hapus akun + seluruh data sync ----
      if (url.pathname === '/api/auth/delete') {
        if (request.method !== 'POST') {
          return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
        }
        if (!isAllowedOrigin(env, request)) {
          return jsonError(403, 'ORIGIN_NOT_ALLOWED', 'Origin tidak diizinkan', cors);
        }
        const user = await authUser(env, request);
        if (!user) return jsonError(401, 'UNAUTHORIZED', 'Belum masuk', cors);
        // S10a: rate limit KETAT — hapus akun adalah tindakan
        // langka (sekali seumur hidup akun). Tanpa ini, siklus
        // hapus + daftar lagi bisa diulang menit demi menit.
        const deleteIp = clientIp(env, request);
        if (
          (await checkRateLimit(
            env,
            `delete-ip:${deleteIp}`,
            RATE_DELETE_PER_HOUR_IP,
            DELETE_RATE_WINDOW_MS,
          )) ||
          (await checkRateLimit(
            env,
            `delete-acct:${user.id}`,
            RATE_DELETE_PER_HOUR_ACCOUNT,
            DELETE_RATE_WINDOW_MS,
          ))
        ) {
          const r = jsonError(
            429,
            'RATE_LIMITED',
            'Terlalu banyak percobaan hapus akun. Coba lagi nanti.',
            cors,
          );
          r.headers.set('Retry-After', '3600');
          return r;
        }
        if (env.DB) {
          const db = env.DB;
          // Blue 7 (S13): hash identitas dipakai lagi sesudah
          // batch hapus (untuk mencatat jumlah baris terhapus di
          // tombstone) — dideklarasikan di luar try supaya tetap
          // terlihat di bawah.
          let identityHash = null;
          // S10b/c: tulis tombstone identitas SEBELUM menghapus
          // data — HANYA hash identitas + angka (waktu hapus,
          // pemakaian anggaran hari ini, stempel clear), tanpa
          // nama/email/data pengguna apa pun. Best-effort:
          // gagal tulis (tabel 0006 belum ada) tidak
          // menggagalkan hapus (fail-open; S10 aktif sesudah
          // koordinator menerapkan 0006).
          try {
            identityHash = await identityHashFor(
              user.provider,
              user.provider_id,
            );
            const now = Date.now();
            const day = new Date(now).toISOString().slice(0, 10);
            const [budgetRow, readRow, metaRow] = await Promise.all([
              db
                .prepare(
                  'SELECT rows_written FROM sync_write_budget WHERE user_id = ? AND day = ?',
                )
                .bind(user.id, day)
                .first(),
              db
                .prepare(
                  'SELECT rows_read FROM sync_read_budget WHERE user_id = ? AND day = ?',
                )
                .bind(user.id, day)
                .first(),
              db
                .prepare(
                  'SELECT history_cleared_at FROM sync_user_meta WHERE user_id = ?',
                )
                .bind(user.id)
                .first(),
            ]);
            await db
              .prepare(
                'INSERT INTO sync_deleted_identities (identity_hash, deleted_at, budget_day, budget_rows, read_rows, history_cleared_at, deleted_rows) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(identity_hash) DO UPDATE SET deleted_at = excluded.deleted_at, budget_day = excluded.budget_day, budget_rows = excluded.budget_rows, read_rows = excluded.read_rows, history_cleared_at = excluded.history_cleared_at, deleted_rows = excluded.deleted_rows',
              )
              .bind(
                identityHash,
                now,
                day,
                budgetRow ? Number(budgetRow.rows_written) : 0,
                readRow ? Number(readRow.rows_read) : 0,
                metaRow ? Number(metaRow.history_cleared_at) : null,
                // Blue 7 (S13): jumlah baris terhapus baru
                // diketahui SESUDAH batch hapus di bawah — ditulis
                // 0 dulu, diperbarui sesudah batch (1 UPDATE).
                0,
              )
              .run();
          } catch (e) {
            logWarn('tombstone identitas: gagal tulis (hapus tetap jalan)', { error: e instanceof Error ? e.message : 'unknown' });
          }
          // Hapus eksplisit berurutan (tidak mengandalkan
          // ON DELETE CASCADE — penegakan FK D1 tidak dijamin).
          const deleteResults = await db.batch([
            db
              .prepare(
                'DELETE FROM sync_playlist_items WHERE playlist_id IN (SELECT id FROM sync_playlists WHERE user_id = ?)',
              )
              .bind(user.id),
            // Blue 7 (I26b): sabuk pengaman — hapus juga item
            // YATIM (playlist-nya sudah hilang lewat sapu
            // tombstone sebelum perbaikan I26a, jadi subquery di
            // atas tidak menemukannya). Berjalan selagi playlist
            // masih ada (posisi ke-2 batch), jadi hanya item yang
            // benar-benar yatim yang kena.
            db
              .prepare(
                'DELETE FROM sync_playlist_items WHERE user_id = ? AND playlist_id NOT IN (SELECT id FROM sync_playlists)',
              )
              .bind(user.id),
            db.prepare('DELETE FROM sync_playlists WHERE user_id = ?').bind(user.id),
            db.prepare('DELETE FROM sync_likes WHERE user_id = ?').bind(user.id),
            db.prepare('DELETE FROM sync_history WHERE user_id = ?').bind(user.id),
            db.prepare('DELETE FROM sync_settings WHERE user_id = ?').bind(user.id),
            // Blue 5: hapus juga penghitung, anggaran, dan stempel
            // pengguna (migrasi 0005) supaya tidak ada sisa.
            db.prepare('DELETE FROM sync_counts WHERE user_id = ?').bind(user.id),
            db.prepare('DELETE FROM sync_write_budget WHERE user_id = ?').bind(user.id),
            db.prepare('DELETE FROM sync_user_meta WHERE user_id = ?').bind(user.id),
            // Blue 6: hapus juga anggaran baca (migrasi 0006).
            // Tombstone identitas (hash + angka) SENGAJA tidak
            // dihapus di sini — ia ditulis di atas, sebelum
            // batch ini, dan dikonsumsi saat daftar ulang.
            db.prepare('DELETE FROM sync_read_budget WHERE user_id = ?').bind(user.id),
            db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
            db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
          ]);
          // Blue 7 (S13): jumlahkan baris yang BENAR-BENAR
          // terhapus (meta.changes per pernyataan batch, 12
          // pernyataan sesudah I26b) dan catat di tombstone —
          // callback menghitung cooldown sebanding dari angka
          // ini. Best-effort: gagal catat berarti cooldown dasar
          // 24 jam (fail-open; akun tetap terhapus).
          if (identityHash) {
            try {
              const deletedRows = deleteResults.reduce(
                (sum, r) => sum + (r?.meta?.changes ?? 0),
                0,
              );
              await db
                .prepare(
                  'UPDATE sync_deleted_identities SET deleted_rows = ? WHERE identity_hash = ?',
                )
                .bind(deletedRows, identityHash)
                .run();
            } catch (e) {
              logWarn('tombstone identitas: gagal catat deleted_rows', { error: e instanceof Error ? e.message : 'unknown' });
            }
          }
        }
        const res = jsonOk({ deleted: true }, cors);
        res.headers.set('Set-Cookie', clearSessionCookieHeader(env));
        return res;
      }

      // ---- Sync (butuh sesi) ----
      if (url.pathname === '/api/sync/pull' || url.pathname === '/api/sync/push') {
        if (!env.DB) {
          return jsonError(503, 'DB_UNAVAILABLE', 'Database tidak tersedia', cors);
        }
        const user = await authUser(env, request);
        if (!user) return jsonError(401, 'UNAUTHORIZED', 'Belum masuk', cors);
        if (url.pathname === '/api/sync/pull') {
          if (request.method !== 'GET') {
            return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
          }
          // P-SameSite: tolak fetch lintas situs SEBELUM pra-cek
          // anggaran — request jahat tidak boleh membakar
          // anggaran baca korban. Tanpa Origin = navigasi
          // langsung, diizinkan (lihat isForbiddenOrigin).
          if (isForbiddenOrigin(env, request)) {
            return jsonError(403, 'ORIGIN_NOT_ALLOWED', 'Origin tidak diizinkan', cors);
          }
          // S11b+S12a: pra-cek anggaran baca SEBELUM menulis
          // baris rate-limit — pull yang pasti ditolak anggaran
          // tidak membakar baris rate-limit (dan tidak
          // memindai apa pun). Reservasi atomik di handlePull
          // tetap menjadi penegak sesungguhnya (pra-cek hanya
          // optimasi; race di antara keduanya ditutup reservasi).
          if (await readBudgetExhausted(env, user.id)) {
            const r = jsonError(
              429,
              'DAILY_READ_BUDGET_EXCEEDED',
              'Batas tarik sinkronisasi harian tercapai. Coba lagi besok.',
              cors,
            );
            r.headers.set(
              'Retry-After',
              String(secondsUntilMidnightUtc(Date.now())),
            );
            return r;
          }
          // S12a: pra-cek anggaran TULIS juga (pull menagih 4
          // baris tulis — lihat PULL_WRITE_CHARGE). Dicek
          // sesudah anggaran baca supaya kode 429 pull yang
          // kehabisan anggaran BACA tetap spesifik.
          if (
            await writeBudgetExhausted(env, user.id, PULL_WRITE_CHARGE)
          ) {
            const r = jsonError(
              429,
              'DAILY_WRITE_BUDGET_EXCEEDED',
              'Batas sinkronisasi harian tercapai. Coba lagi besok.',
              cors,
            );
            r.headers.set(
              'Retry-After',
              String(secondsUntilMidnightUtc(Date.now())),
            );
            return r;
          }
          if (
            await checkRateLimit(env, `sync:${user.id}`, RATE_SYNC_PER_MIN)
          ) {
            const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak sinkronisasi', cors);
            r.headers.set('Retry-After', '60');
            return r;
          }
          const res = await handlePull(env, url, user);
          const headers = new Headers(res.headers);
          for (const [k, v] of Object.entries(cors)) headers.set(k, v);
          return new Response(res.body, { status: res.status, headers });
        }
        if (request.method !== 'POST') {
          return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
        }
        if (!isAllowedOrigin(env, request)) {
          return jsonError(403, 'ORIGIN_NOT_ALLOWED', 'Origin tidak diizinkan', cors);
        }
        // S12a: baca + validasi body SEBELUM rate limit, supaya
        // pra-cek anggaran memakai tagihan PERSIS push ini.
        // (Sebelumnya body dibaca di handlePush, sesudah baris
        // rate-limit ditulis — push yang pasti ditolak anggaran
        // tetap membakar 1 baris rate-limit tiap percobaan.)
        const parsed = await parsePushBody(request);
        if (parsed.error) {
          const headers = new Headers(parsed.error.headers);
          for (const [k, v] of Object.entries(cors)) headers.set(k, v);
          return new Response(parsed.error.body, {
            status: parsed.error.status,
            headers,
          });
        }
        // Pra-cek memakai batas ATAS tagihan (clear ditagih
        // penuh bila diminta): bila batas atas muat, tagihan
        // persis pasti muat. Sudut sempit: anggaran tersisa
        // <1.000 + clear diminta tapi diabaikan — push ditolak
        // pra-cek walau tagihan persisnya muat (pengguna
        // kehilangan sisa <1.000 anggaran hari itu; diterima,
        // karena hanya terjadi di ambang anggaran + clear
        // yang diabaikan gerbang 24 jam).
        const clearRequested =
          parsed.body.historyClearedBefore !== undefined &&
          parsed.body.historyClearedBefore !== null;
        if (
          await writeBudgetExhausted(
            env,
            user.id,
            computePushCharge(parsed.body, clearRequested),
          )
        ) {
          const r = jsonError(
            429,
            'DAILY_WRITE_BUDGET_EXCEEDED',
            'Batas sinkronisasi harian tercapai. Coba lagi besok.',
            cors,
          );
          r.headers.set(
            'Retry-After',
            String(secondsUntilMidnightUtc(Date.now())),
          );
          return r;
        }
        if (
          await checkRateLimit(env, `sync:${user.id}`, RATE_SYNC_PER_MIN)
        ) {
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak sinkronisasi', cors);
          r.headers.set('Retry-After', '60');
          return r;
        }
        const res = await handlePush(env, user, parsed.body);
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }

      return jsonError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan', cors);
    } catch (e) {
      logWarn('sync worker error', { error: e instanceof Error ? e.message : 'unknown' });
      return jsonError(500, 'SERVER_ERROR', 'Kesalahan server', cors);
    }
  },
};
