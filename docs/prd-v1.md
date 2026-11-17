# PRD v1: Laras Web App Full-Stack

**Tanggal tulis:** 17 November 2026.
**Status:** Fase 1 selesai untuk dokumen ini. Belum ada kode, belum ada repo web, belum ada URL produksi. Pilihan stack backend (Cloudflare vs Vercel dan Supabase vs Firebase) diputuskan di arsitektur.md oleh tim terpisah; PRD ini tidak mengunci stack.
**Dokumen acuan:** `~/workspace/music-app/docs/prd-v1.md` (PRD APK, 15 November 2026, basis utama dokumen ini), `docs/riset-kompetitor-web.md` (tanggal cek 17 November 2026), `docs/transfer-ekstraktor.md` (17 November 2026), `docs/keputusan-solver.md` (17 November 2026), `docs/roster-tim.md` (17 November 2026). Semua angka di PRD ini disalin dari dokumen-dokumen itu.
**Hubungan dengan APK:** Laras Web adalah workstream baru yang jalan paralel dengan APK Flutter Laras, bukan penggantinya. APK tetap jalan. Web memakai nama yang sama, Laras, dan memakai ulang pengetahuan ekstraktor APK yang terbukti (urutan fallback client, solver, config remote, kanari). Bila ada selisih antara PRD ini dan PRD APK soal perilaku web, PRD ini yang menang untuk web. Bila ada selisih antara PRD ini dan arsitektur.md, koordinator yang menyelesaikan.

## Otoritas keputusan

Owner mendelegasikan penuh pada 15 November 2026 20:55 WIB: semua keputusan diputuskan sendiri dengan standar hasil terbaik, semaksimal mungkin, anti pengorbanan. Pada 17 November 2026 20:30 WIB owner meminta Laras versi web app full-stack, serius dan niat penuh. Karena itu seluruh keputusan di PRD ini berstatus DIPUTUSKAN oleh koordinator atas otoritas delegasi tersebut, bukan "menunggu owner". Owner tetap bisa membatalkan keputusan apa pun. Satu-satunya butir yang benar-benar butuh tindakan owner adalah kanal kontak kebijakan privasi (D9), karena tim tidak bisa mengarang alamat kontak publik, dan URL produksi (D10), karena tim tidak bisa mengarang domain.

## Cara baca

- **USULAN** berarti angka atau pilihan itu adalah usulan tim dengan alasan tertulis, dan boleh diubah koordinator atau owner dengan alasan baru. Tanpa label USULAN, angka itu dikutip dari arsitektur, riset kompetitor, dokumen transfer, atau sudah diputuskan koordinator.
- **Target** berarti angka yang dituju, bukan janji dan bukan hasil ukur. Target diuji di Fase 2 dan tidak boleh diturunkan diam-diam bila pengukuran pertama lebih rendah.
- **Belum terverifikasi** berarti fakta itu belum dibuktikan dari sumber primer atau dari pengukuran, dan tidak boleh dipakai sebagai dasar keputusan tanpa verifikasi.
- Copy yang menghadap pengguna ditulis dalam tanda kutip dan memakai bahasa Indonesia sehari-hari, tanpa istilah teknis. Istilah teknis (itag, InnerTube, solver, Service Worker, IndexedDB) hanya muncul di penjelasan untuk tim.
- Kata "cache" tidak pernah tampil di copy pengguna. Kata "perpustakaan" tidak pernah tampil di copy pengguna; pakai "Library". Label kanonis untuk tombol refresh config remote adalah "Periksa pembaruan" di semua tempat.

## 1. Visi

Satu pemutar musik di browser yang gratis, tanpa iklan, dan bisa dipakai offline, untuk orang Indonesia yang sering kehabisan kuota atau sinyal. Pengguna membuka tautan dan lagu langsung bisa diputar, tanpa instalasi, tanpa akun, tanpa server yang harus dijalankan. Laras Web adalah client: tidak menyimpan lagu sendiri, mengambil audio dari YouTube dan YouTube Music lewat akses tidak resmi (InnerTube), menyimpan lagu di browser lewat unduhan dan penyimpanan otomatis lagu yang pernah diputar, dan tidak punya iklan atau telemetri.

Tidak satu pun dari keluarga InnerTune punya versi web (riset 17 November 2026). Pesaing web yang nyata adalah proyek baru berumur hitungan minggu (Musike, Cantio, Decibel, Vibentra), dan tidak satu pun dari mereka menggabungkan offline audio sejati, lirik tersinkron tanpa batas, dan equalizer di satu pemutar web yang bisa dibuka langsung. Lima pembeda Laras Web (riset bagian 18): offline audio sejati di browser, lirik tersinkron tanpa batas gratis langsung di browser, equalizer dan pengeras suara yang benar-benar bekerja, buka tautan langsung main tanpa server untuk dijalankan pengguna, dan satu antrean untuk streaming dan file lokal pengguna (file lokal masuk Could, bukan v1).

Tiga dari lima app Android sejenis mati atau membeku (InnerTune tanpa rilis lebih dari 2 tahun, ViMusic diarsipkan 15 Maret 2026, OuterTune berhenti untuk YouTube Music). Laras Web dibangun supaya tidak bernasib sama: arsitektur tahan rusak saat YouTube berubah, backup yang kompatibel selamanya, solver yang jalan di browser pengguna (bukan di server yang bisa kehabisan kuota), dan kode yang bisa dipelihara satu orang.

### Kondisi "v1 selesai" (semua wajib terpenuhi)

1. Empat spike web (S1 sampai S4 di keputusan-solver.md bagian 8) lolos, atau jalur cadangan sudah dipilih dengan bukti bila spike gagal.
2. Semua fitur Must (bagian 4) berfungsi di situs live dan lolos kriteria K1-K15 (bagian 7).
3. Siklus keamanan Red-Blue-Red mencapai nol temuan kritis, tinggi, dan sedang (maks 5 ronde).
4. Pemeriksaan kode (lint dan typecheck) tanpa warning, dan tes jalur resolve, fallback, unduhan, dan migrasi lolos.
5. Dokumen rilis lengkap: README, PRIVACY_POLICY.md, CHANGELOG, dan catatan rilis GitHub.
6. Owner menyetujui preview situs live setelah mencoba sendiri. Gate ini tidak bisa digantikan tes otomatis.

## 2. Persona

Lima arketipe, tanpa nama atau umur karangan. Tiap persona dilabeli mana yang bukti dan mana yang asumsi. P1 sampai P4 adalah adaptasi persona APK ke pengguna web; P5 adalah persona baru untuk web.

**P1. Pendengar yang sering tanpa internet.** Bukti: motivasi owner sendiri (offline saat tidak ada internet). Kebutuhan inti: unduhan yang bisa diandalkan, pemutaran offline yang tidak pernah mengecewakan, pesan jelas saat lagu belum tersimpan. Di web, persona ini membuka Laras dari browser HP dan memasang PWA supaya terasa seperti app. Asumsi: memakai HP Android kelas menengah dan mendengar musik tiap hari.

**P2. Pengguna perangkat ruang dan memori sempit.** Bukti: ukuran APK kompetitor (ViMusic sekitar 2,6 MB, InnerTune 6,5 MiB) dan crash OOM Spotube issue 3193; di web, browser bisa menghapus penyimpanan situs saat ruang perangkat menipis (perilaku persis per browser belum terverifikasi). Kebutuhan inti: bundle awal kecil, batas penyimpanan lagu yang bisa diatur, hitungan ruang yang jujur, tidak ada memori tab yang membengkak diam-diam. Asumsi: HP RAM 3 GB mewakili perangkat awal (A3).

**P3. Pendengar yang sudah pindah app berkali-kali.** Bukti: InnerTune beku lebih dari 2 tahun, ViMusic diarsipkan, backup OuterTune 0.11.x tidak kompatibel dengan 0.10.x. Kebutuhan inti: backup yang bisa dipulihkan selamanya, antrean yang tidak hilang saat tab ditutup, pesan jujur saat app rusak karena YouTube berubah. Asumsi: pengguna ini pernah kehilangan playlist karena app ditinggalkan pengembangnya.

**P4. Pengguna baru yang membuka tautan.** Bukti: tidak satu pun kompetitor keluarga InnerTune ada di web; distribusi web adalah tautan langsung dan direktori aplikasi web atau open source, bukan toko aplikasi berbayar. Kebutuhan inti: buka tautan langsung bisa memutar lagu, penjelasan jujur soal status tidak resmi, dan app yang langsung berguna tanpa login. Asumsi: pengguna ini belum pernah memasang PWA dan tidak tahu apa itu PWA; instalasi harus terasa seperti satu ketukan, bukan pelajaran.

**P5. Pendengar di laptop atau komputer desktop.** Bukti: YouTube Music web adalah jawaban resmi Google di komputer (tidak ada aplikasi desktop resmi sampai 2026); pemutar web kompetitor (Musike, Cantio, Feishin) dipakai di desktop. Kebutuhan inti: pemutar yang rapi di layar lebar, kontrol keyboard, pemutaran yang tetap jalan saat tab berpindah, dan sinkronisasi opsional supaya playlist di laptop sama dengan di HP. Asumsi: pengguna ini mendengar musik sambil bekerja dan memakai Chrome atau Edge (perilaku di browser lain belum terverifikasi).

## 3. User journey

Tujuh alur utama, tiap alur merujuk ke spesifikasi fitur. J1 sampai J5 adalah port journey APK ke web; J6 dan J7 adalah alur baru web.

**J1. Cari dan putar pertama.** Pengguna baru membuka tautan Laras, melihat beranda terisi tanpa login, mengetik judul lagu di pencarian, melihat saran saat mengetik, mengirim kueri, mengetuk lagu, dan lagu berbunyi dalam target 2 detik di koneksi baik. Alur ini memakai B1.1, B1.2, B2.1, dan B2.8.

**J2. Unduh lalu putar offline.** Pengguna mengunduh lagu dari dialog unduh (pilih kualitas, lihat perkiraan ukuran), melihat progress di layar Unduhan, mematikan internet, dan lagu tetap berbunyi dari penyimpanan browser. Lagu yang pernah diputar tanpa diunduh pun ikut tersimpan otomatis dan bisa diputar offline. Alur ini memakai B3.1, B3.2, B3.3, dan B3.6.

**J3. Buat playlist.** Pengguna membuat playlist dari Library, menambah lagu dari hasil cari dan dari lagu yang sedang diputar, mengubah urutan dengan seret, dan playlist tersimpan di database browser. Alur ini memakai B4.1 dan B4.2.

**J4. Lanjutkan setelah tab atau browser ditutup.** Pengguna menutup tab di tengah lagu, membukanya lagi besok, melihat lagu terakhir di mini-player, menekan putar, dan lagu lanjut dari posisi tersimpan dengan antrean yang utuh. Alur ini memakai B2.3 dan B2.7.

**J5. Hadapi lagu gagal karena YouTube berubah.** Pengguna membuka Laras saat YouTube baru berubah, melihat banner jujur di beranda (bukan layar kosong misterius), menekan "Periksa pembaruan", dan bila belum ada perbaikan, tetap bisa memutar lagu yang sudah tersimpan. Alur ini memakai B1.7, B2.6, B6.5, dan B11.5.

**J6. Pasang PWA.** Pengguna yang sering kembali melihat tawaran pasang yang sopan (satu kali, bisa ditolak, tidak muncul lagi setelah ditolak dua kali, USULAN), mengetuk pasang, dan Laras muncul sebagai ikon di layar beranda HP atau desktop. Setelah terpasang, Laras terbuka tanpa bilah alamat browser dan tetap bisa memutar lagu yang tersimpan saat offline. Alur ini memakai B3.7 dan B8.9.

**J7. Sinkronisasi opsional antar perangkat.** Pengguna yang sudah punya playlist di HP memilih masuk akun opsional dari Pengaturan, playlist dan pengaturannya tersinkron, lalu ia membuka Laras di laptop dan menemukan playlist yang sama. Pengguna yang tidak mau akun tetap bisa memakai semua fungsi inti tanpa masuk. Alur ini memakai B7.1 sampai B7.4 dan hanya jalan bila fitur Should sinkronisasi masuk v1; bila tidak masuk, alur ini pindah ke pasca-v1 dan backup file tetap menjadi jalan pindah perangkat.

## 4. Cakupan v1 (MoSCoW)

Daftar ini mem-port MoSCoW PRD APK ke web, dengan penyesuaian yang dicatat. Butir yang berubah dari penempatan APK diberi catatan.

### Must (13, wajib ada di v1)

1. **Pencarian YouTube Music** dengan saran saat mengetik, riwayat lokal, dan pencarian library lokal.
2. **Pemutaran streaming** lewat InnerTube kustom dengan fallback antar client dan resolve ulang dari videoId.
3. **Pemutar web dan antrean persisten** (maks 200 item metadata, tahan tutup tab dan tutup browser, tersimpan di database browser) dengan MediaSession (kontrol lock screen, headset, dan tombol media).
4. **Unduhan lagu, album, dan playlist** dengan antrean unduhan tahan tutup tab, resume Range, dan retry otomatis.
5. **Offline penuh via Service Worker** dan penyimpanan lagu otomatis: lagu yang pernah diputar tersimpan otomatis dan bisa diputar offline, sesuai tabel offline-first (B3.6).
6. **Playlist lokal, library, favorit, dan riwayat putar** dengan sortir, filter, dan pencarian lokal.
7. **Beranda** dengan seksi lokal dan seksi Jelajah dari browse YouTube Music, tanpa login.
8. **Pengaturan** (kualitas unduhan, ruang lagu yang pernah diputar, unduh WiFi saja, audio, tampilan, bahasa).
9. **PWA bisa dipasang** (manifest, Service Worker, ikon, kriteria installability browser terpenuhi).
10. **Impor backup** JSON berversi dengan impor merge.
11. **Info dan bantuan**: layar Tentang, kebijakan privasi, FAQ, dan laporkan kerusakan.
12. **Ketahanan**: tabel config remote, deteksi kanari, klasifikasi error, dan pesan jujur beserta tombol "Periksa pembaruan".
13. **Tautan dalam**: tautan lagu atau playlist Laras (URL yang bisa dibagikan) membuka lagu atau playlist yang dituju; tautan youtu.be dan music.youtube.com yang ditempel membuka lagu atau playlist yang dituju.

Catatan port: Must 9 APK (notifikasi media, lock screen, headset, Bluetooth) menjadi bagian Must 3 web lewat MediaSession, karena web tidak punya foreground service dan notifikasi media native; slot Must 9 web diisi PWA. Must 10 APK dipecah: impor backup tetap Must, impor playlist Spotify pindah ke Should (lihat catatan Should). Fondasi graph Web Audio (jalur audio lewat Web Audio API) masuk Must sebagai bagian pemutar web (B2.1), supaya kontrol EQ (Should) bisa ditambah tanpa rombak; kontrol EQ yang menghadap pengguna tetap Should.

### Should (6, masuk v1 bila memungkinkan, yang pertama dipotong bila terdesak)

1. **Lirik** tersinkron dan biasa dengan penyimpanan lokal (LRCLIB; CORS terverifikasi mengirim `Access-Control-Allow-Origin: *`, riset bagian 16.3; batas laju LRCLIB dari sumber sekunder, belum terverifikasi dari dokumentasi resmi).
2. **Sleep timer** dengan pilihan durasi dan opsi sampai lagu selesai.
3. **Equalizer Web Audio** 10 band dengan preset dan profil (fondasi graph sudah ada di Must B2.1).
4. **Backup JSON berversi** dengan impor merge (prioritas tertinggi di antara Should, karena backup adalah satu-satunya jalan memindahkan data tanpa akun).
5. **Impor playlist Spotify tanpa API** (jalur file sebagai utama, jalur tautan publik sebagai sekunder yang wajib dibuktikan). Di APK butir ini Must; di web pindah ke Should karena impor backup (Must 10) sudah menutup jalan pindah perangkat, dan jalur tautan publik butuh bukti di browser.
6. **Akun opsional dan sinkronisasi antar perangkat** (tambahan web dari pola Cantio: tamu penuh, akun hanya untuk sinkronisasi). Login tidak pernah wajib untuk memutar lagu. Penyedia auth dan database diputuskan di arsitektur.md.

Catatan: tema sebagai Should keenam di APK sudah diselesaikan di sana (v1 hanya mode gelap, keputusan k). Keputusan yang sama berlaku di web: v1 hanya mode gelap, dan itu adalah desain yang diputuskan, bukan fitur Should. Mode terang pindah ke pasca-v1.

### Could (6, bukan v1, dicatat sebagai pekerjaan berikut)

1. **Statistik dengar lokal** (ringkasan lagu teratas dari riwayat putar, tanpa server).
2. **Putar otomatis lagu terkait saat antrean habis** (radio berbasis lagu; perilaku v1 adalah berhenti di akhir antrean).
3. **Pemutar file audio lokal via File API** (satu antrean untuk streaming dan file milik pengguna; file dibaca lokal, tidak diunggah; pembeda 5 riset).
4. **Skip silence** (default mati).
5. **Impor playlist dari URL YouTube Music.**
6. **Visualizer audio** dari Web Audio analyser (patokan Feishin; hanya mungkin di jalur InnerTube, bukan IFrame).

### Tidak masuk v1 (Won't)

1. **API Spotify dalam bentuk apa pun** (permanen, bukan penundaan; preseden cease-and-desist ke Spotube 2025; pengetatan Dev Mode Spotify 2026 memperkuatnya).
2. Login wajib dalam bentuk apa pun; login YouTube Music (pasca-v1 v1.2 bila diputuskan).
3. Iklan, pembayaran, dan telemetri dalam bentuk apa pun (permanen untuk v1; tanpa pengecualian).
4. Minting poToken atau BotGuard.
5. Client SABR (format SABR ditolak; app tidak memilih format SABR).
6. Unduhan video (app audio saja).
7. Normalisasi volume antar lagu yang dilabeli normalisasi (pengeras suara adalah boost, bukan normalisasi, dan tidak boleh dilabeli normalisasi; ReplayGain pasca-v1).
8. Server yang harus dijalankan pengguna (pola Musike dan Decibel ditolak; janji web adalah buka tautan langsung main).
9. Solver di server (keputusan-solver.md: solver jalan di browser; Worker hanya proxy byte bila CORS memblokir).
10. Enkripsi database (sampai pemicu terpenuhi: login masuk, owner menilai profil selera sensitif, atau regulasi mewajibkan).
11. Certificate pinning ke YouTube atau Google (Google merotasi kunci tanpa pemberitahuan).
12. Terjemahan lirik, lirik kata per kata, dan edit lirik oleh pengguna.
13. Lirik di notifikasi atau MediaSession (pasca-v1, menunggu bukti ukur).

## 5. Spesifikasi fitur

Bagian ini merangkum perilaku yang mengikat per area. Detail lengkap (user stories, edge cases, semua kriteria penerimaan dengan cara mengujinya) ada di laporan tim masing-masing. Bila laporan tim dan PRD ini selisih, PRD ini yang menang. Nomor B1 sampai B11 di sini adalah area fitur web, bukan nomor tim di roster-tim.md.

### 5.1 B1. Pencarian dan Discovery

- **Pencarian jaringan hanya jalan saat pengguna mengirim kueri secara eksplisit** (tombol cari di keyboard, ketuk saran, atau ketuk riwayat). Pencarian jaringan tidak jalan tiap ketikan, karena tiap ketikan yang memicu request memboroskan kuota dan memicu rate limit. Umpan balik saat mengetik berasal dari saran pencarian dan hasil lokal.
- **Saran pencarian** dari endpoint `music/get_search_suggestions` setelah debounce 300 ms, paling banyak 8 saran (USULAN). Kegagalan saran hilang diam-diam dan tidak pernah menampilkan error. Saat offline, saran berasal dari riwayat lokal yang cocok dengan awalan teks.
- **Riwayat pencarian lokal**: maks 100 query, dedup (beda kapitalisasi dianggap sama), hapus per baris dengan Urungkan 5 detik (USULAN), hapus semua dengan konfirmasi. Query yang gagal total karena jaringan tidak masuk riwayat. Riwayat MASUK file backup.
- **Pencarian library lokal**: jalan di tab yang sama, kelompok hasil berlabel "Dari Library-mu", tampil sebelum hasil jaringan, jalan penuh saat offline, maks 50 item per halaman dengan keyset pagination. Di web pencarian lokal memakai indeks database browser, bukan FTS5 (FTS5 adalah SQLite, tidak ada di browser). Lagu yang tersimpan menampilkan penanda sudah tersimpan.
- **Hasil pencarian**: dikelompokkan (lagu, album, artis, playlist), tiap kelompok menampilkan paling banyak 10 item di layar hasil dengan tombol "Lihat semua" ke daftar penuh 50 per halaman. Mengetuk lagu memutar lagu itu dan memasukkan sisa hasil lagu ke antrean. Parser yang gagal di satu kelompok tidak mengosongkan kelompok lain.
- **Pagination**: keyset 50 per halaman untuk lokal, continuation token InnerTube untuk jaringan, prefetch saat 10 item sebelum akhir. Gagal memuat halaman berikut menampilkan baris "Coba lagi" tanpa menghapus hasil lama.
- **State**: kosong ("Tidak ada hasil untuk 'xxx'. Coba kata kunci lain atau periksa ejaannya."), error jaringan dengan tombol "Coba lagi", offline dengan indikator "Kamu sedang offline", loading skeleton 6 baris (maks 15 detik, lalu error). Tidak ada kode error atau istilah teknis di pesan mana pun.
- **Saat YouTube berubah**: kegagalan diklasifikasikan ke 6 penyebab (HTTP 403, respons kosong, parse gagal, hanya format SABR, timeout solver, hash player tak dikenal). Satu client gagal lalu client berikut berhasil tidak terlihat pengguna. Semua client gagal menampilkan pesan jujur sesuai penyebab. Ambang rusak tercapai (3 resolve kanari gagal berturut-turut dengan penyebab sama, atau lebih dari separuh resolve dalam 1 jam gagal) menampilkan banner di layar utama dengan tombol "Periksa pembaruan" yang memicu refresh config remote di luar TTL 6 jam.
- **Discovery tanpa login**: beranda menampilkan rak lokal (Baru diputar, Sering diputar) dan rak jaringan (Tangga lagu, Rilisan baru, Jelajahi mood dan genre) di dalam seksi Jelajah. Rak jaringan hilang saat offline tanpa pesan error. Riwayat dengar tidak pernah keluar dari browser; yang dikirim ke jaringan hanyalah permintaan halaman biasa.
- **Jalur jaringan pencarian**: request InnerTube dari browser kemungkinan besar diblokir CORS (pengukuran curl 17 November 2026: preflight OPTIONS ke youtubei dibalas 403 tanpa header CORS; vonis final menunggu spike S2). Bila diblokir, request lewat proxy byte-only (diputuskan di arsitektur.md); proxy hanya meneruskan byte, tidak mengeksekusi apa pun.

### 5.2 B2. Player dan Antrean

- **Urutan sumber audio**: file unduhan dulu, lalu file lagu yang pernah diputar yang tersimpan otomatis, lalu resolve URL stream dari videoId. URL stream hanya ada di memori, tidak pernah disimpan di database, file, atau log. Prefetch 1 lagu ke depan (USULAN); perilaku pastinya wajib verifikasi Fase 2.
- **Pemutar web**: satu elemen `<audio>` yang memegang pemutaran, terhubung ke graph Web Audio (fondasi Must; simpul EQ ditambah saat Should EQ masuk). URL googlevideo diputar lewat elemen media dan tidak butuh CORS (elemen media dikecualikan dari CORS). Metadata dan kontrol lock screen, headset, dan tombol media lewat MediaSession API (`navigator.mediaSession`): judul, artis, album, sampul, dan handler putar, jeda, lagu berikut, lagu sebelum, dan cari posisi.
- **Re-resolve di tengah lagu**: dari IP datacenter, googlevideo membatasi tepat 1 MiB per URL lalu 403 (terbukti di VM; 1 MiB sama dengan sekitar 55 detik audio itag 251 dari lagu 268 detik). Apakah batas ini juga berlaku di IP residensial belum terbukti. Web wajib merancang re-resolve di tengah pemutaran sejak awal, bukan sebagai tambalan: saat stream putus di tengah lagu, player resolve ulang dari videoId dan lanjut dari posisi terakhir tanpa memulai lagu dari awal.
- **Kontrol dasar**: play, pause, seek (angka waktu mengikuti drag, seek dikirim sekali saat drag dilepas), next, prev. Prev: posisi lebih dari 3 detik kembali ke awal lagu yang sama, posisi 3 detik atau kurang pindah ke lagu sebelumnya (USULAN ambang 3 detik). Mengetuk lagu yang sedang diputar tidak me-restart lagu itu. Semua akses audio lewat satu lapisan port pemutar milik app, tidak pernah memanggil elemen audio langsung dari komponen UI.
- **Shuffle, repeat, kecepatan, pitch, skip silence, gapless**: shuffle memakai urutan acak milik app (mematikan shuffle mengembalikan urutan asli); repeat 3 keadaan (mati, semua, satu) yang tersinkron ke MediaSession; kecepatan 7 pilihan (0,5x, 0,75x, 1x, 1,25x, 1,5x, 1,75x, 2x); pitch slider 0,5 sampai 2,0 default 1,0 (USULAN, perilaku di browser wajib verifikasi Fase 2); skip silence toggle default mati (Could); gapless perilaku bawaan engine tanpa toggle; tidak ada toggle normalisasi volume.
- **Antrean**: maks 200 item metadata di memori; tersimpan di database browser sebagai sumber kebenaran (player adalah cerminnya); "Tambah ke antrean" menaruh di akhir, "Putar berikutnya" menyisip sesudah lagu yang sedang diputar, mengetuk lagu dari daftar mengganti seluruh antrean; hapus dengan menu atau tombol hapus; pindah dengan drag and drop (saat shuffle aktif, drag mengubah urutan tampil dan mematikan shuffle mengembalikan urutan asli, USULAN); "Hapus semua" mengosongkan kecuali lagu yang sedang diputar; layar antrean menampilkan total durasi sisa. Antrean tahan tutup tab, tutup browser, dan restart perangkat.
- **Latar, headset, panggilan**: audio tetap berbunyi saat tab berpindah atau browser diminimalkan di desktop; di HP, pemutaran latar mengikuti perilaku browser dan PWA (perilaku persis di iOS Safari belum terverifikasi). Headset dicabut atau Bluetooth terputus menjeda seketika. Panggilan masuk menjeda dan TIDAK lanjut otomatis sesudahnya. App lain yang mengambil fokus audio membuat app ini jeda dan tidak merebut fokus.
- **Sleep timer**: pilihan 5, 10, 15, 30, 45, 60 menit dan "Sampai lagu ini selesai" (USULAN); sisa waktu tampil di player dan diperbarui tiap menit; saat habis, volume turun perlahan 10 detik terakhir (fade out, USULAN), lalu pemutaran dijeda; antrean dan posisi tersimpan di database browser sehingga besok tinggal tekan putar; tidak ada bunyi, pesan, atau getar saat timer habis. Opsi "sampai lagu selesai" mengunci ke lagu yang sedang diputar saat timer dipasang; menekan next atau prev membatalkan timer dengan pesan "Timer dibatalkan karena kamu ganti lagu." Timer berjalan selama tab terbuka; bila tab ditutup, timer berhenti dan app menyatakan itu jujur di layar timer ("Timer berhenti kalau tab ini ditutup.").
- **Stream gagal di tengah lagu**: pemulihan diam-diam berurutan (tunggu 2 detik lalu resume, USULAN; resolve ulang dari videoId; pindah ke lagu berikut). Lagu yang jelas-jelas tidak tersedia (dihapus, dibatasi wilayah) langsung dilewati dengan snackbar sekali. Setelah 3 lagu berturut-turut gagal, app berhenti dan menampilkan "Lagu tidak bisa diputar sekarang. Periksa koneksi internet kamu, lalu coba lagi." dengan tombol "Coba lagi" dan "Buka lagu yang sudah tersimpan". Perintah next dari pengguna selalu menang atas pemulihan otomatis. Repeat one yang gagal berhenti dengan pesan, bukan pindah lagu.
- **Resume posisi**: posisi disimpan tiap 5 detik (USULAN) dan saat jeda, tab disembunyikan, timer habis, dan tab ditutup. Saat tab dibuka lagi, mini-player menampilkan lagu terakhir dan play melanjutkan dari posisi tersimpan (lagu tidak mulai sendiri). Posisi di bawah 10 detik mulai dari awal; posisi kurang dari 10 detik dari akhir pindah ke lagu berikut (USULAN ambang 10 detik, dengan aturan proporsional sepertiga durasi untuk lagu di bawah 30 detik). Play event dicatat bila lagu diputar lebih dari 10 detik (USULAN) atau sampai selesai.
- **URL kedaluwarsa**: resolve ulang dari videoId setiap kali giliran lagu tiba atau setelah jeda panjang (misal jeda 6 jam lalu play). Antrean kemarin tetap bisa diputar hari ini. Single-flight mencegah dua resolve untuk videoId yang sama.
- **Timeout keseluruhan resolve**: APK tidak punya timeout keseluruhan dan rantai worst-case bisa bermenit-menit sebelum client bebas-script dicoba (pelajaran P0-2). Web wajib punya timeout keseluruhan resolve; angkanya USULAN dan diputuskan Fase 2 setelah pengukuran pertama, dengan batas atas yang dinyatakan di dokumen implementasi.

### 5.3 B3. Download Offline dan Penyimpanan Web

- **Unduh lagu, album, playlist**: tombol unduh di player, menu konteks lagu, halaman album dan playlist, dan daftar library. Unduh album atau playlist menampilkan dialog ringkas ("Unduh 12 lagu (sekitar 50 MB)?") dari durasi nyata tiap lagu; lagu yang sudah diunduh dilewati. Unduhan berjalan serial 1 file dalam satu waktu (USULAN). File ditulis sementara lalu dipindah ke penyimpanan final setelah ukuran cocok; tag metadata ditulis setelah selesai bila library tag sudah dipilih (keputusan Fase 2). Pembatalan menghapus job dan file sementara. Dedup job memakai videoId.
- **Kualitas unduhan** (label kanonis): "Terbaik" (itag 251, Opus sampai sekitar 160 kbps, sekitar 4,2 MB per lagu 3,5 menit), "Seimbang" (itag 140, AAC 128 kbps, sekitar 3,4 MB), "Hemat data" (itag 249 atau 139, Opus sekitar 50 kbps atau AAC 48 kbps, sekitar 1,3 MB). Hitungan memakai rumus bitrate x durasi / 8 dengan asumsi durasi 210 detik. Default "Terbaik" (USULAN). Pilihan ada di Pengaturan (default) dan dialog unduh (khusus unduhan itu). Itag yang dipilih tidak tersedia turun ke itag berikut tanpa bertanya. Kata "itag", "bitrate", "codec", "Opus", "AAC", dan angka kbps tidak pernah tampil di antarmuka.
- **Antrean unduhan**: tersimpan di database browser (videoId, kualitas, status, byte terunduh, total byte, jumlah percobaan, waktu dibuat). Resume via header `Range` dari ukuran file sementara; server yang tidak mendukung Range memicu unduh ulang dari awal. Retry otomatis maks 3 kali dengan backoff 1 detik lalu 2 detik ditambah jitter; setelah itu job berstatus gagal sampai pengguna menekan "Coba lagi". Koneksi kembali memulai job tertunda otomatis dalam 10 detik. Layar unduhan menampilkan 4 kelompok (Mengunduh, Menunggu, Selesai, Gagal); kelompok kosong tidak tampil. Job selesai dihapus dari riwayat setelah 7 hari (USULAN); lagu tetap di library. Unduhan berjalan selama tab terbuka; bila tab ditutup, unduhan berhenti dan dilanjutkan otomatis saat tab dibuka lagi (browser tidak menjamin unduhan latar; fakta ini dinyatakan jujur di layar Unduhan).
- **Manajemen storage**: layar Penyimpanan menampilkan total unduhan, total lagu yang pernah diputar dengan batasnya, dan perkiraan ruang yang tersedia, semuanya dihitung dari database (bukan pemindaian filesystem). Hapus unduhan dari daftar (menu), dari player (dialog konfirmasi), atau hapus semua (dialog menyebut jumlah dan ukuran). Menghapus unduhan menghapus file dan mengosongkan status unduhan, lagu tetap di library. Sebelum unduh, app memeriksa perkiraan ruang: kurang dari perkiraan ditambah 100 MB (USULAN buffer 100 MB) berarti unduhan ditolak dengan pesan jelas. Ruang turun di bawah 100 MB saat unduhan berjalan menjeda unduhan otomatis dengan pesan. Daftar unduhan default terurut dari file terbesar (USULAN).
- **Penyimpanan lagu yang pernah diputar (otomatis)**: default 500 MB, pilihan 250 MB, 500 MB, 1 GB, 2 GB (1 GB sama dengan 1.024 MB; hitungan kanonis sekitar 59, 119, 243, 487 lagu). Lagu yang diputar lewat streaming tersimpan otomatis ke penyimpanan browser (pola ViMusic: lagu yang pernah diputar bisa diputar offline tanpa langkah unduh eksplisit). Eviction LRU tidak pernah menyentuh file unduhan dan tidak pernah menghapus file yang sedang diputar. Lagu yang tersimpan sebagian dilanjutkan saat lagu diputar lagi (resume Range). Tombol hapus mengosongkan lagu yang pernah diputar tanpa menyentuh unduhan. Lagu dari penyimpanan otomatis bisa diputar offline tapi tidak menampilkan penanda "Sudah diunduh" dan tidak muncul di daftar unduhan. Media penyimpanan (IndexedDB, Cache Storage, atau OPFS) diputuskan di arsitektur.md; PRD ini hanya mengikat perilakunya.
- **Perilaku offline penuh**: mengikuti tabel offline-first APK tanpa tambah atau kurang, diterjemahkan ke web. Yang jalan offline: putar unduhan, putar lagu yang tersimpan otomatis, browsing library, pencarian lokal, playlist, favorit, riwayat, antrean, pengaturan, dan shell aplikasi lewat Service Worker. Yang tidak jalan: pencarian YouTube Music baru, streaming belum tersimpan, metadata atau sampul baru, unduhan baru (masuk antrean, jalan otomatis saat online), rak jaringan, saran jaringan (diganti saran lokal), refresh config (pakai config terakhir yang valid). Indikator "Kamu sedang offline" tampil di layar utama dan pencarian. Tombol yang butuh jaringan tetap bisa diketuk dan menjelaskan keadaannya ("Lagu ini butuh internet. Unduh dulu supaya bisa didengar offline." dengan tombol "Unduh"), bukan tombol mati tanpa penjelasan.
- **Rekonsiliasi saat start**: jalan di latar saat tab dibuka, tanpa memblokir layar utama. File unduhan hilang atau ukurannya tidak cocok menurunkan status unduhan tanpa menghapus lagu dari library (file rusak dihapus). File yatim dan file sementara tanpa job dihapus. Job berstatus "mengunduh" kembali ke "antre". Tanpa pemeriksaan hash file di v1 (USULAN; ukuran cocok cukup untuk file yang ditulis app sendiri). Snackbar muncul bila ada file unduhan yang hilang (angka persis disebut bila 5 atau kurang, USULAN ambang 5). Rekonsiliasi bersifat idempotent dan memakai batch supaya tidak membuat UI tersendat di library 10.000 lagu.
- **PWA (B3.7)**: manifest valid (nama, ikon, warna tema hitam, mode tampilan standalone), Service Worker terdaftar dan melayani shell aplikasi offline, kriteria installability browser terpenuhi (diuji di Chrome Android dan Chrome desktop; Safari belum terverifikasi). Tawaran pasang muncul paling banyak satu kali per sesi, bisa ditolak, dan tidak muncul lagi setelah ditolak dua kali (USULAN). Setelah terpasang, pembaruan app diambil otomatis di latar; bila ada versi baru, pengguna melihat pesan "Versi baru sudah siap." dengan tombol "Muat ulang".

### 5.4 B4. Playlist dan Library

- **Playlist** (B4.1-B4.3): nama maks 100 karakter, deskripsi maks 500 karakter (USULAN); nama yang sama boleh dipakai dua playlist (identitas adalah baris database). Sampul playlist memakai kolase 2x2 sampul 4 lagu pertama di halaman detail, dan sampul lagu pertama di baris atau kartu daftar. Tambah lagu dari menu konteks lagu (pilih playlist atau buat baru), dari halaman album ("Tambah semua ke playlist"), dari player, dan dari layar antrean. Urutan lagu diubah dengan drag and drop; hapus lagu dari playlist hanya menghapus dari playlist itu (lagu tetap di library). Urungkan 5 detik (USULAN) tersedia untuk hapus playlist dan hapus lagu dari playlist. Favorit adalah playlist virtual tersendiri ("Favorit", tombol hati di player dan menu konteks), bukan tag pada playlist.
- **Library** (B4.4-B4.5): tab Library menampilkan Lagu, Album, Artis, Playlist, Favorit, dan Unduhan (jalan pintas ke layar Unduhan). Daftar 50 per halaman dengan keyset pagination. Sortir diingat per daftar (terbaru, nama, artis, paling sering diputar). Filter "Semua" atau "Library saja" pada hasil cari. Library 10.000 lagu wajib tetap lancar (uji stress, K11).
- **Riwayat putar** (B4.6): tersimpan di database browser, maks 10.000 entri (USULAN ambang 10.000; entri lama dihapus otomatis dengan batas kode). "Putaran bermakna" adalah lagu yang diputar 30 detik atau lebih (USULAN), dipakai rumus rekomendasi. Ambang ini berbeda dari ambang 10 detik pencatatan play event (B2.7); keduanya wajib dinyatakan jelas agar tidak tertukar.
- **Lagu yang tidak bisa diputar** (B4.7): diklasifikasikan dari `playabilityStatus` (dihapus, privat, dibatasi wilayah). Kegagalan jaringan TIDAK menandai lagu. Kerusakan massal YouTube TIDAK menandai lagu satu per satu (ikuti B6.5). Lagu tetap ada, tampil redup dengan label "Tidak bisa diputar", dilewati otomatis saat putar berurutan dengan pesan jumlah ("1 lagu dilewati karena tidak bisa diputar"), dan bisa dihapus massal dengan konfirmasi ("Hapus lagu yang tidak bisa diputar"). Lagu unduhan tetap bisa diputar walau sumber online hilang. Status dibersihkan saat satu resolve berhasil.
- **Backup playlist** digugurkan sebagai fitur terpisah dan digantikan satu sistem backup lengkap (B10). Aturan merge dipertahankan: playlist dengan nama sama dari backup ditambahkan lagunya yang belum ada ke playlist yang sama (bukan membuat salinan "(salinan)"), karena alur utamanya adalah pengguna memulihkan backup-nya sendiri.

### 5.5 B5. Lirik

Fitur Should.

- **Penyedia lirik: LRCLIB.** Berbeda dengan APK (LRCLIB hanya kandidat), di web LRCLIB sudah terverifikasi bisa dipanggil langsung dari browser: tanpa kunci API, tanpa akun, mengembalikan `plainLyrics` dan `syncedLyrics` format LRC, dan mengirim header `Access-Control-Allow-Origin: *` (riset bagian 16.3). Endpoint baca `/api/get` (cocok persis: artis, judul, durasi) dan `/api/search` (cari bebas). Fallback statis: `https://api.lyrics.ovh/v1/<artis>/<judul>` (tanpa kunci, CORS `*` juga). Batas laju LRCLIB (klien generik sekitar 45 request per menit per IP, teridentifikasi sekitar 90, terdaftar sekitar 180 per IP ditambah allowance app sekitar 6.000 per menit) berasal dari pengujian Oktober 2026 oleh cors.dev, sumber sekunder, belum terverifikasi dari dokumentasi resmi LRCLIB; app tidak boleh mengandalkan angka itu tanpa verifikasi. Tidak ada klaim cakupan atau SLA yang boleh ditulis di PRD ini atau di app.
- **Tampilan** (B5.1): lirik tersinkron (baris aktif mengikuti posisi lagu) bila tersedia, lirik biasa bila tidak. Baris aktif adalah baris dengan timestamp terakhir yang sama dengan atau lebih kecil dari posisi lagu. Ketuk baris mencari ke timestamp baris itu. Geser manual menghentikan geser otomatis 5 detik (USULAN). Teks lirik disimpan lokal di database browser (tidak ada batas jumlah lirik tersimpan di v1; lirik dibaca per baris dari disk, bukan dimuat semua ke memori).
- **Pengambilan** (B5.2): penyimpanan lokal dulu; hanya meminta lirik untuk lagu yang sedang diputar atau dibuka; tanpa pengenal pengguna atau perangkat di request. Penanda "tidak ditemukan" disimpan 7 hari (USULAN) supaya app tidak menanyakan lagu yang sama berulang-ulang.
- **Pesan jujur** (B5.3): "Lirik lagu ini belum ada." bila penyedia tidak punya; "Lirik belum bisa dimuat. Periksa koneksimu lalu coba lagi." bila jaringan gagal; "Lirik belum tersimpan. Sambungkan internet sekali untuk mengambilnya." bila offline dan lirik belum tersimpan. Tidak ada teks lirik contoh atau lirik karangan di state kosong.
- **Sinkronisasi** (B5.4): dari posisi pemutar (`timeupdate` elemen audio), bukan jam dinding; berlaku di semua kecepatan putar.
- **Privasi** (B5.5): sebelum request lirik pertama, app menampilkan pemberitahuan satu kali: "Lirik diambil dari layanan luar. Layanan itu bisa melihat judul lagu yang kamu putar dan alamat internetmu." dengan tombol "Mengerti" (USULAN teks). PRIVACY_POLICY.md wajib menyebut LRCLIB sebagai penyedia. Saklar hidup atau mati lirik ada di Pengaturan (default hidup); saklar dan pemberitahuan ini bersama memenuhi kewajiban privasi lirik.
- **Lirik di notifikasi** (B5.6): tidak masuk v1. Alasan: menulis ulang notifikasi tiap pergantian baris membebani sistem dan berisiko mengganggu kontrol media dan baterai. Pasca-v1, satu baris aktif di notifikasi yang diperluas adalah usulan, menunggu bukti ukur.

### 5.6 B6. Beranda dan Rekomendasi

- **Seksi** (B6.1): 5 seksi lokal ditambah 1 seksi jaringan, urutan final: "Baru diputar", "Lagu untukmu", "Sering diputar", "Playlist kamu", "Unduhan", "Jelajah". Seksi lokal selalu tersedia; "Jelajah" (browse YouTube Music) terakhir karena butuh jaringan. Tiap seksi menampilkan paling banyak 10 item (USULAN) dengan tombol "Lihat semua" ke daftar penuh 50 per halaman. Seksi lokal yang kosong tidak tampil. Beranda tidak pernah loading penuh; seksi lokal tampil dulu dari database.
- **"Lagu untukmu"** (B6.2, rumus lokal, USULAN): skor awal sama dengan jumlah putaran bermakna (30 detik atau lebih) dalam 30 hari terakhir; tambah 5 bila difavoritkan; tambah 2 bila diunduh; urutan skor tertinggi dulu, seri dipecah waktu putar terakhir; ambil 20 teratas; bila kurang dari 20, isi sisa dengan lagu library terbaru. Dihitung ulang tiap beranda dibuka dan tiap data berubah, dalam satu query agregasi (bukan memuat riwayat putar ke memori). Tanpa nama artis, genre, kesamaan audio, dan tanpa machine learning. Bila library kosong, seksi tidak tampil. Contoh hitung (terverifikasi koordinator di PRD APK): lagu B dengan 9 putaran bermakna, lagu A dengan 3 putaran dan difavoritkan (3 tambah 5 sama dengan 8), lagu C dengan 1 putaran dan diunduh (1 tambah 2 sama dengan 3); urutan B, A, C.
- **Perilaku offline** (B6.3): seksi lokal tampil penuh; "Jelajah" diganti pesan "Bagian jelajah butuh internet. Sambungkan internet untuk melihatnya." dengan indikator "Kamu sedang offline" dan tanpa tombol "Coba lagi" (tombol itu tidak melakukan apa-apa saat offline). Lagu yang belum tersimpan menampilkan "Lagu ini belum tersimpan di browser-mu. Sambungkan internet untuk memutarnya." "Jelajah" dimuat otomatis saat kembali online. Empty state pengguna baru yang offline memakai pesan "Belum ada yang bisa ditampilkan. Sambungkan internet sekali untuk mulai, atau buka Unduhan bila kamu sudah punya lagu tersimpan." ditambah tombol "Cari lagu".
- **Refresh** (B6.4): seksi lokal diperbarui otomatis saat data berubah. "Jelajah" dimuat ulang otomatis bila datanya lebih dari 6 jam (USULAN, selaras TTL config remote); tarik ke bawah hanya memuat ulang "Jelajah"; gagal refresh menampilkan data terakhir dengan pesan "Gagal memperbarui. Menampilkan data terakhir." Waktu muat terakhir disimpan di penyimpanan lokal.
- **Browse gagal** (B6.5): diklasifikasikan (jaringan, tidak bisa di-parse, HTTP error). Tidak bisa di-parse menampilkan "Bagian jelajah belum bisa dimuat. YouTube mungkin mengubah layanannya." dengan tombol "Periksa pembaruan". HTTP error menampilkan "Bagian jelajah belum bisa dimuat. Coba lagi nanti." dengan tombol "Coba lagi". Seksi lokal tidak terpengaruh kegagalan browse. Tanpa detail teknis di pesan. Log internal maks 1 MB dengan rotasi.
- **Discovery berbasis artis** ("Lagu yang mungkin kamu suka") pindah ke v1.1. **Rak jaringan** (Tangga lagu, Rilisan baru, Jelajahi mood dan genre) hidup di dalam seksi "Jelajah" sebagai sub-seksi, nama seksi mengikuti respons browse.

### 5.7 B7. Akun Opsional dan Sinkronisasi

Fitur Should. Aturan yang mengikat: **login tidak pernah wajib untuk memutar lagu.** Semua fungsi Must jalan penuh tanpa akun. Akun hanya ada untuk sinkronisasi antar perangkat, mengikuti pola Cantio (mode tamu berfungsi penuh, akun opsional hanya untuk sinkronisasi).

- **Tanpa akun adalah keadaan normal** (B7.1): app langsung bisa dipakai tanpa login, tanpa email, tanpa nomor telepon. Layar Pengaturan menampilkan baris "Akun" dengan status "Belum masuk" dan penjelasan "Masuk hanya perlu kalau kamu mau playlist-mu sama di HP dan laptop." (USULAN teks). Tidak ada layar login yang menghalangi pemutaran pertama.
- **Sinkronisasi** (B7.2): bila pengguna masuk, yang disinkronkan adalah playlist, favorit, riwayat putar, riwayat pencarian, antrean, dan pengaturan (isi yang sama dengan file backup, B10). File lagu yang diunduh TIDAK ikut disinkronkan (hanya metadata dan status unduhan); lagu harus diunduh ulang di perangkat lain. Fakta ini dinyatakan jelas di layar akun. Penyedia auth, database sinkronisasi, dan aturan keamanan baris diputuskan di arsitektur.md.
- **Konflik** (B7.3): bila data yang sama diubah di dua perangkat, aturan merge mengikuti aturan backup (B10): playlist dengan nama sama digabung lagunya yang belum ada, bukan ditimpa buta. Aturan merge persis per jenis data adalah USULAN dan diputuskan Fase 2 bersama arsitektur sinkronisasi.
- **Keluar dan hapus** (B7.4): keluar dari akun tidak menghapus data lokal. Hapus akun menghapus data cloud pengguna dan memutuskan sinkronisasi; data lokal tetap ada sampai pengguna menghapusnya sendiri lewat "Hapus semua data".
- **Hapus semua data** (B7.5): dua konfirmasi bertingkat dengan tombol "Simpan salinan dulu" di dialog pertama. Menghapus database browser, lagu tersimpan, unduhan, dan seluruh preferensi. Tidak ada jalan kembali setelah konfirmasi kedua.
- **Pindah perangkat tanpa akun** (B7.6): pengguna mengekspor backup, memindahkan file ke perangkat baru, lalu mengimpor. File lagu yang diunduh TIDAK ikut di backup; lagu harus diunduh ulang di perangkat baru. Fakta ini dinyatakan jelas di layar backup.
- **Kirim riwayat dengar kembali ke Google** (B7.7): TIDAK akan diimplementasikan, berlaku juga pasca-v1 sampai ada keputusan baru owner. Alasannya: mengirim riwayat ke Google bertentangan dengan janji privasi app.
- **Daftar host yang diizinkan** wajib mencakup host config remote (GitHub Releases) dan host proxy (bila dipakai) di samping host YouTube, Google, dan penyedia lirik. Daftar persisnya diputuskan di arsitektur.md.

### 5.8 B8. Pengaturan dan Audio

- **Kualitas streaming** (B8.1): streaming memakai kualitas terbaik otomatis (itag 251 bila tersedia, turun ke 140, 250, 249, 139 bila tidak). Satu saklar "Hemat data" di Pengaturan beralih ke urutan hemat data (249, 139, 250, 140, 251; naik bila perlu supaya lagu tetap bisa diputar). Pemakaian data per jam (sekitar): Terbaik 72 MB, Seimbang 58 MB, Hemat data 22 MB.
- **Kualitas unduhan** (B8.1): 3 opsi kanonis (Terbaik, Seimbang, Hemat data; label dan hitungan di bagian 5.3). Pilihan default di Pengaturan, pilihan per unduhan di dialog.
- **Ruang lagu yang pernah diputar** (B8.3): label layar "Ruang untuk lagu yang pernah diputar" (tanpa kata "cache" di antarmuka); tombol hapus berlabel "Kosongkan ruang lagu yang pernah diputar". Batas 250 MB, 500 MB (default), 1 GB, 2 GB. Layar menampilkan pemakaian nyata dari database.
- **Unduh WiFi saja** (B8.4): default nonaktif (USULAN). Bila aktif, unduhan berjalan hanya saat tersambung WiFi; saat berpindah ke data seluler, unduhan dijeda dan dilanjutkan saat WiFi kembali. Di web, deteksi jenis koneksi memakai API koneksi browser yang tersedia; perilaku persis di semua browser target belum terverifikasi.
- **Audio** (B8.5-B8.7): equalizer Web Audio 10 band dengan preset dan profil (Should, B8.6; fondasi graph di B2.1); skip silence default mati (Could, B8.7); kecepatan 7 pilihan dan pitch 0,5 sampai 2,0 (bagian 5.2); volume app terpisah dari tombol volume perangkat dengan label jujur "Volume di app ini"; saklar "Buat suara lebih keras" dengan keterangan "Bukan penyeimbang volume antar lagu".
- **Sleep timer** (B8.8): spesifikasi di bagian 5.2. Catatan verifikasi Fase 2: timer berhenti bila tab ditutup; perilaku ini dinyatakan jujur di layar timer, bukan disembunyikan.
- **Tema** (B8.9): v1 hanya mode gelap. Spesifikasi 3 opsi (Gelap default, Terang, Ikuti perangkat) disimpan sebagai spesifikasi pasca-v1. Token warna semantik membuat mode terang bisa ditambah nanti tanpa rombak.
- **Bahasa** (B8.10): v1 hanya Bahasa Indonesia. Semua string terpisah dari kode sejak awal (format file terjemahan diputuskan di arsitektur.md) sehingga Bahasa Inggris bisa ditambah pasca-v1 tanpa mengubah kode tampilan.
- **Penyimpanan pengaturan** (B8.11): pengaturan tersimpan di penyimpanan lokal browser untuk nilai kecil; koleksi (antrean, riwayat, job unduhan) tersimpan di database browser, bukan di penyimpanan lokal kunci-nilai. Batas anti-OOM APK tetap berlaku sebagai prinsip: nilai kecil di penyimpanan kunci-nilai, koleksi di database.

### 5.9 B9. Ketahanan, Config Remote, dan Kanari

- **Config remote** (B9.1): tabel player config remote berisi nama fungsi dan class di dalam player JS, signatureTimestamp, daftar client dan versinya, dan daftar hash player yang diizinkan. Bukan signature yang sudah di-decode. Config adalah DATA, bukan kode: app tidak pernah mengeksekusi JavaScript dari tabel config (yang dieksekusi hanyalah script player YouTube itu sendiri, di dalam Web Worker solver). Config diambil lewat HTTPS dari host yang di-pin (GitHub Releases repo sendiri); `raw.githubusercontent.com` mengirim `Access-Control-Allow-Origin: *` (diukur 17 November 2026), sehingga fetch langsung dari browser bisa jalan. Validasi skema sebelum dipakai. Bila host mati atau config rusak, app memakai config terakhir yang valid, lalu nilai bawaan. Nomor versi skema config ada di file; app lama menolak config yang tidak dikenalnya.
- **Perilaku loader config** (B9.2): TTL refresh normal 6 jam (21.600 detik); timeout fetch 5 detik (catatan: satu pengukuran fetch nyata 6,058 detik, jadi timeout 5 detik terbukti terlalu agresif di jaringan lambat; Fase 2 wajib menaikkan atau membedakan timeout config); maks ukuran respons 4 MB; single-flight; rate limit (fetch tidak diulang dalam 5 menit kecuali dipaksa); stale-while-revalidate; refresh dipicu kegagalan (hash tak dikenal, penolakan CDN) dan tombol "Periksa pembaruan" yang memaksa refresh di luar TTL lalu menjalankan ulang cek kanari. Rantai fallback sumber config: aset rilis GitHub, tree tag cadangan di raw.githubusercontent, config terakhir yang valid, nilai bawaan di kode.
- **Semantik allowlist** (B9.3, wajib dipahami): config remote yang diterima membangun daftar hash player HANYA dari JSON remote (tanpa gabung builtin); loader fallback ke builtin HANYA bila set yang diteruskan kosong. Artinya config remote yang basi menonaktifkan hash builtin baru. Ini desain yang disengaja (config remote adalah control plane termasuk pencabutan hash), bukan bug. Web wajib mempertahankan semantik ini atau memutuskan eksplisit untuk mengubahnya dengan alasan tertulis.
- **Jaring pengaman client bebas-script** (B9.4): loader menjamin daftar client yang dipakai selalu membawa minimal satu client bebas-script (ANDROID_VR bawaan ditambahkan di ujung urutan, hanya di memori, bila config tidak membawanya). Titik choke-nya adalah satu fungsi yang dipakai orkestrator, unduhan, dan kanari. Tanpa jaring ini, config lama ditambah satu kegagalan script berarti semua putar mati.
- **Mode terdegradasi** (B9.5): bila script player gagal dimuat, client yang butuh script dilewati tanpa request player (tanpa sts mereka dijamin tidak bisa diputar, dan format cipher mereka tidak bisa dipecahkan tanpa solver). Client bebas-script (saat ini hanya ANDROID_VR, terbukti lolos tanpa sts dan memberi URL langsung) tetap dicoba. Mode terdegradasi juga bisa masuk di tengah loop: bila load script gagal saat jalur cipher sesudah load awal berhasil, orkestrator tidak berhenti; client butuh-script yang tersisa dilewati dan client bebas-script tetap dicoba. Setiap salinan logika fallback (pemutaran, unduhan, kanari) wajib menerapkan pola degradasi yang sama; logika resolve yang diduplikasi adalah utang yang menagih dua kali (pelajaran P0-2).
- **Rotasi client** (B9.6): bila satu resolve menghabiskan semua client dan gagal, resolve berikutnya untuk lagu yang sama mulai dari client berikutnya dalam urutan fallback, bukan mengulang urutan yang sama dari awal. Sukses menghapus rotasi. Rotasi disimpan per videoId, dibatasi 50 entri, best-effort.
- **Deteksi kanari** (B9.7): semua lokal, tanpa telemetri ke server mana pun. Lima lagu kanari (videoId terverifikasi lewat search, 15 November 2026): hhn-nGSuenM "Semua Tentang Kita" 268 detik, qkC4waEZVt4 "Rahasia Hati" 251 detik, k2XdBPv0D3Y "Surat Cinta Untuk Starla" 308 detik, NL8WUtq_NDY "Ya Sudahlah" 254 detik, YsGwU8vTRsE "Tak Ingin Usai" 278 detik. Ambang rusak: 3 cek kanari gagal berturut-turut dengan penyebab dominan yang sama, atau lebih dari separuh resolve kanari gagal dalam 1 jam (dengan minimal 5 resolve). Jadwal cek: sekali sehari di latar saat tab dibuka dan saat kembali dari tab lain, tanpa mengganggu pemutaran. Kegagalan jaringan diabaikan dan tidak memajukan waktu cek (offline bukan kerusakan layanan). Riwayat cek: hanya 1 jam terakhir, dibatasi 50 entri. Timeout satu cek kanari: 90 detik.
- **Banner status** (B9.8): 3 tingkat. Normal: tanpa banner. Terganggu: banner tipis. Bermasalah: banner jelas dengan tombol "Periksa pembaruan". Tombol yang sama ada di Pengaturan dan kegagalan Jelajah; tombol memaksa refresh config di luar TTL 6 jam lalu menjalankan ulang cek kanari.
- **Kode diagnostik** (B9.9): format `LRS1` dari APK dipakai ulang (contoh `LRS1-UPF-16111905-WMV-0901-R20261110-D`), merangkum kegagalan terakhir dari data lokal saja, berfungsi offline, bisa disalin ke chat, ikut terkirim di badan laporan. Kode tidak berisi judul lagu, videoId, URL, IP, atau data pribadi apa pun. Celah APK yang wajib ditutup web sejak awal: snapshot APK hanya menangkap kegagalan resolve; kegagalan pemutar (misal googlevideo 403 saat putar) tidak tertangkap. Web wajib punya snapshot paralel di lapisan pemutar (snapshot resolve ditambah snapshot pemutar).
- **Solver di browser** (B9.10): solver signature (`sig` dan `n`) jalan di browser sebagai QuickJS-WASM di Web Worker khusus (keputusan-solver.md): memori 192 MiB, timeout satu eksekusi 10 detik, eksekusi serial, tanpa callback host, tanpa fetch dari dalam JS, hash player dicocokkan sebelum eksekusi (gerbang hash sebelum unduh base.js). Nama paket QuickJS-WASM adalah kandidat yang wajib diverifikasi di spike S1, bukan keputusan final. Cloudflare Worker (atau setara, diputuskan di arsitektur.md) dipakai hanya sebagai proxy CORS dan config (memindah byte, tanpa mengeksekusi base.js), dan hanya bila spike S2 membuktikan fetch langsung ke youtubei dan base.js diblokir CORS.

### 5.10 B10. Impor dan Backup

- **Backup JSON berversi** (B10.1, satu sistem backup lengkap): berisi playlist, favorit, riwayat putar, riwayat pencarian, antrean, dan pengaturan. Field `backupVersion` wajib ada; migrator per versi di sisi impor; backup dari versi app yang lebih baru ditolak dengan pesan jelas. Batas file 10 MB (USULAN; 10 juta byte dibagi 200 byte per lagu sama dengan 50.000 lagu, jauh di atas library wajar). Nama file `backup-musik-YYYYMMDD-HHmmss.json` (USULAN). Impor dalam satu transaksi; gagal berarti tidak ada yang berubah. Merge, bukan timpa buta (aturan merge playlist memakai B4.8; antrean backup ditambahkan di belakang antrean yang ada, bukan menimpa; pengaturan dari backup bersifat opsional). Format backup web wajib kompatibel dengan format backup APK (satu format, dua platform); bila format berbeda, migrator wajib disediakan.
- **Impor playlist Spotify tanpa API** (B10.2): larangan yang mengikat dan berlaku selamanya. App TIDAK BOLEH memanggil `api.spotify.com` atau `accounts.spotify.com`; TIDAK BOLEH memakai client ID, client secret, atau token Spotify; TIDAK BOLEH login Spotify; TIDAK BOLEH memakai library pembungkus Spotify Web API. Pelanggaran adalah alasan menghentikan rilis. Satu-satunya request ke domain Spotify yang diizinkan adalah mengambil satu halaman publik playlist yang dibagikan pengguna (jalur A).
  - **Jalur B (utama, aman)**: pengguna menempelkan atau memilih file ekspor miliknya (teks "Artis - Judul" per baris, CSV, atau JSON ekspor data Spotify). Tidak ada request ke Spotify sama sekali.
  - **Jalur A (sekunder, berisiko)**: pengguna menempelkan tautan playlist publik Spotify; app mengambil halaman publik itu dan mengekstrak daftar lagu. Ditandai risiko ToS dan kerapuhan; wajib dibuktikan di Fase 2 sebelum dikapalkan; bila tidak bisa dibuktikan, jalur A gugur dan jalur B berdiri sendiri. Risiko dicatat sebagai R11.
  - **Pencocokan**: lagu dicocokkan ke katalog YouTube Music. Cocok yakin (judul dan artis sama persis) langsung diterima. Tidak yakin menampilkan sampai 3 kandidat dan pengguna memilih atau menekan "Lewati lagu ini". Tidak ada kandidat berarti gagal dengan alasan "tidak ditemukan". App tidak pernah menebak diam-diam.
- **Pemutar file audio lokal** (B10.3): ditunda ke pasca-v1 sebagai Could (bagian 4). Spesifikasi disimpan: pemutaran file audio milik pengguna lewat File API, file dibaca lokal dan tidak diunggah, satu antrean dengan lagu streaming.
- **Laporan hasil impor** (B10.4): setelah impor, app menampilkan ringkasan (berhasil, sudah ada, gagal) dengan alasan per lagu yang gagal. Ringkasan bisa ditutup dan tidak disimpan permanen.

### 5.11 B11. Info dan Bantuan

- **Tentang** (B11.1): nama app, nomor versi dan build, penjelasan singkat apa app ini, disclaimer non-afiliasi (app ini bukan produk YouTube atau Google), disclaimer legal (app memakai akses tidak resmi dan bisa berhenti berfungsi kapan saja), lisensi GPL-3.0-only, tautan repo, tautan kebijakan privasi, dan satu baris ajakan mendukung kreator ("Suka lagu ini? Dukung artisnya dengan mendengarkan di layanan resmi atau membeli karyanya." USULAN teks, mengikuti contoh SimpMusic, tanpa pengingat berulang).
- **Kebijakan privasi** (B11.2): 8 butir. (1) App tidak mengumpulkan data pengguna. (2) Semua data tersimpan lokal di browser. (3) Pihak ketiga yang menerima data: Google dan YouTube menerima IP, kueri pencarian, dan permintaan stream; penyedia lirik menerima IP dan judul lagu; host config remote (GitHub Releases) menerima IP saat pemeriksaan pembaruan; proxy byte-only (bila dipakai) menerima IP dan isi request yang diteruskannya; penyedia sinkronisasi (bila pengguna masuk akun opsional) menerima data yang disinkronkan. (4) Tidak ada login wajib di v1; akun bersifat opsional dan hanya untuk sinkronisasi. (5) Pengguna bisa menghapus semua data dari app. (6) App tidak ditujukan untuk anak di bawah umur tanpa pendampingan orang tua. (7) Kanal kontak (D9, menunggu owner). (8) Tanggal berlaku dan cara pemberitahuan perubahan.
- **FAQ** (B11.3): 12 pertanyaan nyata untuk app ini, dengan jawaban bahasa sehari-hari. Q1 menjelaskan cara melaporkan kerusakan dan tombolnya (tanpa janji kecepatan respons). Q12 soal kode sumber terbuka sudah terjawab (GPL-3.0-only, repo publik).
- **Laporkan kerusakan** (B11.4): pengguna bisa mengirim laporan dengan 8 butir info diagnostik (versi app, versi browser, perangkat, langkah yang dilakukan, pesan yang muncul, waktu kejadian, apakah lagu unduhan atau streaming, apakah masalahnya berulang) ditambah kode diagnostik LRS1 bila ada. Yang TIDAK BOLEH ikut terkirim: alamat IP, email, cookie, token, URL stream, isi respons InnerTube, path internal, judul lagu, isi database.
- **Kejujuran** (B11.5): tidak ada baris permanen yang tidak bisa ditutup di beranda. Diganti lembar kejujuran satu kali saat pertama kali membuka app (bisa ditutup, tampil sekali, dengan tautan ke FAQ 1 dan 2). Banner saat layanan terganggu dan tombol "Periksa pembaruan" tetap ada sesuai B1.7 dan B6.5.

## 6. Desain UI dan UX

Design read: pemutar musik web untuk pendengar Indonesia yang sering tanpa internet, dengan bahasa visual monokrom yang dikunci owner, dial ENERGY 2, RHYTHM 2, MOTION 1 (skala anti-slop 1 sampai 3; alasannya: pemutar adalah alat yang dipakai tiap hari, jadi energi sedang, ritme konsisten dengan sedikit variasi antar seksi, dan gerak minimal supaya tidak mengganggu saat mendengar musik).

- **Design system monokrom** sesuai design lock owner: canvas hitam murni `#000000`, surface `#121214`, elevated `#1C1C1E`, teks `#FFFFFF` (utama), `#A1A1AA` (sekunder), `#8E8E93` (redup), aksen putih. Warna hanya untuk status: hijau `#34D399` (sukses), kuning `#FBBF24` (peringatan), merah `#F87171` (error), biru `#60A5FA` (info). Rasio kontras terverifikasi koordinator APK dengan rumus WCAG: teks utama 21,0:1, sekunder 8,19:1, redup 6,44:1, status hijau 10,92:1, kuning 12,58:1, merah 7,59:1, biru 8,26:1. `#71717A` (4,35:1) dilarang untuk teks karena di bawah AA. Catatan konflik skill: skill design-taste melarang `#000000` murni sebagai default; design lock owner menang atas default generik skill (klausul override ada di skill itu dan di PRD APK).
- **Tipografi**: font sistem (tanpa biaya unduh font); skala 8 token dari 12 px sampai 24 px (lantai 12 px untuk semua teks yang menghadap pengguna). Grid 4 px; satu sistem radius yang didokumentasikan; ikon satu keluarga yang sama di seluruh app (keluarga ikon diputuskan di arsitektur.md bersama stack frontend).
- **Navigasi**: tab bawah 4 tab di HP (Beranda, Cari, Library, Unduhan); di layar lebar, navigasi pindah ke rail atau sidebar kiri (USULAN, ambang lebar diputuskan Fase 2). Pengaturan lewat ikon gerigi di Library. URL tiap layar bisa dibagikan (rute untuk lagu, playlist, album, artis, dan hasil cari).
- **Layar utama**: Beranda (seksi bagian 5.6), Pencarian (bagian 5.1), Player (sampul, judul, artis, kontrol, slider seek, antrean, lirik, sleep timer, sheet Suara), Library (bagian 5.4), Detail playlist, Pengaturan, Unduhan. Tiap layar punya keempat state: skeleton, empty state jujur (tanpa data contoh), error bahasa sehari-hari dengan tombol coba lagi, dan state offline.
- **Komponen kunci**: kartu 158 px di layar 360 px (terverifikasi di APK: (360 dikurangi 32 dikurangi 12) dibagi 2); daftar virtual 50 item per halaman; mini-player 64 px (tidak bisa dihapus dengan geser ke samping); antrean maks 200 item; kontrol putar, acak, ulang; slider seek; volume, kecepatan, pitch, dan EQ Web Audio di sheet Suara; dialog unduh dengan label "Terbaik", "Seimbang", "Hemat data" (pemetaan ke itag hanya di dokumen, tidak di layar); indikator status 3 tingkat saat YouTube berubah (Normal, Terganggu, Bermasalah, ambang dari B9.7).
- **Responsivitas**: baseline 360 px (HP Android rata-rata); layout melebar rapi sampai desktop ultrawide; tidak ada horizontal overflow di lebar mana pun; tabel dan baris panjang dibungkus `overflow-x-auto`; area sentuh minimal 44 px di HP (R-03 anti-slop; APK memakai 48 dp, web memakai 44 px sesuai standar web).
- **Aksesibilitas**: kontras AA; teks minimal 12 px; label pembaca layar per kontrol; status tidak pernah hanya warna (pasangan penanda teks dan ikon); skala font sampai 1,3x; reduced motion dihormati; fokus keyboard jelas dan terlihat (tanpa menghilangkan outline tanpa pengganti); semua kontrol bisa dipakai dengan keyboard (Tab, Enter, Space, Escape untuk dialog).
- **Gerak**: transisi singkat (transform dan opacity saja, bukan top, left, width, atau height); tanpa animasi loop tanpa henti; semua gerak runtuh ke statis saat `prefers-reduced-motion` aktif.
- **Aturan copy**: 7 aturan dari PRD APK, berlaku penuh di web. Ringkasnya: bahasa sehari-hari, tanpa istilah teknis, tanpa kata "cache" di layar, tanpa kata "perpustakaan" (pakai "Library"), kata kerja "Periksa" distandarkan (bukan "Cek"), tanpa angka yang tidak perlu, tanpa klaim yang tidak bisa dibuktikan.

## 7. Kriteria sukses v1 (K1-K15)

Tiap kriteria punya target dan cara ukur. Target tidak boleh diturunkan diam-diam bila pengukuran pertama lebih rendah; perubahan target wajib dicatat dengan alasan.

| ID | Kriteria | Target | Cara ukur |
|----|----------|--------|-----------|
| K1 | Kecepatan resolve | Median di bawah 2 detik per lagu | Uji 60 lagu, hitung median waktu resolve; diukur di jaringan HP langsung, bukan VM (median VM 4.049 ms adalah egress-bound dan tidak mewakili pengguna) |
| K2 | Cold start web | LCP di bawah 2,5 detik, INP di bawah 200 ms, CLS di bawah 0,1 | Lighthouse, protokol 5 kali ukur buang min dan maks, perangkat kelas menengah |
| K3 | Pemutaran pertama | Di bawah 2 detik di koneksi baik | Uji 20 lagu dari keadaan dingin |
| K4 | Ukuran bundle dan PWA | Bundle awal (JavaScript dan CSS, gzip) di bawah 1 MB (USULAN); modul solver QuickJS-WASM dimuat malas terpisah; manifest valid, Service Worker terdaftar, bisa dipasang di Chrome Android dan Chrome desktop; skor kategori PWA Lighthouse 100 (USULAN) | Ukur bundle produksi; uji instalasi di dua platform; Lighthouse |
| K5 | Keberhasilan pemutaran | 57 dari 60 lagu berhasil (95 persen) | Uji 60 lagu populer dan kurang populer, 20 lagu per hari selama 3 hari |
| K6 | Fallback antar client | 10 dari 10 tanpa error terlihat | Matikan client utama di config, 10 lagu tetap jalan |
| K7 | Config remote | Dipakai dalam 6 jam | Ubah entri di GitHub Release, app mengambil dalam TTL tanpa deploy ulang |
| K8 | Offline penuh | 10 lagu tanpa internet | Unduh 10 lagu, matikan internet (mode pesawat atau devtools offline), putar semuanya |
| K9 | Penyimpanan otomatis tidak menghapus unduhan | 0 unduhan terhapus oleh eviction | Isi penyimpanan otomatis sampai batas, periksa semua unduhan masih ada |
| K10 | Antrean persisten | Antrean utuh setelah tutup tab dan tutup browser | Buat antrean 50 lagu, tutup browser paksa, buka lagi, antrean sama |
| K11 | Ketahanan memori | 10.000 lagu, 1.000 entri riwayat, antrean 500, tanpa tab crash | Uji stress di RAM 3 GB, ambang memori diputuskan Fase 2 setelah pengukuran pertama |
| K12 | Keamanan | Nol temuan kritis, tinggi, dan sedang | Siklus Red-Blue-Red, maks 5 ronde |
| K13 | Kualitas kode | Lint dan typecheck tanpa warning; tes jalur resolve, fallback, unduhan, migrasi lolos | CI GitHub Actions |
| K14 | Copy bahasa sehari-hari | 0 istilah teknis di teks layar | Audit copy manual tiap layar, checklist bagian 6 |
| K15 | Distribusi dan dokumen | README, PRIVACY_POLICY.md, CHANGELOG, situs live terverifikasi dari tautan depan, PWA terpasang dan teruji | Periksa satu per satu sebelum rilis |

## 8. Milestone (M0-M10)

Berbasis dependensi, tanpa tanggal. Estimasi waktu tanpa bukti build pertama adalah tebakan, jadi PRD ini tidak memberi tanggal. Aturan: scope freeze setelah M4; login tidak boleh menyelinap lewat M3 atau M8; tiap milestone diakhiri demo preview ke owner (milestone tanpa preview yang bisa diuji owner dianggap belum selesai).

- **M0 Fondasi**: repo, CI, skeleton web, token desain, pemisahan string, manifest PWA dan Service Worker shell.
- **M1 Spike ekstraksi web**: 4 spike keputusan-solver.md bagian 8 (S1 QuickJS-WASM di Web Worker untuk ketiga hash, S2 vonis CORS final, S3 pemutaran `<audio>` dan Media Session, S4 port `buildPlayerScript` ke TypeScript). Gate go atau no-go sebelum komitmen penuh; bila spike gagal, pindah ke jalur cadangan (eval di Web Worker, iframe sandbox, atau IFrame Player API sebagai jalur putar).
- **M2 Player core**: bisa paralel dengan M1 setelah interface port pemutar disepakati. Elemen audio, graph Web Audio, MediaSession, antrean.
- **M3 Database dan library**: database browser, skema (15 tabel APK adalah referensi desain), migrasi, library, playlist, favorit, riwayat.
- **M4 Pencarian dan browse**: pencarian YTM, saran, pencarian lokal, beranda, Jelajah.
- **M5 Unduhan dan offline**: download jobs, penyimpanan otomatis, layar Penyimpanan, rekonsiliasi.
- **M6 Ketahanan**: config remote, kanari, klasifikasi error, pesan jujur.
- **M7 Fitur Should**: lirik, sleep timer, EQ Web Audio, akun opsional dan sinkronisasi (bila masuk v1).
- **M8 Backup dan ekspor**: backup JSON berversi, impor merge, hapus semua data.
- **M9 Keamanan**: Red 1 setelah M4, Red 2 setelah M5 dan M6, Red 3 di release candidate. Siklus Red-Blue-Red sampai nol temuan kritis, tinggi, sedang.
- **M10 Rilis**: dokumen rilis, situs live, PWA terverifikasi, pengajuan direktori aplikasi web dan open source.

**Pasca-v1**: v1.1 pemutar file audio lokal dan discovery berbasis artis; v1.2 login YouTube Music bila diputuskan; lalu normalisasi volume, Auto DJ (putar otomatis lagu terkait), statistik dengar lokal.

## 9. Risiko (R1-R14)

| ID | Risiko | Mitigasi | Pemicu eskalasi |
|----|--------|----------|-----------------|
| R1 | YouTube berubah dan merusak ekstraksi | Fallback antar client, config remote, kanari, pesan jujur, mode terdegradasi VR | Ambang rusak tercapai; owner diberi tahu di hari yang sama |
| R2 | Satu maintainer paket QuickJS-WASM | Port ekstraksi milik app; cadangan eval di Web Worker, iframe sandbox, dan mode terdegradasi VR | Tidak ada rilis 12 bulan dan ada bug blocker, atau repo diarsipkan |
| R3 | API browser berubah (MediaSession, Service Worker, penyimpanan) | Pantau standar web; cadangan kontrol DOM dan pemutaran tanpa MediaSession | Kontrol media rusak di browser target, atau API dihapus dari standar |
| R4 | Hosting atau proxy menolak pola config remote | Varian config dibundel; fallback GitHub dan hosting alternatif | Hosting menolak atau meminta config dihapus |
| R5 | Kuota proxy serverless habis (Workers Free 100.000 request per hari untuk semua pengguna) | Direct fetch bila S2 lolos; proxy hanya untuk youtubei dan base.js; degraded penuh dengan pesan jujur bila kuota habis | Kuota habis sebelum reset tengah malam UTC; owner memutuskan soal paket berbayar (melanggar Rp0, jadi bukan keputusan tim) |
| R6 | Kerentanan QuickJS | Worker terpisah, batas memori dan waktu, tanpa callback host, validasi output, hash player dicocokkan | CVE baru atau paket tertinggal perbaikan; bila tidak ada perbaikan, solver dimatikan sementara dan app hanya memakai client yang tidak butuh signature |
| R7 | Tindakan hukum (cease-and-desist, takedown repo) | Clean-room, tanpa merek YouTube atau Spotify, disclaimer, mirror repo cadangan | Surat hukum apa pun atau takedown repo; owner memutuskan langsung; tim tidak melawan tanpa penasihat hukum dan tidak mengabaikan diam-diam |
| R8 | Scope creep | Scope freeze setelah M4; usulan baru masuk backlog | Usulan fitur baru di tengah Fase 2; owner memutuskan |
| R9 | Ketergantungan satu owner | Hotfix config bisa diterbitkan tim bila owner tidak bisa dihubungi lebih dari 30 hari saat kerusakan aktif | Owner tidak bisa mengambil keputusan lebih dari 30 hari di tengah kerusakan aktif; otorisasi ini tercakup dalam delegasi penuh 15 November 2026 20:55 WIB |
| R10 | Pengguna mengira app rusak total | Catatan status di README dan Releases dalam 24 jam, tanpa janji tanggal | Laporan kerusakan massal |
| R11 | Impor Spotify jalur A (halaman publik) melanggar ToS atau rapuh | Jalur B (file ekspor) sebagai utama; jalur A wajib dibuktikan Fase 2 sebelum dikapalkan | Jalur A tidak bisa dibuktikan; jalur A gugur dan jalur B berdiri sendiri |
| R12 | Browser menghapus penyimpanan situs saat ruang perangkat menipis | Unduhan tidak pernah dihapus eviction app; minta penyimpanan persisten ke browser (USULAN); pesan jujur dan rekonsiliasi bila data hilang | Laporan massal lagu tersimpan hilang; perilaku eviction per browser wajib diuji di Fase 2 |
| R13 | iOS Safari membatasi PWA atau audio latar | Uji di perangkat iOS nyata; nyatakan batasnya jujur di FAQ bila terbukti | Perilaku iOS terbukti memutus pemutaran latar; owner memutuskan prioritas iOS |
| R14 | CORS berubah atau proxy ikut diblokir | Lapis fallback keputusan-solver.md bagian 7 (direct, proxy, IFrame, degraded penuh) | Semua jalur jaringan gagal; app tetap memutar lagu tersimpan dengan pesan jujur |

## 10. Keputusan

Seluruh keputusan di bawah ini DIPUTUSKAN koordinator atas otoritas delegasi penuh owner 15 November 2026 20:55 WIB dan permintaan web app 17 November 2026 20:30 WIB. Owner bisa membatalkan keputusan apa pun.

| ID | Keputusan | Isi |
|----|-----------|-----|
| D1 | Lisensi | GPL-3.0-only (norma ekosistem: 4 dari 5 kompetitor APK GPL-3.0; copyleft melindungi dari fork tertutup) |
| D2 | Pemutar file lokal | Ditunda ke pasca-v1 sebagai Could; spesifikasi B10.3 disimpan |
| D3 | Lirik | LRCLIB (CORS terverifikasi ACAO `*`); saklar hidup atau mati di Pengaturan default hidup, plus pemberitahuan satu kali; PRIVACY_POLICY.md menyebut LRCLIB |
| D4 | Equalizer | Web Audio 10 band dengan preset dan profil (Should); fondasi graph di Must B2.1 |
| D5 | Sleep timer | Jeda pemutaran saat habis; antrean dan posisi tersimpan; timer berhenti bila tab ditutup dan itu dinyatakan jujur |
| D6 | Bahasa UI | Indonesia saja di v1; semua string terpisah dari kode sejak awal; Inggris pasca-v1 |
| D7 | Kualitas audio | Unduhan 3 opsi (Terbaik, Seimbang, Hemat data); streaming terbaik otomatis plus satu saklar hemat data |
| D8 | Distribusi | Situs web live dan PWA dulu; direktori aplikasi web dan open source; bukan toko aplikasi berbayar |
| D9 | Kanal kontak privasi | MENUNGGU OWNER. Tim tidak bisa mengarang alamat kontak publik. Satu-satunya butir yang butuh tindakan owner |
| D10 | URL produksi | BELUM DIPUTUSKAN. Bukan butir PRD ini; diputuskan koordinator bersama owner sebelum M10 |
| D11 | Dukung kreator | Satu baris di layar Tentang, mengikuti contoh SimpMusic, tanpa pengingat berulang |
| D12 | Mirror repo | Mirror cadangan ke forge kedua saat rilis pertama (mitigasi R7) |
| D13 | Penomoran versi | 0.9.x untuk build uji, v1.0.0 rilis publik pertama |
| D14 | Repo | PUBLIK. GPL mewajibkan source tersedia; copyleft adalah perlindungan terhadap pencurian source; kelima kompetitor APK publik |
| D15 | Tema | Mode gelap saja di v1; mode terang pasca-v1 |
| D16 | Nama app | Laras, sama dengan APK; diputuskan tim Brand di Paket 4 APK |
| D17 | Solver | Jalan di browser (QuickJS-WASM di Web Worker khusus); Worker hanya proxy byte bila CORS memblokir (keputusan-solver.md) |
| D18 | Stack backend | DIPUTUSKAN di arsitektur.md (Cloudflare vs Vercel dan Supabase vs Firebase), bukan di PRD ini |

## 11. Asumsi dan fakta

**Asumsi** (bila salah, PRD ini perlu revisi):
- A1. Pengguna sudah tahu app ini tidak resmi dan tidak berafiliasi dengan YouTube atau Spotify.
- A2. Durasi lagu rata-rata 210 detik (dipakai semua hitungan ukuran file).
- A3. RAM 3 GB mewakili perangkat awal pengguna.
- A4. Pengguna terutama mendengar lagu yang sudah dikenal, bukan menjelajah katalog baru.
- A5. Koneksi pengguna kadang lambat atau putus.
- A6. Owner adalah satu-satunya pengambil keputusan akhir.
- A7. YouTube tidak memblokir seluruh client InnerTube sekaligus dalam waktu dekat. Bila salah, v1 gagal dan tim beralih ke cadangan atau menghentikan proyek.
- A8. Browser target pengguna mendukung WASM, Web Worker, Service Worker, IndexedDB, dan Media Session API (browser modern). Browser sangat tua tidak didukung di v1.
- A9. Thumbnail YouTube Music sekitar 100 KB (belum diukur).
- A10. Pengguna membuka Laras dari tautan yang dibagikan atau dari PWA yang sudah terpasang, bukan dari mesin pencari (SEO bukan jalan masuk utama v1).

**Fakta** (terverifikasi 15 sampai 17 November 2026):
- F1. Kelima kompetitor APK memakai Media3 ExoPlayer; tidak ada yang masih Flutter.
- F2. Tidak satu pun kompetitor keluarga InnerTune punya versi web; tidak satu pun kompetitor APK ada di Play Store.
- F3. Kualitas audio publik terbaik dari YouTube adalah itag 251 Opus sampai sekitar 160 kbps; tidak ada 320 kbps atau lossless.
- F4. Spotube kena cease-and-desist Spotify 2025 dan membuang Spotify di v5.
- F5. Tiga dari lima kompetitor APK mati atau membeku.
- F6. ToS YouTube (berlaku 15 Desember 2023) melarang akses tidak resmi, automated means, dan mengakali fitur keamanan; app ini melanggar di beberapa titik sekaligus. IFrame Player API adalah satu-satunya jalur pemutaran yang berada di dalam ToS.
- F7. Dokumentasi youtubei.js menyatakan pemakaian di browser wajib mem-proxy request lewat server sendiri, termasuk untuk streaming audio. Tidak ada proyek yang memutar audio InnerTube murni dari browser tanpa perantara, kecuali lewat IFrame resmi.
- F8. LRCLIB mengirim `Access-Control-Allow-Origin: *` dan bisa dipanggil langsung dari browser tanpa proxy (riset bagian 16.3).
- F9. `raw.githubusercontent.com` mengirim `Access-Control-Allow-Origin: *` (diukur 17 November 2026); fetch config langsung dari browser bisa jalan.
- F10. Cloudflare Workers melarang `eval`, `new Function`, dan `WebAssembly.compile` saat request ditangani; Workers Free membatasi CPU 10 ms per request HTTP dan memori 128 MB per isolate (dokumentasi Limits, diperbarui 29 Oktober 2026, diverifikasi silang 3 sumber 17 November 2026).
- F11. Median solve solver APK 10,5 ms (10 resolve nyata, Node di VM, 16 November 2026); median request player 4.028,5 ms; median total resolve 4.049 ms.
- F12. Tiga hash player hidup bersamaan pada 17 November 2026 (fad7e4e9, ad8d59ae, b559f50c); nama kelas URL berputar per hash (tf, bs, JH) dan wajib dibaca dari base.js per hash.

## 12. Tabel angka dan batas

| Butir | Nilai | Sumber |
|-------|-------|--------|
| itag audio | 139 AAC 48 kbps, 140 AAC 128 kbps, 141 AAC 256 kbps (Premium saja, tidak dijanjikan), 249 Opus sekitar 50 kbps, 250 Opus sekitar 70 kbps, 251 Opus sekitar 128 sampai 160 kbps | PRD APK bagian 12 |
| Urutan pemilihan itag | 251, 140, 250, 249, 139 | PRD APK bagian 12 |
| Ukuran lagu 3,5 menit | 251 sama dengan 4,2 MB; 140 sama dengan 3,36 MB; 250 sama dengan 1,84 MB; 249 sama dengan 1,31 MB; 139 sama dengan 1,26 MB | Rumus bitrate x 210 detik / 8 |
| Data streaming per jam (sekitar) | Terbaik 72 MB; Seimbang 58 MB; Hemat data 22 MB | PRD APK bagian 12 |
| Penyimpanan lagu yang pernah diputar | Default 500 MB; pilihan 250 MB, 500 MB, 1 GB, 2 GB; isi sekitar 59, 119, 243, 487 lagu (1 GB = 1.024 MB) | PRD APK bagian 12 |
| Antrean | Maks 200 item metadata | PRD APK bagian 12 |
| Riwayat putar | Maks 10.000 entri | PRD APK bagian 12 |
| Riwayat pencarian | Maks 100 query | PRD APK bagian 12 |
| Pagination | 50 item per halaman, keyset | PRD APK bagian 12 |
| Debounce | 300 ms (pencarian lokal dan saran) | PRD APK bagian 12 |
| Timeout | Connect 10 detik, receive 15 detik (API JSON); 30 detik (stream dan gambar, inactivity unduhan); player dan search 30 detik, HTML 60 detik, base.js 90 detik, config 5 detik (terlalu agresif, lihat B9.2), solver 10 detik, kanari 90 detik, watchdog stall unduhan 60 detik | PRD APK bagian 12, transfer bagian 11 |
| Retry | Maks 3 kali, backoff 1 detik dan 2 detik ditambah jitter, hanya error jaringan, 5xx, 429 | PRD APK bagian 12 |
| Batas anti-OOM | Nilai kunci-nilai maks 1 KB per nilai dan 100 KB total; kolom JSON maks 4 KB per baris; log internal 1 MB rotasi; cache sampul 200 MB disk; thumbnail 200 px, now-playing 512 px | PRD APK bagian 12 |
| Config remote | TTL 6 jam; timeout request 5 detik; maks respons 4 MB; single-flight dan rate limit untuk refresh yang dipicu kegagalan | PRD APK bagian 12, transfer bagian 7 |
| QuickJS | Timeout 10 detik; memori 192 MiB; stack 256 KiB (gg_quickjs saat ini; 8 MiB era lama tidak aman); eksekusi serial | Transfer bagian 4 |
| Ambang rusak | 3 resolve kanari gagal berturut-turut dengan penyebab sama, atau lebih dari separuh resolve dalam 1 jam gagal | PRD APK bagian 12 |
| Client fallback | WEB_REMIX 67 v1.20261110.04.00; MWEB 2 v2.20260708.05.00; ANDROID_VR 14 v1.65.10 (tanpa script) | Transfer bagian 2 |
| signatureTimestamp | fad7e4e9 20767, ad8d59ae 20768, b559f50c 20770, varian tcl 20767001 | Transfer bagian 3.1 |
| Ukuran base.js | fad7e4e9 2.677.001 byte; tcl 2.876.993 byte; ad8d59ae 2.679.612 byte; b559f50c 2.684.806 byte | Transfer bagian 3.4 |
| Kontribusi QuickJS di APK | 1.240.840 byte (bundle WASM web diperkirakan seorde itu; angka pasti wajib diukur di spike S1) | Transfer bagian 4, keputusan-solver bagian 5.1 |
| Batas respons | JSON youtubei 10 MB, script player 8 MB, config remote 4 MB, HTML youtube 4 MB; parser 100 item; unduhan 1 GB ditambah margin 1 MB | Transfer bagian 11 |
| Batas googlevideo dari VM | Tepat 1 MiB per URL lalu 403; 1 MiB sama dengan sekitar 55 detik audio itag 251 dari lagu 268 detik | Transfer bagian 10 |
| Workers Free | 100.000 request per hari; CPU 10 ms per request HTTP; memori 128 MB per isolate; subrequest 50 | Keputusan-solver bagian 4.2 |
| Workers Paid | US$5 per bulan minimum; CPU 30 detik default, maks 5 menit; 10 juta request per bulan termasuk | Keputusan-solver bagian 4.2 |
| LRCLIB batas laju | Klien generik sekitar 45 request per menit per IP, teridentifikasi sekitar 90, terdaftar sekitar 180 per IP ditambah allowance app sekitar 6.000 per menit (sumber sekunder, belum terverifikasi dari dokumentasi resmi) | Riset bagian 16.3 |
| Target performa | Resolve median di bawah 2 detik; LCP di bawah 2,5 detik; INP di bawah 200 ms; CLS di bawah 0,1; pemutaran pertama 2 detik | K1-K3 |
| Target bundle | Bundle awal di bawah 1 MB gzip (USULAN) | K4 |

## 13. Yang belum terverifikasi dan verifikasi Fase 2

Daftar ini wajib diselesaikan sebelum atau saat Fase 2, bukan ditebak.

1. Spike S1 sampai S4 (keputusan-solver.md bagian 8): QuickJS-WASM di Web Worker untuk ketiga hash, vonis CORS final, pemutaran `<audio>` dan Media Session, port `buildPlayerScript` ke TypeScript.
2. Ukuran pasti bundle QuickJS-WASM dan pemakaian memori puncak solver di browser.
3. Waktu resolve di jaringan HP langsung (median VM 4.049 ms adalah egress-bound; K1 berstatus tertunda di verifikasi APK).
4. Apakah batas 1 MiB googlevideo juga berlaku di IP residensial (hanya uji perangkat owner yang bisa memutuskan).
5. Perilaku pemutaran latar dan PWA di iOS Safari.
6. Perilaku eviction penyimpanan browser per browser target (Chrome, Firefox, Safari, Edge).
7. Batas laju LRCLIB dari dokumentasi resmi (angka saat ini dari pengujian sekunder cors.dev).
8. Kewajiban UU PDP Indonesia untuk app ini (belum diperiksa dari sumber live).
9. Library tag metadata web (uji Fase 2).
10. Ukuran file thumbnail YouTube Music nyata (asumsi 100 KB belum diukur).
11. Ambang memori persis uji regresi anti-OOM web (diputuskan setelah pengukuran pertama).
12. Perilaku pitch slider dan prefetch 1 lagu ke depan di browser (USULAN, wajib verifikasi Fase 2).
13. Browse charts, rilisan, dan mood tanpa login; saran pencarian tanpa login; continuation token dari client yang dipakai web.
14. Deteksi jenis koneksi (WiFi vs seluler) di semua browser target untuk saklar "Unduh WiFi saja".
15. Label tombol "Periksa pembaruan" dipahami pengguna (uji pemahaman Fase 2).
16. Akar tunggal insiden P0-2 APK (hipotesis teratas: cek bot IP HP); menunggu kode diagnostik dan uji unduh K8 dari perangkat owner.
17. Berapa lama varian non-tcl base.js lama tetap dilayani YouTube (fallback varian rapuh; VR adalah jaring pengaman).
18. VisitorData cadangan dari HTML youtube.com (rekomendasi P0-2, belum diimplementasikan, butuh bukti kode dulu).
19. Nama paket QuickJS-WASM final (kandidat `quickjs-emscripten` wajib diverifikasi di spike S1).
20. Batas Workers dan kebijakan platform pada tanggal implementasi (batas platform dapat berubah; tim implementasi wajib mengecek ulang halaman Limits saat membangun proxy dan mencatat tanggal ceknya).

## 14. Checklist 7 skill anti-slop

Dokumen ini ditulis dengan 7 skill anti-slop owner (mode during). Checklist per skill:

- **local-design-taste-frontend**: design read satu baris ditulis di bagian 6 sebelum spesifikasi desain; token desain APK dipakai apa adanya (monokrom, hitam murni, aksen putih); tidak ada gradasi dekoratif, tidak ada glassmorphism, tidak ada shadow tebal; aturan owner menang atas default generik skill (klausul override dicatat eksplisit untuk `#000000`); target Core Web Vitals dari skill dipakai di K2.
- **local-impeccable**: tiap fitur punya state lengkap (loading, kosong, error, offline); tiap angka punya sumber atau label USULAN atau "belum terverifikasi"; edge cases (lagu tidak bisa diputar, file hilang, antrean penuh, ruang habis, tab ditutup saat unduh, timer berhenti saat tab ditutup) dispesifikasikan, bukan diabaikan; brief menang atas selera (design lock owner dipertahankan).
- **local-humanizer**: copy pengguna dalam bahasa Indonesia sehari-hari; tidak ada kalimat template ("Berikut adalah", "Senantiasa"); pesan error menjelaskan apa yang terjadi dan apa yang bisa dilakukan pengguna; tidak ada kontras "tidak hanya X tapi juga Y"; tidak ada em dash atau en dash di dokumen ini.
- **local-stop-slop**: tidak ada kata haram (komprehensif, sinergi, transformasi, dan kawan-kawan); tidak ada filler; tiap paragraf membawa keputusan atau angka; kalimat aktif dipakai di mana aktornya jelas.
- **local-no-ai-slop**: tidak ada klaim yang tidak bisa dibuktikan (angka yang belum terverifikasi dilabeli, bukan disajikan sebagai fakta); tidak ada angka karangan (semua angka dikutip dari PRD APK, riset, transfer, atau keputusan-solver, atau berlabel USULAN dengan rumus atau alasan); tidak ada label bergaya AI; tidak ada bold dekoratif di tengah kalimat tanpa alasan.
- **local-avoid-ai-writing**: kalimat aktif dan pendek; tidak ada pola "tidak hanya X tapi juga Y"; tidak ada daftar klise AI; tidak ada kata ganti orang pertama yang mengarang pengalaman; ketidakpastian dinyatakan apa adanya ("belum terverifikasi") tanpa ditutup-tutupi.
- **local-anti-slop (rulebook)**: tidak ada em dash, tidak ada en dash, tidak ada karakter persen (ditulis kata "persen"); tidak ada emoji; tidak ada kata "cache" atau "perpustakaan" di copy pengguna; istilah teknis hanya di penjelasan untuk tim; dial ENERGY 2, RHYTHM 2, MOTION 1 dinyatakan dengan alasan satu baris tiap dial; tiap keputusan desain punya alasan tertulis (R-31).
