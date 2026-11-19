# Egress Kedua: Proxy InnerTube via Vercel — Hasil Uji (19 Nov 2026)

**Vonis: DITOLAK JUGA.** Egress Vercel mengembalikan `LOGIN_REQUIRED`
7/7 percobaan (0 format audio) pada jendela yang sama saat egress
Cloudflare juga ditolak. Failover CF → Vercel TIDAK dibangun — tidak
ada nilai tambah pada jendela buruk yang diamati.

Semua jam WIB, 19 Nov 2026. Body + header probe persis `resolve.ts`
(videoId `hhn-nGSuenM`; WEB_REMIX 1.20261110.04.00 clientId 67 sts
20770; ANDROID_VR 1.65.10 clientId 14, tanpa sts).

## 1. Akun Vercel terverifikasi (Tahap 1)

| Item | Nilai |
|---|---|
| Akun (GET /v2/user) | `adiprmx-2915` ("Adip Fvnky"), adiprmx@gmail.com, id `ZqMvT50EytgA8Kaasw4LD8Y5` |
| Tim | `Adip Fvnky's projects` (slug `adiprmx`), id `team_tDEfHrtDtl7q1Q2gyvuCoaxs` |
| Tier | **Hobby (gratis)** — `billing.plan: hobby` |
| Bukti akun benar | Proyek `dokter-hp-web` ADA (`prj_lYqANF9uzTr2oSYKYHVUDfHnxrGu`), bersama `karir`, `adip-tools`, dll. |

Kredensial `custom.vercel` dipakai lewat helper `vercel_api.py`
(surrogate, nilai mentah tidak pernah dicetak/disimpan). Dijalankan
dengan `PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin`
(jalur template lama di helper sudah tidak ada).

## 2. Fungsi proxy live (Tahap 2)

| Item | Nilai |
|---|---|
| Proyek Vercel (BARU) | `laras-proxy-vercel`, id `prj_F9PSuRV113OTiSBDm7UGs8BwLAGW` |
| URL produksi | `https://laras-proxy-vercel-adiprmx.vercel.app` (alias kedua `https://laras-proxy-vercel.vercel.app`) |
| Rute | `POST /api/innertube/player` → `https://www.youtube.com/youtubei/v1/player` |
| Deployment | `dpl_9q6vkaHoMJVXZMf31KGygDk5CFnv` (READY; awal `dpl_FU18EPWuYy1u5ug9cyido7mEadve`) |
| Region | `iad1` (Washington) |
| Sumber | `workers/vercel-proxy/` (README + `api/innertube/player.js` + `vercel.json`) |

Pola byte-only cermin proxy CF: teruskan body + header
`X-YouTube-Client-Name/Version`, kembalikan status + body apa adanya.
Batas: body 1 MB, respons 10 MB, timeout upstream 30 dtk, rate limit
60/menit per IP (in-memory, best-effort), CORS hanya tiga origin
Laras. TIDAK log body/URL stream. Jalur diagnosis
`POST /api/innertube/player?ping=1` membalas langsung tanpa
menyentuh YouTube.

Verifikasi live sebelum uji egress: OPTIONS → 204 + ACAO benar
(`https://laras.adipmusic.my.id`); GET → 405 envelope JSON;
`?ping=1` → 200 `{"success":true,"ping":"ok"}`.

### Jebakan deploy (detail di `workers/vercel-proxy/README.md`)

1. **Deployment Protection (SSO) AKTIF default** untuk proyek baru
   via API (`ssoProtection: all_except_custom_domains`): semua URL
   `*.vercel.app` me-redirect 302 ke `vercel.com/sso-api` sampai
   dimatikan via `PATCH /v9/projects/{id}` `{"ssoProtection": null}`
   (HANYA proyek ini; berlaku langsung tanpa redeploy). Catatan:
   `dokter-hp-web` punya setelan yang sama — mirror
   `*.vercel.app`-nya kemungkinan juga di balik SSO (di luar scope
   tugas ini, tapi layak dicek pemiliknya).
2. **Egress VM ke `*.vercel.app` lambat + flapping**: round trip
   15–23 dtk saat sehat, kadang hang total (HTTP 000) sampai timeout
   60–90 dtk. Probe 000 BUKAN bukti fungsi mati — ulangi dengan
   `--max-time` ≥ 120 dtk.
3. **Penjaga timeout keras WAJIB**: versi pertama (hanya
   `AbortSignal.timeout(30s)`) 6/6 probe POST menggantung sampai
   batas curl 70 dtk tanpa respons. Dengan penjaga `setTimeout`
   28 dtk yang memaksa respons 502, POST kembali dengan jawaban nyata.

## 3. Tabel bukti uji egress

### 3.1 Keadaan CF sebelum uji (jendela buruk terkonfirmasi)

| Waktu | Via | Klien | HTTP | Playability | Format audio | Durasi |
|---|---|---|---|---|---|---|
| 15:59:21 | CF | WEB_REMIX | 200 | LOGIN_REQUIRED | 0 | 15,7 dtk |
| 15:59:46 | CF | ANDROID_VR | 200 | LOGIN_REQUIRED | 0 | 22,8 dtk |

(Konteks: §5 15:50–15:52 WIB 0/5 TOTAL; probe koordinator 15:56
masih LOGIN_REQUIRED; uji ulang §5 15:57 gagal 0/5 juga.)

### 3.2 Uji Vercel — probe tunggal pasca-redeploy

| Waktu | Via | Klien | HTTP | Playability | Format audio | Durasi |
|---|---|---|---|---|---|---|
| 16:44:08 | Vercel | WEB_REMIX | 200 | LOGIN_REQUIRED | 0 | 15,3 dtk |

### 3.3 Uji berpasangan (CF diapit sebelum + sesudah Vercel 3x)

| Waktu | Via | Klien | HTTP | Playability | Format audio | Durasi |
|---|---|---|---|---|---|---|
| 16:44:39 | CF | WEB_REMIX | 200 | LOGIN_REQUIRED | 0 | 22,8 dtk |
| 16:44:58 | CF | ANDROID_VR | 200 | LOGIN_REQUIRED | 0 | 17,1 dtk |
| 16:45:18 | Vercel | WEB_REMIX | 200 | LOGIN_REQUIRED | 0 | 18,4 dtk |
| 16:45:36 | Vercel | ANDROID_VR | 200 | LOGIN_REQUIRED | 0 | 15,3 dtk |
| 16:45:57 | Vercel | WEB_REMIX | 200 | LOGIN_REQUIRED | 0 | 16,4 dtk |
| 16:46:20 | Vercel | ANDROID_VR | 200 | LOGIN_REQUIRED | 0 | 20,5 dtk |
| 16:46:36 | Vercel | WEB_REMIX | 200 | LOGIN_REQUIRED | 0 | 11,4 dtk |
| 16:46:54 | Vercel | ANDROID_VR | 200 | LOGIN_REQUIRED | 0 | 16,1 dtk |
| 16:47:10 | CF | WEB_REMIX | 200 | LOGIN_REQUIRED | 0 | 13,9 dtk |
| 16:47:29 | CF | ANDROID_VR | 200 | LOGIN_REQUIRED | 0 | 17,1 dtk |

**Rekap: Vercel 7/7 LOGIN_REQUIRED (0 format audio) — 4x WEB_REMIX,
3x ANDROID_VR — dalam jendela 16:44–16:47 saat CF 4/4
LOGIN_REQUIRED di menit yang sama (diapit sebelum dan sesudah).**
Fungsi Vercel sendiri SEHAT (HTTP 200 + JSON InnerTube utuh);
yang menolak adalah YouTube terhadap IP egress-nya — sama seperti
terhadap egress CF.

## 4. Vonis: DITOLAK JUGA

Vercel BUKAN egress bersih pada jendela buruk yang diamati. Failover
hanya bernilai bila egress kedua lolos SAAT CF ditolak — dan persis
pada saat itu Vercel juga ditolak (7/7). Karena itu modul
`proxyFailover.ts` TIDAK dibangun (sesuai mandat: failover hanya
bila vonis BERSIH), dan TIDAK ADA wiring `resolve.ts` yang
diperlukan dari paket ini.

**Caveat kejujuran (per spike §5):** penanda LOGIN_REQUIRED
non-deterministik per client × waktu × IP egress. Vonis ini berlaku
untuk jendela 15:59–16:47 WIB 19 Nov 2026. Uji ulang di jendela lain
secara teori bisa berbeda — tapi itu tidak mengubah keputusan
failover: egress yang ikut ditolak di jendela buruk tidak menolong
saat dibutuhkan. Pola yang menguat: YouTube menolak IP pusat data
secara luas pada jendela buruk (CF Workers, Vercel/AWS, GitHub
Actions runner — ketiganya LOGIN_REQUIRED; hanya IP VM ini dan
kadang visitorData sesi bersih yang lolos).

**Proyek Vercel tetap LIVE** (biaya $0, tier Hobby, pemakaian hanya
belasan invokasi) untuk uji ulang di jendela lain bila koordinator
menginginkannya. Tidak ada kode app yang diubah — tidak ada tes
Vitest/typecheck/lint/bundle yang perlu dijalankan untuk paket ini
(fungsi Vercel di luar bundle app; sintaks dicek `node --check`).

## 5. Evaluasi Deno Deploy sebagai egress ketiga (RISET SAJA)

Tidak ada akun yang dibuat. Pembuatan akun adalah langkah parent.

### Yang dibutuhkan

- **Akun:** daftar di `console.deno.com` dengan akun GitHub owner
  (login via GitHub; tanpa kartu kredit untuk tier gratis).
  Buat organisasi (slug permanen) — token API organisasi (`ddo_`)
  dipakai untuk REST API v2 (`api.deno.com/v2/...`); token personal
  (`ddp_`) ditolak API v2.
- **Cara deploy function:** (a) hubungkan repo GitHub di dashboard
  → auto-deploy tiap push; (b) CLI `deno deploy` (subcommand bawaan
  binary Deno; `deployctl` SUDAH deprecated — jangan pakai);
  (c) GitHub Actions; (d) REST API v2 untuk manajemen app/env.
  Entrypoint: satu file `main.ts` dengan `Deno.serve(...)` —
  port fungsi Vercel (fetch + CORS + cap) hampir 1:1 karena Deno
  memakai Web API standar. URL live: `<app>.<org>.deno.net`.
- **Catatan platform:** Deploy Classic (`dash.deno.com`) SUNSET
  20 Jul 2026 — hanya platform baru (`console.deno.com`) yang
  berlaku.

### Batas gratis (tier Free, $0)

Angka dari halaman pricing resmi per berbagai ringkasan Nov 2026
(verifikasi di dashboard sebelum deploy — sumber pihak ketiga
sedikit berbeda angkanya):

- 1 juta request/bulan; egress 20 GiB/bulan (angka 100 GB yang
  beredar adalah era Classic — JANGAN pakai).
- CPU aktif ~10–15 jam/bulan; memori ~150–350 GiB-jam/bulan.
- 5 custom domain, 10–20 app, KV 1 GiB.
- CPU TIDAK terhitung saat menunggu fetch jaringan (menunggu
  upstream gratis) — cocok untuk proxy byte-only.
- Bila kuota habis, app DIJEDA sampai siklus berikutnya (bukan
  tagihan) — aman dari biaya tak terduga. Sebagian sumber menyebut
  batas penuh butuh verifikasi organisasi (kartu) — verifikasi
  saat pembuatan akun.

### Apakah egress-nya plausibel bersih?

**Plausibel, BELUM TERBUKTI.** Argumen pro: Deno Deploy memakai
jaringan edge sendiri (35+ region, IP sendiri) — berbeda dari
Cloudflare Workers maupun Vercel/AWS, jadi penanda IP-nya
independen; kandidat paling masuk akal berikutnya setelah dua
egress besar gagal. Argumen kontra / yang harus diverifikasi:

1. **Tidak ada jaminan:** YouTube menolak IP pusat data secara
   luas di jendela buruk; Deno Deploy juga pusat data. Hanya probe
   live saat CF ditolak yang bisa membuktikan.
2. **"Deno joining Cloudflare":** satu roundup Okt 2026 menyebut
   banner di halaman pricing Deno bahwa Deno bergabung dengan
   Cloudflare (tanpa detail). Bila egress Deno bermigrasi ke
   infrastruktur Cloudflare, keunggulan IP independennya hilang.
   Verifikasi status ini SEBELUM investasi besar.
3. **Outbound allowlist:** tier Free/Pro disebut punya allowlist
   koneksi outbound — pastikan `youtube.com` /
   `youtubei.googleapis.com` diizinkan di tier gratis sebelum
   mengandalkan jalur ini.
4. **Skala tim:** pola deploy (GitHub connect / `deno deploy`)
   butuh Deno terinstal atau CI — bukan deploy API satu panggilan
   seperti Vercel.

Rekomendasi: bila parent memutuskan mencoba, langkahnya: (1) owner
buat akun + organisasi; (2) tim deploy fungsi port dari
`workers/vercel-proxy/` (port langsung ke `Deno.serve`); (3) uji
egress dengan protokol yang sama (3x per klien, CF diapit) —
vonis BERSIH hanya bila OK + format audio SAAT CF LOGIN_REQUIRED.

## 6. Langkah koordinator yang masih diperlukan

1. **Tidak ada wiring `resolve.ts`** dari paket ini (failover
   tidak dibangun — vonis DITOLAK JUGA).
2. **Keputusan egress ketiga (Deno Deploy):** butuh akun owner
   (lihat §5). Bila owner setuju, luncurkan tim deploy + uji
   dengan protokol yang sama.
3. **Proyek Vercel `laras-proxy-vercel` tetap live** untuk uji
   ulang sewaktu-waktu; hapus bila koordinator memutuskan tidak
   dipakai lagi (penghapusan via `DELETE /v9/projects/{id}`).
4. **Opsional:** cek apakah mirror `dokter-hp-web.vercel.app`
   juga terhalang SSO protection (setelan yang sama dengan proyek
   ini) — di luar scope, tapi temuan sampingan yang layak
   diteruskan ke pemiliknya.
5. Perbarui `docs/spikes/egress-dan-opsi-resolve.md` §3.3 bila
   koordinator mau: Vercel kini TERUJI (LOGIN_REQUIRED 7/7,
   19 Nov 16:44–16:47 WIB) — bukan lagi "BELUM DIUJI".

## 7. Artefak

- Fungsi + README: `workers/vercel-proxy/` (repo `adiprmx/laras-web`,
  belum push — koordinator yang memverifikasi + push).
- Skrip probe + deploy (di luar repo, `/tmp/vercel-egress/`):
  `probe.py`, `deploy_vercel_proxy.py` — minta ke tim ini bila
  koordinator perlu menjalankannya lagi (file /tmp tidak permanen).
- Laporan ini: `docs/vercel-egress.md`.
