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
// + 0003_item_meta.sql. Worker ini WAJIB di-deploy sesudah ketiga
// migrasi diterapkan (SQL push/pull memakai kolom title/artist
// dari 0003).
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
//   tarik maks 1000 baris per koleksi, rate limit D1 (fail-open).
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
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    },
  );
}

function jsonOk(data, extraHeaders = {}) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
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
    if (name) out[name] = decodeURIComponent(rest.join('=') || '');
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
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
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

  // Playlist: id server = clientId (deterministik per perangkat
  // pembuat; LWW + tiebreak device_id seperti yang terbukti S8).
  for (const p of body.playlists || []) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO sync_playlists (id, user_id, client_id, nama, deskripsi, device_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET nama = excluded.nama, deskripsi = excluded.deskripsi, device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = NULL WHERE excluded.updated_at > sync_playlists.updated_at OR (excluded.updated_at = sync_playlists.updated_at AND excluded.device_id > sync_playlists.device_id)',
        )
        .bind(p.clientId, user.id, p.clientId, p.nama, p.deskripsi ?? null, deviceId, now),
    );
  }
  for (const d of body.deletedPlaylists || []) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO sync_playlists (id, user_id, client_id, nama, deskripsi, device_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at WHERE excluded.updated_at > sync_playlists.updated_at OR (excluded.updated_at = sync_playlists.updated_at AND excluded.device_id > sync_playlists.device_id)',
        )
        .bind(d.clientId, user.id, d.clientId, '', null, deviceId, now, now),
    );
  }
  for (const item of body.playlistItems || []) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO sync_playlist_items (playlist_id, video_id, posisi, added_at, device_id, updated_at, deleted_at, title, artist) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(playlist_id, video_id) DO UPDATE SET posisi = excluded.posisi, device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = NULL, title = excluded.title, artist = excluded.artist WHERE excluded.updated_at > sync_playlist_items.updated_at OR (excluded.updated_at = sync_playlist_items.updated_at AND excluded.device_id > sync_playlist_items.device_id)',
        )
        .bind(item.playlistClientId, item.videoId, item.posisi, now, deviceId, now, item.title ?? null, item.artist ?? null),
    );
  }
  for (const d of body.deletedPlaylistItems || []) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO sync_playlist_items (playlist_id, video_id, posisi, added_at, device_id, updated_at, deleted_at) VALUES (?, ?, 0, ?, ?, ?, ?) ON CONFLICT(playlist_id, video_id) DO UPDATE SET device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at WHERE excluded.updated_at > sync_playlist_items.updated_at OR (excluded.updated_at = sync_playlist_items.updated_at AND excluded.device_id > sync_playlist_items.device_id)',
        )
        .bind(d.playlistClientId, d.videoId, now, deviceId, now, now),
    );
  }
  for (const like of body.likes || []) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO sync_likes (user_id, video_id, liked_at, device_id, updated_at, deleted_at, title, artist) VALUES (?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(user_id, video_id) DO UPDATE SET liked_at = excluded.liked_at, device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = NULL, title = excluded.title, artist = excluded.artist WHERE excluded.updated_at > sync_likes.updated_at OR (excluded.updated_at = sync_likes.updated_at AND excluded.device_id > sync_likes.device_id)',
        )
        .bind(user.id, like.videoId, like.likedAt, deviceId, now, like.title ?? null, like.artist ?? null),
    );
  }
  for (const d of body.deletedLikes || []) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO sync_likes (user_id, video_id, liked_at, device_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, video_id) DO UPDATE SET device_id = excluded.device_id, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at WHERE excluded.updated_at > sync_likes.updated_at OR (excluded.updated_at = sync_likes.updated_at AND excluded.device_id > sync_likes.device_id)',
        )
        .bind(user.id, d.videoId, now, deviceId, now, now),
    );
  }
  for (const h of body.history || []) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO sync_history (user_id, video_id, played_at, seconds_played, device_id, updated_at, title, artist) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, video_id, played_at) DO UPDATE SET seconds_played = max(sync_history.seconds_played, excluded.seconds_played), device_id = excluded.device_id, updated_at = excluded.updated_at, title = excluded.title, artist = excluded.artist',
        )
        .bind(user.id, h.videoId, h.playedAt, h.secondsPlayed, deviceId, now, h.title ?? null, h.artist ?? null),
    );
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
  if (body.historyClearedBefore) {
    stmts.push(
      db
        .prepare('DELETE FROM sync_history WHERE user_id = ? AND played_at <= ?')
        .bind(user.id, body.historyClearedBefore),
    );
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
  return jsonOk({ serverTime: now, applied: stmts.length });
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
