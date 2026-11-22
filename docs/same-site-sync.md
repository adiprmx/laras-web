# Sync same-origin: proxy Pages Functions + cookie Lax

Status: **KODE SIAP, AKTIVASI DITUNDA** (P-SameSite, Gelombang 5,
22 Nov 2026). Yang sudah live di push konsolidasi #18: cek
Origin di GET /pull + helper `clientIp` + `OAUTH_REDIRECT_BASE`
(semua no-op tanpa konfigurasi — lihat "Yang sudah dikirim"
di bawah). Yang BELUM: proxy, pergantian basis API app,
flip `COOKIE_SAMESITE=Lax`. **JANGAN flip Lax sebelum proxy
live dan login OAuth terverifikasi lewat proxy — Lax dulu =
auth putus total.**

## Masalah

Cookie sesi sync saat ini `SameSite=None` (lintas situs):
app di `laras.adipmusic.my.id`, API di
`laras-sync.hiroohengkerr.workers.dev`. Cookie lintas situs
bergantung pada kebijakan browser yang terus mengetat
(Safari/Firefox sudah membatasi; Chrome memberi pengguna
pilihan memblokir). Cookie same-site (`Lax`) tidak
terpengaruh kebijakan itu.

## Kenapa bukan route/custom domain biasa (temuan P-SameSite)

Rencana awal roadmap — `routes` di `wrangler.toml` sync
worker untuk `sync.adipmusic.my.id` — **TIDAK BISA**:
Cloudflare mewajibkan zone satu akun dengan worker
(dokumen resmi Workers "Custom Domains" + konfirmasi
beberapa sumber, 22 Nov 2026). Worker sync ada di akun
hiroohengkerr; zone `adipmusic.my.id` ada di akun adiprmx.
Deploy dengan route itu akan gagal ("you do not own the
zone"). Memindahkan worker + D1 ke akun adiprmx adalah
migrasi database berisiko — ditolak.

## Arsitektur yang dipakai: proxy Pages Functions

Pages project `laras-web` (akun hiroohengkerr) sudah
melayani `laras.adipmusic.my.id`. Pages Function di
`functions/api/[[path]].js` meneruskan `/api/*` ke sync
worker lewat `fetch()` — API menjadi **same-origin**,
bukan sekadar same-site. Tanpa perubahan DNS, tanpa
worker baru, tanpa pindah akun. Kuota: request proxy
dihitung di kuota Pages Functions akun hiroohengkerr
(free tier 100.000 request/hari — pemakaian sync jauh
di bawah itu).

Kode proxy: `workers/pages-api-proxy/functions/` —
disimpan DI LUAR root repo dengan sengaja: Wrangler
mengunggah folder `functions/` yang ada di CWD saat
`wrangler pages deploy`, jadi menaruhnya di root akan
mengaktifkannya pada deploy biasa berikutnya tanpa
sengaja. Aktivasi = salin pohon itu ke root (langkah 1).

Perilaku proxy (diuji di `app/src/worker/pagesApiProxy.test.ts`):
- Teruskan method, path + query, semua header (kecuali
  Host), dan body apa adanya.
- `redirect: 'manual'` — 302 OAuth harus sampai ke
  browser, bukan diikuti di edge.
- Teruskan Set-Cookie GANDA (sesi + state + verifier).
- Teruskan IP klien di `X-Laras-Forwarded-IP` + bukti
  proxy di `X-Laras-Proxy-Secret` (env `LARAS_PROXY_SECRET`).
- Upstream mati -> 502 envelope (app memetakannya ke
  galat sync generik).

## Yang sudah dikirim (no-op tanpa konfigurasi)

1. **Cek Origin di GET /pull** (`workers/sync/src/index.js`,
   `isForbiddenOrigin`): Origin ada + tidak di allowlist ->
   403 `ORIGIN_NOT_ALLOWED`, dicek SEBELUM pra-cek anggaran
   (request jahat tidak membakar anggaran baca korban).
   Tanpa Origin = navigasi langsung, diizinkan. CORS memang
   sudah mencegah halaman jahat MEMBACA respons; cek ini
   menutup penyalahgunaan kuota lewat sesi korban. Tes:
   403 origin jahat + 200 tanpa Origin.
2. **`clientIp(env, request)`** (`workers/sync/src/util.js`):
   sentralisasi 4 titik baca `CF-Connecting-IP` (callback,
   /me, delete, login). Header `X-Laras-Forwarded-IP`
   dipercaya HANYA bila `X-Laras-Proxy-Secret` cocok dengan
   secret `PROXY_SECRET` (perbandingan waktu-konstan).
   Tanpa secret terpasang, header terusan diabaikan
   (fail-closed). Tanpa ini, semua pengguna di belakang
   proxy berbagi satu IP egress dan rate limit per-IP
   menjadi tidak berguna. Tes: 3 tes perilaku lewat
   rate limit /me (60/mnt).
3. **`OAUTH_REDIRECT_BASE`** (`workers/sync/src/auth.js`):
   basis redirect URI OAuth; default = origin worker
   (perilaku sekarang). Saat aktivasi, set ke
   `https://laras.adipmusic.my.id` supaya cookie sesi diset
   dari domain app. Dipakai identik di login + callback
   (token endpoint menuntut redirect_uri yang sama
   dengan authorize). Tes: 2 tes (dengan + tanpa env).

## Runbook aktivasi (deploy-time, butuh egress + verifikasi live)

Urutan TIDAK BOLEH dibalik. Lakukan dalam satu jendela
egress hidup; verifikasi tiap langkah sebelum lanjut.

0. **Prasyarat:** push konsolidasi #18 sudah live (kode
   di atas + proxy belum aktif). Egress hidup.
1. **Salin proxy ke root repo** (di workdir):
   `cp -r workers/pages-api-proxy/functions ./functions`
   Lalu deploy Pages seperti biasa (wrangler / CI-artifact;
   JANGAN pages_deploy.py). Verifikasi: `GET
   https://laras.adipmusic.my.id/api/health` mengembalikan
   respons sync worker (bukan 404 Pages). App MASIH
   memanggil workers.dev langsung — proxy live tapi
   belum dipakai siapa pun.
2. **Secret proxy (nilai acak baru, 32+ byte hex):**
   set `LARAS_PROXY_SECRET` sebagai env var Pages project
   (dashboard Cloudflare > Pages > laras-web > Settings >
   Environment variables, Production) LALU deploy ulang
   Pages (env var baru hanya berlaku sesudah deploy),
   dan set `PROXY_SECRET` dengan nilai SAMA sebagai
   secret sync worker (`wrangler secret put PROXY_SECRET
   --config workers/sync/wrangler.toml` + deploy worker).
   Verifikasi: `GET /api/auth/me` lewat domain app tanpa
   sesi -> 401 (bukan 429 massal); rate limit per-IP
   masih bekerja (uji manual: 61x /me cepat dari satu IP
   -> 429 pada yang ke-61).
3. **Redirect URI OAuth:** di Google Cloud Console
   (project laras-sync > client "Laras sync") TAMBAH
   Authorized redirect URI
   `https://laras.adipmusic.my.id/api/auth/callback`
   (URI lama workers.dev biarkan dulu). Di GitHub OAuth
   App "Laras" (hanya SATU callback URL — tidak bisa
   tambah): GANTI Authorization callback URL ke URI
   domain app. Jeda antara langkah ini dan langkah 4 =
   login GitHub rusak sementara; kerjakan berurutan
   tanpa jeda panjang.
4. **Set `OAUTH_REDIRECT_BASE`** di sync worker
   (`[vars]` di `workers/sync/wrangler.toml` +
   deploy worker, atau env var dashboard). Verifikasi:
   `GET https://laras.adipmusic.my.id/api/auth/login?provider=google`
   -> 302 ke Google dengan `redirect_uri` = domain app.
5. **App ke same-origin:** ubah `SYNC_API_BASE_URL` di
   `app/src/sync/config.ts` menjadi string kosong
   (fetch relatif same-origin) + push + deploy web.
   Verifikasi: /me + pull + push jalan dari domain app
   (cek Network tab: request ke `/api/*` same-origin,
   bukan workers.dev).
6. **Login OAuth penuh lewat proxy (KEDUA provider):**
   keluar, masuk dengan Google, lalu keluar, masuk
   dengan GitHub. Verifikasi tiap kali: redirect ke
   /settings?auth=ok, /me 200, cookie `laras_session`
   terpasang untuk domain `laras.adipmusic.my.id`
   (cek DevTools > Application > Cookies).
7. **Flip `COOKIE_SAMESITE=Lax`** (env var sync worker +
   deploy). Verifikasi: login ulang kedua provider;
   cookie sesi baru membawa `SameSite=Lax`; sync +
   logout + logout-all jalan. HANYA sesudah ini,
   hapus redirect URI workers.dev lama dari Google
   Console (GitHub sudah diganti di langkah 3).
8. **Rollback:** bila langkah 6/7 gagal — kembalikan
   `SYNC_API_BASE_URL` ke workers.dev, hapus
   `OAUTH_REDIRECT_BASE`, kembalikan callback GitHub
   ke workers.dev, flip `COOKIE_SAMESITE` kembali ke
   None. Proxy di Pages bisa dibiarkan (tidak dipakai)
   atau dihapus dengan deploy tanpa folder functions/.

## Yang sengaja TIDAK diubah

- GET `/api/auth/me` tanpa cek Origin: data minimal
  (nama + provider), CORS sudah mencegah pembacaan
  lintas situs; cek Origin di /me adalah tindak lanjut
  opsional, bukan bagian paket ini.
- Cookie sesi tetap `Secure` + `HttpOnly` dalam semua
  konfigurasi.
