// Observabilitas bersama worker Laras (P-Shared, Koordinator #18):
// log terstruktur satu baris JSON (P-Health), id korelasi request,
// dan cek D1 untuk /health. Sebelumnya diduplikasi verbatim di
// kedua worker. Modul ini TIDAK BOLEH mengimpor dari worker mana
// pun (tidak ada dependensi balik ke proxy/ atau sync/).

// Log terstruktur satu baris JSON (P-Health): level, pesan, stempel
// waktu, + field tambahan. JANGAN catat IP, kunci, token, atau
// body. Log tidak pernah melempar — kegagalan mencatat tidak boleh
// mematikan request.
export function logJson(level, msg, fields = {}) {
  try {
    const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...fields });
    if (level === 'warn') console.warn(line);
    else console.log(line);
  } catch {
    /* abaikan */
  }
}
export function logWarn(msg, fields = {}) {
  logJson('warn', msg, fields);
}
export function logInfo(msg, fields = {}) {
  logJson('info', msg, fields);
}

// Id korelasi request: pakai CF-Ray bila ada (id asli Cloudflare),
// kalau tidak, UUID acak. Dikirim balik sebagai header x-request-id
// dan dicatat di log supaya satu request bisa dilacak ujung-ke-ujung.
export function newRequestId(request) {
  return (
    request.headers.get('CF-Ray') ||
    (globalThis.crypto?.randomUUID?.() ??
      `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  );
}

// Cek D1 dengan query ringan. Kembalikan 'ok' | 'fail' | 'unbound'.
export async function checkDb(env) {
  if (!env.DB) return 'unbound';
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return 'ok';
  } catch {
    return 'fail';
  }
}
