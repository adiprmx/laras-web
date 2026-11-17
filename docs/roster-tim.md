# Roster Tim — Laras Web App Full-Stack

> Proyek: **Laras Web** — aplikasi musik gratis tanpa iklan + offline versi WEB
> (workstream baru dari APK Flutter Laras; web berjalan PARALEL, bukan pengganti APK).
> Workdir: `~/workspace/music-app-web/`
> Basis: struktur 1 koordinator + 45 tim (`prompt-struktur-45-tim.md`), diperluas
> atas permintaan owner menjadi puluhan hingga ratusan tim senior.
> Standar tim: **pengalaman 10+ tahun** di bidangnya masing-masing.
> Terakhir diperbarui: 17 November 2026 (Fase 1).

---

## Kepemimpinan (peran, bukan tim tambahan)

| Peran | Tugas |
|---|---|
| **Koordinator Proyek (1)** | Membagi tugas per paket, menyelaraskan standar, menghapus duplikat, menggabungkan laporan, memverifikasi hasil, melaporkan progres berkala kepada owner. |
| **Ketua Grup A — Lapisan Teknis** | Mengoordinasikan seluruh tim lapisan teknis (Kelompok A). |
| **Ketua Grup B — Area Fitur** | Mengoordinasikan seluruh tim fitur (Kelompok B). |
| **Ketua Grup C — Organisasi Produk** | Mengoordinasikan seluruh tim organisasi produk (Kelompok C). |
| **Ketua Grup D — Pertumbuhan & Kepercayaan** | Mengoordinasikan seluruh tim pertumbuhan & kepercayaan (Kelompok D). |

### Ketua Divisi (peran, bukan tim tambahan)

| Divisi | Cakupan |
|---|---|
| Divisi Frontend | Arsitektur frontend, komponen UI, PWA, audio web, aksesibilitas (A1–A10). |
| Divisi Backend & Edge | Edge workers, API gateway, proxy InnerTube, auth, sinkronisasi, CDN (A11–A15, A22). |
| Divisi Data | Database, storage media, katalog, analitik (A16–A17, C4, C15–C16). |
| Divisi Keamanan | Blue Team, Red Team, Purple Team, privasi, legal (A18–A20, C9–C10, D5). |
| Divisi Kualitas | QA fungsional, QA E2E, performa, observabilitas, SRE (A23–A28). |
| Divisi Produk | Fitur (Kelompok B), organisasi produk (Kelompok C), manajemen produk (D1–D2). |
| Divisi Pertumbuhan | Marketing, komunitas, kemitraan, edukasi, keberlanjutan (Kelompok D). |

---

## Kelompok A — Lapisan Teknis (30 tim)

### A1–A10: Frontend Web

| No | Tim | Tugas (1 baris) |
|---|---|---|
| A1 | Arsitektur Frontend Web | Merancang arsitektur aplikasi web (struktur modul, pola rendering, pemisahan lapisan UI/logika). |
| A2 | Komponen UI & Design System Web | Membangun pustaka komponen web yang konsisten, dapat dipakai ulang, dan sesuai design system Laras. |
| A3 | State Management & Data Fetching | Mengelola state aplikasi, cache data, dan pola pengambilan data yang efisien dan konsisten. |
| A4 | Routing & Navigasi Web | Mengatur rute, navigasi antar halaman, deep link, dan state URL yang bisa dibagikan. |
| A5 | PWA & Offline | Mengimplementasikan service worker, manifest PWA, instalasi aplikasi, dan mode offline. |
| A6 | Audio Web Inti | Mengimplementasikan pemutaran audio berbasis Web Audio API dan elemen audio HTML5. |
| A7 | Web Workers & Pemrosesan Latar | Menjalankan pekerjaan berat (decoding, unduhan, sinkronisasi) di latar tanpa menghambat antarmuka. |
| A8 | Aksesibilitas Web | Memastikan aplikasi memenuhi WCAG: navigasi keyboard, pembaca layar, kontras, dan fokus. |
| A9 | Responsivitas & Multi-Perangkat | Memastikan tampilan rapi di HP, tablet, dan desktop pada berbagai ukuran layar. |
| A10 | Animasi & Mikro-interaksi Web | Membangun animasi dan umpan balik visual yang halus, ringan, dan tidak mengganggu. |

### A11–A17: Backend, Edge & Data

| No | Tim | Tugas (1 baris) |
|---|---|---|
| A11 | Edge Workers & Serverless Backend | Membangun logika sisi server tanpa server khusus (serverless/edge) dengan biaya nol rupiah. |
| A12 | API Gateway & BFF | Merancang gerbang API dan Backend-for-Frontend yang melayani kebutuhan khusus aplikasi web. |
| A13 | Proxy InnerTube & Integrasi YouTube Music | Mengelola integrasi katalog YouTube/YouTube Music melalui InnerTube kustom (jalur tidak resmi, port dari APK Laras), tanpa menyentuh API Spotify. |
| A14 | Auth & Akun (Backend) | Mengelola autentikasi, sesi, dan keamanan akun di sisi server. |
| A15 | Sinkronisasi Data (Backend) | Membangun mekanisme sinkronisasi perpustakaan, playlist, dan preferensi antar perangkat. |
| A16 | Data & Database | Merancang skema, migrasi, retensi, pencadangan, dan keamanan baris (RLS) pada database. |
| A17 | Storage & Media | Mengelola penyimpanan lokal (IndexedDB, OPFS, Cache Storage) untuk audio unduhan dan media. |

### A18–A20: Keamanan

| No | Tim | Tugas (1 baris) |
|---|---|---|
| A18 | Blue Team — Web Security | Bertahan: autentikasi, otorisasi, CSP, secrets, rate limit, dan hardening aplikasi web. |
| A19 | Red Team Web | Menyerang: simulasi serangan, penetration test, dan pencarian celah keamanan. |
| A20 | Purple Team | Memvalidasi perbaikan: memastikan temuan Red Team benar-benar sudah ditutup, lalu menguji ulang. |

### A21–A30: Infrastruktur, Kualitas & Performa

| No | Tim | Tugas (1 baris) |
|---|---|---|
| A21 | DevOps & CI/CD Web | Mengelola pipeline build, pengujian otomatis, deploy, domain, dan hosting. |
| A22 | Edge & CDN | Mengoptimalkan distribusi global melalui edge network dan caching konten statis. |
| A23 | Observabilitas Web | Membangun logging, metrik, dan tracing untuk memantau kesehatan aplikasi. |
| A24 | SRE & Respons Insiden | Menjaga uptime, merespons insiden, dan menjalankan postmortem. |
| A25 | QA Fungsional & Regresi Web | Menguji fungsi aplikasi, regresi antar rilis, dan edge case. |
| A26 | QA E2E & Otomasi Browser | Menulis dan menjalankan pengujian end-to-end otomatis di browser (Playwright). |
| A27 | Performance Web | Mengoptimalkan Core Web Vitals, waktu muat, dan konsumsi sumber daya browser. |
| A28 | Skalabilitas & Beban | Menguji beban, profiling, caching, dan kesiapan aplikasi menghadapi lonjakan pengguna. |
| A29 | Kompatibilitas Browser & Standar Web | Memastikan aplikasi berjalan konsisten di browser utama dan mengikuti standar web terbaru. |
| A30 | Tooling & Developer Experience | Mengelola build tools, bundler, monorepo, linter, dan alur kerja pengembang. |

**Jumlah Kelompok A: 30 tim.**

---

## Kelompok B — Area Fitur (28 tim)

Dipetakan ke 11 fitur utama Laras Web. Setiap fitur ditangani 2–3 tim spesialis.

### Fitur 1 — Beranda / Jelajah (3 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B1 | Beranda & Rekomendasi | Membangun halaman beranda dengan rekomendasi lagu yang relevan dan personal. |
| B2 | Jelajah & Genre | Membangun halaman jelajah berdasarkan genre, suasana, dan kategori musik. |
| B3 | Tren & Kurasi | Menampilkan lagu trending dan kurasi editorial di beranda. |

### Fitur 2 — Pencarian (2 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B4 | Pencarian Inti & Saran | Membangun mesin pencarian lagu, artis, dan album beserta saran pencarian. |
| B5 | Hasil Pencarian & Filter | Menampilkan hasil pencarian dengan filter, pengurutan, dan tampilan yang jelas. |

### Fitur 3 — Pemutar (3 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B6 | Pemutar Inti | Membangun kontrol putar/jeda/lanjut/mundur, seek bar, volume, dan mode putar. |
| B7 | MediaSession & Now Playing | Mengintegrasikan MediaSession API dan tampilan Now Playing di perangkat. |
| B8 | Radio, Autoplay & Putar Berikutnya | Membangun radio berbasis lagu/artis, autoplay, dan antrean putar berikutnya otomatis. |

### Fitur 4 — Antrean (2 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B9 | Antrean & Manajemen Urutan | Membangun antrean putar: tambah, hapus, susun ulang, dan simpan antrean. |
| B10 | Riwayat Putar & Putar Ulang | Mencatat riwayat pemutaran dan memudahkan pengguna memutar ulang lagu. |

### Fitur 5 — Perpustakaan (2 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B11 | Perpustakaan & Koleksi | Membangun perpustakaan pribadi: lagu, album, dan artis yang disimpan pengguna. |
| B12 | Favorit & Lagu Disukai | Mengelola lagu favorit, tanda suka, dan koleksi cepat pengguna. |

### Fitur 6 — Playlist (3 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B13 | Playlist Inti | Membangun pembuatan, pengeditan, penghapusan, dan pemutaran playlist. |
| B14 | Playlist Berbagi & Kolaboratif | Membangun berbagi playlist dan kolaborasi playlist antar pengguna. |
| B15 | Impor Playlist | Mengimpor playlist dari sumber lain tanpa API Spotify (mis. file, tautan publik). |

### Fitur 7 — Unduhan / Offline (3 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B16 | Unduhan Audio & Manajemen Storage | Membangun unduhan lagu untuk pemutaran offline dan pengelolaan ruang penyimpanan. |
| B17 | Mode Offline & Sinkronisasi Unduhan | Memastikan lagu unduhan dapat diputar tanpa internet dan tersinkron antar perangkat. |
| B18 | Kualitas Audio & Manajemen Bitrate | Mengelola pilihan kualitas audio unduhan dan streaming sesuai koneksi pengguna. |

### Fitur 8 — Lirik (2 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B19 | Lirik Sinkron & Tampilan | Menampilkan lirik yang tersinkron dengan lagu yang sedang diputar. |
| B20 | Terjemahan & Sumber Lirik | Menyediakan terjemahan lirik dan mengelola sumber lirik yang sah. |

### Fitur 9 — Pengaturan (3 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B21 | Pengaturan Aplikasi & Preferensi | Membangun halaman pengaturan: tema, bahasa, kualitas, dan preferensi umum. |
| B22 | Equalizer & Efek Audio | Membangun equalizer, preset suara, dan efek audio yang dapat disesuaikan. |
| B23 | Timer Tidur & Pemutaran Latar | Membangun sleep timer dan pemutaran latar yang tetap berjalan saat layar terkunci. |

### Fitur 10 — Akun & Sinkronisasi (3 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B24 | Akun & Profil Pengguna | Membangun halaman akun, profil, dan pengelolaan data pengguna. |
| B25 | Sinkronisasi Cloud & Backup | Membangun backup dan sinkronisasi data pengguna ke cloud secara aman. |
| B26 | Multi-Perangkat & Handoff | Memungkinkan pemutaran berpindah antar perangkat tanpa kehilangan posisi lagu. |

### Fitur 11 — Onboarding (2 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| B27 | Onboarding & Tur Pertama | Membangun pengalaman pertama pengguna: tur fitur, pengenalan, dan langkah awal. |
| B28 | Personalisasi Awal & Aktivasi | Membantu pengguna memilih preferensi musik awal agar rekomendasi langsung relevan. |

**Jumlah Kelompok B: 28 tim** (3+2+3+2+2+3+3+2+3+3+2 = 28).

---

## Kelompok C — Organisasi Produk (21 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| C1 | Riset Produk & Perbandingan Kompetitor | Meneliti produk sejenis dan memetakan keunggulan serta kekurangan Laras Web. |
| C2 | Konten & Bahasa | Menulis copy antarmuka dan konten dengan bahasa sehari-hari yang mudah dicerna semua orang. |
| C3 | Dukungan Pengguna & Helpdesk | Menjawab pertanyaan pengguna, menangani keluhan, dan mengelola kanal bantuan. |
| C4 | Web Analytics Tanpa Pelacak Pihak Ketiga | Mengukur penggunaan aplikasi dengan analitik yang menghormati privasi (tanpa pelacak pihak ketiga). |
| C5 | SEO Teknis & Keterlihatan Web | Mengoptimalkan struktur, metadata, dan performa agar Laras Web mudah ditemukan mesin pencari. |
| C6 | Aksesibilitas Produk & Inklusi | Memastikan produk dapat digunakan semua orang, termasuk pengguna disabilitas. |
| C7 | Dokumentasi Pengguna | Menulis panduan penggunaan, FAQ, dan pusat bantuan untuk pengguna akhir. |
| C8 | Dokumentasi API & Developer | Menulis dokumentasi teknis API dan panduan kontribusi untuk pengembang. |
| C9 | Legal, Lisensi & Hak Cipta Musik | Mengurus aspek hukum, lisensi, dan hak cipta terkait katalog musik. |
| C10 | Privasi & Perlindungan Data | Memastikan kepatuhan terhadap aturan privasi (termasuk UU PDP) dan perlindungan data pengguna. |
| C11 | AI & Otomasi | Mengembangkan fitur rekomendasi cerdas, bantuan otomatis, dan otomasi internal. |
| C12 | Lokalisasi & i18n | Menerjemahkan antarmuka ke berbagai bahasa dan menyesuaikan format lokal. |
| C13 | Brand & Identitas Visual Web | Menjaga konsistensi logo, warna, tipografi, dan pedoman brand di web. |
| C14 | Desain Grafis & Aset Media | Membuat aset visual: ikon, ilustrasi, sampul, dan materi promosi. |
| C15 | Manajemen Konten & Kurasi Katalog | Mengelola dan mengkurasi katalog lagu, album, dan playlist unggulan. |
| C16 | Kualitas Data Katalog (Metadata) | Menjaga akurasi metadata lagu, artis, album, dan sampul di katalog. |
| C17 | Kebijakan Platform & Kepatuhan | Memastikan produk mematuhi kebijakan platform, hosting, dan layanan yang dipakai. |
| C18 | Riset Teknologi & Evaluasi Stack | Mengevaluasi teknologi, framework, dan layanan baru sebelum diadopsi. |
| C19 | Manajemen Rilis & Changelog | Mengatur jadwal rilis, catatan perubahan, dan komunikasi versi baru. |
| C20 | Umpan Balik Pengguna & Backlog Produk | Mengumpulkan umpan balik pengguna dan mengubahnya menjadi backlog yang terprioritasi. |
| C21 | Standar Editorial & Panduan Gaya | Menyusun dan menegakkan standar penulisan, nada bahasa, dan gaya konten produk. |

**Jumlah Kelompok C: 21 tim.**

---

## Kelompok D — Pertumbuhan & Kepercayaan (23 tim)

| No | Tim | Tugas (1 baris) |
|---|---|---|
| D1 | Product Management & Roadmap | Menyusun roadmap produk, prioritas, dan definisi keberhasilan tiap fase. |
| D2 | User Research | Melakukan wawancara dan observasi untuk memahami kebutuhan pengguna nyata. |
| D3 | Marketing & Growth Web | Merancang strategi pertumbuhan pengguna web secara organik dan berkelanjutan. |
| D4 | Komunitas Web & Forum | Membangun dan merawat komunitas pengguna Laras di web dan forum. |
| D5 | Trust & Safety | Menjaga keamanan pengguna: moderasi konten, anti-spam, dan penanganan penyalahgunaan. |
| D6 | Keuangan & Keberlanjutan | Mengelola model gratis yang berkelanjutan (donasi, sponsor) dengan biaya nol rupiah. |
| D7 | Business Development & Kemitraan | Menjalin kemitraan strategis dengan pihak yang sejalan dengan misi Laras. |
| D8 | PR & Media | Mengelola hubungan media, siaran pers, dan liputan tentang Laras. |
| D9 | Edukasi Pengguna | Membuat tutorial, panduan, dan materi belajar agar pengguna memaksimalkan Laras. |
| D10 | Manajemen Risiko & Keberlangsungan | Mengidentifikasi risiko bisnis dan menyusun rencana darurat keberlangsungan layanan. |
| D11 | Distribusi Web | Mengoptimalkan distribusi: instalasi PWA, direktori aplikasi web, dan tautan berbagi. |
| D12 | Social Media & Konten Promosi | Mengelola media sosial dan konten promosi Laras. |
| D13 | Program Beta & Early Adopter | Mengelola program pengujian beta dan komunitas pengguna awal. |
| D14 | Advokasi Open Source & Kontributor | Membangun komunitas kontributor open source dan mengelola kontribusi eksternal. |
| D15 | Hubungan Artis & Label Independen | Menjalin hubungan dengan artis dan label independen untuk katalog dan promosi. |
| D16 | Metrik Pertumbuhan & Eksperimen A/B | Mengukur pertumbuhan dan menjalankan eksperimen untuk meningkatkan produk. |
| D17 | Retensi & Engagement | Merancang program agar pengguna tetap aktif dan kembali menggunakan Laras. |
| D18 | Program Referral & Word-of-Mouth | Membangun program ajak teman dan pertumbuhan dari mulut ke mulut. |
| D19 | Green Web & Efisiensi Energi | Mengurangi jejak energi aplikasi web melalui efisiensi kode dan infrastruktur. |
| D20 | Etika AI & Transparansi Algoritma | Menjaga rekomendasi dan fitur AI tetap transparan, adil, dan dapat dijelaskan. |
| D21 | Komunikasi Krisis & Darurat | Menangani komunikasi kepada pengguna saat terjadi gangguan atau krisis. |
| D22 | Audit Kepercayaan & Sertifikasi | Melakukan audit berkala atas klaim privasi, keamanan, dan keterbukaan produk. |
| D23 | Kemitraan Pendidikan & Komunitas Musik | Menjalin kemitraan dengan institusi pendidikan dan komunitas musik. |

**Jumlah Kelompok D: 23 tim.**

---

## Rekapitulasi

| Kelompok | Jumlah tim |
|---|---|
| A — Lapisan Teknis | 30 |
| B — Area Fitur | 28 |
| C — Organisasi Produk | 21 |
| D — Pertumbuhan & Kepercayaan | 23 |
| **Total** | **102 tim** |

Struktur lengkap: **1 Koordinator Proyek + 4 Ketua Grup + 7 Ketua Divisi + 102 tim senior**.

Verifikasi hitungan: 30 + 28 + 21 + 23 = **102 tim** (melebihi target 100+).

---

## Aturan Kerja

1. **Koordinator membagi tugas per paket.** Setiap paket kerja didefinisikan dengan jelas
   (tujuan, ruang lingkup, kriteria selesai, dan tim yang terlibat) sebelum dikerjakan.
2. **Tim bekerja BERGILIRAN per paket, bukan serentak.** Tim yang tidak sedang bertugas
   pada suatu paket tidak ikut campur hingga gilirannya tiba; koordinator mengatur urutan
   dan dependensi antar paket.
3. **Siklus keamanan Red → Blue → Red.** Red Team menyerang, Blue Team memperbaiki,
   Red Team menyerang lagi — sampai satu ronde penuh menghasilkan nol temuan
   kritis/tinggi/sedang, maksimal 5 ronde. Purple Team memvalidasi setiap perbaikan.
4. **Jangan klaim selesai tanpa bukti tes nyata.** Setiap klaim "sudah selesai" atau
   "sudah diperbaiki" wajib disertai bukti pengujian nyata: tes browser untuk web,
   tes E2E otomatis, atau probe live untuk API/backend. Tes yang gagal tidak boleh
   dihapus atau dilonggarkan demi hasil hijau.
5. **Update berkala.** Koordinator memberi kabar progres secara berkala; tidak diam
   saat pekerjaan panjang berjalan. Setiap tim melaporkan hasil dan hambatan kepada
   koordinator, bukan langsung kepada owner.
6. **Satu persetujuan = eksekusi end-to-end.** Setelah owner menyetujui suatu paket,
   tim mengerjakannya sampai tuntas tanpa meminta persetujuan per langkah dan tanpa
   melempar opsi berulang.
7. **Jangan mengarang angka atau data.** Semua angka wajib data nyata atau hitungan
   eksak dari asumsi yang dinyatakan jelas. Bila belum ada data nyata, tampilkan
   empty state yang jujur, bukan data contoh yang tampak nyata.
8. **Bahasa Indonesia netral profesional** untuk semua dokumen, laporan, dan komunikasi
   internal proyek. Copy yang menghadap pengguna memakai bahasa sehari-hari yang
   mudah dicerna semua orang.
9. **Kredensial tidak pernah lewat chat.** Jalur kredensial yang sah adalah Secure Vault,
   form aman, atau file ke folder `secrets/` (0600). Jangan menyimpan kredensial di
   memori, repositori, atau laporan.
10. **Batasan proyek:** jangan menyentuh API Spotify (risiko cease-and-desist); distribusi
    melalui GitHub dan direktori aplikasi web/open source, bukan toko aplikasi berbayar;
    biaya nol rupiah — solusi wajib berjalan di free-tier sejati atau tanpa server.
11. **Jangan menyentuh QIKO / @adipjasebbot.** Keduanya adalah urusan owner sepenuhnya
    dan di luar ruang lingkup proyek ini.

## Standar Senior 10+ Tahun

Setiap tim bekerja dengan standar profesional senior:

- **Code review wajib** — tidak ada perubahan yang masuk ke cabang utama tanpa ditinjau
  rekan satu tim atau tim terkait.
- **Bukti tes nyata** — setiap perubahan disertai hasil pengujian (unit, integrasi,
  E2E, atau tes browser) yang dapat diverifikasi ulang.
- **Dokumentasi** — setiap fitur, keputusan arsitektur, dan perubahan perilaku dicatat
  dalam dokumentasi proyek (termasuk alasan "mengapa", bukan hanya "apa").
- **Foresight risiko** — setiap tim mengantisipasi konsekuensi ke depan sejak awal
  (penyalahgunaan, spam, kuota, beban, keamanan), bukan hanya memperbaiki gejala.
- **Kualitas di atas kecepatan** — hasil yang rapi, teruji, dan terdokumentasi lebih
  diutamakan daripada hasil cepat yang setengah jadi.
