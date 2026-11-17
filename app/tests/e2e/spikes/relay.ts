// Relay Range googlevideo untuk harness spike S3/S5.
//
// LATAR: dari IP VM, egress ke googlevideo tidak bisa dipercaya:
// request Range terbuka (bytes=0-, persis yang dikirim Chromium) dan
// request tanpa Range dibalas 403, 0 byte; request Range kecil
// (<=768 KiB) dibalas 206 + byte audio asli; sesudah ~1 MiB dari satu
// URL, request berikut 403 (dinding per-URL, bukti APK P1 + prototipe
// spike 17 Nov 2026). Browser di VM bahkan gagal di terowongan proxy
// (net::ERR_TUNNEL_CONNECTION_FAILED). Karena itu jalur LANGSUNG
// <audio src=googlevideo> TIDAK BISA diuji dari VM.
//
// Relay ini HANYA alat uji: ia mengambil byte dari googlevideo lewat
// request Range kecil di sisi Node (yang terbukti 206), lalu melayani
// browser lewat page.route. Byte yang sampai ke <audio> adalah byte
// Opus ASLI lagu yang di-resolve, sehingga rantai decode dan putar
// terbukti dengan byte nyata. Relay TIDAK BOLEH masuk ke aplikasi:
// arsitektur v1 melarang proxy audio untuk streaming (§9).
//
// Perilaku relay:
// - Satu antrean serial untuk semua fetch upstream (request bersamaan
//   ke URL yang sama memicu 403 non-deterministik).
// - Anggaran 1 MiB per URL: sebelum melewati anggaran, relay me-resolve
//   URL segar untuk lagu yang sama (inilah mekanisme re-resolve tengah
//   lagu yang dituntut arsitektur §3.3, dibuktikan end-to-end di sini).
// - Ukuran jendela adaptif: mulai 768 KiB. Bila upstream 403, relay
//   mencoba URL segar dengan ukuran jendela YANG SAMA dulu (403
//   non-deterministik sering spesifik per URL, bukan per ukuran);
//   hanya bila URL segar itu juga 403, jendela dipotong setengah
//   (384, 192 KiB) + re-resolve. Sesudah 2 sukses beruntun, jendela
//   dikembalikan ke 768 KiB agar throughput pulih di atas kecepatan
//   konsumsi audio. Kebijakan ini perbaikan 17 Nov 2026 atas diagnosis
//   rangkaian S3 pertama: pemotongan langsung ke 192 KiB membuat
//   throughput jatuh di bawah konsumsi dan pemutaran kehabisan buffer.
// - Semua kegagalan re-resolve (anggaran maupun sesudah 403) dicoba
//   ulang seperti kegagalan fetch; satu timeout re-resolve tidak boleh
//   membunuh jendela (bug ditemukan rangkaian S3 17 Nov 2026: re-resolve
//   anggaran di luar try membuat satu player POST timeout 60 detik
//   langsung menggagalkan lagu penuh).
// - Cache jendela di memori + prefetch 2 jendela ke depan (serial).
//
// URL stream TIDAK PERNAH dicetak ke log.
import type { CanarySong } from './canary';

export interface RelayStats {
  upstreamFetches: number;
  upstreamMs: number;
  upstreamBytes: number;
  servedRequests: number;
  servedBytes: number;
  cacheHits: number;
  reresolves: number;
  reresolveReasons: string[];
  adaptations: string[];
  failures: string[];
}

export interface ServedRange {
  status: 206;
  headers: Record<string, string>;
  body: Buffer;
  fromCache: boolean;
}

/** Anggaran byte per URL (dinding googlevideo ~1 MiB, bukti APK P1). */
const URL_BYTE_BUDGET = 1048576;
/** Jendela layan awal. 768 KiB terbukti 206 (probe 17 Nov 2026). */
const INITIAL_WINDOW = 786432;
/** Jendela terkecil sesudah adaptasi. */
const MIN_WINDOW = 131072;
/** Timeout satu fetch upstream (egress VM lambat, terukur s.d. 38 detik). */
const UPSTREAM_TIMEOUT_MS = 120000;

export type ReresolveFn = () => Promise<{ url: string; ms: number }>;

export class GooglevideoRelay {
  readonly song: CanarySong;
  readonly itag: number;
  readonly mimeType: string;
  readonly stats: RelayStats = {
    upstreamFetches: 0,
    upstreamMs: 0,
    upstreamBytes: 0,
    servedRequests: 0,
    servedBytes: 0,
    cacheHits: 0,
    reresolves: 0,
    reresolveReasons: [],
    adaptations: [],
    failures: [],
  };

  private url: string;
  private readonly reresolve: ReresolveFn;
  private totalBytes: number | null = null;
  private windowSize = INITIAL_WINDOW;
  /** Sukses fetch beruntun; 2 sukses memulihkan jendela ke awal. */
  private consecutiveSuccesses = 0;
  private urlBytesUsed = 0;
  private readonly cache = new Map<number, Buffer>();
  private readonly inflight = new Map<number, Promise<Buffer>>();
  /** Rantai antrean serial: semua fetch upstream lewat sini. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    song: CanarySong,
    itag: number,
    mimeType: string,
    initialUrl: string,
    reresolve: ReresolveFn,
  ) {
    this.song = song;
    this.itag = itag;
    this.mimeType = mimeType;
    this.url = initialUrl;
    this.reresolve = reresolve;
  }

  get total(): number | null {
    return this.totalBytes;
  }

  get currentWindowSize(): number {
    return this.windowSize;
  }

  /** Layani satu request Range dari browser. */
  async serve(rangeHeader: string | undefined): Promise<ServedRange> {
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader ?? '');
    const start = m ? parseInt(m[1], 10) : 0;
    if (this.totalBytes !== null && start >= this.totalBytes) {
      throw new Error(`range di luar file: start=${start} total=${this.totalBytes}`);
    }
    const fromCache = this.cache.has(start);
    const buf = await this.fetchWindow(start);
    const end = start + buf.length - 1;
    if (this.totalBytes === null) {
      throw new Error('total byte tidak diketahui sesudah fetch');
    }
    this.stats.servedRequests++;
    this.stats.servedBytes += buf.length;
    if (fromCache) this.stats.cacheHits++;
    // Prefetch 2 jendela ke depan (latar, serial, kegagalan dicatat saja).
    const nextStart = end + 1;
    if (nextStart < this.totalBytes) {
      void this.fetchWindow(nextStart).catch(() => undefined);
      const next2 = nextStart + this.windowSize;
      if (next2 < this.totalBytes) {
        void this.fetchWindow(next2).catch(() => undefined);
      }
    }
    return {
      status: 206,
      headers: {
        'Content-Type': this.mimeType,
        'Content-Range': `bytes ${start}-${end}/${this.totalBytes}`,
        'Content-Length': String(buf.length),
        'Accept-Ranges': 'bytes',
      },
      body: buf,
      fromCache,
    };
  }

  /** Ambil jendela [start, start+window) dengan dedup + antrean serial. */
  private fetchWindow(start: number): Promise<Buffer> {
    const cached = this.cache.get(start);
    if (cached) return Promise.resolve(cached);
    const existing = this.inflight.get(start);
    if (existing) return existing;
    const job = this.enqueue(() => this.fetchWindowUncached(start));
    this.inflight.set(start, job);
    void job.then(
      (buf) => {
        this.cache.set(start, buf);
        this.inflight.delete(start);
      },
      () => {
        this.inflight.delete(start);
      },
    );
    return job;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Rantai tidak boleh putus karena satu job gagal.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async fetchWindowUncached(start: number): Promise<Buffer> {
    let attempt = 0;
    let lastError = '';
    // Maks 3 percobaan. Kebijakan adaptasi (perbaikan 17 Nov 2026):
    // - Percobaan 1 gagal 403/jaringan -> re-resolve, coba lagi dengan
    //   jendela YANG SAMA (403 non-deterministik sering spesifik per
    //   URL, bukan per ukuran jendela).
    // - Percobaan 2 gagal juga -> re-resolve + potong jendela setengah.
    // - Percobaan 3 gagal -> lempar; route membalas 502 ke browser.
    while (attempt < 3) {
      attempt++;
      try {
        const end =
          this.totalBytes !== null
            ? Math.min(start + this.windowSize - 1, this.totalBytes - 1)
            : start + this.windowSize - 1;
        const size = end - start + 1;
        // Re-resolve anggaran WAJIB di dalam try: bila re-resolve ini
        // gagal (mis. player POST timeout 60 detik, terbukti di
        // rangkaian S3 17 Nov 2026), kegagalan harus dicoba ulang
        // seperti kegagalan fetch, bukan membunuh jendela seketika.
        if (this.urlBytesUsed + size > URL_BYTE_BUDGET) {
          await this.doReresolve('anggaran-1MiB');
        }
        const buf = await this.fetchUpstream(start, end);
        this.noteSuccess();
        return buf;
      } catch (e) {
        lastError = String(e).slice(0, 160);
        const status = /HTTP (\d+)/.exec(lastError)?.[1];
        this.stats.failures.push(
          `jendela start=${start} percobaan=${attempt} ${lastError}`,
        );
        this.consecutiveSuccesses = 0;
        if (attempt >= 3) break;
        if (status === '403' || status === undefined) {
          // Re-resolve untuk percobaan berikut. Bila re-resolve ini
          // sendiri gagal, JANGAN lempar dari sini: catat saja dan
          // biarkan percobaan berikut mencoba lagi (budget check di
          // sana memicu re-resolve ulang bila perlu).
          try {
            await this.doReresolve(`HTTP-${status ?? 'jaringan'}`);
          } catch (reErr) {
            this.stats.failures.push(
              `re-resolve gagal sesudah ${lastError}: ${String(reErr).slice(0, 120)}`,
            );
          }
          // Potong jendela HANYA bila URL segar dengan ukuran sama
          // sudah gagal juga (percobaan ke-2). Percobaan pertama
          // selalu diulang dengan ukuran sama.
          if (attempt >= 2 && this.windowSize > MIN_WINDOW) {
            this.windowSize = Math.max(
              MIN_WINDOW,
              Math.floor(this.windowSize / 2),
            );
            this.stats.adaptations.push(
              `jendela dipotong ke ${this.windowSize} byte sesudah ${lastError}`,
            );
          }
        } else {
          break;
        }
      }
    }
    throw new Error(`fetch jendela start=${start} gagal 3x: ${lastError}`);
  }

  /** Catat satu fetch sukses; 2 sukses beruntun memulihkan jendela. */
  private noteSuccess(): void {
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses >= 2 && this.windowSize < INITIAL_WINDOW) {
      this.windowSize = INITIAL_WINDOW;
      this.consecutiveSuccesses = 0;
      this.stats.adaptations.push(
        `jendela dikembalikan ke ${INITIAL_WINDOW} byte sesudah 2 sukses beruntun`,
      );
    }
  }

  private async doReresolve(reason: string): Promise<void> {
    const { url, ms } = await this.reresolve();
    this.url = url;
    this.urlBytesUsed = 0;
    this.stats.reresolves++;
    this.stats.reresolveReasons.push(`${reason} (${ms} ms)`);
  }

  private async fetchUpstream(start: number, end: number): Promise<Buffer> {
    const t0 = Date.now();
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    this.stats.upstreamFetches++;
    this.stats.upstreamMs += Date.now() - t0;
    if (res.status !== 206) {
      throw new Error(
        `upstream HTTP ${res.status} untuk range ${start}-${end} (${Date.now() - t0} ms)`,
      );
    }
    const cr = res.headers.get('content-range');
    if (cr) {
      const match = /\/(\d+)$/.exec(cr);
      if (match) {
        const total = parseInt(match[1], 10);
        if (this.totalBytes !== null && this.totalBytes !== total) {
          throw new Error(
            `total byte berubah antar URL: ${this.totalBytes} vs ${total}`,
          );
        }
        this.totalBytes = total;
      }
    }
    this.stats.upstreamBytes += buf.length;
    this.urlBytesUsed += buf.length;
    return buf;
  }
}

/**
 * Uji konfirmasi dinding per-URL: ambil 3 jendela 512 KiB berurutan dari
 * SATU URL yang sama tanpa re-resolve. Hipotesis (bukti APK P1): jendela
 * ke-1 dan ke-2 206 (total tepat 1 MiB), jendela ke-3 403.
 */
export async function probeOneUrlWall(
  url: string,
): Promise<Array<{ range: string; status: number; bytes: number; ms: number }>> {
  const out: Array<{ range: string; status: number; bytes: number; ms: number }> = [];
  for (let i = 0; i < 3; i++) {
    const start = i * 524288;
    const end = start + 524287;
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        redirect: 'follow',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      out.push({ range: `${start}-${end}`, status: res.status, bytes: buf.length, ms: Date.now() - t0 });
    } catch (e) {
      out.push({ range: `${start}-${end}`, status: 0, bytes: 0, ms: Date.now() - t0 });
      void e;
    }
  }
  return out;
}

/**
 * Probe header CORS googlevideo dari sisi Node: GET Range kecil dengan
 * header Origin + preflight OPTIONS. Hasilnya menentukan vonis S5
 * bersama bukti browser (fetch dari halaman + createMediaElementSource).
 */
export async function probeGooglevideoCorsHeaders(url: string): Promise<{
  getStatus: number;
  getAcao: string | null;
  getBytes: number;
  optionsStatus: number;
  optionsAcao: string | null;
  optionsAllowMethods: string | null;
}> {
  const getRes = await fetch(url, {
    headers: { Range: 'bytes=0-999', Origin: 'http://localhost:5229' },
    redirect: 'follow',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const getBuf = Buffer.from(await getRes.arrayBuffer());
  const optionsRes = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5229',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'range',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  await optionsRes.arrayBuffer();
  return {
    getStatus: getRes.status,
    getAcao: getRes.headers.get('access-control-allow-origin'),
    getBytes: getBuf.length,
    optionsStatus: optionsRes.status,
    optionsAcao: optionsRes.headers.get('access-control-allow-origin'),
    optionsAllowMethods: optionsRes.headers.get('access-control-allow-methods'),
  };
}
