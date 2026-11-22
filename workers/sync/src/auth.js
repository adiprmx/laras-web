// Worker sync — Sesi + OAuth Google/GitHub + callback (P-SyncSplit).
// Dipindah verbatim dari index.js (P-SyncSplit); logika
// tidak berubah. Impor di bawah dihitung dari graf
// dependensi, bukan tebakan.

import {
  clientIp,
  parseCookies,
  randomTokenHex,
  sha256Hex,
} from './util.js';
import {
  identityHashFor,
  reRegisterCooldownMs,
  readDeletedIdentity,
  restoreFromTombstone,
} from './tombstones.js';
import {
  DELETED_IDENTITY_RETENTION_MS,
  FETCH_TIMEOUT_MS,
  GITHUB_AUTHORIZE,
  GITHUB_TOKEN,
  GITHUB_USER,
  GOOGLE_AUTHORIZE,
  GOOGLE_TOKEN,
  GOOGLE_USERINFO,
  RATE_AUTH_PER_MIN,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  STATE_COOKIE,
  STATE_MAX_AGE_SECONDS,
  VERIFIER_COOKIE,
} from './constants.js';
import { jsonError } from '../../shared/http.js';
import { logWarn } from '../../shared/log.js';
import { checkRateLimit } from '../../shared/rateLimit.js';

export function sessionCookieHeader(env, token, maxAge) {
  // SameSite=None (lihat catatan di kepala file) kecuali env
  // meminta Lax (deploy same-site di masa depan).
  const sameSite = env.COOKIE_SAMESITE === 'Lax' ? 'Lax' : 'None';
  return (
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=${sameSite}; ` +
    `Path=/; Max-Age=${maxAge}`
  );
}

export function clearSessionCookieHeader(env) {
  return sessionCookieHeader(env, '', 0);
}

export function stateCookieHeader(state, provider) {
  // State cookie hanya dipakai navigasi top-level (login ->
  // provider -> callback), jadi Lax cukup dan lebih ketat.
  return (
    `${STATE_COOKIE}=${state}.${provider}; HttpOnly; Secure; ` +
    `SameSite=Lax; Path=/api/auth; Max-Age=${STATE_MAX_AGE_SECONDS}`
  );
}

export function clearStateCookieHeader() {
  return (
    `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/api/auth; Max-Age=0`
  );
}

// ------------------------------------------------------------------
// PKCE S256 (P-Auth, OAuth 2.1 best practice)
// ------------------------------------------------------------------
// Verifier disimpan di cookie HttpOnly (seperti state cookie) —
// BUKAN di D1: callback tidak bergantung pada D1 untuk PKCE,
// dan logika state sekali pakai (DELETE atomik) tidak berubah.
// Verifier tidak pernah menyentuh JS (HttpOnly) dan hanya hidup
// 10 menit (sama dengan state).

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Verifier acak 64 byte -> base64url 86 karakter (batas PKCE 43-128). */
export function randomVerifier() {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Challenge S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

export function verifierCookieHeader(verifier) {
  return (
    `${VERIFIER_COOKIE}=${verifier}; HttpOnly; Secure; ` +
    `SameSite=Lax; Path=/api/auth; Max-Age=${STATE_MAX_AGE_SECONDS}`
  );
}

export function clearVerifierCookieHeader() {
  return (
    `${VERIFIER_COOKIE}=; HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/api/auth; Max-Age=0`
  );
}

export function appUrl(env) {
  return (env.APP_URL || 'https://laras.adipmusic.my.id').replace(/\/$/, '');
}

// P-SameSite: basis redirect URI OAuth. Default = origin worker
// (perilaku sekarang). Saat proxy same-origin aktif, set
// OAUTH_REDIRECT_BASE=https://laras.adipmusic.my.id supaya
// alur login berjalan lewat domain app dan cookie sesi diset
// dari domain app (same-site), bukan dari workers.dev — DAN
// daftarkan URI baru itu di konsol Google + GitHub (GitHub
// hanya mengizinkan SATU callback URL; lihat
// docs/same-site-sync.md). Tanpa pendaftaran itu, provider
// menolak authorize dengan redirect_uri_mismatch.
export function oauthRedirectBase(env, url) {
  const base = (env.OAUTH_REDIRECT_BASE || '').replace(/\/$/, '');
  return base || url.origin;
}

// (checkRateLimit + readCapped: modul bersama, lihat impor di atas.)

// ------------------------------------------------------------------
// Sesi
// ------------------------------------------------------------------

/** Cari pengguna dari cookie sesi; null bila tidak ada/kedaluwarsa. */
export async function authUser(env, request) {
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
    'SELECT id, display_name, provider, provider_id FROM users WHERE id = ?',
  )
    .bind(session.user_id)
    .first();
  if (!user) return null;
  // provider_id ikut dikembalikan untuk tombstone hapus akun
  // (S10: hash identitas) — TIDAK PERNAH diekspos ke respons
  // API (handler /api/auth/me hanya memetik display_name +
  // provider).
  return { sessionId: session.id, ...user };
}

/** Hapus satu sesi berdasarkan token mentahnya (rotasi saat login). */
export async function deleteSessionByToken(env, token) {
  if (!env.DB || !token) return;
  try {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256Hex(token))
      .run();
  } catch {
    // Abaikan: rotasi adalah pertahanan lapis kedua; kegagalan
    // hapus tidak boleh menggagalkan login.
  }
}

/** Hapus SEMUA sesi satu pengguna ("keluar dari semua perangkat"). */
export async function deleteAllSessions(env, userId) {
  if (!env.DB) return 0;
  const res = await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?')
    .bind(userId)
    .run();
  return res.meta?.changes ?? 0;
}

export async function createSession(env, userId) {
  const token = randomTokenHex(32);
  const hash = await sha256Hex(token);
  const now = Date.now();
  // Sapu malas sesi kedaluwarsa (G7): tanpa ini tabel sessions
  // tumbuh tanpa batas (1 baris/login). Satu pernyataan
  // best-effort per login — kegagalan diabaikan.
  try {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?')
      .bind(now)
      .run();
  } catch {
    // Abaikan: tabel mungkin belum termigrasi (fail-open).
  }
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

export function oauthConfig(env, provider) {
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
export async function storeOAuthState(env, state, provider) {
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
    logWarn('oauth state: gagal simpan', { error: e instanceof Error ? e.message : 'unknown' });
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
export async function consumeOAuthState(env, state, provider) {
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
    logWarn('oauth state: gagal pakai (fail-open, login dilanjutkan)', { error: e instanceof Error ? e.message : 'unknown' });
    return true;
  }
}

export function setupPendingPage(env) {
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

export async function handleLogin(request, env, url) {
  const provider = url.searchParams.get('provider') || '';
  if (provider !== 'google' && provider !== 'github') {
    return jsonError(400, 'BAD_PROVIDER', 'Penyedia tidak dikenal');
  }
  const config = oauthConfig(env, provider);
  if (!config.clientId || !config.clientSecret) {
    return setupPendingPage(env);
  }
  const ip = clientIp(env, request);
  if (await checkRateLimit(env, `auth:${ip}`, RATE_AUTH_PER_MIN)) {
    const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak percobaan masuk');
    r.headers.set('Retry-After', '60');
    return r;
  }
  const state = randomTokenHex(16);
  // S6: catat state di server supaya callback bisa menolak
  // pemakaian ulang (single-use).
  await storeOAuthState(env, state, provider);
  // PKCE (P-Auth): verifier di cookie, challenge S256 di URL.
  // Bila kode bocor (log, referer, riwayat), penyerang tetap
  // tidak bisa menukarnya tanpa verifier.
  const verifier = randomVerifier();
  const challenge = await pkceChallenge(verifier);
  const redirectUri = `${oauthRedirectBase(env, url)}/api/auth/callback`;
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  // Dua cookie dikirim sebagai dua header Set-Cookie terpisah
  // (menggabungkan dengan koma tidak valid untuk Set-Cookie).
  const headers = new Headers();
  headers.set('Location', `${config.authorizeUrl}?${params}`);
  headers.append('Set-Cookie', stateCookieHeader(state, provider));
  headers.append('Set-Cookie', verifierCookieHeader(verifier));
  return new Response(null, { status: 302, headers });
}

export async function exchangeCode(env, provider, code, redirectUri, verifier) {
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
        code_verifier: verifier,
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
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.access_token || null;
}

export async function fetchProfile(provider, accessToken) {
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

export async function handleCallback(request, env, url) {
  const base = appUrl(env);
  // fail() membersihkan KEDUA cookie sekali pakai (state +
  // verifier) supaya percobaan gagal tidak meninggalkan verifier
  // yang bisa dipakai ulang.
  const fail = (reason, extraParams = '') => {
    const headers = new Headers();
    headers.set(
      'Location',
      `${base}/settings?auth=error&reason=${reason}${extraParams}`,
    );
    headers.append('Set-Cookie', clearStateCookieHeader());
    headers.append('Set-Cookie', clearVerifierCookieHeader());
    return new Response(null, { status: 302, headers });
  };
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
  // PKCE (P-Auth): verifier WAJIB ada sebelum state dipakai —
  // tanpa verifier, tukar kode pasti ditolak provider (challenge
  // sudah dikirim di login). Gagal di sini TIDAK membakar state.
  const verifier = cookies[VERIFIER_COOKIE] || '';
  if (!verifier) return fail('pkce');
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
  const redirectUri = `${oauthRedirectBase(env, url)}/api/auth/callback`;
  let accessToken = null;
  try {
    accessToken = await exchangeCode(env, provider, code, redirectUri, verifier);
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
    // S10b/c: identitas yang baru saja menghapus akun tidak bisa
    // langsung daftar lagi (cooldown 24 jam), dan bila cooldown
    // sudah lewat, anggaran + stempel lama diwariskan (bukan
    // di-reset). Tombstone hanya hash + angka (tanpa data pribadi).
    const identityHash = await identityHashFor(provider, profile.providerId);
    try {
      // Sapu malas tombstone >30 hari (1 pernyataan best-effort).
      await env.DB.prepare(
        'DELETE FROM sync_deleted_identities WHERE deleted_at < ?',
      )
        .bind(now - DELETED_IDENTITY_RETENTION_MS)
        .run();
    } catch {
      // Abaikan: tabel mungkin belum termigrasi (fail-open).
    }
    const tombstone = await readDeletedIdentity(env, identityHash);
    // Blue 7 (S13): cooldown SEBANDING ukuran akun yang dihapus
    // (24 jam + 1 hari per 20.000 baris di atas 20.000, maks
    // 30 hari). Redirect membawa tanggal buka kunci (ISO
    // YYYY-MM-DD, UTC) supaya pesan klien menyebut tanggal itu —
    // "masuk lagi besok" akan berbohong untuk cooldown panjang.
    if (tombstone) {
      const cooldownMs = reRegisterCooldownMs(tombstone.deletedRows);
      if (now - tombstone.deletedAt < cooldownMs) {
        const unlockDate = new Date(tombstone.deletedAt + cooldownMs)
          .toISOString()
          .slice(0, 10);
        return fail('deleted-recently', `&until=${unlockDate}`);
      }
    }
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO users (id, provider, provider_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, provider, profile.providerId, displayName, now)
      .run();
    user = { id };
    if (tombstone) {
      await restoreFromTombstone(env, id, identityHash, tombstone, now);
    }
  } else if (user.display_name !== displayName) {
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .bind(displayName, user.id)
      .run();
  }
  // Rotasi sesi (P-Auth): bila request ini membawa sesi lama
  // (masuk ulang di browser yang sama), sesi lama dimatikan
  // SEBELUM sesi baru dibuat — satu login = satu token aktif
  // per browser. Tanpa ini, token lama tetap hidup 30 hari.
  const oldToken = cookies[SESSION_COOKIE] || '';
  if (oldToken) await deleteSessionByToken(env, oldToken);
  const token = await createSession(env, user.id);
  // Cookie dikirim sebagai header Set-Cookie terpisah
  // (menggabungkan dengan koma tidak valid untuk Set-Cookie).
  const headers = new Headers();
  headers.set('Location', `${base}/settings?auth=ok`);
  headers.append('Set-Cookie', sessionCookieHeader(env, token, SESSION_MAX_AGE_SECONDS));
  headers.append('Set-Cookie', clearStateCookieHeader());
  headers.append('Set-Cookie', clearVerifierCookieHeader());
  return new Response(null, { status: 302, headers });
}
