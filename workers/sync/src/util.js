// Worker sync — Utilitas kecil tanpa dependensi lokal (P-SyncSplit).
// Dipindah verbatim dari index.js (P-SyncSplit); logika
// tidak berubah. Impor di bawah dihitung dari graf
// dependensi, bukan tebakan.

export function jsonOk(data, extraHeaders = {}) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function parseCookies(request) {
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

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomTokenHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------
// P-SameSite: IP klien untuk rate limit + perbandingan rahasia.
// ------------------------------------------------------------------

/** Perbandingan string waktu-konstan (Workers tidak punya timingSafeEqual). */
export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * IP klien untuk kunci rate limit. Bila request datang lewat
 * proxy Pages Functions same-origin, IP asli diteruskan di
 * header X-Laras-Forwarded-IP — DIPERCAYA hanya bila header
 * X-Laras-Proxy-Secret cocok dengan secret PROXY_SECRET.
 * Tanpa secret yang terpasang (keadaan sekarang), header
 * terusan DIABAIKAN (fail-closed): penyerang tidak bisa
 * memalsukan IP untuk mengelak rate limit. Tanpa proxy, semua
 * pengguna berbagi satu IP egress proxy dan rate limit
 * per-IP menjadi tidak berguna — karena itu secret ini WAJIB
 * dipasang bersamaan dengan aktivasi proxy (lihat
 * docs/same-site-sync.md).
 */
export function clientIp(env, request) {
  const secret = env.PROXY_SECRET || '';
  if (secret) {
    const forwarded = request.headers.get('X-Laras-Forwarded-IP') || '';
    const presented = request.headers.get('X-Laras-Proxy-Secret') || '';
    if (
      forwarded &&
      presented &&
      timingSafeEqualString(presented, secret)
    ) {
      return forwarded;
    }
  }
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/** Detik sampai 00:00 UTC berikutnya (Retry-After anggaran harian). */
export function secondsUntilMidnightUtc(nowMs) {
  const d = new Date(nowMs);
  const nextMidnight = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((nextMidnight - nowMs) / 1000));
}
