/**
 * Validasi URL dari jaringan sebelum dipakai (port `url_allowlist.dart`
 * APK, R1-M1 + R1-L2).
 *
 * Semua jalur yang menerima URL dari respons InnerTube atau dari solver
 * WAJIB lewat sini sebelum URL itu dipakai. Aturan: skema HTTPS, tanpa
 * userinfo, host `googlevideo.com` atau subdomainnya untuk stream audio.
 */
function isAllowedHost(rawUrl: string, allowedBases: string[]): boolean {
  let uri: URL;
  try {
    uri = new URL(rawUrl);
  } catch {
    return false;
  }
  if (uri.protocol !== 'https:') return false;
  if (uri.username !== '' || uri.password !== '') return false;
  const host = uri.hostname.toLowerCase();
  if (host === '') return false;
  for (const base of allowedBases) {
    // Persis `googlevideo.com.evil.com` dan `evilgooglevideo.com` harus
    // ditolak: yang lolos hanya host yang sama persis atau subdomain
    // (dipisah titik) dari basis yang diizinkan.
    if (host === base || host.endsWith(`.${base}`)) return true;
  }
  return false;
}

/** Benar bila `rawUrl` adalah URL stream audio yang boleh diputar. */
export function isAllowedStreamUrl(rawUrl: string): boolean {
  return isAllowedHost(rawUrl, ['googlevideo.com']);
}

/** Benar bila `rawUrl` adalah URL thumbnail yang boleh di-fetch. */
export function isAllowedThumbnailUrl(rawUrl: string): boolean {
  return isAllowedHost(rawUrl, [
    'ytimg.com',
    'googleusercontent.com',
    'ggpht.com',
  ]);
}
