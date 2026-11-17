// S10 probe browser percobaan 3: Chromium memakai proxy egress VM DENGAN
// kredensial yang dipisah (Playwright tidak membaca user:pass dari URL
// server). Kredensial dibaca dari variabel lingkungan dan TIDAK PERNAH
// dicetak ke log.
const { chromium } = require("/home/hatch/workspace/music-app-web/app/node_modules/playwright");

const CLIENT = "LarasWeb/1.0 (spike-s10; +https://github.com/adiprmx/laras-web)";
const QUERIES = [
  "Bohemian Rhapsody", "Imagine", "Hotel California", "Shape of You",
  "Blinding Lights", "Someone Like You", "Rolling in the Deep",
  "Uptown Funk", "Despacito", "Perfect", "Thinking Out Loud",
  "Bad Guy", "Levitating", "Watermelon Sugar", "drivers license",
  "Stay", "As It Was", "Anti-Hero", "Flowers", "Kill Bill",
  "Viva la Vida", "Yellow", "Fix You", "The Scientist", "Clocks",
  "Hallelujah", "Let It Be", "Hey Jude", "Yesterday", "Come Together",
  "Stairway to Heaven", "Sweet Child O Mine", "November Rain",
  "Smells Like Teen Spirit", "Come As You Are", "Wonderwall",
  "Don't Look Back in Anger", "Champagne Supernova", "Creep",
  "Karma Police", "No Surprises", "Paranoid Android", "Fake Plastic Trees",
  "High and Dry", "Exit Music", "Let Down", "Idioteque", "Everything in Its Right Place",
  "Pyramid Song", "Weird Fishes",
];

(async () => {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (!raw) { console.error("Tidak ada proxy di environment"); process.exit(1); }
  const u = new URL(raw);
  const server = `${u.protocol}//${u.hostname}:${u.port}`;
  const browser = await chromium.launch({
    proxy: {
      server,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    },
  });
  const page = await browser.newPage();
  await page.goto("about:blank");

  const control = await page.evaluate(async () => {
    try {
      const res = await fetch("https://lrclib.net/api/search?track_name=Yellow");
      return { status: res.status, cors: res.headers.get("access-control-allow-origin") };
    } catch (e) { return { status: "FETCH_ERROR", error: String(e) }; }
  });
  console.log("KONTROL tanpa header kustom:", JSON.stringify(control));

  const results = await page.evaluate(async ({ queries, client }) => {
    const out = [];
    for (let i = 0; i < queries.length; i++) {
      const t0 = performance.now();
      try {
        const res = await fetch(
          "https://lrclib.net/api/search?track_name=" + encodeURIComponent(queries[i]),
          { headers: { "X-User-Agent": client, "Lrclib-Client": client } }
        );
        const ms = Math.round(performance.now() - t0);
        let count = -1;
        if (res.ok) {
          const json = await res.json();
          count = Array.isArray(json) ? json.length : -1;
        }
        out.push({
          n: i + 1, query: queries[i], status: res.status, ms, count,
          cors: res.headers.get("access-control-allow-origin"),
        });
      } catch (e) {
        out.push({ n: i + 1, query: queries[i], status: "FETCH_ERROR", ms: Math.round(performance.now() - t0), error: String(e) });
      }
    }
    return out;
  }, { queries: QUERIES, client: CLIENT });

  const counts = {};
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    console.log(`${String(r.n).padStart(2)}/50 ${r.status} ${String(r.ms).padStart(5)}ms hasil=${r.count} cors=${r.cors} ${r.query}${r.error ? " ERR=" + r.error : ""}`);
  }
  console.log(JSON.stringify({ status_counts: counts, rate_limited_429: counts[429] || 0 }, null, 2));
  require("fs").writeFileSync("/tmp/s10_browser_results3.json", JSON.stringify({ control, results }, null, 2));
  console.log("saved /tmp/s10_browser_results3.json");
  await browser.close();
})().catch((e) => { console.error("BROWSER PROBE GAGAL:", e.message); process.exit(1); });
