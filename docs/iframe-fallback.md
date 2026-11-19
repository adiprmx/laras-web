# Fallback Pemutar YouTube (P3)

> Status: terimplementasi 19 Nov 2026 (TIM P3). Siap di-wire koordinator:
> tidak ada langkah deploy khusus — kode app ikut build biasa; yang
> perlu deploy terpisah hanyalah endpoint cache D1 (lihat p3-log.md).

## Masalah

YouTube menolak IP pusat data di jendela buruk (LOGIN_REQUIRED):
CF Workers, Vercel/AWS, GitHub Actions, Render/Oregon semua ditolak.
Jendela BERKEDIP — terbuka sesaat (< 1 menit) lalu tertutup lagi.
Saat jendela tertutup, resolve langsung gagal dan cache D1 kosong:
tanpa fallback ini, pengguna hanya mendapat pesan galat dan diam.

## Cara kerja

Bila resolve langsung gagal DAN cache D1 kosong, lagu diputar lewat
**pemutar resmi YouTube di dalam iframe** (YouTube IFrame Player API)
— pemutar yang sama seperti video YouTube yang disematkan di situs
web mana pun. Pemutar itu berjalan di browser pengunjung, dari IP
pengunjung sendiri, jadi tidak kena penolakan IP pusat data. Tidak
ada resolve, tidak ada CORS, tidak ada server yang terlibat.

Urutan lengkap saat pengguna menekan putar:

1. Resolve langsung via proxy (cara biasa).
2. Bila gagal: cache D1 (simpanan dari jendela terbuka terakhir).
3. Bila cache kosong/kedaluwarsa: tangga retry latar — coba lagi
   otomatis sesudah 60 detik, lalu 5 menit (jendela buruk sering
   berbalik dalam hitungan menit; tangga ini memberi pemulihan
   kualitas penuh).
4. Bila tangga habis dan resolve masih gagal total: pemutar
   YouTube (fallback ini).
5. Bila pemutar YouTube juga gagal: pesan galat seperti semula.

Keputusan urutan (19 Nov 2026): tangga didahulukan atas fallback
karena tangga memulihkan pemutaran NORMAL (kualitas penuh, putar
latar, EQ) begitu jendela berbalik, sementara fallback adalah
mode darurat yang lebih terbatas. Fallback masuk hanya sesudah
semua jalur pemulihan normal habis — bukan menyaingi tangga.

## Kapan fallback aktif

Gerbang masuk (`shouldEnterIframeFallback` di
`app/src/player/iframeFallback.ts`), dicek saat tangga retry
latar habis:

- Mayoritas upaya resolve terakhir ditolak YouTube
  (LOGIN_REQUIRED) — gerbang yang sama dengan tangga retry
  latar. Lagu yang memang tidak ada (UNPLAYABLE murni di semua
  client) TIDAK masuk fallback: pemutar YouTube juga akan
  gagal, dan perilaku lama (berhenti di lagu ini dengan pesan
  jujur) lebih tepat.
- Pengguna BELUM menjeda. Lagu tidak boleh mulai sendiri
  menit-menit sesudah pengguna menjeda (aturan yang sama dengan
  tangga retry latar; jeda manual membatalkan tangga, jadi
  kasus ini praktis tidak sampai ke gerbang — tapi gerbang
  tetap dicek eksplisit).

## Keluar dari mode fallback

- **Resolve pulih:** tiap ganti lagu (next, prev, pilih lagu, ulang)
  mencoba cara biasa dulu. Bila resolve berhasil, mode fallback
  berakhir otomatis dan pemutaran normal berlanjut.
- **Tombol "Coba cara biasa lagi":** pengguna bisa memaksa coba
  ulang cara biasa untuk lagu yang sedang diputar. Bila masih
  gagal, lagu kembali ke mode fallback.
- **Pemutar YouTube melaporkan galat** (mis. video tidak bisa
  diputar): keluar dari mode fallback, lagu digagalkan seperti
  biasa (pindah ke lagu berikut).
- **Lagu lokal/unduhan:** memutar lagu lokal/unduhan selalu
  mengakhiri mode fallback (tanpa ini, dua sumber suara berbunyi
  bersamaan).

## Batasan — jujur, tanpa janji lebih

Mode fallback adalah jalan darurat, BUKAN pengganti pemutaran
normal. Yang TIDAK BISA dilakukan selama mode ini aktif:

- **Tanpa putar latar / layar kunci.** Pemutar YouTube berhenti
  bila tab tidak terlihat, layar dikunci, atau app ditutup.
  Ini batasan pemutar YouTube sendiri, bukan bug app.
- **Tanpa unduh.** Tidak ada URL stream yang bisa disimpan.
- **Tanpa pengatur suara (EQ).** Suara keluar langsung dari
  iframe YouTube, bukan lewat graph audio app.
- **Tanpa antrean mulus.** Tiap pindah lagu mencoba cara biasa
  dulu (butuh waktu); bila masih gagal, pemutar YouTube dibuat
  ulang untuk lagu berikut — ada jeda singkat antar lagu.
- **Kontrol kecepatan/volume app tidak berpengaruh.** Kecepatan
  dan volume diatur dari kontrol bawaan pemutar YouTube.
- **Video terlihat.** Pemutar menampilkan video, bukan hanya
  suara — sesuai syarat YouTube (lihat bawah).
- **Riwayat putar tercatat** (waktu putar dihitung dari status
  pemutar), sama seperti pemutaran normal.

Semua batasan ini juga dijelaskan ke pengguna dengan bahasa
sehari-hari di panel fallback (string `fallbackLimits`).

## Kepatuhan kebijakan YouTube

Pemutar resmi di iframe adalah penggunaan yang diizinkan YouTube
— situs web mana pun boleh menyematkan pemutar YouTube. Yang
wajib dipatuhi (dokumen resmi IFrame Player API, dibaca
19 Nov 2026 — https://developers.google.com/youtube/iframe_api_reference):

- Pemutar WAJIB terlihat, viewport minimal **200x200 px**.
  Implementasi: wujud docked memakai video 200x200 persis;
  wujud expanded memakai video 16:9 selebar layar. Dilarang
  menyembunyikan pemutar atau memakainya sebagai pemutar
  latar/audio saja.
- Dilarang menaruh elemen apa pun DI ATAS pemutar (overlay).
  Implementasi: kontrol app sendiri (tombol putar, bilah
  progres, tombol kembali) berada DI LUAR iframe, di bawahnya.
- Dilarang memisahkan komponen audio dari videonya.
  Implementasi: video selalu tampil bersama suaranya; kontrol
  bawaan YouTube dibiarkan tampil (`controls: 1`).
- Iklan YouTube bisa muncul di pemutar (pengguna YouTube Premium
  tidak melihat iklan). Ini di luar kendali app dan bukan
  sesuatu yang disembunyikan.

Dokumen ini TIDAK mengklaim lebih dari itu: tidak ada penilaian
hukum di sini, hanya pemakaian pemutar resmi sesuai dokumen
resminya.

## Implementasi

| Berkas | Peran |
| --- | --- |
| `app/src/player/iframeFallback.ts` | Logika murni: gerbang masuk, pemuat API on-demand, registry kontroler. |
| `app/src/player/IframeFallbackPlayer.tsx` | Komponen panel (docked 200x200 / expanded 16:9). |
| `app/src/store/player.ts` | State `fallbackMode` + `fallbackVideoId`. |
| `app/src/player/service.ts` | Masuk/keluar mode, arahkan putar/jeda/cari ke iframe, notifikasi status. |
| `app/src/components/MiniPlayer.tsx` | Titik mount (satu-satunya; dirender di semua rute). |
| `app/src/strings/id.ts` | Semua teks pengguna (bahasa sehari-hari). |

Detail yang sengaja dijaga:

- **API dimuat on-demand.** Script `iframe_api` hanya diunduh saat
  fallback aktif pertama kali — tidak masuk bundle awal, tidak
  dimuat saat app dibuka.
- **Satu instance pemain.** Komponen mount sekali di MiniPlayer;
  pindah rute atau buka/tutup pemutar penuh tidak me-remount
  iframe. Elemen host iframe hanya ada satu dan memakai key
  stabil supaya pergantian wujud docked/expanded tidak
  membuang iframe (remount = lagu mulai dari awal).
- **Tombol app tetap berfungsi.** MiniPlayer/FullPlayer dan
  MediaSession memanggil service seperti biasa; service
  mengarahkan putar/jeda/cari ke kontroler iframe saat mode
  fallback aktif. Tombol putar/jeda di dalam panel fallback
  memanggil service yang sama (satu jalur, bukan dua).
- **Tidak ada angka karangan.** Satu-satunya angka kebijakan
  (200x200) dikutip dari dokumen resmi YouTube di atas.

## Yang belum dikerjakan (tindak lanjut, bukan P3)

- Nonaktifkan tombol EQ/kecepatan/volume di FullPlayer saat mode
  fallback aktif (saat ini tombol-tombol itu tidak berpengaruh
  ke suara iframe — perilaku aman tapi membingungkan).
- E2E Playwright untuk alur masuk/keluar mode fallback
  (butuh jaringan ke YouTube; Vitest menutup logika keputusan).
