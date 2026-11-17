// app/tests/e2e/spikes/relay.ts
var URL_BYTE_BUDGET = 1048576;
var INITIAL_WINDOW = 786432;
var MIN_WINDOW = 131072;
var UPSTREAM_TIMEOUT_MS = 12e4;
var GooglevideoRelay = class {
  song;
  itag;
  mimeType;
  stats = {
    upstreamFetches: 0,
    upstreamMs: 0,
    upstreamBytes: 0,
    servedRequests: 0,
    servedBytes: 0,
    cacheHits: 0,
    reresolves: 0,
    reresolveReasons: [],
    adaptations: [],
    failures: []
  };
  url;
  reresolve;
  totalBytes = null;
  windowSize = INITIAL_WINDOW;
  /** Sukses fetch beruntun; 2 sukses memulihkan jendela ke awal. */
  consecutiveSuccesses = 0;
  urlBytesUsed = 0;
  cache = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  /** Rantai antrean serial: semua fetch upstream lewat sini. */
  queue = Promise.resolve();
  constructor(song, itag, mimeType, initialUrl, reresolve) {
    this.song = song;
    this.itag = itag;
    this.mimeType = mimeType;
    this.url = initialUrl;
    this.reresolve = reresolve;
  }
  get total() {
    return this.totalBytes;
  }
  get currentWindowSize() {
    return this.windowSize;
  }
  /** Layani satu request Range dari browser. */
  async serve(rangeHeader) {
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader ?? "");
    const start = m ? parseInt(m[1], 10) : 0;
    if (this.totalBytes !== null && start >= this.totalBytes) {
      throw new Error(`range di luar file: start=${start} total=${this.totalBytes}`);
    }
    const fromCache = this.cache.has(start);
    const buf = await this.fetchWindow(start);
    const end = start + buf.length - 1;
    if (this.totalBytes === null) {
      throw new Error("total byte tidak diketahui sesudah fetch");
    }
    this.stats.servedRequests++;
    this.stats.servedBytes += buf.length;
    if (fromCache) this.stats.cacheHits++;
    const nextStart = end + 1;
    if (nextStart < this.totalBytes) {
      void this.fetchWindow(nextStart).catch(() => void 0);
      const next2 = nextStart + this.windowSize;
      if (next2 < this.totalBytes) {
        void this.fetchWindow(next2).catch(() => void 0);
      }
    }
    return {
      status: 206,
      headers: {
        "Content-Type": this.mimeType,
        "Content-Range": `bytes ${start}-${end}/${this.totalBytes}`,
        "Content-Length": String(buf.length),
        "Accept-Ranges": "bytes"
      },
      body: buf,
      fromCache
    };
  }
  /** Ambil jendela [start, start+window) dengan dedup + antrean serial. */
  fetchWindow(start) {
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
      }
    );
    return job;
  }
  enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async fetchWindowUncached(start) {
    let attempt = 0;
    let lastError = "";
    while (attempt < 3) {
      attempt++;
      try {
        const end = this.totalBytes !== null ? Math.min(start + this.windowSize - 1, this.totalBytes - 1) : start + this.windowSize - 1;
        const size = end - start + 1;
        if (this.urlBytesUsed + size > URL_BYTE_BUDGET) {
          await this.doReresolve("anggaran-1MiB");
        }
        const buf = await this.fetchUpstream(start, end);
        this.noteSuccess();
        return buf;
      } catch (e) {
        lastError = String(e).slice(0, 160);
        const status = /HTTP (\d+)/.exec(lastError)?.[1];
        this.stats.failures.push(
          `jendela start=${start} percobaan=${attempt} ${lastError}`
        );
        this.consecutiveSuccesses = 0;
        if (attempt >= 3) break;
        if (status === "403" || status === void 0) {
          try {
            await this.doReresolve(`HTTP-${status ?? "jaringan"}`);
          } catch (reErr) {
            this.stats.failures.push(
              `re-resolve gagal sesudah ${lastError}: ${String(reErr).slice(0, 120)}`
            );
          }
          if (attempt >= 2 && this.windowSize > MIN_WINDOW) {
            this.windowSize = Math.max(
              MIN_WINDOW,
              Math.floor(this.windowSize / 2)
            );
            this.stats.adaptations.push(
              `jendela dipotong ke ${this.windowSize} byte sesudah ${lastError}`
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
  noteSuccess() {
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses >= 2 && this.windowSize < INITIAL_WINDOW) {
      this.windowSize = INITIAL_WINDOW;
      this.consecutiveSuccesses = 0;
      this.stats.adaptations.push(
        `jendela dikembalikan ke ${INITIAL_WINDOW} byte sesudah 2 sukses beruntun`
      );
    }
  }
  async doReresolve(reason) {
    const { url, ms } = await this.reresolve();
    this.url = url;
    this.urlBytesUsed = 0;
    this.stats.reresolves++;
    this.stats.reresolveReasons.push(`${reason} (${ms} ms)`);
  }
  async fetchUpstream(start, end) {
    const t0 = Date.now();
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    const buf = Buffer.from(await res.arrayBuffer());
    this.stats.upstreamFetches++;
    this.stats.upstreamMs += Date.now() - t0;
    if (res.status !== 206) {
      throw new Error(
        `upstream HTTP ${res.status} untuk range ${start}-${end} (${Date.now() - t0} ms)`
      );
    }
    const cr = res.headers.get("content-range");
    if (cr) {
      const match = /\/(\d+)$/.exec(cr);
      if (match) {
        const total = parseInt(match[1], 10);
        if (this.totalBytes !== null && this.totalBytes !== total) {
          throw new Error(
            `total byte berubah antar URL: ${this.totalBytes} vs ${total}`
          );
        }
        this.totalBytes = total;
      }
    }
    this.stats.upstreamBytes += buf.length;
    this.urlBytesUsed += buf.length;
    return buf;
  }
};
async function probeOneUrlWall(url) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const start = i * 524288;
    const end = start + 524287;
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        redirect: "follow",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
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
async function probeGooglevideoCorsHeaders(url) {
  const getRes = await fetch(url, {
    headers: { Range: "bytes=0-999", Origin: "http://localhost:5229" },
    redirect: "follow",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  const getBuf = Buffer.from(await getRes.arrayBuffer());
  const optionsRes = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5229",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "range"
    },
    redirect: "manual",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  await optionsRes.arrayBuffer();
  return {
    getStatus: getRes.status,
    getAcao: getRes.headers.get("access-control-allow-origin"),
    getBytes: getBuf.length,
    optionsStatus: optionsRes.status,
    optionsAcao: optionsRes.headers.get("access-control-allow-origin"),
    optionsAllowMethods: optionsRes.headers.get("access-control-allow-methods")
  };
}
export {
  GooglevideoRelay,
  probeGooglevideoCorsHeaders,
  probeOneUrlWall
};
