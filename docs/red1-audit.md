# Red 1 — Audit Keamanan Laras Web (P0–P4)

**Tanggal:** 18 November 2026.
**Auditor:** Tim Red 1 (A19, Red Team Web) — audit statis + penalaran atas
seluruh kode aplikasi sejauh ini.
**Ruang lingkup:** `app/src/**`, `workers/proxy/src/index.js`,
`app/public/sw.js` + manifest, `.github/workflows/ci.yml`, `wrangler.toml`.
**HEAD yang diaudit:** remote `debca8ad` (P4 + fix laporan spike).
**Metode:** baca kode penuh jalur sensitif (solver, resolve, proxy, parser,
persistensi, SW, CI), grep pola berbahaya (`innerHTML`, `eval`, `fetch`,
`localStorage`, secrets), cek lockfile dependensi, cek isi `dist/` hasil
build lokal. Tanpa menjalankan Vitest/Playwright (sandbox VM sedang
gelombang EPERM/mmap — kegagalan alat bukan vonis produk; bukti tes yang
sah adalah CI run 44218519106, conclusion=success).
**Catatan:** Red HANYA audit — tidak ada kode produksi yang diubah.

## Ringkasan vonis

| Tingkat | Jumlah |
|---|---|
| Kritis | **0** |
| Tinggi | **1** |
| Sedang | **4** |
| Rendah | **6** |
| Info | **4** |
| **Total** | **15** |

**Vonis: LAYAK LANJUT KE BLUE.** Tidak ada temuan kritis. Satu temuan
tinggi (halaman uji destruktif terkirim di produksi) dan 4 sedang wajib
ditutup Blue sebelum release candidate; Red 2 mengaudit ulang sesudah
perbaikan. Fondasi keamanannya kuat: solver tersandbox dengan benar,
allowlist URL ditegakkan di semua jalur, tidak ada XSS, tidak ada
kebocoran URL stream, tidak ada telemetri, tidak ada secret di repo.

---

## Temuan tinggi

### H1 — Halaman uji destruktif terkirim di build produksi, hapus database tanpa konfirmasi

**Tingkat: tinggi.** **File:** `app/src/App.tsx:20-23,52-58`
(`LibraryTestPage`, `P4TestPage`, `PlayerTestPage`, `SpikePage`),
`app/src/test-pages/LibraryTestPage.tsx:57-73,106`,
`app/src/test-pages/P4TestPage.tsx:110-117,141`.

**Bukti:**
- Rute `/library-test`, `/p4-test`, `/player-test`, `/spike` didaftarkan
  tanpa syarat di `App.tsx` (tidak ada gerbang `import.meta.env.DEV`).
- Chunk-chunk itu ADA di `dist/` hasil build produksi (terverifikasi):
  `LibraryTestPage-*.js`, `P4TestPage-*.js`, `PlayerTestPage-*.js`,
  `SpikePage-*.js` — artinya setiap pengunjung situs produksi bisa
  membuka halaman-halaman ini lewat URL.
- Tombol "Hapus seluruh database" memanggil `deleteDatabase()` langsung
  tanpa dialog konfirmasi dan tanpa undo (`LibraryTestPage.tsx:57-73`):

```tsx
const clearAll = (): void => {
  setBusy(true);
  setStatus('Menghapus seluruh database.');
  deleteDatabase()   // tanpa konfirmasi, tanpa undo
```

  Satu ketukan menghapus SELURUH library pengguna (lagu, playlist,
  favorit, riwayat, antrean) secara permanen. `P4TestPage` punya tombol
  yang sama (`P4TestPage.tsx:110-141`). Tombol "Isi 1.000 lagu contoh"
  juga bisa mengotori library pengguna nyata.

**Dampak:** tautan `/library-test` yang dibagikan ("coba buka ini")
+ satu ketukan = kehilangan data total yang tidak bisa dipulihkan.
Halaman ini dibuat untuk E2E, tetapi E2E berjalan terhadap build
preview — tidak ada alasan halaman ini ada di build produksi.

**Rekomendasi (Blue):**
1. Gerbang SEMUA rute uji + `/spike` di belakang `import.meta.env.DEV`
   (atau variabel build eksplisit), sehingga chunk-nya tidak ada di
   `dist/` produksi. Verifikasi: `ls dist/assets` tidak lagi memuat
   `*TestPage*` / `SpikePage*`.
2. Bila halaman uji tetap dibutuhkan di preview, tambahkan dialog
   konfirmasi dua langkah untuk hapus database (sesuai pola PRD B7.5)
   dan pisahkan build preview dari build produksi.
3. Tambahkan gerbang CI: gagalkan build bila `dist/assets` memuat
   chunk `TestPage`/`SpikePage` pada build produksi.

---

## Temuan sedang

### S1 — Proxy membaca body POST sampai habis SEBELUM cek cap 1 MB (DoS memori)

**Tingkat: sedang.** **File:** `workers/proxy/src/index.js:241-245`.

**Bukti:**

```js
const bodyBytes = await request.arrayBuffer();   // baca SELURUH body dulu
t0 = performance.now();
if (bodyBytes.byteLength > MAX_BODY_BYTES) {     // cek cap sesudahnya
  return withCpu(jsonError(413, 'BODY_TOO_BIG', ...));
}
```

Cap 1 MB (`MAX_BODY_BYTES`) hanya diperiksa sesudah seluruh body
dimuat ke memori isolate (batas memori Workers 128 MB). Body POST
ratusan MB membuat isolate kehabisan memori sebelum penolakan 413
terjadi. Ironisnya, pola yang benar SUDAH ada di file yang sama:
`readCapped()` (baris 73-91) dipakai untuk respons upstream dan
membatalkan stream saat cap terlampaui.

**Dampak:** penyerang bisa mematikan isolate worker berulang kali
dengan POST body besar (rate limit dicek sebelum baca body, tetapi
rate limit in-memory per isolate mudah dilewati — lihat S3).
**Rekomendasi (Blue):** pakai `readCapped(request.body,
MAX_BODY_BYTES)` untuk body request, persis seperti respons
upstream; tolak 413 saat `tooBig`. Tambahkan juga cek
`Content-Length` awal sebagai penolakan cepat bila header ada.

### S2 — Tidak ada CSP dan tidak ada security header sama sekali

**Tingkat: sedang.** **File:** tidak ada `app/public/_headers`;
`app/index.html` tanpa `<meta http-equiv="Content-Security-Policy">`;
`app/vite.config.ts` tanpa header; respons proxy tanpa
`X-Content-Type-Options`/`Content-Security-Policy`.

**Bukti:** grep `content-security|unsafe-eval|X-Content-Type|X-Frame`
di `app/index.html`, `vite.config.*`, `public/_redirects`, `main.tsx`
mengembalikan NOL. Arsitektur §6 mewajibkan "CSP halaman tidak
mengandung `unsafe-eval`" — saat ini tidak ada CSP sama sekali,
sehingga kewajiban itu tidak terpenuhi dan tidak ada pertahanan
lapis kedua bila suatu hari muncul satu celah XSS (mis. lewat
dependensi atau `dangerouslySetInnerHTML` di masa depan). Tanpa
`frame-ancestors`, app juga bisa di-iframe situs lain (clickjacking
terhadap tombol-tombol destruktif — relevan dengan H1).

**Rekomendasi (Blue):** tambahkan `app/public/_headers` (Cloudflare
Pages) dengan minimal:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://laras-proxy-spike.hiroohengkerr.workers.dev https://raw.githubusercontent.com; img-src 'self' https://*.ytimg.com https://*.googleusercontent.com https://*.ggpht.com data:; media-src 'self' https://*.googlevideo.com blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Catatan penting: QuickJS-WASM butuh `'wasm-unsafe-eval'` di
`script-src` (kompilasi WASM); JANGAN pakai `'unsafe-eval'` penuh —
itu akan mengaktifkan kembali jalur eval fallback dan melanggar
arsitektur §6. `style-src 'unsafe-inline'` dibutuhkan karena
Tailwind v4 + `style={{ width }}` inline di komponen; bila bisa
dihilangkan, hapus. Uji CSP di preview sebelum produksi (CSP yang
salah mem-blank total PWA).

### S3 — Rate limit proxy in-memory per isolate + bucket tanpa eviction (kuota bisa dibakar)

**Tingkat: sedang.** **File:** `workers/proxy/src/index.js:44-55`
(`buckets`), komentar baris 11-13 dan `workers/proxy/README.md`
mengakui ini skeleton.

**Bukti:**

```js
const buckets = new Map();   // tidak pernah dibersihkan: tumbuh tanpa batas
function rateLimited(ip, limit) { ... }  // per isolate, best-effort
```

- Satu IP tersebar ke banyak isolate Cloudflare, masing-masing
  dengan bucket sendiri — batas 60/menit bisa dilampaui berkali
  lipat hanya dengan membuka banyak koneksi.
- `buckets` tidak pernah menghapus entri kedaluwarsa: setiap IP
  unik menambah entri selamanya (kebocoran memori per isolate).
- Dampak nyata: kuota Workers gratis 100.000 request/hari
  (arsitektur §2.1) bisa dihabiskan penyerang, mematikan
  pencarian/streaming untuk SEMUA pengguna sampai reset 00:00 UTC.
  Proxy spike ini SUDAH live di
  `laras-proxy-spike.hiroohengkerr.workers.dev`.

**Rekomendasi (Blue):** pindahkan rate limit ke D1 sesuai arsitektur
§4.1 (KV tulis hanya 1.000/hari, tidak cocok). Sementara itu:
bersihkan entri bucket yang kedaluwarsa secara berkala (atau pakai
TTL sweep saat insert) dan turunkan ambang per isolate untuk
mengkompensasi penyebaran. Catat metrik 429 agregat untuk deteksi.

### S4 — Config remote tanpa cap ukuran dan tanpa cek versi skema

**Tingkat: sedang.** **File:** `app/src/extractor/resolve.ts:310-330`
(`loadPlayerConfig`), `app/src/extractor/resolve.ts:108-156`
(`parsePlayerConfig`).

**Bukti:**
- `await res.json()` (baris 316) tanpa cap ukuran apa pun, padahal
  arsitektur §6.1 mewajibkan cap respons config 4 MB. Respons
  raksasa dari `raw.githubusercontent.com` (tag dipindah, repo
  dikompromi, atau file rusak) di-parse penuh ke memori tab.
- `parsePlayerConfig` tidak memeriksa field versi skema apa pun,
  padahal PRD B9.1 mewajibkan: "Nomor versi skema config ada di
  file; app lama menolak config yang tidak dikenalnya." Config
  dengan skema masa depan akan diterima dan diartikan semaunya
  (mis. field `requiresScript` hilang → default `true`).
- Catatan penyeimbang: `parsePlayerConfig` sendiri defensif
  (validasi tipe per field, lewati client rusak) dan hash dipakai
  hanya lewat `encodeURIComponent` + gerbang `^[a-f0-9]{8}$` di
  proxy; tidak ada prototype pollution (`stsByHash['__proto__'] =
  <number>` adalah no-op di JS).

**Rekomendasi (Blue):** (1) baca config lewat `res.text()` +
  `TextEncoder` dengan cap 4 MB sebelum `JSON.parse`, atau cek
  `Content-Length` dulu; (2) tambahkan field `schemaVersion` ke
  `player-config.json` dan tolak config dengan versi mayor yang
  tidak dikenal (fallback ke builtin); (3) terapkan TTL/rate-limit
  refresh config sesuai PRD B9.2 saat P6 membangun tombol
  "Periksa pembaruan" (saat ini setiap `init()` mengambil config
  tanpa cache — lihat juga daftar endpoint).

---

## Temuan rendah

### R1 — `/api/media` mengikuti redirect tanpa validasi ulang host

**Tingkat: rendah.** **File:** `workers/proxy/src/index.js:157-163`.

**Bukti:** `fetch(dest.href, { ..., redirect: 'follow' })` — URL
awal divalidasi ke `*.googlevideo.com`, tetapi bila upstream
membalas redirect ke host lain, Worker mengikutinya dan
mengembalikan konten host itu (dengan `Content-Type` upstream
diteruskan apa adanya, baris 181-185). Praktiknya googlevideo
hanya redirect ke sesama host Google, jadi eksploitasi realistis
rendah — tetapi ini celah SSRF-adjacent yang tidak perlu ada.
**Rekomendasi (Blue):** pakai `redirect: 'manual'`, validasi
`Location` dengan aturan host yang sama (`*.googlevideo.com`),
maks 3 redirect; batasi `Content-Type` yang diteruskan ke
`audio/*`/`video/*`/`application/octet-stream` dan tambahkan
`X-Content-Type-Options: nosniff` pada respons media.

### R2 — `decodeURIComponent` tanpa try/catch di router: tautan crafted membuat app blank total

**Tingkat: rendah.** **File:** `app/src/App.tsx:60-68`
(`parseRoute`), `app/src/App.tsx:107-109` (dipanggil di
initializer `useState`), `app/src/main.tsx` (tanpa ErrorBoundary).

**Bukti:**

```tsx
const browse = /^\/browse\/([^/]+)$/.exec(path);
if (browse) {
  return { name: 'browse', browseId: decodeURIComponent(browse[1]), ... };
}
```

`decodeURIComponent('%E0%A4%A')` melempar `URIError`. Karena
`parseRoute` dipanggil di initializer `useState` saat render,
lemparan itu meruntuhkan seluruh pohon React tanpa ErrorBoundary —
pengguna melihat layar hitam kosong sampai menavigasi manual ke
`/`. Pemicu kedua: `BrowseShelves.tsx:78` membangun
`` `/browse/${item.browseId}` `` TANPA `encodeURIComponent`
(browseId dari respons YTM; bila mengandung `/` atau `%`,
rute rusak atau crash).
**Rekomendasi (Blue):** bungkus `decodeURIComponent` dengan
try/catch (fallback ke string mentah / rute home); tambahkan
`encodeURIComponent(item.browseId)` di `BrowseShelves`;
tambahkan React ErrorBoundary di `main.tsx` dengan layar
"Terjadi kesalahan" + tombol muat ulang.

### R3 — Service Worker cache-first tanpa revalidasi + versi cache manual

**Tingkat: rendah.** **File:** `app/public/sw.js:3,27-45`.

**Bukti:** handler fetch memakai `caches.match(request)` dulu
untuk SEMUA GET same-origin dan hanya fetch bila tidak ada
cache; entri runtime tidak pernah kedaluwarsa kecuali
`CACHE_NAME` (`laras-shell-v1`) dinaikkan manual dan SW baru
aktif. Bila rilis lupa menaikkan versi, pengguna terjebak di
shell lama selamanya (termasuk shell yang memuat kode dengan
bug keamanan yang sudah diperbaiki di server). Cache poisoning
juga persisten: satu respons buruk yang tercache (mis. halaman
error yang lolos `response.ok`) dilayani terus sampai bump versi.
**Rekomendasi (Blue):** (1) precache shell tetap cache-first,
tetapi `index.html`/navigasi pakai stale-while-revalidate atau
network-first; (2) naikkan `CACHE_NAME` otomatis dari versi
app/build (bukan string manual); (3) batasi yang di-cache
runtime ke aset statis (JS/CSS/ikon), bukan semua GET
same-origin (saat ini `/search?q=...` ikut meng-cache salinan
`index.html` per URL).

### R4 — CI: action dipin tag `@v4` (bukan SHA), tanpa blok `permissions`, tanpa `npm audit`

**Tingkat: rendah.** **File:** `.github/workflows/ci.yml:15-16,53,65-66,75`
(tanpa blok `permissions:` di file mana pun).

**Bukti:** `actions/checkout@v4`, `actions/setup-node@v4`,
`actions/upload-artifact@v4` — tag mayor bisa dipindah
(penerbit terpercaya, tetapi SHA pin adalah standar ASVS).
Tanpa `permissions:`, job memakai izin default token GitHub
(yang permissive di repo lama). Tidak ada langkah `npm audit`,
padahal rencana-fase-2 §P9 mewajibkan audit dependensi sebelum
tiap rilis.
**Rekomendasi (Blue):** pin semua action ke SHA commit penuh;
tambahkan `permissions: contents: read` di level workflow;
tambahkan langkah `npm audit --audit-level=high` di job `check`
(sebagai gerbang, bukan sekadar laporan).

### R5 — Cap ukuran diperiksa SESUDAH body dibaca penuh (client)

**Tingkat: rendah.** **File:** `app/src/extractor/resolve.ts:432-438`
(base.js: `res.text()` dulu, cek 8 MB sesudahnya),
`app/src/extractor/innertube.ts:67` (`res.text()` tanpa cap klien
sama sekali — bergantung penuh pada cap 10 MB proxy).

**Bukti:** pola yang sama dengan S1 tetapi di sisi client.
Praktiknya terlindungi karena proxy memotong respons di 10 MB
(JSON) / 8 MB (base.js) lebih dulu, jadi ini defense-in-depth,
bukan celah yang bisa dieksploitasi langsung hari ini.
**Rekomendasi (Blue):** baca respons lewat `ReadableStream`
dengan cap (`readCapped` ala proxy) di kedua tempat; untuk
`innertube.ts`, cap 10 MB sesuai arsitektur §6.1.

### R6 — Origin dev `http://127.0.0.1:4173` ada di konfigurasi CORS produksi

**Tingkat: rendah.** **File:** `workers/proxy/wrangler.toml:9`
(`ALLOWED_ORIGINS` memuat `http://127.0.0.1:4173` berdampingan
dengan domain produksi) dan perintah deploy di
`workers/proxy/README.md` yang memakai daftar yang sama.

**Bukti:** origin localhost hanya bisa dipakai server lokal di
mesin pengguna sendiri, jadi risiko langsung minimal — tetapi
konfigurasi produksi seharusnya tidak memuat origin dev (bila
suatu hari ada layanan lokal berbahaya di port 4173, ia bisa
memakai kuota proxy). **Rekomendasi (Blue):** pisahkan
`ALLOWED_ORIGINS` per lingkungan (dev vs produksi); produksi
hanya `https://laras.adipmusic.my.id` +
`https://preview.laras-web.pages.dev`.

---

## Info

### I1 — Header ukur spike `x-proxy-cpu-ms` masih aktif di worker yang di-deploy

`workers/proxy/src/index.js:14-15,100-103`. Komentar kode sendiri
menyatakan header ini "dicabut di deployment produksi", tetapi
kode yang di-deploy (proxy spike live) masih mengesetnya +
`Access-Control-Expose-Headers`. Risikonya kecil (hanya timing
sinkron handler), tetapi ini permukaan informasi yang tidak perlu
dan bertentangan dengan komentarnya sendiri. **Rekomendasi:**
cabut `withCpu`/`x-proxy-cpu-ms` saat promosi ke proxy produksi.

### I2 — Allowlist hash player di worker di-hardcode (bisa basi)

`workers/proxy/src/index.js:40` — `PLAYER_HASHES` berisi 3 hash
per 17 Nov 2026; komentar menyatakan "Produksi membaca daftar
ini dari config remote". Bila YouTube merotasi hash, proxy
menolak base.js baru (403) sampai redeploy manual — risiko
ketersediaan, bukan keamanan langsung. **Rekomendasi:** baca
dari config remote (KV/D1) dengan TTL seperti rencana, atau
sinkronkan saat deploy.

### I3 — Track lokal tanpa validasi skema URL

`app/src/player/port.ts:125-133` (`load(url, kind)`) dan
`app/src/player/service.ts:480-495` memuat `track.source.url`
apa adanya ke elemen `<audio>`. Validasi persistensi
(`persistence.ts:52-64`) hanya menolak `blob:`/`data:` yang
tidak bisa dipulihkan — URL `https://host-asing/...` lolos dan
akan diputar. Dampak minimal (elemen audio tidak mengeksekusi
skrip; penyerang harus sudah bisa menulis ke storage same-origin
korban). **Rekomendasi:** saat P5/P7 membangun jalur file lokal,
validasi `local` ke `blob:`/same-origin saja di `port.load`.

### I4 — Sourcemap dikirim di `dist/` (`.map` berdampingan dengan chunk)

`app/vite.config.ts` (`sourcemap: true`) + `dist/assets/*.js.map`
terverifikasi ada. Bukan kebocoran: repo ini GPL publik dan
sumbernya terbuka. Dicatat supaya tidak dianggap temuan di
ronde berikut. Bila suatu hari ada kode yang tidak boleh publik,
matikan sourcemap produksi.

---

## Daftar endpoint eksternal (lengkap — hasil grep `fetch`/`XMLHttpRequest`/`WebSocket` + `<img>`/`<audio>`)

| # | Endpoint | Pemanggil | Keterangan |
|---|---|---|---|
| 1 | `https://laras-proxy-spike.hiroohengkerr.workers.dev/api/innertube/player` | `innertube.ts:57` via `resolve.ts` | POST JSON player |
| 2 | `.../api/innertube/search` | `innertube.ts:57` via `searchService.ts`, `resolve.ts:388` (visitorData) | POST JSON search |
| 3 | `.../api/innertube/browse` | `innertube.ts:57` via `searchService.ts` | POST JSON browse |
| 4 | `.../api/innertube/suggestions` | `innertube.ts:57` via `searchService.ts` | POST JSON saran |
| 5 | `.../api/innertube/next` | rute proxy ada; **belum dipakai client** | cadangan |
| 6 | `.../api/player-script?hash=` | `resolve.ts:421` | GET base.js (gerbang hash) |
| 7 | `.../api/media?u=` | rute proxy ada; **belum dipakai client** (P5) | unduhan saja |
| 8 | `https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json` | `resolve.ts:310-311` | GET config remote |
| 9 | `https://*.googlevideo.com/videoplayback...` | elemen `<audio>` (`port.ts:125`) + probe CORS (`audioGraph.ts:76`, tidak pernah untuk googlevideo — di-seed tertutup) | stream audio |
| 10 | `https://i.ytimg.com/vi/<videoId>/hqdefault.jpg` | `<img>` sampul default (`player/types.ts:57`) | thumbnail |
| 11 | `https://*.ytimg.com`, `https://*.googleusercontent.com` (yt3/lh3), `https://*.ggpht.com` | `<img>` thumbnail YTM (`searchParser.ts` bestThumbnail, allowlist) + artwork MediaSession | thumbnail |
| 12 | `https://www.youtube.com/youtubei/v1/*`, `https://music.youtube.com/youtubei/v1/*`, `https://www.youtube.com/s/player/.../base.js` | **hanya via proxy** (upstream worker); tidak ada fetch langsung dari browser | — |

**NOL telemetri/analytics:** tidak ada `fetch`/`XHR`/`WebSocket`/
`sendBeacon`/piksel pelacak lain di seluruh `app/src` (grep
terverifikasi). Tidak ada font/CDN pihak ketiga, tidak ada
LRCLIB (baru P7), tidak ada panggilan ke `api.spotify.com`
(larangan permanen PRD dipatuhi).

---

## Yang DIPERIKSA dan bersih

- **Solver QuickJS-WASM tersandbox dengan benar.**
  `solver/quickJsEngine.ts`: runtime di Web Worker khusus
  (`solverWorker.ts`), batas memori 192 MiB
  (`setMemoryLimit`), stack 256 KiB, timeout 10 dtk via
  interrupt handler + backstop terminasi worker di
  `solverClient.ts:102-124`, eksekusi serial (antrean),
  TANPA callback host, TANPA fetch dari dalam JS
  (`jsStubs.ts:151` — `fetch` melempar). Hasil solver
  divalidasi allowlist googlevideo (`solverClient.ts:207-214`).
  Driver memakai `JSON.stringify` untuk nilai cipher dan
  identifier hasil validasi ketat untuk nama kelas/metode
  (`playerScript.ts` — `kJsIdentifierFullPattern`, cap prelude
  1 MB + 64 definisi, cap kedalaman template 32).
- **Eval fallback TIDAK terkirim di produksi.** `evalEngine.ts` /
  `evalFallbackWorker.ts` hanya dipakai `solver/spikePage.ts`
  (harness `spike-s1.html`, konfigurasi build terpisah);
  terverifikasi TIDAK ADA chunk eval/fallback di `dist/`.
  (Catatan: stub `fetch` melempar bahkan di jalur fallback —
  pertahanan yang bagus bila suatu hari dipakai. Jaga agar
  harness spike tetap di luar build produksi.)
- **Allowlist URL ditegakkan di semua jalur.**
  `solver/urlAllowlist.ts`: HTTPS saja, tanpa userinfo,
  tolak `googlevideo.com.evil.com` / `evilgooglevideo.com`
  (cek `===` atau `endsWith('.'+base)`). Dipakai untuk URL
  langsung (`resolve.ts:558`), cipher (`resolve.ts:198`),
  hasil solver (`solverClient.ts:211`), dan thumbnail
  (`searchParser.ts:bestThumbnail`). Jalur ANDROID_VR tidak
  lolos tanpa validasi (celah R1-M1 APK sudah ditutup).
- **Tidak ada XSS.** NOL `dangerouslySetInnerHTML` /
  `innerHTML` / `document.write` / `new Function` di
  `app/src` (grep). Semua judul/artis/lirik YTM dirender
  lewat React (auto-escape). Tidak ada `<a href>` /
  `window.open` / `target=_blank` di komponen. `videoId`
  yang diinterpolasi ke URL artwork aman karena React
  meng-escape nilai atribut.
- **Tidak ada URL stream di log/laporan (PRD B2.1 dipatuhi).**
  NOL `console.log/warn/error` di kode produksi (grep).
  `describeStreamUrl` (`resolve.ts:229-240`) hanya mencetak
  host tersamar + itag + panjang URL. Laporan spike
  (`spike/report.ts`) tidak memuat URL; `failDetail` hanya
  berisi attempts per client + pesan proxy (tanpa URL).
  Stream URL hanya ada di memori (`ResolvedTrack.url`,
  `preResolvedUrl`) dan tidak pernah disimpan
  (`persistence.ts`, `queuePersistence.ts` hanya menyimpan
  videoId). Debug hook `window.__larasPlayer.getState()`
  hanya mengekspos videoId/status (`service.ts:161-178`).
- **Parser InnerTube defensif.** `searchParser.ts`: traversal
  ITERATIF (stack/queue, bukan rekursi — tahan JSON dalam),
  cap 100 item/grup, satu item/kelompok rusak tidak
  mengosongkan hasil lain, thumbnail hanya dari allowlist,
  `runsText` toleran. `resolve.ts:parseAudioFormats` menolak
  format SABR; `pickAudioFormat` memakai urutan itag kanonis.
- **Proxy: gerbang hash sebelum fetch, allowlist host, cap
  respons, CORS allowlist (bukan `*`).**
  `workers/proxy/src/index.js`: `/api/player-script`
  memvalidasi `^[a-f0-9]{8}$` + keanggotaan set SEBELUM fetch
  (baris 199-203); `/api/media` menolak host non-`*.googlevideo.com`
  (baris 143-146); respons upstream dibaca dengan cap
  (`readCapped`, 10 MB JSON / 8 MB script; media streaming
  dengan cap 100 MB + `TransformStream` penghitung byte);
  timeout 30/90/120 dtk; CORS hanya origin di
  `ALLOWED_ORIGINS` (baris 57-64) dengan `Vary: Origin`;
  tanpa `Allow-Credentials`; rate limit memakai
  `CF-Connecting-IP` (bukan `X-Forwarded-For` yang bisa
  dipalsukan); tanpa log body/URL stream.
- **Persistensi tervalidasi ketat.** `player/persistence.ts`:
  JSON berversi, validasi penuh tiap field (versi, antrean,
  urutan = permutasi sah, posisi/rate/volume dalam rentang),
  cap 100 KB, satu lagu tak valid menolak seluruh state
  (lebih aman daripada filter tengah). `data/queuePersistence.ts`:
  pemetaan ulang urutan bila lagu hilang, rate/volume
  divalidasi saat restore. `data/browseCache.ts`: cap 512 KB,
  validasi bentuk saat muat.
- **Caps koleksi ditegakkan (anti-OOM).** `data/library.ts`:
  riwayat putar 10.000 (`MAX_PLAY_EVENTS`), riwayat pencarian
  100 (`MAX_SEARCH_HISTORY`), playlist 1.000 lagu, nama
  playlist 100 / deskripsi 500 karakter, lirik 256 KB/kolom.
  Pagination keyset 50/halaman; tidak ada query "muat semua".
- **Service Worker P0 aman dari cache poisoning lintas origin.**
  `app/public/sw.js`: hanya GET same-origin, tidak menyentuh
  request lintas origin, hanya meng-cache respons `ok`,
  hapus cache lama saat activate, scope `/` (manifest
  `scope: "/"`, `start_url: "/"`).
- **Tidak ada secret di repo.** Scan pola `ghp_/gho_/github_pat_/
  sk-/CF_API/CF_AUTH/password=/Bearer` di seluruh repo: NOL.
  Satu-satunya kunci adalah kunci API InnerTube publik YouTube
  (`workers/proxy/src/index.js:18`) — DIPUTUSKAN bukan temuan
  (kunci publik yang tertanam di halaman youtube.com). `dist/`
  dan `.env*` ada di `.gitignore`; tidak ada secret di CI
  (CI tidak memakai secret sama sekali).
- **Dependensi (lockfile, tanpa `npm audit` jaringan).**
  React 19.3.1 (di atas perbaikan React2Shell CVE-2025-55182;
  app tidak memakai RSC sama sekali), Vite 6.4.6, esbuild
  0.25.12, Dexie 4.4.7, Zustand 5.1.0, quickjs-emscripten-core
  0.32.0 (varian bellard; varian quickjs-ng yang di bawah
  lantai CVE sudah sengaja TIDAK dipakai — lihat
  `quickJsEngine.ts:8-17`), ws 8.23.0, semver 6.3.2, rollup
  4.68.5. Tidak ada CVE dikenal pada versi yang dipin dari
  pengetahuan auditor; `npm audit` di CI tetap wajib sebelum
  rilis (lihat R4) sebagai pemeriksaan otoritatif.
- **Privasi:** tanpa akun di jalur inti; riwayat dengar tidak
  pernah keluar perangkat (hanya query pencarian + judul lagu
  ke YouTube/LRCLIB-nanti, sesuai desain); visitorData hanya
  di memori sesi; config remote di-fetch tanpa pengenal
  pengguna; laporan spike memuat userAgent hanya bila pengguna
  sendiri menyalinnya.

---

## Rekomendasi urutan perbaikan untuk Blue

1. H1 — gerbang rute uji/spike ke build dev + konfirmasi hapus
   (dampak kehilangan data, perbaikan kecil).
2. S1 — `readCapped` untuk body request proxy (satu fungsi,
   pola sudah ada).
3. S2 — `_headers` CSP + nosniff + frame-ancestors (uji di
   preview; ingat `'wasm-unsafe-eval'` untuk QuickJS-WASM).
4. S3 — rate limit ke D1 + sweep bucket (pekerjaan backend
   terbesar di ronde ini).
5. S4 — cap + versi skema config remote.
6. R1–R6 — perbaikan kecil, bisa satu paket.

**Red 2 (sesudah Blue):** verifikasi ulang H1 (chunk uji hilang
dari `dist/`), S1 (uji body >1 MB → 413 tanpa OOM), S2 (header
live di preview + QuickJS tetap jalan), S3 (rate limit bertahan
antar isolate), S4 (config raksasa/versi asing ditolak), plus
audit P5 (unduhan + `/api/media` client + cache media SW) dan
P6 (pengaturan + tombol "Periksa pembaruan" + backup).
