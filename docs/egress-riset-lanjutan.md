# Egress Ketiga Laras: Riset Lanjutan (Deno, Netlify, Render, Fly.io)

**Tanggal riset:** 19 November 2026, ~18:45-19:00 WIB
**Jenis:** RISET SAJA. Tidak ada akun dibuat, tidak ada deploy, tidak ada kode diubah.
**Konteks:** YouTube menolak resolve Laras dari IP pusat data. Cloudflare Workers dan Vercel/AWS sama-sama LOGIN_REQUIRED 7/7 pada jendela buruk 19 Nov 2026 (lihat `docs/vercel-egress.md`). Laras butuh egress ketiga yang IP-nya independen. Dokumen ini memverifikasi laporan "Deno joining Cloudflare" dan memberi peringkat Netlify, Render, dan Fly.io.

**Aturan penulisan:** tanpa em dash di seluruh dokumen. Fakta terverifikasi ditandai [FAKTA], dugaan beralasan ditandai [DUGAAN].

---

## Ringkasan vonis (baca ini dulu)

| Kandidat | Vonis | Satu kalimat |
|---|---|---|
| **Deno Deploy** | **DITOLAK (sunset)** | Tim Deno resmi bergabung ke Cloudflare 9 Okt 2026; Deno Deploy MATI sekitar April 2027. Jangan buang waktu. |
| **Render** | **PERINGKAT 1** | Satu-satunya opsi $0 tanpa kartu yang lolos syarat timeout (100 menit); egress AWS+GCP, porsi GCP belum pernah diuji YouTube. |
| **Fly.io** | **PERINGKAT 2** | Independensi IP terbaik (server bare metal sendiri, bukan cloud besar), tapi TIDAK ADA tier gratis; trial 7 hari tanpa kartu cukup untuk uji probe. |
| **Netlify** | **PERINGKAT 3** | Functions jalan di AWS Lambda (keluarga IP yang sama dengan Vercel, sudah terbukti ditolak) dan timeout gratis hanya 10 detik, di bawah syarat 30 detik. |

**Catatan kejujuran:** belum ada satu pun kandidat yang TERBUKTI lolos dari YouTube. Peringkat ini soal kelayakan untuk diuji, bukan jaminan bersih. Hanya probe live saat CF ditolak yang bisa membuktikan (protokol sama seperti `docs/vercel-egress.md` §3: 3x per klien, CF diapit sebelum dan sesudah).

---

## BAGIAN A - Verifikasi Deno: "Deno joining Cloudflare"

### A.1 Apakah Deno bergabung/menjadi bagian Cloudflare?

**Ya. Terverifikasi dari dua sumber primer yang dibaca langsung.**

- **Blog Deno, Ryan Dahl, "Deno is joining Cloudflare", 9 Oktober 2026** (https://deno.com/blog/cloudflare). Kalimat kuncinya: "Today we're announcing that the entire Deno team is joining Cloudflare." Isi konkret pengumuman:
  - Runtime Deno: didukung satu tahun lagi dengan rilis bulanan (bug fix + security update), setelah itu "we will end our development of the Deno runtime". Deno tetap open source (MIT).
  - **Deno Deploy: "will continue operating for six months before shutting down."** Dukungan migrasi diberikan untuk pelanggan berbayar yang pindah ke Cloudflare Workers.
  - JSR: terus beroperasi, "with its infrastructure moving to Cloudflare".
  - `rusty_v8` terus didukung dan diintegrasikan ke `workerd`.
- **Blog Cloudflare, Kenton Varda dan Ryan Dahl, "Deno is joining Cloudflare", diterbitkan 9 Oktober 2026 12:50 UTC** (https://blog.cloudflare.com/deno-joins-cloudflare). Postingan gabungan ini fokus ke rencana teknis: menggabungkan `workerd` (runtime open source Workers) dengan `celld` (implementasi Workers + Durable Objects yang bisa self-host, dirilis tim Deno Agustus 2026) agar self-hosting workerd menjadi cara yang didukung penuh. Dahl dan Bert Belder memimpin upaya ini.
- **Liputan pers:** TechCrunch (Anthony Ha, 10 Oktober 2026, "Cloudflare acquires Deno to improve its Workers programming model") dan The New Stack (Paul Sawers, 9 Oktober 2026) melaporkannya sebagai akuisisi; syarat finansial tidak diungkap. [FAKTA, via TSN Media 23 Okt 2026 yang merangkum kedua liputan tersebut.] Kedua postingan resmi sendiri tidak memakai kata "acquisition", hanya "joining".

**Tanggal tutup Deploy:** tidak ada tanggal kalender resmi. Enam bulan dihitung dari 9 Oktober 2026 mengarah ke **sekitar 9 April 2027** (perkiraan yang dipakai semua sumber sekunder; Deno belum menerbitkan tanggal pasti). [FAKTA: durasi 6 bulan; DUGAAN: tanggal 9 April 2027.]

### A.2 Apakah egress Deno Deploy kini berjalan di infrastruktur Cloudflare?

**Tidak ada bukti bahwa egress Deploy pindah ke infrastruktur Cloudflare. [FAKTA: tidak ada pernyataan resmi soal itu; DUGAAN beralasan: egress masih di jaringan Deno sendiri sampai tutup.]**

Alasannya:

- Pengumuman Deno hanya menyebut SATU produk yang infrastrukturnya pindah ke Cloudflare: JSR ("JSR will continue operating, with its infrastructure moving to Cloudflare"). Untuk Deploy, yang diumumkan adalah penutupan, bukan migrasi.
- Postingan Cloudflare tidak membahas Deploy sama sekali; fokusnya ke workerd + celld dan self-hosting.
- Tidak satu pun sumber sekunder yang ditemukan menyatakan Deploy bermigrasi ke rentang IP Cloudflare.

Jadi secara teknis, keunggulan IP independen Deno kemungkinan masih ada untuk saat ini. TAPI keunggulan itu tidak lagi relevan, karena layanannya punya tanggal mati sekitar 5 bulan dari sekarang dan tidak ada masa depan di luar itu. Membangun egress di atas layanan yang sedang dimatikan adalah investasi yang dibuang.

### A.3 Tier gratis Deno Deploy saat ini

Angka dari halaman pricing resmi Deno, dikutip konsisten oleh banyak sumber per November 2026 (stacksfree.com 10 Nov 2026; freetier.wiki 16 Nov 2026; agentdeals.dev, terakhir dicek 31 Okt 2026):

| Item | Free ($0/bulan) |
|---|---|
| Request | 1.000.000/bulan |
| Egress | 20 GiB/bulan (angka 100 GB yang beredar adalah era Classic, sudah kedaluwarsa) |
| Active CPU | 10 jam/bulan (dipotong dari 15 jam sekitar 28 Agu 2026) |
| Memory time | 150 GiB-jam/bulan (dipotong dari 350) |
| Aplikasi | 10 |
| Custom domain | 5 (tanpa wildcard) |
| KV | 1 GiB, 1.000.000 read unit + 500.000 write unit/bulan |
| Build | 15/jam, 1 bersamaan |
| Log | retensi 1 hari, tanpa SLA |

Perilaku penting:

- **Kuota penuh butuh kartu.** Organisasi yang belum diverifikasi dengan kartu kredit mendapat batas yang dikurangi (besarnya tidak dipublikasikan); kuota penuh di atas mensyaratkan kartu terhubung untuk verifikasi organisasi. [FAKTA, freetier.wiki 16 Nov 2026; agentdeals.dev mengutip changelog Deno, dibaca 22 Okt 2026.] Ini bertabrakan dengan aturan nol rupiah/tanpa kartu.
- **Bila kuota habis, aplikasi DIJEDA sampai siklus berikutnya**, bukan ditagih. Aman dari biaya tak terduga.
- **Idle scale-to-zero:** aplikasi idle mati setelah ~20-30 detik; request pertama setelah sepi bisa lambat (cold start).
- CPU TIDAK terhitung saat menunggu fetch jaringan (menunggu upstream gratis), cocok untuk proxy byte-only.
- Deploy Classic (dash.deno.com) sudah sunset 20 Juli 2026; hanya platform baru (console.deno.com) yang berlaku.

### A.4 Apakah fetch ke youtube.com diizinkan di tier gratis?

**Tidak ada blokir yang terdokumentasi. [FAKTA: tidak ditemukan allowlist outbound untuk aplikasi Deploy reguler; DUGAAN: fetch ke youtube.com diizinkan.]**

- wheredoirunthis.com (profil Deno Deploy): "No primary-app outbound allowlist found on current pricing, runtime docs or v2 API. Runtime runs --allow-all and supports network requests."
- Kekhawatiran allowlist di riset sebelumnya (`docs/vercel-egress.md` §5) ternyata berasal dari produk lain: **Deno Sandbox** (microVM Linux, produk terpisah, hanya di Pro $20/bulan) yang punya `allowNet` allowlist. Sandbox bukan aplikasi Deploy reguler, jadi aturan itu tidak berlaku untuk proxy kita.
- Deno Deploy tidak menyediakan daftar IP statis; tidak ada daftar IP egress yang bisa di-allowlist di sisi YouTube (tidak relevan untuk kasus ini).

### A.5 Vonis Deno

**DITOLAK. Jangan buat akun, jangan deploy, jangan buang waktu.**

Alasan, berurutan dari yang paling menentukan:

1. **Layanan mati sekitar April 2027.** Sekitar 5 bulan dari sekarang. Egress yang dibangun hari ini harus dibangun ulang tak lama kemudian.
2. **Kuota gratis penuh butuh kartu kredit** untuk verifikasi organisasi. Melanggar aturan nol rupiah/tanpa kartu.
3. **Egress memang (kemungkinan) masih independen dari Cloudflare**, tapi poin 1 dan 2 sudah cukup untuk menolak. Keunggulan IP yang berumur 5 bulan bukan fondasi.
4. Bonus negatif: Netlify Edge Functions berjalan di atas runtime Deno Deploy (lihat Bagian B), jadi kematian Deno juga merembet ke opsi lain.

Satu-satunya penggunaan Deno yang masih masuk akal adalah probe sekali jalan untuk menjawab pertanyaan riset "apakah IP Deno lolos dari YouTube", TAPI itu pun tidak layak: butuh akun + organisasi + (untuk kuota penuh) kartu, demi jawaban yang tidak bisa dipakai jangka panjang. **Rekomendasi: tutup jalur Deno.**

---

## BAGIAN B - Peringkat Netlify / Render / Fly.io sebagai egress ketiga

### Kebutuhan Laras (pengingat)

- Meneruskan POST `/api/innertube/player` + GET media ke YouTube.
- Timeout minimal 30 detik (probe nyata 11-23 detik; Vercel memakai penjaga 28-30 detik).
- Pola byte-only, tanpa log body/URL stream.
- Syarat owner: $0, tanpa kartu kredit.

### Tabel perbandingan ringkas

| Kriteria | Render (1) | Fly.io (2) | Netlify (3) | Deno (pembanding) |
|---|---|---|---|---|
| Independensi IP egress | Sebagian: AWS+GCP, porsi GCP belum diuji | Terbaik: bare metal sendiri, bukan CF/AWS/Vercel | Buruk: Functions = AWS Lambda (sama dgn Vercel) | Baik (saat ini), tapi layanan mati |
| Tier gratis tanpa kartu | Ya, permanen ($0 Hobby) | TIDAK ADA; trial $1/7 hari saja | Ya, 300 kredit/bulan | Ya, tapi kuota penuh butuh kartu |
| Timeout | 100 menit | Tanpa batas (VM) | 10 detik (Free), 26 detik (Pro) | Isolate, tanpa batas ketat |
| Tidur/idle | Tidur 15 menit, bangun ~1 menit (keep-alive bisa) | Tidak tidur bila always-on (bayar); auto-stop opsional | Scale-to-zero, cold start | Scale-to-zero 20-30 detik |
| Bandwidth gratis | 5 GB/bulan (Hobby) | Tidak ada (bayar $0,02/GB) | ~15 GB (dari kredit) | 20 GiB/bulan |
| Fetch ke youtube.com | Diizinkan (tanpa allowlist) | Diizinkan (tanpa allowlist) | Diizinkan (tanpa allowlist) | Diizinkan (tanpa allowlist) |
| Model fungsi | Kontainer persisten (Node server) | MicroVM persisten (Docker) | Serverless Lambda + Edge (Deno) | V8 isolate |
| POST + streaming + header kustom | Ya, native | Ya, native | Ya, tapi dinding 10 detik | Ya |
| Umur layanan | Stabil (raise $100jt, Feb 2026) | Stabil | Stabil | MATI ~Apr 2027 |

---

### B.1 Peringkat 1 - Render

**Kenapa peringkat 1:** satu-satunya kandidat yang memenuhi SEMUA syarat keras sekaligus: $0 permanen tanpa kartu, timeout jauh di atas 30 detik, dan egress yang setidaknya sebagian berada di luar keluarga CF/Vercel/AWS.

#### (1) Independensi IP egress dari CF/Vercel/AWS

**Sebagian independen. [FAKTA: infrastruktur Render adalah AWS + GCP; DUGAAN: porsi GCP memberi peluang IP yang belum masuk daftar tolak YouTube.]**

- ComparEdge (15 Juli 2026): "Core infrastructure: AWS + GCP (US)", dengan CDN Cloudflare hanya untuk static sites (tidak relevan untuk web service egress).
- Encore.dev (27 Okt 2026): "Underlying infra: Render's (AWS-backed)".
- CrowsEye (22 Mar 2026): "Render runs on AWS and GCP infrastructure underneath".
- SaaStweaks (Mei 2026): "built on Google Cloud".
- Lima region layanan: Oregon (default), Ohio, Virginia, Frankfurt, Singapura (Render docs, via ComparEdge).

Interpretasi jujur: Render BUKAN independen penuh. Egress-nya tetap IP pusat data hyperscaler. Tapi ada dua hal yang membuatnya layak diuji: (a) sebagian region berjalan di GCP, keluarga IP yang BELUM pernah diuji Laras (yang sudah terbukti ditolak: CF, Vercel/AWS, GitHub Actions runner); (b) IP egress Render adalah IP dari akun cloud Render sendiri, bukan IP bersama Vercel/CF. Peluang lolos tidak dijamin, tapi nonzero dan sepadan dengan biaya uji $0. **Region yang disarankan untuk probe pertama: Oregon** (region default, historis GCP) atau Frankfurt (satu-satunya region EU; bila YouTube menerapkan penanda per region, Frankfurt memberi variasi kedua).

#### (2) Tier gratis tanpa kartu

**Ya, permanen, tanpa kartu.** [FAKTA, banyak sumber: justinmckelvey.com Sep 2026 ("genuinely, permanently, no card"); agentdeals.dev, terverifikasi 2 Okt 2026 ("Render's free web services need no credit card"); altftool.com, dicek 1 Nov 2026.]

| Item | Free (Hobby workspace $0) |
|---|---|
| Web service | 512 MB RAM, 0,1 CPU, 1 instance |
| Instance hours | 750/bulan per workspace (dipakai bersama semua layanan gratis) |
| Bandwidth | 5 GB/bulan (dipotong dari 100 GB pada 23 Apr 2026; kelebihan $0,15/GB, tapi tanpa kartu layanan di-suspend sampai bulan berikut, bukan ditagih) |
| Batas layanan | 25 layanan per workspace Hobby |
| Postgres gratis | 1 database, 1 GB, kedaluwarsa 30 hari (tidak dibutuhkan Laras) |

**Tidur/idle:** layanan gratis spin-down setelah 15 menit tanpa traffic masuk; bangun lagi sekitar 1 menit saat request berikutnya datang, pengunjung melihat halaman loading Render selama itu. [FAKTA, Render docs via theproofdesk.com Okt 2026; justinmckelvey.com Sep 2026; ployz.dev Nov 2026.]

**Keep-alive:** ping eksternal tiap 10-14 menit mencegah tidur. Satu layanan yang tidak pernah tidur memakai ~744 dari 750 jam/bulan, jadi hanya muat SATU layanan always-on per workspace. Praktik ini ditoleransi Render (karyawan Render mengakuinya di forum komunitas) tapi bukan jaminan. [FAKTA, watchcron.com; theproofdesk.com Okt 2026.] Untuk Laras: cron ping tiap 10 menit dari Worker CF yang sudah ada (atau dari cron eksternal) adalah solusi keep-alive yang murah. Catatan: selama layanan tidur, request pertama gagal/lambat sekitar 1 menit; failover Laras harus memperhitungkan ini (atau mengandalkan keep-alive).

**Bandwidth 5 GB/bulan adalah batas nyata untuk GET media.** POST /player (JSON kecil) hampir tidak memakai bandwidth; tapi bila media audio ikut di-proxy lewat Render, 5 GB habis cepat (estimasi kasar: 5 GB setara ~80-100 jam audio ~128 kbps; angka ini hitungan, bukan janji). Arsitektur Laras saat ini hanya mem-proxy /player dan memberikan URL media langsung ke klien, jadi 5 GB kemungkinan cukup untuk jalur /player. Bila suatu hari media ikut di-proxy, Render gratis tidak cukup.

#### (3) Outbound fetch ke youtube.com

**Diizinkan, tanpa allowlist.** [FAKTA: tidak ada pembatasan outbound yang terdokumentasi kecuali SMTP.] Render adalah kontainer penuh: aplikasi Node bisa fetch ke host mana pun. Satu-satunya blokir outbound yang didokumentasikan di tier gratis adalah port SMTP 25/465/587 (justinmckelvey.com, Sep 2026, mengutip render.com/docs/free). HTTPS ke youtube.com/youtubei.googleapis.com tidak dibatasi.

#### (4) Model fungsi serverless

**Bukan serverless; ini kontainer persisten (serverful).** Justru lebih cocok untuk proxy Laras:

- Server Node (Express/Hono/polos) berjalan terus, mendengarkan di port yang di-bind. POST + streaming respons + header kustom semuanya native, tanpa batasan runtime isolate.
- **Timeout HTTP 100 menit per request** untuk web service. [FAKTA, Render resmi: render.com/articles/leaving-heroku-migration-guide-2026 dan beberapa artikel Render 2026; juga blog.enkihost.com 19 Okt 2026.] Jauh di atas syarat 30 detik.
- Deploy dari repo GitHub (auto-deploy tiap push), Docker image, atau Blueprint `render.yaml`. Mendukung Node 20/22/24.
- Keterbatasan gratis yang relevan: tanpa disk persisten, tanpa SSH/shell, tanpa cron job/background worker gratis (cron tidak dibutuhkan; keep-alive bisa dari luar), file lokal hilang tiap spin-down/redeploy (tidak masalah untuk proxy stateless).

#### Langkah akun (Render)

1. Buka https://render.com, klik "Get Started" / "Get Started for Free".
2. Daftar dengan **GitHub** (disarankan: sekalian menghubungkan repo untuk deploy) atau email/Google. GitHub adalah jalur yang dipakai semua panduan deploy.
3. Bila daftar via GitHub: klik "Authorize Render"; saat GitHub bertanya repo mana yang boleh diakses, pilih **"Only select repositories"** dan pilih hanya repo yang diperlukan (prinsip least privilege).
4. Verifikasi email lewat tautan konfirmasi yang dikirim ke inbox (langkah wajib bila daftar via email; via GitHub memakai email akun GitHub).
5. Pilih workspace plan **Hobby ($0/bulan)**. Jangan pilih Pro ($25/bulan).
6. **Tanpa kartu kredit.** Tidak ada langkah pembayaran untuk layanan gratis.
7. Buat Web Service baru: hubungkan repo (atau Docker image), pilih region (saran: Oregon untuk probe pertama), pilih instance **Free**, set start command (mis. `node server.js`), deploy. URL live: `https://<nama>.onrender.com`.
8. (Opsional, untuk tim deploy:) siapkan keep-alive ping tiap 10 menit ke endpoint `/healthz` atau `/ping` ringan agar layanan tidak tidur.

---

### B.2 Peringkat 2 - Fly.io

**Kenapa peringkat 2:** independensi IP terbaik dari semua kandidat, tapi gagal syarat $0/tanpa kartu untuk pemakaian berkelanjutan. Trial 7 hari tanpa kartu masih cukup untuk probe uji.

#### (1) Independensi IP egress dari CF/Vercel/AWS

**Independen penuh. Ini kandidat paling independen secara infrastruktur.** [FAKTA, sumber primer: Fly.io Security & Compliance Questionnaire, terakhir diperbarui 13 Nov 2026, https://fly.io/legal/security-questionnaire/]

- Fly.io menjalankan beban kerja pelanggan di **server fisik (bare metal) yang disewa dari hosting provider**: CacheNetworks (CacheFly), DataPacket, Latitude.sh, NetActuate, dan Vultr. Servernya bermerek Supermicro, Gigabyte, Dell.
- Penggunaan AWS dan GCP "minimal" dan hanya untuk control plane: AWS RDS untuk database API Fly.io dan S3 untuk backup/artefak build. BUKAN untuk beban kerja pelanggan.
- Fly.io memasarkan dirinya sebagai "its own cloud with physical servers in data centers" / "Bare Metal - Not a Big Cloud Abstraction" (fly.io/nextjs, halaman resmi).
- Jaringan: Anycast BGP sendiri, 35+ region, proxy Rust + WireGuard mesh (cloudparts.dev, fakta dicek 12 Okt 2026; northflank.com, Sep 2026).

Egress Fly.io keluar dari rentang IP provider bare-metal di atas, bukan dari CF, AWS, atau Vercel. Dari sudut pandang penanda IP YouTube, ini keluarga yang paling berbeda dari semua yang sudah ditolak. **Ini alasan teknis terkuat untuk menguji Fly.io, walau tier gratisnya tidak ada.**

#### (2) Tier gratis tanpa kartu

**TIDAK ADA tier gratis untuk organisasi baru.** [FAKTA, banyak sumber yang konsisten.]

- Fly.io menghentikan penjualan plan Hobby ($5/bulan), Launch, dan Scale pada **7 Oktober 2024**; organisasi baru masuk Pay As You Go tanpa free allowance. Hanya organisasi lama yang masih memegang plan lama yang menyimpan allowance gratisnya (3 VM shared-cpu, 3 GB volume, 100 GB transfer). [FAKTA, convika.com 16 Nov 2026 mengutip docs Fly.io yang dibaca 5 Nov 2026; temps.sh Okt 2026; exodus.elim.io 19 Okt 2026.]
- **Trial pengganti:** akun baru mendapat **$1 kredit, berlaku 7 hari atau sampai habis**, tanpa kartu kredit. Trial Machines berhenti setelah 5 menit berjalan. [FAKTA, convika.com 16 Nov 2026; temps.sh Okt 2026. Catatan: bentuk trial berubah antara 3-4 Nov 2026 dari "2 jam runtime mesin atau 7 hari" menjadi "$1 kredit / 7 hari".]
- **Setelah trial:** kartu kredit wajib ditambahkan sebelum Machines bisa jalan lagi. Alternatif: prepaid credit, minimum $25.
- **Biaya bila diteruskan:** mesin terkecil always-on (shared-cpu-1x, 256 MB RAM) = **$2,19 per 30 hari** di region termurah (Ashburn `iad` atau Secaucus `ewr`). Egress $0,02/GB (Amerika Utara/Eropa). Volume $0,15/GB/bulan. [FAKTA, convika.com; temps.sh; exodus.elim.io, semua Okt-Nov 2026.]
- **Detail penting:** halaman pricing Fly.io menyatakan **"Invoices under $5 are waived"** (tagihan di bawah $5 ditiadakan). [FAKTA, convika.com 16 Nov 2026 mengutip fly.io/pricing.] Artinya mesin $2,19/bulan kemungkinan tidak pernah benar-benar ditagih. TAPI kartu tetap wajib tersimpan di akun, dan tidak ada spending cap/alert bawaan (exodus.elim.io 19 Okt 2026: "Fly does not support billing alerts yet"). Keputusan memakai kartu tetap di tangan owner; agen tidak boleh mendaftarkan kartu sendiri.
- **Tidak ada tidur paksa:** Machines bisa di-set always-on (bayar per detik saat jalan) atau auto-stop saat idle (bayar hanya saat jalan + $0,15/GB/bulan root filesystem saat berhenti). Untuk proxy yang harus responsif, always-on adalah pilihannya.

**Implikasi untuk Laras:** Fly.io TIDAK bisa menjadi egress produksi gratis. Tapi trial 7 hari / $1 (tanpa kartu) cukup untuk menjalankan protokol probe lengkap (belasan request, masing-masing beberapa detik) dan menjawab pertanyaan "apakah IP Fly.io lolos dari YouTube". Bila probe menunjukkan BERSIH, owner bisa memutuskan apakah $2,19/bulan (kemungkinan ditiadakan karena di bawah $5) sepadan dengan kartu yang tersimpan.

#### (3) Outbound fetch ke youtube.com

**Diizinkan, tanpa allowlist.** [FAKTA: tidak ada pembatasan outbound yang terdokumentasi.] Fly Machine adalah microVM penuh (Firecracker/KVM) dengan akses jaringan penuh; aplikasi bisa fetch ke host mana pun.

#### (4) Model fungsi serverless

**Bukan serverless; ini microVM persisten (Fly Machines).** Cocok penuh untuk proxy:

- Menjalankan Docker image atau buildpacks; deploy via `flyctl` CLI atau Machines API. Server Node long-lived, POST + streaming + WebSocket + header kustom semuanya native (fly.io/nextjs: "streaming and WebSockets work natively").
- **Tanpa batas timeout per request** (VM, bukan fungsi). Boot mesin dalam hitungan ratus milidetik sampai beberapa detik.
- Satu aplikasi bisa di-deploy multi-region; untuk probe, satu region (mis. `iad` Ashburn, termurah) sudah cukup.

#### Langkah akun (Fly.io)

1. Buka https://fly.io, daftar dengan **email** atau **GitHub**. Verifikasi email bila diminta.
2. **Trial otomatis aktif:** $1 kredit, 7 hari, TANPA kartu kredit. Tidak ada langkah pembayaran untuk memulai trial.
3. Install `flyctl` CLI dan jalankan `fly auth login` (atau pakai Machines API dengan token).
4. Buat aplikasi (`fly launch`), pilih region termurah (`iad` Ashburn atau `ewr` Secaucus), mesin shared-cpu-1x 256 MB.
5. **Setelah trial habis (7 hari atau $1 habis):** Machines berhenti sampai kartu kredit ditambahkan di dashboard Billing (atau prepaid credit minimum $25). Kartu baru dikenai pre-authorization kecil (di bawah $10) untuk verifikasi.
6. Catatan untuk owner: tagihan di bawah $5/bulan dinyatakan ditiadakan di halaman pricing, tapi kartu tetap wajib tersimpan dan tidak ada spending cap bawaan. Keputusan ini milik owner sepenuhnya.

---

### B.3 Peringkat 3 - Netlify

**Kenapa peringkat 3:** gagal di dua syarat sekaligus, independensi IP (AWS, sama dengan Vercel) dan timeout (10 detik, di bawah 30 detik). Satu-satunya hal yang mendukungnya adalah tier gratis tanpa kartu, tapi itu tidak cukup.

#### (1) Independensi IP egress dari CF/Vercel/AWS

**Tidak independen. Netlify Functions berjalan di AWS Lambda.** [FAKTA, banyak sumber yang konsisten.]

- sota.io (17 Mei 2026): "Every serverless function on Netlify runs on AWS Lambda."
- pickhosting.co (2026): "Netlify Functions also run on AWS Lambda."
- databasezy docs: "Netlify Functions run on AWS Lambda without static IPs."
- workflowautomation.net (2026): "Netlify Functions are actually built on AWS Lambda under the hood."
- Netlify tidak mempublikasikan daftar egress IP untuk Functions di plan self-serve; IP outbound statis hanya via add-on Enterprise "Private Connectivity" (fixedmark.com, 7 Nov 2026).

Artinya egress Netlify Functions keluar dari pool IP AWS yang sama dengan keluarga Vercel, yang sudah terbukti ditolak YouTube 7/7 pada jendela buruk. Probabilitas lolos rendah.

**Edge Functions bukan jalan keluar:** Netlify Edge Functions berjalan di runtime Deno Deploy (sota.io 17 Mei 2026; pickhosting.co 2026). Deno Deploy mati sekitar April 2027 (Bagian A), jadi jalur ini ikut mati. Edge Functions juga punya batas CPU 50 ms per invokasi (mindrally/skills, GitHub).

#### (2) Tier gratis tanpa kartu

**Ya, tanpa kartu, tapi dengan sistem kredit yang restriktif untuk akun baru.** [FAKTA.]

- **Akun baru (dibuat sejak 4 September 2025):** paket kredit, **300 kredit/bulan** dipakai bersama: bandwidth 20 kredit/GB (sekitar 15 GB bila semua dipakai untuk bandwidth), deploy produksi 15 kredit each (sekitar 20 deploy), fungsi 10 kredit per GB-jam. Bila kredit habis, layanan BERHENTI melayani traffic sampai bulan berikut; tidak ada auto-recharge di Free. [FAKTA, temps.sh 20 Okt 2026; aiunplugged.in 9 Sep 2026; snapdeploy.dev 29 Sep 2026.]
- **Akun lama (sebelum 4 Sep 2025):** paket legacy, 100 GB bandwidth + 125.000 invokasi fungsi/bulan. Owner kemungkinan belum punya akun Netlify, jadi yang berlaku adalah paket kredit.
- Edge Functions mendapat 1 juta invokasi/bulan terpisah dari pool kredit (aiunplugged.in), tapi Edge berjalan di Deno (lihat di atas).
- Free plan: "permanent, no credit card" (aipriceradar.com, 9 Nov 2026). Personal $9/bulan (1.000 kredit), Pro $20/bulan per tim (3.000 kredit).

#### (3) Outbound fetch ke youtube.com

**Diizinkan, tanpa allowlist yang terdokumentasi.** [FAKTA: tidak ada pembatasan outbound yang ditemukan.] Netlify Functions adalah Node.js di Lambda; fetch ke host mana pun bekerja. Masalahnya bukan izin, tapi IP egress (AWS) dan timeout.

#### (4) Model fungsi serverless

**Serverless Lambda, dan inilah yang menggugurkannya.**

- **Timeout: 10 detik di Free, maksimal 26 detik di Pro.** [FAKTA, dikonfirmasi banyak sumber independen: alivemcp.com; pickhosting.co; hostfleet.net 21 Apr 2026; aipriceradar.com 9 Nov 2026; tomevault-io/tomes (skill Netlify, GitHub).] Melewati batas = 502 tanpa respons parsial. Laras butuh minimal 30 detik (probe nyata 11-23 detik; Pro yang 26 detik pun masih di bawah 30 detik).
- **Konflik sumber, dicatat jujur:** satu sumber (temps.sh, 20 Okt 2026) mengklaim fungsi sinkron berjalan "hingga 60 detik" di semua paket kredit termasuk Free. Klaim ini bertentangan dengan mayoritas sumber (termasuk yang terbaru, Nov 2026) yang menyebut 10 detik Free / 26 detik Pro. Laporan ini memakai angka 10 detik karena dikoroborasi banyak sumber independen; bila koordinator tetap ingin menguji Netlify, verifikasi timeout di dashboard/docs resmi saat pembuatan akun.
- Background Functions (hingga 15 menit) tersedia tapi fire-and-forget (tidak mengembalikan respons ke klien) dan merupakan fitur berbayar; tidak cocok untuk proxy sinkron.
- Scheduled Functions: 30 detik, tapi untuk cron, bukan proxy request.
- Deploy: file di `netlify/functions/`, deploy via Git connect, CLI, atau drag-and-drop. POST + header kustom didukung; streaming respons terbatas oleh dinding timeout.

#### Langkah akun (Netlify)

1. Buka https://netlify.com, daftar dengan **email** atau **GitHub/GitLab/Bitbucket**.
2. Verifikasi email lewat tautan konfirmasi.
3. **Tanpa kartu kredit** untuk Free plan.
4. Akun baru otomatis masuk paket kredit (300 kredit/bulan). Buat site baru, hubungkan repo GitHub atau deploy via CLI (`netlify deploy`).
5. Fungsi ditaruh di `netlify/functions/`; endpoint live di `/.netlify/functions/<nama>` pada domain `https://<site>.netlify.app`.
6. Catatan: timeout fungsi default 10 detik di Free; verifikasi di dashboard bila ragu (lihat konflik sumber di atas).

---

### Deno Deploy sebagai pembanding (bukan peringkat)

| Aspek | Penilaian |
|---|---|
| Independensi IP | Baik saat ini (jaringan sendiri, bukan CF); tidak ada bukti migrasi egress ke CF |
| Tier gratis | 1 juta request, 20 GiB egress, 10 jam CPU; kuota penuh butuh kartu |
| Timeout | Isolate tanpa batas ketat; cocok untuk proxy |
| Umur | **MATI sekitar April 2027** |
| Keputusan | DITOLAK. Lihat Bagian A.5. |

---

## Rekomendasi langkah berikut untuk koordinator

1. **Jalur utama: Render.** Minta owner membuat akun Render (tanpa kartu, via GitHub) dan luncurkan tim deploy + uji dengan protokol yang sama seperti Vercel (3x per klien WEB_REMIX + ANDROID_VR, CF diapit). Vonis BERSIH hanya bila OK + format audio SAAT CF LOGIN_REQUIRED. Region probe pertama: Oregon.
2. **Jalur uji paralel (tanpa kartu): Fly.io trial.** Akun Fly.io + trial $1/7 hari cukup untuk probe yang sama. Bila Fly.io BERSIH sementara Render ditolak, owner bisa memutuskan soal kartu ($2,19/bulan, kemungkinan ditiadakan karena di bawah $5). Jangan daftarkan kartu tanpa persetujuan owner.
3. **Netlify: jangan dulu.** Kecuali Render dan Fly.io sama-sama ditolak DAN koordinator ingin menghabiskan semua opsi, Netlify tidak layak diuji duluan (AWS + timeout 10 detik).
4. **Deno: tutup.** Jangan buat akun.
5. **Catatan arsitektur:** bila Render lolos, siapkan keep-alive ping tiap 10 menit (dari Worker CF atau cron eksternal) dan failover yang tahan terhadap bangun tidur ~1 menit. Bila media ikut di-proxy, pantau bandwidth 5 GB/bulan.

---

## Fakta vs dugaan (ringkas)

**FAKTA (terverifikasi dari sumber yang dikutip):**

- Tim Deno bergabung ke Cloudflare, diumumkan 9 Okt 2026 (dua blog resmi).
- Deno Deploy tutup 6 bulan setelah pengumuman; JSR pindah infrastruktur ke Cloudflare; runtime dapat 1 tahun maintenance.
- Tier gratis Deno Deploy: 1 juta request, 20 GiB egress, 10 jam CPU; kuota penuh butuh verifikasi kartu.
- Tidak ada allowlist outbound untuk aplikasi Deploy reguler (allowlist hanya milik Deno Sandbox, produk Pro).
- Netlify Functions berjalan di AWS Lambda; timeout 10 detik Free / 26 detik Pro (mayoritas sumber).
- Netlify Edge Functions berjalan di runtime Deno Deploy.
- Render berjalan di AWS + GCP; free tier $0 tanpa kartu; tidur 15 menit, bangun ~1 menit; 750 jam/bulan; bandwidth Hobby 5 GB/bulan; timeout HTTP 100 menit.
- Fly.io tanpa free tier untuk organisasi baru sejak 7 Okt 2024; trial $1/7 hari tanpa kartu; mesin termurah $2,19/30 hari; tagihan di bawah $5 ditiadakan (per pricing page); beban kerja di bare metal sendiri (bukan AWS/GCP/CF).
- Tidak satu pun dari keempat layanan ini mendokumentasikan blokir outbound ke youtube.com.

**DUGAAN (beralasan, belum terverifikasi):**

- Egress Deno Deploy masih di jaringan Deno sendiri sampai tutup (disimpulkan dari tidak adanya pernyataan migrasi; hanya JSR yang dinyatakan pindah).
- Tanggal tutup Deploy sekitar 9 April 2027 (6 bulan dari pengumuman; Deno belum menerbitkan tanggal kalender).
- IP GCP Render berpeluang lolos dari YouTube (belum pernah diuji; YouTube mungkin menolak semua IP pusat data di jendela buruk).
- Oregon adalah region Render yang paling condong ke GCP (berdasarkan sejarah Render; pembagian AWS/GCP per region tidak dipublikasikan).
- Tagihan Fly.io $2,19/bulan akan ditiadakan karena di bawah $5 (pernyataan di pricing page; belum dibuktikan dengan tagihan nyata).
- Klaim temps.sh soal timeout Netlify 60 detik di paket kredit (bertentangan dengan mayoritas sumber; tidak dipakai sebagai dasar keputusan).

---

## Daftar sumber

Sumber primer (dibaca langsung):

1. Deno Blog, Ryan Dahl, "Deno is joining Cloudflare", 9 Okt 2026 - https://deno.com/blog/cloudflare
2. Cloudflare Blog, Kenton Varda dan Ryan Dahl, "Deno is joining Cloudflare", 9 Okt 2026 12:50 UTC - https://blog.cloudflare.com/deno-joins-cloudflare
3. Fly.io, "Security & Compliance Questionnaire", terakhir diperbarui 13 Nov 2026 - https://fly.io/legal/security-questionnaire/
4. Deno, halaman produk Deno Deploy (dibaca 19 Nov 2026) - https://deno.com/deploy
5. Render (resmi), "Leaving Heroku in 2026: A Complete Migration Guide" (timeout 100 menit) - https://render.com/articles/leaving-heroku-migration-guide-2026
6. Render (resmi), "Best infrastructure for Python AI backends and Celery workers in 2026" (timeout 100 menit) - https://render.com/articles/best-infrastructure-python-ai-celery-workers

Liputan dan analisis Deno/Cloudflare:

7. TSN Media, "Deno Team Joins Cloudflare as Deno Deploy Winds Down", diperbarui 23 Okt 2026 - https://tsnmedia.org/deno-team-joins-cloudflare-runtime-one-year-deploy-six-months/
8. Beri.net, "Deno Deploy to Shut Down Six Months After Cloudflare Deal", Okt 2026 - https://www.beri.net/article/cloudflare-deno-acquisition-deno-deploy-shutdown-six-months-runtime-one-year-workers-migration
9. Pinggy Blog, "Deno Is Joining Cloudflare: What to Do With Your Deno Apps", 10 Okt 2026 - https://pinggy.io/amp/blog/deno_joins_cloudflare_what_to_do/
10. Digital Matters, "Deno Joins Cloudflare: Deno Deploy Has Six Months", Okt 2026 - https://digitalmatters.me/it-infrastructure/deno-joins-cloudflare/
11. Flavio Copes, "How to move a Deno app to Cloudflare Workers", diperbarui 4 Nov 2026 - https://flaviocopes.com/deno-workers/

Tier gratis Deno Deploy:

12. freetier.wiki, "Deno Deploy free tier: limits & billing", 16 Nov 2026 - https://freetier.wiki/services/deno-deploy/
13. stacksfree.com, "Cloudflare Workers vs Deno Deploy vs Vercel Functions", dicek 10 Nov 2026 - https://stacksfree.com/blog/free-tier-serverless-cloudflare-workers-vs-deno-deploy-vs-vercel-functions/
14. agentdeals.dev, "Hosting & PaaS Free Tier Comparison 2026", terakhir dicek 31 Okt 2026 - https://agentdeals.dev/hosting-free-tier-comparison-2026
15. wheredoirunthis.com, "Deno Deploy - pricing, runtime, capabilities" (tidak ada allowlist outbound untuk aplikasi reguler) - https://wheredoirunthis.com/products/deno

Netlify:

16. sota.io, "EU Serverless PaaS Comparison 2026" (Functions = AWS Lambda; Edge = Deno Deploy), 17 Mei 2026 - https://www.sota.io/blog/eu-serverless-paas-comparison-2026-cloud-act-gdpr-finale
17. temps.sh, "Netlify Pricing 2026: Free Tier, 300 Credits", 20 Okt 2026 - https://temps.sh/compare/vs-netlify
18. aiunplugged.in, "Cloudflare Pages vs Vercel vs Netlify - free tier comparison 2026", 9 Sep 2026 - https://aiunplugged.in/blog/cloudflare-pages-vs-vercel-vs-netlify/
19. aipriceradar.com, "Netlify Pricing 2026", diperbarui 9 Nov 2026 - https://aipriceradar.com/tool/netlify-pricing
20. alivemcp.com, "MCP server on Netlify Functions" (timeout 10 detik Free / 26 detik Pro) - https://www.alivemcp.com/seo/mcp-server-netlify-functions
21. pickhosting.co, "Vercel vs Netlify 2026" - https://pickhosting.co/compare/vercel-vs-netlify/
22. fixedmark.com, "Netlify Functions Static IP: Outbound IP Setup", 7 Nov 2026 - https://www.fixedmark.com/integrations/netlify
23. snapdeploy.dev, "From Vercel or Netlify to a Container", 29 Sep 2026 - https://snapdeploy.dev/blog/vercel-netlify-to-container-when-you-need-a-server

Render:

24. theproofdesk.com, "Render Review 2026", Okt 2026 (angka per 22 Okt 2026) - https://theproofdesk.com/render-review
25. justinmckelvey.com, "Is Render Free? Free Tier Limits, Sleep, and the 30-Day DB (2026)", 3 Sep 2026 - https://justinmckelvey.com/blog/is-render-free
26. ployz.dev, "Render free tier in 2026: what's free, what sleeps", harga dicek 16 Nov 2026 - https://ployz.dev/blog/render-free-tier
27. agentdeals.dev, "Render Free Tier 2026", terakhir diperbarui 14 Nov 2026 - https://agentdeals.dev/vendor/render
28. render.alternative.to, "Render alternatives: free tier limits and first paid plans", diperbarui 12 Nov 2026 - https://render.alternative.to/
29. comparedge.com, "Render Deployment, Regions & Data Residency 2026", diperbarui 15 Juli 2026 - https://comparedge.com/tools/render/deployment-regions
30. encore.dev, "Render vs Railway (2026)", harga dicek 27 Okt 2026 - https://encore.dev/articles/render-vs-railway
31. watchcron.com, "How to keep free-tier apps alive with external cron" - https://watchcron.com/guides/keep-alive-free-tier-hosting
32. altftool.com, "Render free tier", dicek 1 Nov 2026 - https://www.altftool.com/lookouts/free-domain-hosting/cloud/render

Fly.io:

33. convika.com, "Is Fly.io free? No free tier: the trial and what apps cost", diperbarui 16 Nov 2026 (docs dibaca 5 Nov 2026) - https://convika.com/compare/fly-io-free-tier/
34. temps.sh, "Fly.io Pricing 2026: What It Actually Costs", terverifikasi Okt 2026 - https://temps.sh/blog/fly-io-pricing-2026
35. exodus.elim.io, "Fly.io pricing, line by line, next to Cloud Run", 19 Okt 2026 - https://exodus.elim.io/blog/fly-io-pricing-next-to-cloud-run
36. stacksfree.com, "Beginner's Guide to Fly.io: Getting Started in 2026", terverifikasi Sep 2026 - https://stacksfree.com/blog/fly-io-free-tier-guide-2026/
37. cloudparts.dev, "Fly.io" (fakta dicek 12 Okt 2026) - https://cloudparts.dev/technologies/fly-io/
38. fly.io (resmi), halaman Next.js ("Bare Metal - Not a Big Cloud Abstraction") - https://fly.io/nextjs/

Dokumen Laras terkait:

39. `docs/vercel-egress.md` (19 Nov 2026) - Vercel DITOLAK (LOGIN_REQUIRED 7/7); evaluasi awal Deno Deploy §5.
