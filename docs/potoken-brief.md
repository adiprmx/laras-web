# Brief keputusan: poToken untuk Laras

Tanggal: 19 Nov 2026. Status: BRIEF SAJA — belum ada yang diimplementasikan.
Untuk: owner (disampaikan parent). Keputusan yang dibutuhkan ada di akhir.

## Masalah yang mau dipecahkan

Sejak 18 Nov 2026, YouTube menolak request resolve Laras dari IP Cloudflare
Workers dengan jawaban LOGIN_REQUIRED ("masuk untuk mengonfirmasi Anda bukan
bot"). Uji §5 19 Nov 15:50 WIB: 0/5 lagu, ketiga klien, sesudah 3 putaran
retry P6. Proxy-nya sehat; yang menolak adalah YouTube terhadap IP egress-nya.
Jendela buruk berlangsung 10+ menit. Jalur yang sudah berjalan paralel:
tangga retry lebih panjang (hotfix) + egress kedua via Vercel.

## Apa itu poToken

poToken (Proof of Origin Token) adalah token bukti dari YouTube sendiri yang
menyatakan "request ini datang dari browser asli". Cara kerjanya:

- YouTube punya sistem anti-bot bernama BotGuard. Browser asli menjalankan
  program kecil BotGuard di latar, lalu YouTube memberi token.
- Token itu dikirim bersama request player (`serviceIntegrityDimensions.poToken`,
  terikat ke ID video) dan bersama URL audio (`pot`, terikat ke sesi).
- Tanpa token, request dari klien web bisa ditolak 403 atau dianggap bot.
  Sejak Agustus 2024, YouTube mewajibkan token ini untuk klien berbasis web.

Untuk Laras, token harus dibuat oleh layanan kecil (disebut provider) yang
menjalankan program BotGuard, lalu tokennya dipakai saat resolve tiap lagu.
Perpustakaan terbuka yang sudah ada: BgUtils (dipakai yt-dlp lewat plugin
bgutil-ytdlp-pot-provider, tersedia sebagai server HTTP + Docker, dukungan
Node/Deno), rustypipe-botguard (Rust), dan youtube-trusted-session-generator
milik Invidious (juga menghasilkan visitorData).

## Apa yang dibuka

- Bila berhasil, request player dari IP Cloudflare yang sekarang ditolak bisa
  lolos lagi, karena lalu lintas terlihat lebih sah di mata YouTube.
- Ini melengkapi, bukan menggantikan, retry + failover egress: token membuat
  tiap egress lebih dipercaya.

## Yang TIDAK dijamin (jujur)

- Dokumentasi resmi provider-nya sendiri berkata: token TIDAK MENJAMIN
  lolos dari 403 atau cek bot, dan TIDAK MELEWATI pembatasan login berbasis
  IP. Blokir Laras terlihat berbasis IP (IP Workers ditolak, IP lain lolos),
  jadi poToken MUNGKIN tidak memperbaiki kasus ini sama sekali.
- Satu-satunya cara tahu: uji coba kecil (spike) — pasang provider, tembak
  request player dari egress Cloudflare dengan token, lihat hasilnya.
  Tanpa spike, semua klaim soal poToken adalah dugaan.

## Usaha dan biaya

- Spike: pasang provider di layanan gratis (mis. Deno Deploy, tier gratis),
  uji dari egress Cloudflare. Perkiraan usaha: paket kecil, beberapa hari
  kerja tim.
- Bila spike lolos: integrasi ke resolver (minta token per lagu, simpan di
  cache beberapa jam), plus perawatan BERKELANJUTAN — YouTube mengubah
  BotGuard secara berkala, provider harus diperbarui mengikuti.
- Biaya uang: nol bila jalan di tier gratis. Biaya lain: satu layanan
  tambahan yang harus dipantau (bila provider mati, resolve kembali gagal).

## Risiko

1. Ketegangan dengan aturan keras owner. Aturan yang berlaku melarang
   membangun solver CAPTCHA / bypass anti-bot. poToken adalah mekanisme
   untuk lolos dari cek bot YouTube — persis di garis itu. yt-dlp dan
   proyek sejenis memperlakukannya sebagai emulasi klien yang sah
   (menjalankan tantangan resmi YouTube, bukan memalsukan jawaban), tapi
   keputusan apakah ini masih di dalam garis atau sudah melewatinya adalah
   keputusan owner, bukan keputusan tim.
2. Ketergantungan baru: token terikat ke pengenal sesi, sehingga sesi
   Laras jadi lebih mudah dilacak YouTube (dampak privasi kecil, tapi nyata).
3. Perlombaan senjata: YouTube bisa mengubah BotGuard kapan saja dan
   mematahkan provider sampai ada pembaruan.
4. Nilai tidak pasti (lihat "Yang TIDAK dijamin" di atas): spike bisa
   berakhir dengan jawaban "tidak membantu untuk kasus ini".

## Keputusan yang dibutuhkan (pilih satu)

A. SETUJU SPIKE SAJA: tim menguji apakah poToken membuka blokir egress
   Cloudflare, lalu melapor. Tanpa komitmen implementasi produksi.
B. SETUJU SPIKE + IMPLEMENTASI BILA LOLOS: bila spike membuktikan token
   membuka blokir, tim langsung mengintegrasikan ke produksi.
C. TOLAK: jangan sentuh poToken; andalkan tangga retry + failover egress
   (Vercel, Deno) saja.

Rekomendasi tim: A. Spike itu murah dan menjawab pertanyaan yang tidak bisa
dijawab dari teori. Keputusan B baru masuk akal sesudah bukti spike ada.

## Sumber (diperiksa 19 Nov 2026)

- pytubefix, dokumentasi PoToken (cara kerja token + BotGuard).
- bgutil-ytdlp-pot-provider, Docker Hub + docs.rs (provider HTTP/skrip,
  peringatan "tidak menjamin lolos" + "tidak melewati pembatasan berbasis IP").
- rustypipe-botguard, docs.rs (alur Create/GenerateIT, token terikat konten
  vs sesi).
- youtube-trusted-session-generator, PyPI (harus jalan di IP yang sama
  dengan yang diblokir; token membuat sesi lebih terlacak).
- DeepWiki yt-dlp PO Token System + @distube/ytdl-core (konteks player/gvs/
  subs, minting lokal di worker thread).
