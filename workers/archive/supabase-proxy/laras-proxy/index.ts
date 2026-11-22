// Laras Web, proxy InnerTube player via Supabase Edge Functions (Deno).
//
// Peran: jalan keluar keempat/kelima bila egress Cloudflare Workers,
// Vercel, dan Render sama-sama ditolak YouTube (playability
// LOGIN_REQUIRED). Pola sama dengan workers/render-proxy/server.js:
// byte-only forward, teruskan body + header client, kembalikan
// status + body apa adanya. Fungsi ini TIDAK mengeksekusi base.js,
// TIDAK memecahkan cipher, TIDAK menyimpan data pengguna, TIDAK
// mencatat body request/response (hanya status + ukuran + durasi
// di log, tanpa videoId).
//
// Tanpa dependensi/import: hanya Deno.serve + fetch bawaan.
// Satu file index.ts, jauh di bawah batas bundle server-side 5 MB.
//
// Batas Supabase Edge Functions, Free plan (dok resmi,
// supabase.com/docs/guides/functions/limits, diperbarui 29 Okt 2026):
//   memori 256 MB | wall clock 150 dtk | CPU 2 dtk/request (tidak
//   termasuk async I/O) | idle timeout 150 dtk | maks 100 fungsi.
// Proxy ini ringan CPU (salin byte, I/O-bound) dan merespons dalam
// 28 dtk lewat penjaga keras — jauh di dalam semua batas di atas.
//
// Batas Laras (cermin proxy CF/Vercel/Render): body POST maks 1 MB,
// JSON youtubei maks 10 MB, timeout upstream 30 dtk, rate limit
// 60/menit per IP (in-memory per isolate, best-effort). Fail-open:
// bila hitungan gagal, request diizinkan. CORS: hanya origin Laras
// (bukan `*`).
//
// Rute (gateway memotong `/functions/v1/`, fungsi menerima
// `/laras-proxy/...` — routing dicocokkan dari ujung, lihat
// handle()):
//   GET  /healthz                 -> 200 {"status":"ok"}
//   POST /api/innertube/player    -> proxy ke youtubei/v1/player
//   POST /api/innertube/player?ping=1 -> 200 ping ok (diagnosis,
//                                     tanpa menyentuh YouTube)
//   OPTIONS .../player            -> 204 preflight CORS
//   lainnya                       -> 404 envelope JSON
//
// Deploy: proyek `adipmusic` (jebafddwupyqpwevhsqn), slug
// `laras-proxy`, verify_jwt=false (publik, tanpa JWT). Deploy via
// Management API — lihat README.md di workers/supabase-proxy/.
// URL: https://jebafddwupyqpwevhsqn.supabase.co/functions/v1/laras-proxy

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // kunci publik InnerTube
const UPSTREAM = "https://www.youtube.com/youtubei/v1/player";
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const RESPONSE_CAP_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30000;
const GUARD_TIMEOUT_MS = 28000;
const RATE_PER_MIN = 60;
const RATE_WINDOW_MS = 60 * 1000;

const ALLOWED_ORIGINS = new Set([
  "https://laras.adipmusic.my.id",
  "https://laras-web.pages.dev",
  "https://preview.laras-web.pages.dev",
]);

// Rate limit in-memory per isolate: ip -> { count, windowStart }.
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    if (rateBuckets.size > 10000) {
      for (const [key, value] of rateBuckets) {
        if (now - value.windowStart >= RATE_WINDOW_MS) rateBuckets.delete(key);
      }
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_PER_MIN;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const headers: Record<string, string> = { Vary: "Origin" };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ success: false, error: { code, message } }),
    {
      status,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    },
  );
}

// Baca stream dengan cap: { tooBig: true } bila melewati cap, TANPA
// mem-buffer seluruh body (stream dibatalkan begitu cap terlampaui).
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<{ tooBig: boolean; bytes?: Uint8Array }> {
  if (!stream) return { tooBig: false, bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
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
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* abaikan */
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { tooBig: false, bytes: out };
}

async function handle(req: Request): Promise<Response> {
  const t0 = Date.now();
  const cors = corsHeaders(req);

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return jsonError(400, "BAD_URL", "URL request tidak valid", cors);
  }
  // Routing prefix-agnostik (fakta runtime, 19 Nov 2026): gateway
  // Supabase memotong `/functions/v1/` dan meneruskan
  // `/<slug>/...` ke fungsi (terbukti: pathname mentah yang
  // diterima adalah `/laras-proxy/tidak-ada`, BUKAN
  // `/functions/v1/laras-proxy/tidak-ada`). Cocokkan dari ujung
  // agar tahan bentuk prefix apa pun.
  const rawPath = url.pathname;
  const isHealthz = rawPath === "/healthz" || rawPath.endsWith("/healthz");
  const isPlayer = rawPath === "/api/innertube/player" ||
    rawPath.endsWith("/api/innertube/player");

  if (isHealthz) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return jsonError(405, "METHOD_NOT_ALLOWED", "Metode tidak diizinkan", cors);
    }
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!isPlayer) {
    return jsonError(404, "NOT_FOUND", "Endpoint tidak ditemukan", cors);
  }

  // Jalur diagnosis (?ping=1): balas langsung tanpa menyentuh
  // YouTube, membedakan "transport macet" dari "upstream macet".
  if (req.method === "POST" && url.searchParams.get("ping") === "1") {
    return new Response(JSON.stringify({ success: true, ping: "ok" }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, X-YouTube-Client-Name, X-YouTube-Client-Version",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonError(405, "METHOD_NOT_ALLOWED", "Metode tidak diizinkan", cors);
  }

  // Supabase berada di balik edge gateway: IP client asli ada di
  // X-Forwarded-For (entri pertama).
  const forwarded = (req.headers.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim();
  const ip = forwarded || "unknown";
  try {
    if (isRateLimited(ip)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: "Terlalu banyak request, coba lagi sebentar",
          },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "60",
            ...cors,
          },
        },
      );
    }
  } catch {
    // Fail-open: hitungan rate limit gagal = request diizinkan.
  }

  // Penolakan cepat dari Content-Length yang dideklarasikan,
  // sebelum membaca stream.
  const declaredLen = Number(req.headers.get("content-length") || 0);
  if (declaredLen > MAX_BODY_BYTES) {
    return jsonError(413, "BODY_TOO_BIG", "Body request melewati 1 MB", cors);
  }

  let bodyBytes: Uint8Array;
  try {
    const read = await readCapped(req.body, MAX_BODY_BYTES);
    if (read.tooBig || !read.bytes) {
      return jsonError(413, "BODY_TOO_BIG", "Body request melewati 1 MB", cors);
    }
    bodyBytes = read.bytes;
  } catch {
    return jsonError(400, "BAD_BODY", "Body request tidak bisa dibaca", cors);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const clientName = req.headers.get("x-youtube-client-name");
  const clientVersion = req.headers.get("x-youtube-client-version");
  if (clientName) headers["X-YouTube-Client-Name"] = clientName;
  if (clientVersion) headers["X-YouTube-Client-Version"] = clientVersion;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${UPSTREAM}?key=${INNERTUBE_KEY}&prettyPrint=false`,
      {
        method: "POST",
        headers,
        body: bodyBytes,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    const timeout = err instanceof Error && err.name === "TimeoutError";
    return jsonError(
      502,
      "UPSTREAM_ERROR",
      timeout ? "Timeout ke upstream" : "Kesalahan proxy",
      cors,
    );
  }

  const declared = Number(upstream.headers.get("Content-Length") || 0);
  if (declared > RESPONSE_CAP_BYTES) {
    return jsonError(502, "UPSTREAM_TOO_BIG", "Respons upstream melewati cap", cors);
  }
  const read = await readCapped(upstream.body, RESPONSE_CAP_BYTES);
  if (read.tooBig || !read.bytes) {
    return jsonError(502, "UPSTREAM_TOO_BIG", "Respons upstream melewati cap", cors);
  }

  // Log operasional saja: status + ukuran + durasi. Tanpa videoId,
  // tanpa body, tanpa URL stream.
  console.log(JSON.stringify({
    route: "innertube/player",
    upstreamStatus: upstream.status,
    bytes: read.bytes.length,
    ms: Date.now() - t0,
  }));

  return new Response(read.bytes, {
    status: upstream.status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Penjaga keras: fungsi WAJIB merespons dalam 28 dtk apa pun yang
// terjadi di upstream (pelajaran Vercel 19 Nov 2026: hanya
// AbortSignal.timeout saja tidak cukup, 6/6 POST menggantung).
Deno.serve((req: Request): Promise<Response> => {
  let timer: number | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          jsonError(502, "UPSTREAM_ERROR", "Timeout ke upstream", corsHeaders(req)),
        ),
      GUARD_TIMEOUT_MS,
    );
  });
  return Promise.race([
    handle(req).catch((err: unknown) => {
      console.log(JSON.stringify({
        route: "unhandled",
        error: err instanceof Error ? err.name : "unknown",
      }));
      return jsonError(502, "UPSTREAM_ERROR", "Kesalahan proxy", corsHeaders(req));
    }),
    timeout,
  ]).finally(() => clearTimeout(timer));
});
