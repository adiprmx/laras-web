// Probe diagnostik 403 googlevideo (S3, 17 Nov 2026).
// Tujuan: membedakan tiga hipotesis atas 403 rangkaian S3:
// (a) sensitif terhadap awal range (range 0 lolos, range tengah 403),
// (b) acak per URL (URL segar kadang 403 kadang 206),
// (c) memburuk seiring waktu/kuota IP (awal lolos, kemudian 403 semua).
// Dijalankan SESUDAH rangkaian formal, agar tidak mencemari kuota IP
// yang sama. URL stream TIDAK PERNAH dicetak (hanya host tersamar).
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

// Langkah 1: URL segar 1, range awal 0-786431.
const u1 = await resolveViaVr(SONG, resolver.visitorData);
log(`URL1 segar (${u1.ms} ms)`);
const r1 = await fetchRange(u1.url, 0, 786431);
log(`URL1 range 0-786431: HTTP ${r1.status} ${r1.bytes} byte ${r1.ms} ms${r1.error ? ` ERR ${r1.error}` : ''}`);

// Langkah 2: URL segar 2, range TENGAH 786432-1572863 (tanpa range 0 dulu).
const u2 = await resolveViaVr(SONG, resolver.visitorData);
log(`URL2 segar (${u2.ms} ms)`);
const r2 = await fetchRange(u2.url, 786432, 1572863);
log(`URL2 range 786432-1572863: HTTP ${r2.status} ${r2.bytes} byte ${r2.ms} ms${r2.error ? ` ERR ${r2.error}` : ''}`);

// Langkah 3: URL segar 3, range awal lagi (uji pengulangan hipotesis a).
const u3 = await resolveViaVr(SONG, resolver.visitorData);
log(`URL3 segar (${u3.ms} ms)`);
const r3 = await fetchRange(u3.url, 0, 786431);
log(`URL3 range 0-786431: HTTP ${r3.status} ${r3.bytes} byte ${r3.ms} ms${r3.error ? ` ERR ${r3.error}` : ''}`);

// Langkah 4: URL segar 4, range tengah lagi.
const u4 = await resolveViaVr(SONG, resolver.visitorData);
log(`URL4 segar (${u4.ms} ms)`);
const r4 = await fetchRange(u4.url, 786432, 1572863);
log(`URL4 range 786432-1572863: HTTP ${r4.status} ${r4.bytes} byte ${r4.ms} ms${r4.error ? ` ERR ${r4.error}` : ''}`);

// Langkah 5: bila URL1 lolos, pakai URL1 yang SAMA untuk range tengah
// 512 KiB (total pemakaian URL1 tetap di bawah anggaran 1 MiB).
if (r1.status === 206) {
  const r5 = await fetchRange(u1.url, 786432, 1310719);
  log(`URL1 ulang range 786432-1310719: HTTP ${r5.status} ${r5.bytes} byte ${r5.ms} ms${r5.error ? ` ERR ${r5.error}` : ''}`);
} else {
  log('URL1 ulang DILEWATI (URL1 tidak 206)');
}

log('probe selesai');
