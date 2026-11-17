// Diagnostik jaringan Chromium: ambil errorText persis dari requestfailed
// untuk membedakan gagal tunnel, gagal auth proxy, gagal sertifikat,
// atau gagal DNS. Kredensial proxy tidak pernah dicetak.
const { chromium } = require("/home/hatch/workspace/music-app-web/app/node_modules/playwright");

(async () => {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY;
  const u = new URL(raw);
  const server = `${u.protocol}//${u.hostname}:${u.port}`;
  const browser = await chromium.launch({
    proxy: { server, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
  });
  const page = await browser.newPage();
  page.on("requestfailed", (req) => {
    const f = req.failure();
    console.log("REQUESTFAILED:", req.url(), "->", f ? f.errorText : "(tanpa detail)");
  });
  page.on("response", (res) => {
    console.log("RESPONSE:", res.status(), res.url());
  });

  console.log("--- uji 1: page.goto https://example.com ---");
  try {
    const r = await page.goto("https://example.com", { timeout: 30000 });
    console.log("goto status:", r ? r.status() : "null");
  } catch (e) { console.log("goto gagal:", e.message.split("\n")[0]); }

  console.log("--- uji 2: fetch https://lrclib.net/api/search (tanpa header kustom) ---");
  await page.goto("about:blank");
  const r2 = await page.evaluate(async () => {
    try {
      const res = await fetch("https://lrclib.net/api/search?track_name=Yellow");
      return { status: res.status };
    } catch (e) { return { status: "FETCH_ERROR", error: String(e) }; }
  });
  console.log("fetch lrclib:", JSON.stringify(r2));

  console.log("--- uji 3: fetch http://example.com (HTTP polos, tanpa CONNECT) ---");
  const r3 = await page.evaluate(async () => {
    try {
      const res = await fetch("http://example.com/");
      return { status: res.status };
    } catch (e) { return { status: "FETCH_ERROR", error: String(e) }; }
  });
  console.log("fetch http example:", JSON.stringify(r3));

  await browser.close();
})().catch((e) => { console.error("DIAGNOSTIK GAGAL:", e.message); process.exit(1); });
