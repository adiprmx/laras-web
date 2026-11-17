// Probe diagnostik 403 googlevideo, ronde 2 (S3, 17 Nov 2026).
// Ronde 1 membuktikan: URL segar + range 0 -> 206 (2/2); URL segar +
// range tengah pertama -> 403 (2/2). Langkah penentu ronde 1 (URL yang
// sudah melayani range 0, dipakai lagi untuk range tengah) TIMEOUT
// (120 detik), bukan 403 dan bukan 206: tidak meyakinkan.
// Ronde 2 menguji hipotesis pemanasan (warm-up) dengan dua varian:
// (a) pemanasan KECIL (range 0-999) lalu range tengah di URL yang sama;
// (b) bila (a) gagal, ulangi langkah penentu ronde 1 persis (range 0
// penuh 768 KiB lalu range tengah) sebagai sampel kedua.
// URL stream TIDAK PERNAH dicetak.
import { createResolver, resolveViaVr } from './resolve.bundle.mjs';

const SONG = { videoId: 'qkC4waEZVt4', title: 'Rahasia Hati', lengthSeconds: 251 };
const TIMEOUT_MS = 120000;

async function fetchRange(url, start, end) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, bytes: buf.length, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, bytes: 0, ms: Date.now() - t0, error: String(e).slice(0, 100) };
  }
}

function log(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}

const resolver = await createResolver();
log(`resolver siap: sts=${resolver.sts} visitorData=${resolver.visitorData ? 'ada' : 'tidak ada'}`);

// Varian (a): pemanasan kecil.
const u5 = await resolveViaVr(SONG, resolver.visitorData);
log(`URL5 segar (${u5.ms} ms)`);
const a1 = await fetchRange(u5.url, 0, 999);
log(`URL5 pemanasan range 0-999: HTTP ${a1.status} ${a1.bytes} byte ${a1.ms} ms${a1.error ? ` ERR ${a1.error}` : ''}`);
let warmupOk = false;
if (a1.status === 206) {
  const a2 = await fetchRange(u5.url, 786432, 1310719);
  log(`URL5 range tengah 786432-1310719 sesudah pemanasan kecil: HTTP ${a2.status} ${a2.bytes} byte ${a2.ms} ms${a2.error ? ` ERR ${a2.error}` : ''}`);
  warmupOk = a2.status === 206;
}

// Varian (b): ulangi langkah penentu ronde 1 persis, bila (a) gagal.
if (!warmupOk) {
  const u6 = await resolveViaVr(SONG, resolver.visitorData);
  log(`URL6 segar (${u6.ms} ms)`);
  const b1 = await fetchRange(u6.url, 0, 786431);
  log(`URL6 range 0-786431: HTTP ${b1.status} ${b1.bytes} byte ${b1.ms} ms${b1.error ? ` ERR ${b1.error}` : ''}`);
  if (b1.status === 206) {
    const b2 = await fetchRange(u6.url, 786432, 1310719);
    log(`URL6 range tengah 786432-1310719 sesudah range 0 penuh: HTTP ${b2.status} ${b2.bytes} byte ${b2.ms} ms${b2.error ? ` ERR ${b2.error}` : ''}`);
    warmupOk = b2.status === 206;
  }
}

log(warmupOk ? 'KESIMPULAN: pemanasan TERBUKTI (range tengah 206 sesudah range 0)' : 'KESIMPULAN: pemanasan TIDAK TERBUKTI ronde ini');
log('probe ronde 2 selesai');
