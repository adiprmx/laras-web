// Proxy Pages Functions same-origin: /api/* -> sync worker (P-SameSite).
//
// KENAPA ADA: cookie sesi saat ini SameSite=None (lintas situs:
// laras.adipmusic.my.id -> laras-sync.*.workers.dev) karena
// zone adipmusic.my.id ada di akun Cloudflare BERBEDA dengan
// worker sync — route/custom domain lintas akun TIDAK BISA
// (Cloudflare mewajibkan zone satu akun dengan worker).
// Proxy ini membuat API same-origin: app memanggil /api/*
// di domainnya sendiri, cookie bisa SameSite=Lax.
//
// PENEMPATAN: file ini TIDAK AKTIF sampai aktivasi eksplisit
// (lihat docs/same-site-sync.md). Wrangler mengunggah folder
// `functions/` yang ada di CWD saat `wrangler pages deploy`
// — karena itu pohon ini disimpan di workers/pages-api-proxy/
// (BUKAN di root repo), supaya deploy biasa tidak pernah
// mengaktifkannya tanpa sengaja. Aktivasi = salin pohon
// functions/ ini ke root repo, lalu deploy.
//
// KONTRAK:
// - Teruskan method, path + query, semua header (kecuali Host),
//   dan body apa adanya ke upstream.
// - Teruskan IP klien asli di X-Laras-Forwarded-IP + bukti
//   proxy di X-Laras-Proxy-Secret (env LARAS_PROXY_SECRET).
//   Upstream hanya percaya IP terusan bila secret-nya cocok
//   (lihat clientIp di workers/sync/src/util.js).
// - JANGAN ikuti redirect (redirect: 'manual'): respons 302
//   OAuth harus sampai ke browser apa adanya.
// - Teruskan SEMUA header respons termasuk Set-Cookie GANDA
//   (sesi + state + verifier) — getSetCookie + append.
// - Upstream mati -> 502 envelope (bukan 500 polos) supaya
//   app memetakannya ke galat sync generik.

export const UPSTREAM_BASE =
  'https://laras-sync.hiroohengkerr.workers.dev';
export const FORWARDED_IP_HEADER = 'X-Laras-Forwarded-IP';
export const PROXY_SECRET_HEADER = 'X-Laras-Proxy-Secret';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const upstream = new URL(UPSTREAM_BASE + url.pathname + url.search);

  const headers = new Headers(request.headers);
  headers.delete('host');
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set(FORWARDED_IP_HEADER, clientIp);
  if (env.LARAS_PROXY_SECRET) {
    headers.set(PROXY_SECRET_HEADER, env.LARAS_PROXY_SECRET);
  }

  const init = {
    method: request.method,
    headers,
    // JANGAN ikuti redirect: 302 OAuth (login/callback) harus
    // sampai ke browser apa adanya.
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  let res;
  try {
    res = await fetch(upstream, init);
  } catch {
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Server sinkron tidak bisa dihubungi' },
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  }

  // Teruskan semua header; Set-Cookie ditangani terpisah
  // karena bisa muncul BERKALI-KALI (sesi + state + verifier)
  // dan Headers.set() akan menimpa yang sebelumnya.
  const outHeaders = new Headers();
  for (const [k, v] of res.headers.entries()) {
    if (k.toLowerCase() === 'set-cookie') continue;
    outHeaders.set(k, v);
  }
  for (const c of res.headers.getSetCookie()) {
    outHeaders.append('Set-Cookie', c);
  }
  return new Response(res.body, { status: res.status, headers: outHeaders });
}
