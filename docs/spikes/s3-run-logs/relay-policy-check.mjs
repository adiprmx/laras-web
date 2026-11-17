// Uji kebijakan adaptasi jendela relay.ts (perbaikan S3, 17 Nov 2026).
// Deterministik: fetch upstream di-mock, tanpa jaringan.
// Dijalankan sesudah bundle: esbuild relay.ts -> relay.bundle.mjs,
// lalu node relay-policy-check.mjs. Keluar non-nol bila asersi gagal.
import { GooglevideoRelay } from './relay.bundle.mjs';

const TOTAL = 5000000;
const SONG = { videoId: 'qkC4waEZVt4', title: 'Rahasia Hati', lengthSeconds: 251 };

function makeRes(status, start, end) {
  const len = status === 206 ? end - start + 1 : 0;
  return {
    status,
    headers: {
      get: (n) =>
        n.toLowerCase() === 'content-range' && status === 206
          ? `bytes ${start}-${end}/${TOTAL}`
          : null,
    },
    arrayBuffer: async () => new ArrayBuffer(len),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'LOLOS' : 'GAGAL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) failures++;
}

/** Pasang mock fetch: url yang tercantum di badUrls selalu 403. */
function installMock(badUrls) {
  globalThis.fetch = async (url, opts) => {
    const m = /bytes=(\d+)-(\d+)/.exec(opts?.headers?.Range ?? '');
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m ? parseInt(m[2], 10) : 0;
    if (badUrls.has(url)) return makeRes(403, start, end);
    return makeRes(206, start, end);
  };
}

/** Reresolve stub: mengembalikan URL segar dari daftar goodUrls. */
function makeReresolve(goodUrls) {
  let i = 0;
  return async () => ({ url: goodUrls[i++ % goodUrls.length], ms: 5 });
}

// Skenario 1: URL awal 403, URL segar 206.
// Harapan: jendela TETAP 786432 (tidak dipotong), adaptasi kosong.
{
  installMock(new Set(['https://bad-a.googlevideo.com/x']));
  const relay = new GooglevideoRelay(
    SONG, 251, 'audio/webm',
    'https://bad-a.googlevideo.com/x',
    makeReresolve(['https://good-b.googlevideo.com/x', 'https://good-c.googlevideo.com/x', 'https://good-d.googlevideo.com/x']),
  );
  await relay.serve('bytes=0-');
  await sleep(500);
  check('S1 jendela tetap 786432 sesudah 403 sekali', relay.currentWindowSize === 786432, `window=${relay.currentWindowSize}`);
  check('S1 tanpa adaptasi (tanpa pemotongan)', relay.stats.adaptations.length === 0, `adaptasi=[${relay.stats.adaptations.join('; ')}]`);
  check('S1 tepat 1 kegagalan tercatat', relay.stats.failures.length === 1, `gagal=${relay.stats.failures.length}`);
  check('S1 re-resolve terjadi', relay.stats.reresolves >= 1, `re-resolve=${relay.stats.reresolves}`);
  check('S1 total byte diketahui', relay.total === TOTAL, `total=${relay.total}`);
}

// Skenario 2: URL awal 403 DAN URL segar pertama juga 403.
// Harapan: jendela dipotong ke 393216 pada percobaan ke-3, lalu
// dikembalikan ke 786432 sesudah 2 sukses beruntun (prefetch).
{
  installMock(new Set(['https://bad-a.googlevideo.com/x', 'https://bad-b.googlevideo.com/x']));
  const relay = new GooglevideoRelay(
    SONG, 251, 'audio/webm',
    'https://bad-a.googlevideo.com/x',
    makeReresolve(['https://bad-b.googlevideo.com/x', 'https://good-c.googlevideo.com/x', 'https://good-d.googlevideo.com/x', 'https://good-e.googlevideo.com/x']),
  );
  await relay.serve('bytes=0-');
  await sleep(800);
  const joined = relay.stats.adaptations.join(' | ');
  check('S2 jendela dipotong ke 393216', joined.includes('dipotong ke 393216'), joined);
  check('S2 jendela dikembalikan ke 786432', joined.includes('dikembalikan ke 786432'), joined);
  check('S2 jendela akhir 786432', relay.currentWindowSize === 786432, `window=${relay.currentWindowSize}`);
  check('S2 tepat 2 kegagalan tercatat', relay.stats.failures.length === 2, `gagal=${relay.stats.failures.length}`);
  check('S2 byte terlayani > 0', relay.stats.servedBytes > 0, `served=${relay.stats.servedBytes}`);
}

// Skenario 3: semua URL 403 -> fetch gagal 3x dan melempar.
{
  installMock(new Set(['https://bad-a.googlevideo.com/x', 'https://bad-b.googlevideo.com/x', 'https://bad-c.googlevideo.com/x']));
  const relay = new GooglevideoRelay(
    SONG, 251, 'audio/webm',
    'https://bad-a.googlevideo.com/x',
    makeReresolve(['https://bad-b.googlevideo.com/x', 'https://bad-c.googlevideo.com/x', 'https://bad-a.googlevideo.com/x']),
  );
  let threw = false;
  try {
    await relay.serve('bytes=0-');
  } catch (e) {
    threw = String(e).includes('gagal 3x');
  }
  check('S3 gagal 3x melempar error', threw);
  check('S3 tepat 3 kegagalan tercatat', relay.stats.failures.length === 3, `gagal=${relay.stats.failures.length}`);
}

// Skenario 4: re-resolve anggaran GAGAL sekali (timeout) lalu sukses.
// Harapan: jendela ke-2 tetap terlayani (kegagalan re-resolve dicoba
// ulang, bukan membunuh jendela). Bug rangkaian S3 17 Nov 2026.
{
  installMock(new Set());
  let reresolveCalls = 0;
  const flakyReresolve = async () => {
    reresolveCalls++;
    if (reresolveCalls === 1) {
      throw new Error('TimeoutError: The operation was aborted due to timeout');
    }
    return { url: 'https://good-r.googlevideo.com/x', ms: 5 };
  };
  const relay = new GooglevideoRelay(
    SONG, 251, 'audio/webm',
    'https://good-a.googlevideo.com/x',
    flakyReresolve,
  );
  await relay.serve('bytes=0-');
  await sleep(800);
  // Prefetch jendela ke-2 berjalan di latar (bukan lewat serve, jadi
  // yang diuji adalah upstreamBytes + layani eksplisit dari cache).
  check('S4 jendela ke-2 terambil upstream walau re-resolve sempat gagal', relay.stats.upstreamBytes >= 786432 * 2, `upstream=${relay.stats.upstreamBytes}`);
  const served2 = await relay.serve('bytes=786432-');
  check('S4 jendela ke-2 terlayani dari cache', served2.fromCache === true && served2.body.length === 786432, `fromCache=${served2.fromCache} len=${served2.body.length}`);
  check('S4 kegagalan re-resolve tercatat', relay.stats.failures.length >= 1, `gagal=${relay.stats.failures.length}`);
  check('S4 re-resolve akhirnya sukses', relay.stats.reresolves >= 1, `re-resolve=${relay.stats.reresolves}`);
}

// Skenario 5: fetch selalu 403 DAN re-resolve selalu gagal.
// Harapan: tetap melempar 'gagal 3x' sesudah 3 percobaan (tidak lolos
// tanpa kendali dari catch), kegagalan re-resolve tercatat.
{
  installMock(new Set(['https://bad-a.googlevideo.com/x']));
  const relay = new GooglevideoRelay(
    SONG, 251, 'audio/webm',
    'https://bad-a.googlevideo.com/x',
    async () => { throw new Error('TimeoutError: The operation was aborted due to timeout'); },
  );
  let threw = false;
  try {
    await relay.serve('bytes=0-');
  } catch (e) {
    threw = String(e).includes('gagal 3x');
  }
  check('S5 gagal 3x melempar walau re-resolve selalu gagal', threw);
  check('S5 kegagalan fetch tercatat 3x', relay.stats.failures.filter((f) => f.includes('percobaan=')).length === 3, `gagal=[${relay.stats.failures.join(' | ')}]`);
  check('S5 kegagalan re-resolve tercatat', relay.stats.failures.some((f) => f.includes('re-resolve gagal')), `gagal=[${relay.stats.failures.join(' | ')}]`);
}

console.log(failures === 0 ? 'SEMUA ASEPSI LOLOS' : `${failures} ASEPSI GAGAL`);
process.exit(failures === 0 ? 0 : 1);
