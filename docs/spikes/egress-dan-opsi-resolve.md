# Egress dan Opsi Resolve — Hasil §5 + Matriks Empiris (18 Nov 2026)

Dokumen ini mencatat hasil verifikasi §5 (browser nyata), matriks
egress empiris, eksperimen visitorData, dan evaluasi opsi resolve.
Semua angka di sini terukur, bukan asumsi. Bila sebuah egress tidak
bisa diuji, dicatat alasannya — tidak ada hasil karangan.

## 1. Hasil §5 (parent, cloud browser Chrome 157, ~08:00 WIB)

- Periksa cepat: **0/5, dua kali identik** (total 5 detik + 3 detik;
  tiap lagu gagal ~1 detik). Pesan tampil: "Lagu tidak bisa
  ditemukan di semua jalur. Coba lagi nanti."
- Putar penuh tidak jalan (kriteria: lanjut hanya bila 5/5).
- Tampilan halaman lengkap, tombol jalan. Bukan cacat UI.

Probe parent (semua terukur):
- Preview `/spike`: HTTP 200. Proxy OPTIONS preflight origin preview:
  204 + ACAO benar + `x-proxy-cpu-ms: 0.000`. Proxy rute tak dikenal:
  404 envelope benar. Config-v1 remote: HTTP 200, 869 byte.
  Semua infra hidup.
- Player via proxy (body + header persis `resolve.ts`, videoId
  `hhn-nGSuenM`, sts 20770): WEB_REMIX HTTP 200 LOGIN_REQUIRED
  "Sign in to confirm you're not a bot", 0 format audio. ANDROID_VR
  sama persis.
- Waktu gagal ~1 detik/lagu cocok: `resolve.ts` hanya retry bila
  galat jaringan — proxy membalas 200 dengan LOGIN_REQUIRED, jadi
  tidak ada retry.

## 2. KOREKSI: HP owner BUKAN penentu untuk resolve

Klaim log lama ("HP owner penentu definitif") **salah untuk tahap
resolve**: IP yang dilihat YouTube adalah IP egress worker, bukan IP
browser pemanggil. Tes HP owner akan gagal sama di tahap resolve.
IP residensial HP hanya berpengaruh di fetch audio googlevideo
langsung SESUDAH resolve lolos. **Jangan minta owner tes §5 dari HP
sampai resolve lewat proxy bisa lolos.**

## 3. Matriks egress empiris (koordinator, 18 Nov ~08:05–08:25 WIB)

Body + header persis `resolve.ts` (WEB_REMIX sts 20770, MWEB sts
20770, ANDROID_VR tanpa sts; videoId `hhn-nGSuenM`). Skrip probe:
`hidden_files/koordinator/egress_probe.py`.

### 3.1 Player

| Egress | WEB_REMIX | MWEB | ANDROID_VR |
|---|---|---|---|
| VM langsung | OK (4 audio, 6,45 dtk) | — | LOGIN_REQUIRED (7,0 dtk) |
| Proxy CF (hiroohengkerr) | OK 3/3 (4 audio; 8,08 / 7,95 / 3,08 dtk) | LOGIN_REQUIRED (4,07 dtk) | LOGIN_REQUIRED 2/2 (7,29 / 3,97 dtk) |
| Proxy CF + visitorData VM | — | OK 1/2 (6 audio) | OK 2/2 (4 audio) |
| Proxy CF, kontrol tanpa VD (menit yang sama) | — | LOGIN_REQUIRED | LOGIN_REQUIRED |

Tanpa visitorData di jendela ini: MWEB 0/2, ANDROID_VR 0/4.
Dengan visitorData yang dipanen dari VM: MWEB 1/2, ANDROID_VR 2/2.

### 3.2 Search / browse / next via proxy CF — JALAN (vonis P4)

- Search (`lagu indonesia populer`): HTTP 200, 237.932 byte,
  30 `musicResponsiveListItemRenderer` (hasil YTM nyata),
  visitorData ada, tanpa error. Struktur respons:
  `tabbedSearchResultsRenderer` (bukan `twoColumnSearchResultsRenderer`
  seperti client WEB).
- Browse (`FEmusic_home`): HTTP 200, contents ada.
- Next (`hhn-nGSuenM`): HTTP 200, contents ada.
- Search langsung VM: HTTP 200, contents ada (baseline).

**P4 live search JALAN.** Bot-check menargetkan endpoint player
(dan client tertentu), bukan search/browse/next. P4 tetap lanjut;
vonis live-nya lolos.

### 3.3 Egress lain

- **corsproxy.io**: HTTP 403 HTML (layanan proxy itu sendiri di
  balik tantangan Cloudflare) — tidak bisa dipakai sebagai egress.
- **youtubei.googleapis.com langsung dari VM**: timeout 60 detik,
  HTTP 000, tidak terjangkau — BELUM TERUJI sebagai egress (butuh
  worker untuk menguji dari egress CF).
- **Akun Cloudflare ke-2 (adiprmx)**: TIDAK BISA DIUJI — token
  legacy hanya Zone:Read + DNS:Edit. Terbukti empiris: `GET /zones`
  sukses, `GET /accounts/.../workers/scripts` → "Authentication
  error". Butuh token baru dari owner.
- **GitHub Actions runner**: LOGIN_REQUIRED (diketahui dari CI
  00:58, semua client).
- **Vercel**: TERUJI 19 Nov 2026 (16:44–16:49 WIB) — DITOLAK JUGA.
  Fungsi `laras-proxy-vercel` (akun adiprmx-2915, Hobby gratis,
  `https://laras-proxy-vercel-adiprmx.vercel.app/api/innertube/player`,
  byte-only forward cermin proxy CF) mengembalikan LOGIN_REQUIRED
  7/7 (WEB_REMIX + ANDROID_VR, 3x per klien, 0 format audio) pada
  jendela yang sama saat egress Cloudflare juga ditolak; probe
  koordinator 16:49 WIB mengonfirmasi (15,3 dtk, LOGIN_REQUIRED).
  Fungsi sendiri SEHAT (HTTP 200 + JSON InnerTube utuh) — YouTube
  yang menolak IP egress-nya. Pola menguat: YouTube menolak IP pusat
  data secara luas di jendela buruk (CF, Vercel/AWS, GHA runner).
  Failover CF → Vercel TIDAK dibangun (tidak menolong saat
  dibutuhkan). Fungsi tetap live ($0) untuk uji ulang. Bukti lengkap:
  `docs/vercel-egress.md`. Jebakan: Deployment Protection SSO aktif
  default untuk proyek baru via API (dimatikan via PATCH hanya untuk
  proyek ini); egress VM → Vercel lambat + flapping (15–23 dtk).
- **Netlify / Render / Fly.io / Deno Deploy**: BELUM DIUJI —
  Deno Deploy dievaluasi (riset saja, `docs/vercel-egress.md`):
  plausibel tapi BELUM TERBUKTI (jaringan edge sendiri, 35+ region);
  butuh akun owner via GitHub + verifikasi laporan "Deno joining
  Cloudflare" (Okt 2026) dan outbound allowlist tier gratis untuk
  youtube.com. Netlify/Render/Fly.io belum dievaluasi.
- **Firebase Functions (proyek adip-promo, sudah ada)**: BELUM
  TERUJI — percobaan 18 Nov 2026 dibatasi waktu: CLI `firebase`
  tidak terinstal di VM; instalasi via npm/npx terblokir gelombang
  EPERM sandbox saat ini (npx gagal tulis cache, terbukti tim P4);
  deploy via REST API mentah di luar batas waktu 30 menit. BUKAN
  ditolak — percobaan ulang bila sandbox sehat. Paket Spark
  membatasi outbound ke API Google; `youtubei.googleapis.com`
  memenuhi syarat secara prinsip.
- **Supabase Edge Functions**: BELUM TERUJI — kandidat egress
  Deno (IP beda dari CF Workers), tapi deploy butuh CLI/API
  Management + proyek Supabase yang sedang dipakai proyek lain;
  ditunda, bukan ditolak.

### 3.4 Asimetri IP

IP egress VM ini resolve LANGSUNG lolos (WEB_REMIX OK berulang) —
IP worker Cloudflare bukan satu-satunya yang dicurigai, dan bukan
semua IP pusat data dicurigai. Penanda berubah per client, per
waktu, dan kemungkinan per IP egress per request.

## 4. Eksperimen visitorData (terkendali, 18 Nov ~08:15–08:25 WIB)

Pertanyaan: apakah visitorData yang dipanen dari sesi NON-proxy
membalik LOGIN_REQUIRED pada client yang sedang ditantang?

- Panen: search langsung dari VM → `responseContext.visitorData`
  (48 karakter, baru tiap panen: `CgtMMHg4...`, `CgtBYVNk...`,
  `CgtSd2cw...`, `CgthVEF1...`).
- Replay: player via proxy CF dengan visitorData itu di
  `context.client.visitorData` (posisi sama seperti `resolve.ts`).
- Kontrol: request identik tanpa visitorData di menit yang sama.

Hasil: tanpa VD 0/6 (MWEB 0/2, VR 0/4); dengan VD VM 3/4
(MWEB 1/2, VR 2/2). Satu kegagalan MWEB+VD (run 1) vs sukses
(run 2, VD segar) menunjukkan VD bukan jaminan 100% — jendela
waktu ikut berperan.

Catatan kejujuran:
- VisitorData dari browser SESUNGGUHNYA tidak bisa dipanen dari VM:
  Chromium gagal launch (gelombang EPERM sandbox, SIGTRAP) dan
  homepage youtube.com via curl membalas kosong (HTTP 000).
  VD yang dipakai dipanen dari search API langsung (sesi VM) —
  pengganti yang sah untuk "dipanen di luar egress CF", tapi BUKAN
  sesi browser residensial. Tes ideal (VD dari browser HP owner)
  belum dilakukan.
- VisitorData yang dipanen LEWAT proxy (perilaku resolver saat ini,
  `init()` memanen dari search via proxy) TIDAK membantu — §5 gagal
  dengan VD itu. Yang penting adalah SUMBER panen (sesi bersih),
  bukan keberadaan VD.
- Percobaan pertama replay 400 `FAILED_PRECONDITION` adalah artefak
  EPERM (file body 0 byte, request kosong) — BUKAN penolakan
  visitorData. Diulang dengan body di memori, hasilnya di atas.

## 5. Non-deterministik (koreksi S7)

- S7 (17 Nov): POST player WEB_REMIX via proxy → HTTP 200 OK.
- Parent (18 Nov ~08:00): WEB_REMIX via proxy → LOGIN_REQUIRED.
- Koordinator (18 Nov ~08:05–08:25): WEB_REMIX via proxy → OK 4/4
  (3 via proxy + 1 langsung), MWEB/VR LOGIN_REQUIRED.
- Penanda berubah per client × waktu (dan kemungkinan per IP egress
  per request). Satu probe TIDAK BISA jadi vonis permanen untuk satu
  egress/client. Setiap klaim "egress X diblokir/lolos" WAJIB
  membawa jam + client + jumlah ulangan.

## 6. Evaluasi opsi (untuk keputusan parent/owner)

### Opsi 1 — Retry LOGIN_REQUIRED lintas waktu (DIREKOMENDASIKAN)

`resolve.ts` saat ini hanya retry galat jaringan. Tambah: bila semua
client LOGIN_REQUIRED, ulangi urutan client 2–3 ronde dengan backoff
(mis. 5 dtk, 15 dtk). Bukti: WEB_REMIX buruk pukul 08:00, lolos pukul
08:05 — jendela berbalik dalam hitungan menit. Tanpa perubahan scope
(masuk kerja ketahanan P6). Biaya: jeda beberapa detik di jendela
buruk, bukan gagal instan. Urutan client tetap WEB_REMIX dulu
(saat ini paling sering lolos).

### Opsi 2 — visitorData dari sesi bersih (MEKANISME TERBUKTI, JALUR PRODUKSI BELUM ADA)

Mekanisme terbukti (§4). Tapi aplikasi web TIDAK BISA memanen VD
residensial sendiri: browser tidak bisa fetch youtubei (CORS),
tidak bisa baca DOM youtube.com (same-origin), iframe diblokir
X-Frame-Options. VD yang dipanen lewat proxy (sesi CF) tidak
membantu. Jalur produksi butuh minter di sisi server yang bersih —
yang butuh egress bersih (Opsi 4) — melingkar. Status: ditahan
sampai ada minter bersih.

### Opsi 3 — poToken (DI LUAR SCOPE v1, BUTUH KEPUTUSAN OWNER)

Attestasi Proof of Origin YouTube (BotGuard). Pembuatan poToken di
sisi server butuh menjalankan tantangan BotGuard (berat, rapuh,
sering berubah) atau layanan pihak ketiga (biaya/kepercayaan). APK
sengaja tanpa poToken. MUNGKIN membuka blokir player, tapi opsi
terberat dengan beban rawat terbesar dan bersinggungan dengan garis
keras owner soal bypass anti-bot. TIDAK direkomendasikan untuk v1;
ditinjau hanya bila semua opsi lain gagal. JANGAN implementasi tanpa
persetujuan eksplisit parent/owner.

### Opsi 4 — Cari egress bersih (SEDANG BERJALAN)

Kandidat butuh akun owner: Vercel, Netlify, Render, Fly.io, Deno
Deploy. Firebase Functions (proyek sudah ada): percobaan deploy
tertunda. Akun CF ke-2: butuh token Workers baru. Pola ketahanan
bila ≥1 egress bersih ada: fallback multi-egress (coba CF → coba X
→ coba Y) + panen VD dari egress bersih (§4).

### Opsi 5 — Pengerasan fingerprint request (NILAI RENDAH)

Header sudah cocok dengan client InnerTube; Workers tidak bisa
mengatur fingerprint TLS. Bukti menunjukkan penanda ditentukan
client × waktu × kepercayaan sesi, bukan bentuk header. Prioritas
rendah, bukan penggerak.

### Opsi 6 — Tunggu saja (PASIF, BUKAN STRATEGI)

Penanda berbalik sendiri (bukti §5). Jangan over-engineering untuk
jendela buruk yang sesaat — tapi jangan juga diam: Opsi 1
menutupinya.

## 7. Rekomendasi koordinator ke parent

1. Implementasi Opsi 1 (retry LOGIN_REQUIRED lintas waktu) di P6 —
   tanpa perubahan scope, tanpa persetujuan tambahan.
2. Lanjutkan perburuan egress bersih: percobaan Firebase Functions
   dulu (tanpa akun baru); keputusan owner soal akun Vercel/Deno
   untuk egress + minter ke-2.
3. poToken tetap di luar v1 kecuali owner menyetujui eksplisit.
4. Uji §5 ulang sesudah retry mendarat — laporan spike kini
   menampilkan penyebab spesifik per lagu (Detail: attempts +
   playability), jadi §5 berikut bisa didiagnosis sendiri tanpa
   probe parent. Catatan: sesudah retry, jendela buruk akan gagal
   dalam ~30–60 detik (bukan ~1 detik) — ekspektasi waktu §5
   berubah.

## 8. Perbaikan diagnosis (aksi 3, 18 Nov 2026)

Laporan spike HANYA menampilkan pesan generik (`failCause`) —
attempts sudah ada di `ResolveError.message` tapi dibuang di
`SpikePage.tsx`. Perbaikan: field baru `SongResult.failDetail`
(diisi `error.message` untuk ResolveError, `jaringan: ...` untuk
galat jaringan), tampil di teks laporan sebagai baris
`Detail: ...` (TIDAK tampil di layar — tanpa jargon di UI).
Contoh baris baru: `Detail: resolve gagal untuk hhn-nGSuenM:
WEB_REMIX=LOGIN_REQUIRED, MWEB=LOGIN_REQUIRED,
ANDROID_VR=LOGIN_REQUIRED`. Tes Vitest baru di `report.test.ts`.
