// Laras Web — Worker sinkronisasi + auth (P7).
//
// Peran: OAuth Google/GitHub (tukar kode di server, client secret
// tidak pernah menyentuh browser) + API sinkronisasi D1 mengikuti
// protokol S8 yang sudah terbukti (docs/spikes/s8-s10-data.md):
// last-write-wins + tiebreak device_id deterministik, tombstone
// hapus, hash sesi SHA-256, sinkronisasi inkremental 2 arah,
// settings 4 KB.
//
// SKEMA: workers/sync/0001_init.sql (7 tabel) + 0002_ratelimit.sql
// + 0003_item_meta.sql + migrations/0004_oauth_states_item_owner.sql
// (tabel oauth_states + kolom user_id di sync_playlist_items)
// + migrations/0005_sync_quotas.sql (tabel sync_counts,
// sync_write_budget, sync_user_meta — penghitung batas, anggaran
// tulis harian, stempel hapus riwayat).
// Worker ini WAJIB di-deploy sesudah kelima migrasi diterapkan
// (SQL push/pull memakai kolom title/artist dari 0003, SQL
// callback memakai tabel oauth_states dari 0004, SQL push item
// memakai kolom user_id dari 0004, SQL kuota memakai tabel 0005).
// Tanpa 0005, Worker fail-open ke perilaku Blue 4 (COUNT per push
// + tanpa anggaran tulis) supaya sync tidak mati — tetapi S8/S9
// kembali terbuka sampai 0005 diterapkan.
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
// Tanpa log isi: Worker tidak mencatat body, token, atau data
// pengguna; hanya metrik agregat di console (jumlah request
// per endpoint per jam) bila dibutuhkan.
//
// Login TIDAK PERNAH wajib untuk memutar lagu (aturan permanen):
// Worker ini hanya melayani pengguna yang memilih masuk dari
// Pengaturan; app jalan penuh tanpa sesi.

import { isRateLimited } from '../../proxy/src/rateLimit.js';

const SESSION_COOKIE = 'laras_session';
const STATE_COOKIE = 'laras_oauth_state';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const STATE_MAX_AGE_SECONDS = 600;
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_PUSH_ENTRIES = 100;
const MAX_PULL_ROWS = 1000;
const MAX_SETTINGS_BYTES = 4096;
const MAX_META_CHARS = 500;
// Batas TOTAL per pengguna (arsitektur §4.3, S7): tanpa ini
// satu akun bisa membakar kuota tulis D1 bersama (100.000
// baris/hari) dalam <5 menit lewat push 700 baris x 30/mnt.
const MAX_PLAYLISTS_PER_USER = 100;
const MAX_ITEMS_PER_PLAYLIST = 1000;
const MAX_LIKES_PER_USER = 10000;
const MAX_HISTORY_PER_USER = 1000;
// Anggaran tulis harian per akun (arsitektur §4.3, S8b): 20.000
// baris/hari/akun. Longgar untuk pemakaian normal (sinkron penuh
// akun yang sudah maksimal pun ~12.100 baris: 100 playlist +
// 1.000 item + 10.000 suka + 1.000 riwayat), tetapi satu akun
// paling banyak memakai 20% kuota tulis bersama (100.000/hari),
// jadi TIDAK BISA mengurasnya sendirian — butuh 5 akun penuh
// berkoordinasi. Dihitung dari ISI BODY push (termasuk entri
// yang dilewati cap / bukan milik pendorong) supaya push "gratis"
// tidak bisa dipakai membakar kuota BACA lewat probe (S9).
const DAILY_WRITE_BUDGET = 20000;
// Hapus riwayat dihonori paling sering sekali per 24 jam per
// pengguna (S8a). Menghapus riwayat adalah tindakan sadar yang
// jarang (seperti membersihkan riwayat browser); sekali sehari
// jauh di atas kebutuhan sahih, dan menutup putaran
// insert-100 + DELETE-keras yang memutar kuota tulis tanpa henti.
const HISTORY_CLEAR_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Rekonsiliasi penghitung (S9): hitung ulang via COUNT bila
// penghitung melenceng di atas batas + 30 (tidak mungkin tanpa
// drift — guard R19 menahan jumlah nyata di dekat batas), atau
// lebih tua dari 24 jam saat sudah dalam 500 baris dari batas.
const COUNTER_RECONCILE_OVER_CAP_SLACK = 30;
const COUNTER_RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const COUNTER_RECONCILE_NEAR_CAP = 500;
const RATE_AUTH_PER_MIN = 10;
const RATE_SYNC_PER_MIN = 30;
const RATE_ME_PER_MIN = 60;
const FETCH_TIMEOUT_MS = 15000;

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';

// ------------------------------------------------------------------
// Utilitas kecil
// ------------------------------------------------------------------

function jsonError(status, code, message, extraHeaders = {}) {
  return new Response(
    JSON.stringify({ success: false, error: { code, message } }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
      },
    },
  );
}

function jsonOk(data, extraHeaders = {}) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || 'https://laras.adipmusic.my.id')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const h = { Vary: 'Origin' };
  if (allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
  }
  return h;
}

/** Apakah Origin request ada di allowlist (pertahanan CSRF untuk POST). */
function isAllowedOrigin(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || 'https://laras.adipmusic.my.id')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function parseCookies(request) {
  const out = {};
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) continue;
    // I12: nilai cookie malformed (% tidak valid) membuat
    // decodeURIComponent melempar; pakai nilai mentah daripada
    // menggagalkan seluruh request dengan 500.
    const raw = rest.join('=') || '';
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomTokenHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sessionCookieHeader(env, token, maxAge) {
  // SameSite=None (lihat catatan di kepala file) kecuali env
  // meminta Lax (deploy same-site di masa depan).
  const sameSite = env.COOKIE_SAMESITE === 'Lax' ? 'Lax' : 'None';
  return (
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=${sameSite}; ` +
    `Path=/; Max-Age=${maxAge}`
  );
}

function clearSessionCookieHeader(env) {
  return sessionCookieHeader(env, '', 0);
}

function stateCookieHeader(state, provider) {
  // State cookie hanya dipakai navigasi top-level (login ->
  // provider -> callback), jadi Lax cukup dan lebih ketat.
  return (
    `${STATE_COOKIE}=${state}.${provider}; HttpOnly; Secure; ` +
    `SameSite=Lax; Path=/api/auth; Max-Age=${STATE_MAX_AGE_SECONDS}`
  );
}

function clearStateCookieHeader() {
  return (
    `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/api/auth; Max-Age=0`
  );
}

function appUrl(env) {
  return (env.APP_URL || 'https://laras.adipmusic.my.id').replace(/\/$/, '');
}

// Rate limit D1 fail-open (pola proxy): D1 mati berarti request
// diizinkan, bukan layanan mati.
let warnedMissingDb = false;
async function checkRateLimit(env, key, limit) {
  if (!env.DB) {
    if (!warnedMissingDb) {
      warnedMissingDb = true;
      console.warn('rate limit: binding D1 (DB) tidak ada, rate limit nonaktif');
    }
    return false;
  }
  try {
    return await isRateLimited(env.DB, key, limit);
  } catch (e) {
    console.warn(
      'rate limit: D1 gagal, request diizinkan:',
      e instanceof Error ? e.message : 'unknown',
    );
    return false;
  }
}

// Baca body dengan cap tanpa mem-buffer melebihi cap (pola proxy).
async function readCapped(body, capBytes) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      try {
        await reader.cancel();
      } catch {
        /* abaikan */
      }
      return { tooBig: true };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { tooBig: false, bytes: out };
}

// ------------------------------------------------------------------
// Sesi
// ------------------------------------------------------------------

/** Cari pengguna dari cookie sesi; null bila tidak ada/kedaluwarsa. */
async function authUser(env, request) {
  if (!env.DB) return null;
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const hash = await sha256Hex(token);
  const session = await env.DB.prepare(
    'SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?',
  )
    .bind(hash)
    .first();
  if (!session) return null;
  if (session.expires_at <= Date.now()) return null;
  const user = await env.DB.prepare(
    'SELECT id, display_name, provider FROM users WHERE id = ?',
  )
    .bind(session.user_id)
    .first();
  if (!user) return null;
  return { sessionId: session.id, ...user };
}

async function createSession(env, userId) {
  const token = randomTokenHex(32);
  const hash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      crypto.randomUUID(),
      userId,
      hash,
      now + SESSION_MAX_AGE_SECONDS * 1000,
      now,
    )
    .run();
  // Batasi 10 sesi aktif per pengguna (arsitektur §4.3): hapus
  // sesi terlama di luar 10 terbaru.
  await env.DB.prepare(
    'DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10)',
  )
    .bind(userId, userId)
    .run();
  return token;
}

// ------------------------------------------------------------------
// OAuth
// ------------------------------------------------------------------

function oauthConfig(env, provider) {
  if (provider === 'google') {
    return {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      authorizeUrl: GOOGLE_AUTHORIZE,
      tokenUrl: GOOGLE_TOKEN,
      scope: 'openid profile',
    };
  }
  return {
    clientId: env.GITHUB_CLIENT_ID || '',
    clientSecret: env.GITHUB_CLIENT_SECRET || '',
    authorizeUrl: GITHUB_AUTHORIZE,
    tokenUrl: GITHUB_TOKEN,
    scope: 'read:user',
  };
}

// ------------------------------------------------------------------
// State OAuth sekali pakai (Red 3 S6, migrasi 0004)
//
// State disimpan sebagai hash SHA-256 di D1 saat login, lalu
// DIHAPUS saat callback memakainya: state yang sama tidak bisa
// dipakai dua kali, dan state yang tidak pernah dikeluarkan
// login ditolak. Cookie saja tidak cukup — penyerang terskrip
// mengabaikan Set-Cookie penghapus dan memakai ulang cookie
// state tanpa batas. TTL 10 menit, sama dengan cookie.
// ------------------------------------------------------------------

/** Simpan hash state (best-effort: gagal simpan tidak mematikan login). */
async function storeOAuthState(env, state, provider) {
  if (!env.DB) return;
  try {
    const now = Date.now();
    // Sapu baris kedaluwarsa supaya tabel tidak tumbuh tanpa batas.
    await env.DB.prepare(
      'DELETE FROM oauth_states WHERE expires_at < ?',
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      'INSERT INTO oauth_states (state_hash, provider, expires_at, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(
        await sha256Hex(state),
        provider,
        now + STATE_MAX_AGE_SECONDS * 1000,
        now,
      )
      .run();
  } catch (e) {
    console.warn(
      'oauth state: gagal simpan:',
      e instanceof Error ? e.message : 'unknown',
    );
  }
}

/**
 * Pakai satu state: true bila state dikenal, provider cocok,
 * belum kedaluwarsa, dan belum pernah dipakai. Konsumsi ATOMIK
 * (I19): satu DELETE berkondisi — dua callback bersamaan dengan
 * state yang sama tidak bisa sama-sama lolos, karena hanya
 * DELETE pertama yang mengubah 1 baris (`meta.changes === 1`).
 * State tak dikenal/kedaluwarsa/salah provider/sudah dipakai
 * mengubah 0 baris dan mengembalikan false. Baris kedaluwarsa
 * tidak ikut terhapus di sini; sapu login (storeOAuthState)
 * yang membersihkannya. Galat D1 (mis. tabel belum termigrasi
 * atau D1 mati sesaat) fail-open ke true supaya login tidak
 * mati total — rate limit callback tetap melindungi kuota.
 * Koordinator WAJIB menerapkan migrasi 0004 sebelum deploy
 * supaya single-use benar-benar aktif.
 */
async function consumeOAuthState(env, state, provider) {
  if (!env.DB) return false;
  const hash = await sha256Hex(state);
  try {
    const res = await env.DB.prepare(
      'DELETE FROM oauth_states WHERE state_hash = ? AND provider = ? AND expires_at > ?',
    )
      .bind(hash, provider, Date.now())
      .run();
    return res.meta?.changes === 1;
  } catch (e) {
    console.warn(
      'oauth state: gagal pakai (fail-open, login dilanjutkan):',
      e instanceof Error ? e.message : 'unknown',
    );
    return true;
  }
}

function setupPendingPage(env) {
  // Halaman penjelasan saat aplikasi OAuth belum dibuat owner.
  // Bahasa sehari-hari, tanpa jargon, tanpa detail teknis.
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Laras</title></head><body style="background:#000;color:#fff;` +
      `font-family:sans-serif;padding:32px"><h1>Masuk belum tersedia.</h1>` +
      `<p>Akun untuk sinkronisasi masih disiapkan. Kamu tetap bisa ` +
      `memakai semua fitur pemutar tanpa masuk.</p>` +
      `<p><a href="${appUrl(env)}" style="color:#fff">Kembali ke Laras</a></p>` +
      `</body></html>`,
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'",
      },
    },
  );
}

async function handleLogin(request, env, url) {
  const provider = url.searchParams.get('provider') || '';
  if (provider !== 'google' && provider !== 'github') {
    return jsonError(400, 'BAD_PROVIDER', 'Penyedia tidak dikenal');
  }
  const config = oauthConfig(env, provider);
  if (!config.clientId || !config.clientSecret) {
    return setupPendingPage(env);
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await checkRateLimit(env, `auth:${ip}`, RATE_AUTH_PER_MIN)) {
    const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak percobaan masuk');
    r.headers.set('Retry-After', '60');
    return r;
  }
  const state = randomTokenHex(16);
  // S6: catat state di server supaya callback bisa menolak
  // pemakaian ulang (single-use).
  await storeOAuthState(env, state, provider);
  const redirectUri = `${url.origin}/api/auth/callback`;
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scope,
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${config.authorizeUrl}?${params}`,
      'Set-Cookie': stateCookieHeader(state, provider),
    },
  });
}

async function exchangeCode(env, provider, code, redirectUri) {
  const config = oauthConfig(env, provider);
  if (provider === 'google') {
    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.access_token || null;
  }
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.access_token || null;
}

async function fetchProfile(provider, accessToken) {
  if (provider === 'google') {
    const res = await fetch(GOOGLE_USERINFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.sub) return null;
    return { providerId: String(body.sub), displayName: body.name || null };
  }
  const res = await fetch(GITHUB_USER, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'LarasWeb/1.0',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json();
  if (body.id === undefined || body.id === null) return null;
  return {
    providerId: String(body.id),
    displayName: body.name || body.login || null,
  };
}

async function handleCallback(request, env, url) {
  const base = appUrl(env);
  const fail = (reason) =>
    new Response(null, {
      status: 302,
      headers: {
        Location: `${base}/settings?auth=error&reason=${reason}`,
        'Set-Cookie': clearStateCookieHeader(),
      },
    });
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';
  if (error) return fail('denied');
  if (!code || !state) return fail('missing');
  const cookies = parseCookies(request);
  const stored = cookies[STATE_COOKIE] || '';
  const dot = stored.lastIndexOf('.');
  if (dot <= 0) return fail('state');
  const storedState = stored.slice(0, dot);
  const provider = stored.slice(dot + 1);
  if (storedState !== state || (provider !== 'google' && provider !== 'github')) {
    return fail('state');
  }
  if (!env.DB) return fail('server');
  // S6: state sekali pakai di server — tolak state yang sudah
  // dipakai, tidak dikenal, atau kedaluwarsa (sebelum tukar kode).
  if (!(await consumeOAuthState(env, state, provider))) {
    return fail('state');
  }
  const config = oauthConfig(env, provider);
  if (!config.clientId || !config.clientSecret) {
    return setupPendingPage(env);
  }
  const redirectUri = `${url.origin}/api/auth/callback`;
  let accessToken = null;
  try {
    accessToken = await exchangeCode(env, provider, code, redirectUri);
  } catch {
    return fail('exchange');
  }
  if (!accessToken) return fail('exchange');
  let profile = null;
  try {
    profile = await fetchProfile(provider, accessToken);
  } catch {
    return fail('profile');
  }
  if (!profile) return fail('profile');

  const now = Date.now();
  const displayName = profile.displayName || 'Tanpa nama';
  let user = await env.DB.prepare(
    'SELECT id, provider, provider_id, display_name FROM users WHERE provider = ? AND provider_id = ?',
  )
    .bind(provider, profile.providerId)
    .first();
  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO users (id, provider, provider_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, provider, profile.providerId, displayName, now)
      .run();
    user = { id };
  } else if (user.display_name !== displayName) {
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .bind(displayName, user.id)
      .run();
  }
  const token = await createSession(env, user.id);
  // Dua cookie dikirim sebagai dua header Set-Cookie terpisah
  // (menggabungkan dengan koma tidak valid untuk Set-Cookie).
  const headers = new Headers();
  headers.set('Location', `${base}/settings?auth=ok`);
  headers.append('Set-Cookie', sessionCookieHeader(env, token, SESSION_MAX_AGE_SECONDS));
  headers.append('Set-Cookie', clearStateCookieHeader());
  return new Response(null, { status: 302, headers });
}

// ------------------------------------------------------------------
// Sync: tarik
// ------------------------------------------------------------------

async function handlePull(env, url, user) {
  const sinceRaw = Number(url.searchParams.get('since') || 0);
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
  const db = env.DB;
  const [playlists, items, likes, history, settings] = await Promise.all([
    db
      .prepare(
        'SELECT client_id, nama, deskripsi, updated_at, deleted_at FROM sync_playlists WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ?',
      )
      .bind(user.id, since, MAX_PULL_ROWS)
      .all(),
    db
      .prepare(
        'SELECT p.client_id AS playlist_client_id, i.video_id, i.posisi, i.title, i.artist, i.updated_at, i.deleted_at FROM sync_playlist_items i JOIN sync_playlists p ON p.id = i.playlist_id WHERE p.user_id = ? AND i.updated_at > ? ORDER BY i.updated_at ASC LIMIT ?',
      )
      .bind(user.id, since, MAX_PULL_ROWS)
      .all(),
    db
      .prepare(
        'SELECT video_id, liked_at, title, artist, updated_at, deleted_at FROM sync_likes WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ?',
      )
      .bind(user.id, since, MAX_PULL_ROWS)
      .all(),
    db
      .prepare(
        'SELECT video_id, played_at, seconds_played, title, artist, updated_at FROM sync_history WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ?',
      )
      .bind(user.id, since, MAX_PULL_ROWS)
      .all(),
    db
      .prepare('SELECT settings_json, updated_at FROM sync_settings WHERE user_id = ?')
      .bind(user.id)
      .first(),
  ]);
  return jsonOk({
    serverTime: Date.now(),
    playlists: (playlists.results || []).map((r) => ({
      clientId: r.client_id,
      nama: r.nama,
      deskripsi: r.deskripsi,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    })),
    playlistItems: (items.results || []).map((r) => ({
      playlistClientId: r.playlist_client_id,
      videoId: r.video_id,
      posisi: r.posisi,
      title: r.title,
      artist: r.artist,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    })),
    likes: (likes.results || []).map((r) => ({
      videoId: r.video_id,
      likedAt: r.liked_at,
      title: r.title,
      artist: r.artist,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    })),
    history: (history.results || []).map((r) => ({
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

// ------------------------------------------------------------------
// Sync: dorong
// ------------------------------------------------------------------

function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

function isOptionalString(v, maxLen) {
  return v === null || v === undefined || (typeof v === 'string' && v.length <= maxLen);
}

function isSafeInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Validasi satu entri push; mengembalikan pesan galat atau null. */
function validatePushBody(body) {
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
async function countUserRows(db, table, userId) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
    .bind(userId)
    .first();
  return row ? Number(row.n) : 0;
}

/** Jumlah item di SATU playlist milik pengguna (rekonsiliasi). */
async function countItemsForPlaylist(db, playlistId, userId) {
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
async function countItemsPerPlaylist(db, userId, playlistIds) {
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
async function readScalarCounters(db, userId, collections) {
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
async function readItemCounters(db, userId, playlistIds) {
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

/** Simpan nilai penghitung hasil rekonsiliasi (nilai absolut, bukan delta). */
async function storeCount(db, userId, collection, playlistId, n, now) {
  await db
    .prepare(
      'INSERT INTO sync_counts (user_id, collection, playlist_id, n, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, collection, playlist_id) DO UPDATE SET n = excluded.n, updated_at = excluded.updated_at',
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
 */
async function reconcileCount(db, userId, collection, playlistId, cap, now) {
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
  await storeCount(db, userId, collection, playlistId, n, now);
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
async function resolveCount(
  db,
  userId,
  collection,
  playlistId,
  cap,
  row,
  now,
) {
  if (!row) {
    return reconcileCount(db, userId, collection, playlistId, cap, now);
  }
  const stale = row.n < 0;
  const overCap = row.n > cap + COUNTER_RECONCILE_OVER_CAP_SLACK;
  const oldNearCap =
    now - row.updatedAt > COUNTER_RECONCILE_MAX_AGE_MS &&
    row.n > cap - COUNTER_RECONCILE_NEAR_CAP;
  if (stale || overCap || oldNearCap) {
    return reconcileCount(db, userId, collection, playlistId, cap, now);
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
async function capNewEntries({ count, cap, entries, keyOf, fetchExisting }) {
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

/** Detik sampai 00:00 UTC berikutnya (Retry-After anggaran harian). */
function secondsUntilMidnightUtc(nowMs) {
  const d = new Date(nowMs);
  const nextMidnight = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((nextMidnight - nowMs) / 1000));
}

async function handlePush(env, request, user) {
  const declaredLen = Number(request.headers.get('Content-Length') || 0);
  if (declaredLen > MAX_BODY_BYTES) {
    return jsonError(413, 'BODY_TOO_BIG', 'Body request melewati 1 MB');
  }
  const read = request.body
    ? await readCapped(request.body, MAX_BODY_BYTES)
    : { tooBig: false, bytes: new Uint8Array(0) };
  if (read.tooBig) {
    return jsonError(413, 'BODY_TOO_BIG', 'Body request melewati 1 MB');
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch {
    return jsonError(400, 'BAD_JSON', 'Body bukan JSON yang valid');
  }
  const invalid = validatePushBody(body);
  if (invalid) return jsonError(400, 'INVALID_BODY', invalid);

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
      console.warn(
        'history clear: gagal baca stempel, clear diizinkan:',
        e instanceof Error ? e.message : 'unknown',
      );
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
  // stempel meta, dan upsert cadangan anggaran itu sendiri.
  // Dengan tunjangan ini tagihan TIDAK PERNAH kurang dari tulis
  // sebenarnya yang ditimbulkan push (maks 1.909/push).
  // Cadangan bersifat atomik (satu upsert berkondisi): push
  // bersamaan tidak bisa sama-sama lolos sesudah anggaran habis.
  const nonEmptyScalar =
    (playlistsIn.length > 0 ? 1 : 0) +
    (likesIn.length > 0 ? 1 : 0) +
    (historyIn.length > 0 ? 1 : 0);
  const distinctItemPlaylists = new Set(
    itemsIn.map((i) => i.playlistClientId),
  ).size;
  const charge =
    playlistsIn.length +
    itemsIn.length +
    likesIn.length +
    historyIn.length +
    deletedPlaylistsIn.length +
    deletedItemsIn.length +
    deletedLikesIn.length +
    (body.settings ? 1 : 0) +
    (clearHonored ? MAX_HISTORY_PER_USER : 0) +
    2 * (nonEmptyScalar + distinctItemPlaylists) +
    3;
  // Tagihan selalu >= 3 (tunjangan pembukuan), jadi cadangan
  // selalu jalan — termasuk push kosong, supaya push kosong pun
  // tidak bisa dipakai membakar kuota baca tanpa batas.
  try {
    const day = new Date(now).toISOString().slice(0, 10);
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
  } catch (e) {
    console.warn(
      'anggaran tulis: gagal cadang, push diizinkan:',
      e instanceof Error ? e.message : 'unknown',
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
    console.warn(
      'penghitung: gagal baca, fallback ke COUNT:',
      e instanceof Error ? e.message : 'unknown',
    );
    countersOk = false;
    [playlistCount, likesCount, historyCount] = await Promise.all([
      playlistsIn.length > 0
        ? countUserRows(db, 'sync_playlists', user.id)
        : 0,
      likesIn.length > 0 ? countUserRows(db, 'sync_likes', user.id) : 0,
      historyIn.length > 0
        ? countUserRows(db, 'sync_history', user.id)
        : 0,
    ]);
  }
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
  let skippedNotOwned = 0;
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
    } else {
      itemCounts = await countItemsPerPlaylist(db, user.id, touchedIds);
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
    await db.batch(stmts);
  }
  return jsonOk({
    serverTime: now,
    // `applied` hanya menghitung pernyataan data (bukan
    // pembukuan penghitung/stempel) supaya artinya tetap
    // "entri yang diterapkan".
    applied: stmts.length - bookkeepingStmts,
    skippedNotOwned,
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

// ------------------------------------------------------------------
// Router
// ------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

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
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
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
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
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
        if (env.DB) {
          // Hapus eksplisit berurutan (tidak mengandalkan
          // ON DELETE CASCADE — penegakan FK D1 tidak dijamin).
          const db = env.DB;
          await db.batch([
            db
              .prepare(
                'DELETE FROM sync_playlist_items WHERE playlist_id IN (SELECT id FROM sync_playlists WHERE user_id = ?)',
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
            db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
            db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
          ]);
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
        if (
          await checkRateLimit(env, `sync:${user.id}`, RATE_SYNC_PER_MIN)
        ) {
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak sinkronisasi', cors);
          r.headers.set('Retry-After', '60');
          return r;
        }
        if (url.pathname === '/api/sync/pull') {
          if (request.method !== 'GET') {
            return jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
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
        const res = await handlePush(env, request, user);
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }

      return jsonError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan', cors);
    } catch (e) {
      console.warn(
        'sync worker error:',
        e instanceof Error ? e.message : 'unknown',
      );
      return jsonError(500, 'SERVER_ERROR', 'Kesalahan server', cors);
    }
  },
};
