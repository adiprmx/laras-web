// Helper HTTP bersama worker Laras (P-Shared, Koordinator #18).
//
// Sebelumnya diduplikasi verbatim di workers/proxy/src/index.js dan
// workers/sync/src/index.js — drift sudah terjadi (sync menambah
// nosniff, proxy tidak). Satu sumber kebenaran di sini; kedua worker
// mengimpor lewat path relatif dan deploy membundelnya dengan
// esbuild (deploy_proxy.py / deploy_sync.py), jadi impor lintas
// direktori aman.
//
// Aturan: modul ini TIDAK BOLEH mengimpor dari worker mana pun
// (tidak ada dependensi balik ke proxy/ atau sync/).

/** Cap body POST 1 MB (dipakai kedua worker). */
export const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Origin bawaan bila env.ALLOWED_ORIGINS tidak diset. */
const DEFAULT_ALLOWED_ORIGIN = 'https://laras.adipmusic.my.id';

/** Daftar origin yang diizinkan dari env (koma-dipisah, di-trim). */
export function parseAllowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGIN)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Header CORS respons: selalu `Vary: Origin`; `Access-Control-
 * Allow-Origin` hanya bila Origin request ada di allowlist.
 * `options.credentials` menambah `Access-Control-Allow-Credentials`
 * — HANYA untuk sync (cookie sesi); proxy tidak memakai kredensial
 * sehingga memanggil tanpa opsi (perilaku lama dipertahankan).
 */
export function corsHeaders(env, request, options = {}) {
  const origin = request.headers.get('Origin') || '';
  const allowed = parseAllowedOrigins(env);
  const h = { Vary: 'Origin' };
  if (allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    if (options.credentials) h['Access-Control-Allow-Credentials'] = 'true';
  }
  return h;
}

/**
 * Respons galat JSON standar: { success: false, error: { code,
 * message } }. Selalu membawa nosniff (dulu hanya sync; proxy
 * kini ikut — pengetatan keamanan, tanpa perubahan perilaku klien).
 */
export function jsonError(status, code, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

// Baca body dengan cap: kembalikan { tooBig: true } bila melewati
// cap, TANPA mem-buffer seluruh body (stream dibatalkan begitu cap
// terlampaui). Dipakai untuk respons upstream DAN body request
// (Red 1 S1); pemanggil yang memutuskan kode galatnya (502/413).
export async function readCapped(body, capBytes) {
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
