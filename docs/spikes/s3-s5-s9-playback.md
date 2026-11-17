# Spike S3, S5, S9: Pemutaran, Web Audio CORS, PWA dan Audio Latar

**Proyek:** Laras Web App Full-Stack, paket P1, Tim Pemutaran (A6, A14, A15, A29)
**Tanggal uji:** 17 November 2026 (21:20-23:00 WIB, tim pertama) +
17-18 November 2026 (22:23 WIB-00:06 WIB, tim lanjutan)
**Lingkungan uji:** VM Linux, Node v24.22.1, Playwright 1.65.1 (dipin),
Chromium 159.0.8154.6 headless, proyek `chromium` (Desktop Chrome) dan
`mobile` (Pixel 7). Tanpa WebKit/Firefox di VM.
**Harness:** `app/tests/e2e/spikes/` (spesifikasi Playwright +
`playwright.spikes.config.ts`, server statis port 5229, halaman
`fixtures/playback.html`, nada WAV kontrol).
**Dokumen acuan:** `docs/arsitektur.md` §3.3, §3.4, §8;
`docs/transfer-ekstraktor.md`.

**Cara membaca vonis:** tiap spike divonis LULUS, GAGAL, atau TIDAK
TERBUKTI DARI VM (bukan vonis produk gagal, melainkan batas alat uji).
Angka yang berasal dari jaringan VM dilabeli eksplisit sebagai angka
VM (egress-bound) dan BUKAN angka perangkat pengguna.

## Ringkasan vonis

| Spike | Vonis | Satu kalimat |
|---|---|---|
| S3 pemutaran `<audio>` + MediaSession | **LULUS SEBAGIAN (mekanisme), TIDAK TERBUKTI DARI VM (jalur langsung + relay penuh)** | Dinding 1 MiB terkonfirmasi; byte Opus asli diputar nyata sampai ct 44,7 detik (769.947 byte ter-decode, 0 error selama buffer tersedia); mekanisme re-resolve + kebijakan jendela terbukti (live + unit 19/19); seek tereksekusi sampai ct=200; ganti sumber terbukti di kedua proyek (lanjut ~3,3 detik sesudah swap); MediaSession didukung; mobile 3 lolos 3 gagal-pola-sama 1 dilewati. Relay penuh terblokir 403 pada semua range non-nol (probe: range 0 206 2/2, range tengah 403 2/2): bukan gagal kode. |
| S5 Web Audio CORS | **LULUS (vonis: CORS TERTUTUP)** | googlevideo tidak mengirim header CORS apa pun; graph `createMediaElementSource` pada sumber lintas origin tanpa CORS terbukti sunyi sementara elemennya memutar. EQ hanya untuk audio lokal/cache; tanpa proxy audio di v1. |
| S9 PWA install + audio latar | **LULUS SEBAGIAN** | Manifest valid, installability tanpa error (CDP), SW + offline lolos, MediaSession lolos. Audio saat tab latar, audio saat layar terkunci, dan seluruh iOS Safari BUTUH TES PERANGKAT NYATA. |

## 0. Resolve: fondasi bersama ketiga spike

Resolve dikerjakan sisi Node (port minimal alur APK: config remote,
visitorData via search, request player dengan sts, pilih itag,
tolak SABR, allowlist host). Direct fetch dari browser ke youtubei
bukan bagian spike ini (itu S2); harness resolve memberi URL stream
kepada uji pemutaran.

Hasil resolve formal (rangkaian `beforeAll` S3, 17 Nov 2026 15:28 UTC,
log `docs/spikes/s3-run-logs/s3-chromium-relay-20261117.log`). Dalam
rangkaian ini `beforeAll` tercatat berjalan dua kali sampai selesai
(sebelum uji 1 dan sebelum uji 2), sehingga tiap lagu ter-resolve dua
kali; kedua ronde dicatat. Perilaku ini terverifikasi eksperimen:
Playwright 1.65.1 menjalankan ulang `beforeAll` sesudah tiap uji yang
gagal (uji 1 gagal, uji 2 lolos, uji 3 lolos -> `beforeAll` berjalan
2x, bukan 1x atau 3x). Dalam rangkaian 16:05 UTC `beforeAll` berjalan
tiga kali (tiga uji relay semuanya gagal); waktu resolve di sana
3.509-14.797 ms per lagu. Semua percobaan WEB_REMIX dan MWEB memberi
itag 251 cipher (butuh solver S4); ANDROID_VR memberi URL langsung di
semua lagu.

| Lagu kanari | Client berhasil | Itag | Waktu resolve ronde 1 | Waktu resolve ronde 2 |
|---|---|---|---|---|
| hhn-nGSuenM "Semua Tentang Kita" (268 dtk) | ANDROID_VR | 251 | 32.444 ms | 15.975 ms |
| qkC4waEZVt4 "Rahasia Hati" (251 dtk) | ANDROID_VR | 251 | 39.404 ms | 10.109 ms |
| k2XdBPv0D3Y "Surat Cinta Untuk Starla" (308 dtk) | ANDROID_VR | 251 | 36.767 ms | 14.361 ms |
| NL8WUtq_NDY "Ya Sudahlah" (254 dtk) | ANDROID_VR | 251 | 37.427 ms | 19.237 ms |
| YsGwU8vTRsE "Tak Ingin Usai" (278 dtk) | ANDROID_VR | 251 | 30.429 ms | 16.866 ms |

Hasil probe awal (sebelum rangkaian formal, angka VM):

- Config remote: HTTP 200, 869 byte, 10.680 ms dan 12.119 ms (dua
  pengukuran). Hash: ad8d59ae (sts 20768), b559f50c (sts 20770),
  fad7e4e9 (sts 20767).
- Search/visitorData: HTTP 200, 11.441 ms, visitorData ada (48 karakter).
- WEB_REMIX: playability OK, 2.993 ms, 4 format audio (140, 249, 250,
  251), SEMUANYA cipher (butuh solver S4), tanpa format SABR.
- ANDROID_VR: 5/5 playability OK, itag 251 URL langsung. Waktu player
  POST: 3.735, 2.458, 3.768, 3.281, 5.021 ms (median 3.735 ms, angka VM).
- Total byte itag 251 per lagu (dari Content-Range): "Semua Tentang
  Kita" 4.808.098 byte, "Rahasia Hati" 4.198.956 byte, "Ya Sudahlah"
  3.770.415 byte.

Implikasi: S3 berjalan lewat ANDROID_VR (satu-satunya client tanpa
solver). WEB_REMIX/MWEB menunggu S4; itu bukan kegagalan S3.

## S3. Pemutaran `<audio>` dari URL googlevideo + MediaSession

### S3.1 Jalur langsung dari VM: GAGAL KARENA JARINGAN (bukan kode)

Empat lapis bukti, semuanya diukur 17 Nov 2026:

1. **Probe Range sisi Node (URL segar, belum pernah dipakai):**
   `Range: bytes=0-999` menjadi 206 + 1.000 byte audio asli
   (`audio/webm`, head `1a45dfa3` EBML); `bytes=0-65535` menjadi 206 +
   65.536 byte; `bytes=0-262143` menjadi 206 + 262.144 byte;
   `bytes=0-524287` (512 KiB) menjadi 206; `bytes=0-786431` (768 KiB)
   menjadi 206. Sebaliknya `bytes=0-` (terbuka, persis yang dikirim
   Chromium) menjadi 403, 0 byte (16.753 ms); `bytes=0-1048575`
   (1 MiB pas) menjadi 403, 0 byte (19.288 ms); tanpa Range menjadi
   403, 0 byte (6.425 ms). Batas 206-vs-403 terletak di antara
   768 KiB dan 1 MiB.
2. **Dinding 1 MiB per URL (terkonfirmasi):** tiga jendela 512 KiB
   berurutan dari SATU URL segar: jendela 1 dan 2 menjadi 206 (total
   tepat 1.048.576 byte), jendela 3 menjadi 403, 0 byte. Pola ini
   sama persis dengan temuan APK P1.
3. **Perilaku browser:** Chromium mengirim `Range: bytes=0-` terbuka
   untuk `<audio>`. Dari VM, request itu gagal di terowongan proxy
   (`net::ERR_TUNNEL_CONNECTION_FAILED`, 7.234 ms, nol respons HTTP)
   pada dua percobaan dengan URL segar yang berbeda. `play()`
   ditolak `NotSupportedError`, error media kode 4, 0 byte ter-decode.
   Kalaupun terowongan lolos, Range terbuka dibalas 403 oleh
   googlevideo (bukti lapis 1), jadi `<audio>` langsung tidak mungkin
   berbunyi dari IP VM ini lewat cara apa pun.
4. **Kontrol positif (mekanisme pemutar sehat):** file WAV lokal yang
   sama persis jalurnya (elemen, `play()`, event) diputar sampai
   habis: `loadedmetadata`, `loadeddata`, `canplay`, `playing`,
   `ended`, error 0. Nada lokal 10 detik diputar sampai habis
   (diukur ulang tim lanjutan di rangkaian mobile,
   log `s3-mobile-4-20261117.log`). Kegagalan googlevideo adalah
   kegagalan jaringan VM, bukan kegagalan kode pemutar.

   Koreksi koordinator (17 Nov 2026): angka lama di butir ini
   (`currentTime` 2,00/2,00 detik, 32.000 byte ter-decode) tidak
   bisa diverifikasi — tidak ada berkas nada 2 detik di fixtures
   (yang ada tone-10s dan tone-60s) dan log aslinya hilang saat
   restart VM. Klaim substantifnya (kontrol lokal diputar sampai
   habis) BENAR dan terbukti ulang dengan nada 10 detik.

### S3.2 Byte Opus asli diputar: relay uji (bukti lapis kedua)

Karena jalur langsung tidak bisa diuji dari VM, harness memakai relay
Range sisi Node (`relay.ts`, HANYA alat uji, DILARANG masuk aplikasi:
arsitektur §9 melarang proxy audio untuk streaming di v1). Relay
mengambil byte dari googlevideo lewat request Range kecil (yang
terbukti 206), melayani browser lewat `page.route`, dan me-resolve
URL segar tiap ~1 MiB (mekanisme re-resolve tengah lagu §3.3).
Byte yang sampai ke `<audio>` adalah byte Opus ASLI lagu kanari.

### S3.2.1 Rangkaian pertama (tim Pemutaran pertama, 15:00-15:18 UTC)

Ketiga uji relay (90 detik, lagu penuh, seek) TIMEOUT pada sampling
(bukti: `error-context.md` ketiga uji, `expect(timedOut).toBe(false)`
menerima `true`). Log jalan rangkaian ini hilang saat VM restart
15:18-15:21 UTC. Menurut diagnosis tim pertama, akar masalahnya adalah
403 non-deterministik googlevideo yang memaksa jendela relay menyusut
ke 192 KiB, sehingga throughput jatuh di bawah kecepatan konsumsi
audio dan pemutaran kehabisan buffer. Uji keempat rangkaian itu (ganti
sumber) terbunuh di tengah jalan oleh restart yang sama (error-context
hanya berisi "browser has been closed").

### S3.2.2 Perbaikan relay (tim Pemutaran lanjutan)

Dua perbaikan diimplementasikan di `relay.ts` sesudah rangkaian
pertama, ditambah fail-fast di `helpers.ts`:

1. **Coba URL segar dengan jendela sama dulu.** Bila upstream 403,
   relay me-resolve URL segar dan mencoba lagi dengan ukuran jendela
   YANG SAMA (403 non-deterministik sering spesifik per URL, bukan
   per ukuran). Jendela baru dipotong setengah bila URL segar itu juga
   403. Sesudah 2 sukses beruntun, jendela dikembalikan ke 768 KiB.
2. **Kegagalan re-resolve dicoba ulang.** Rangkaian lanjutan menemukan
   bug kedua: re-resolve anggaran berada DI LUAR blok try, sehingga
   satu player POST timeout 60 detik langsung membunuh jendela tanpa
   percobaan ulang dan tanpa catatan kegagalan. Re-resolve kini berada
   di dalam try, dan re-resolve di dalam catch yang gagal dicatat
   tanpa melempar (percobaan berikut mencoba lagi).
3. **Fail-fast pada sampling S3.** Bila elemen audio mencatat error
   media (`err !== 0`), sampling berhenti segera (`failedFast=true`)
   alih-alih membakar seluruh timeout. Dipasang di semua sampling S3
   kecuali uji jalur langsung (yang memang mengharapkan error).

Verifikasi deterministik (mock fetch, tanpa jaringan):
`docs/spikes/s3-run-logs/relay-policy-check.mjs`, 19/19 asersi lolos
(log `relay-policy-check.log`): jendela tetap 768 KiB sesudah 403
sekali; dipotong ke 393.216 sesudah 403 dua kali lalu dikembalikan ke
786.432 sesudah 2 sukses beruntun; gagal 3x melempar; re-resolve yang
sempat gagal lalu sukses tetap melayani jendela ke-2; re-resolve yang
selalu gagal tidak lolos tanpa kendali.

### S3.2.3 Rangkaian lanjutan (chromium, 15:28-15:42 UTC)

Log lengkap: `docs/spikes/s3-run-logs/s3-chromium-relay-20261117.log`.
Ketiga uji relay GAGAL lagi, tetapi dengan bukti yang jauh lebih
lengkap dan akar yang berbeda dari diagnosis awal: bukan lagi soal
ukuran jendela, melainkan 403 pada URL segar di SEMUA ukuran jendela
dan throughput upstream 206 yang sudah di bawah konsumsi audio.

**Uji 90 detik via relay ("Rahasia Hati"):**

| Ukuran | Nilai |
|---|---|
| Bunyi pertama (decoded > 0) | 53.954 ms sesudah `load()` |
| Jendela pertama | 786.432 byte, HTTP 206 |
| Pemutaran nyata | ct 0,13 ke 44,694 detik; decoded 7.720 ke 769.947 byte; `bufferedEnd` 46,97; err 0 |
| Stall | ct membeku di 44,694 selama ~190 detik (19 sampel x 10 detik) menunggu jendela ke-2 |
| Jendela ke-2 (start 786432) | Percobaan 1: 768 KiB, URL segar (re-resolve 12.568 ms) -> 403 (55.331 ms). Percobaan 2: 768 KiB SAMA, URL segar (re-resolve 34.794 ms) -> 403. Percobaan 3: 384 KiB, URL segar (re-resolve 15.321 ms) -> 403 (54.074 ms) |
| Akhir | Route 502 -> error media kode 2 -> fail-fast di ct=44,773 |
| Statistik relay | upstream fetch=4 (232.884 ms, 786.432 byte); dilayani=1 req; re-resolve=3; adaptasi=[potong ke 393.216]; gagal=3 |
| Durasi uji | 5,1 menit |

Kebijakan baru TERBUKTI berjalan sesuai rancangan (percobaan 2 memakai
jendela sama 768 KiB dengan URL segar; pemotongan baru terjadi di
percobaan 3), tetapi ketiga URL segar 403 di semua ukuran jendela.

**Uji lagu penuh via relay ("Rahasia Hati", 1x):**

| Ukuran | Nilai |
|---|---|
| Jendela pertama | 786.432 byte, HTTP 206, upstream 113.118 ms |
| Pemutaran nyata | ct 0,019 ke 44,773 detik; decoded 5.190 ke 769.947 byte; `bufferedEnd` 46,97; err 0 |
| Jendela ke-2 | Re-resolve anggaran TIMEOUT (player POST 60 detik) -> bug re-resolve di luar try -> route TimeoutError -> error media kode 2 -> fail-fast di ct=44,773 |
| Statistik relay | upstream fetch=1 (113.118 ms, 786.432 byte); dilayani=1 req; re-resolve=0; gagal=0 (kegagalan re-resolve tidak tercatat karena di luar try: itulah bukti bugnya) |
| Durasi uji | 3,0 menit |

Bug ini sudah diperbaiki sesudah rangkaian (lihat §S3.2.2 butir 2)
dan terverifikasi unit 19/19; perbaikan kemudian TERBUKTI LIVE di
rangkaian 16:05 UTC (uji 90 detik: percobaan jendela 0 pertama timeout
jaringan, lalu re-resolve `HTTP-jaringan` 39.561 ms + percobaan ke-2
jendela sama berhasil 206; lihat §S3.2.4).

**Uji seek via relay ("Semua Tentang Kita"):**

Gagal SEBELUM pemutaran, dan kegagalannya BUKAN di badan uji melainkan
di `beforeAll` ke-3: `TimeoutError` (durasi dilaporkan 0 ms, waktu
dinding ~95 detik), tanpa baris `resolver siap` dan tanpa satu pun
resolve tercatat sebelum uji ini. Buktinya: `beforeAll` terbukti
berjalan ulang sesudah tiap uji yang gagal (lihat §0), sehingga
`beforeAll` ke-3 PASTI dimulai sesudah uji lagu penuh gagal; karena
tidak ada log resolve sama sekali, kegagalan terjadi di dalam
`createResolver` sebelum `resolver siap`, dan satu-satunya
`AbortSignal.timeout` di jalur itu adalah `fetchPlayerConfig` (30
detik; `fetchVisitorData` ditangkap dan tidak pernah melempar).
Diagnosis: config remote tidak bisa diambil karena egress mulai
sekarat menjelang mati total 15:42 UTC. Seek TIDAK TERUJI dalam
rangkaian ini (tidak ada byte yang diputar).

**Hitungan throughput rangkaian ini (angka eksak dari log, angka VM):**

- Kecepatan konsumsi audio itag 251: 786.432 byte / 46,97 detik buffer
  = 16.743 byte/detik (sekitar 134 kbps, terukur).
- Throughput upstream fetch 206 yang sukses (uji lagu penuh):
  786.432 byte / 113,118 detik = 6.952 byte/detik (sekitar 55 kbps).
- Rasio: 6.952 / 16.743 = 0,415. Pada rangkaian ini upstream hanya
  memasok 41,5 persen dari kecepatan konsumsi, sehingga buffer tetap
  terkuras bahkan tanpa 403 sama sekali. Angka ini KHAS rangkaian
  15:28 UTC (egress sedang memburuk menjelang mati total); rangkaian
  16:05 UTC menunjukkan fetch 206 yang jauh lebih cepat (lihat
  §S3.2.4). Throughput upstream dari VM BERVARIASI antar rangkaian;
  kendala yang konsisten di semua rangkaian adalah 403 pada range
  non-nol (lihat §S3.2.4-§S3.2.5).

### S3.2.4 Rangkaian ulang pasca-pulih (chromium, 16:05-16:16 UTC)

Egress pulih 16:04 UTC (google.com HTTP 200 dalam 9,5 detik, config
HTTP 200 dalam 13,6 detik). Rangkaian ini memakai relay yang SUDAH
diperbaiki (kebijakan jendela baru + retry re-resolve). Log lengkap:
`docs/spikes/s3-run-logs/s3-chromium-relay-3-20261117.log`. Ketiga uji
relay GAGAL lagi, dengan pola yang kini konsisten dan terukur: 403
mengenai SEMUA range yang tidak mulai dari 0.

**Uji 90 detik via relay ("Rahasia Hati"):**

| Ukuran | Nilai |
|---|---|
| Bunyi pertama (decoded > 0) | 164.471 ms. Sebab: percobaan jendela 0 pertama TIMEOUT jaringan (~120 detik) -> re-resolve `HTTP-jaringan` 39.561 ms -> percobaan ke-2 (jendela SAMA, URL segar) 206. Ini BUKTI LIVE perbaikan retry re-resolve bekerja (skenario unit S4, kini terbukti live) |
| Pemutaran nyata | ct 0,014 ke 34,731 detik; decoded 5.933 ke 606.303 byte; `bufferedEnd` 46,97; err 0 |
| Jendela ke-2 (start 786432) | 3x 403 CEPAT (15.011 ms, lalu 6.771 ms pada percobaan ke-3): 768 KiB URL segar, 768 KiB SAMA URL segar, 384 KiB URL segar |
| Akhir | Route 502 -> error media kode 2 -> fail-fast di ct=34,731 (lebih awal dari 44,7 karena 403 datang cepat dan Chromium meminta range berikut lebih dini) |
| Statistik relay | upstream fetch=4 (28.087 ms, 786.432 byte); dilayani=1 req; re-resolve=4 [HTTP-jaringan 39.561 ms; anggaran 3.473 ms; HTTP-403 1.763 ms; HTTP-403 8.616 ms]; adaptasi=[potong ke 393.216]; gagal=4 |
| Durasi uji | 3,4 menit |

**Uji lagu penuh via relay ("Rahasia Hati", 1x):**

| Ukuran | Nilai |
|---|---|
| Pemutaran nyata | ct 0,013 ke 44,795 detik; decoded 5.190 ke 769.947 byte; `bufferedEnd` 46,97; err 0 |
| Jendela ke-2 (start 786432) | 3x 403 (15.239 ms, lalu 12.336 ms pada percobaan ke-3) |
| Akhir | Route 502 -> error media kode 2 -> fail-fast di ct=44,795 |
| Statistik relay | upstream fetch=4 (66.210 ms, 786.432 byte); dilayani=1 req; re-resolve=3 [anggaran 1.924 ms; HTTP-403 8.090 ms; HTTP-403 5.075 ms]; adaptasi=[potong ke 393.216]; gagal=3 |
| Durasi uji | 1,5 menit |

**Uji seek via relay ("Semua Tentang Kita"):**

| Ukuran | Nilai |
|---|---|
| Seek tereksekusi | Mencapai ct=5,425 lalu seek ke 200 detik (posisi tercatat ct=200) |
| Sesudah seek | ct membeku di 200 selama ~165 detik (33 sampel x 5 detik); decoded membeku 107.179 byte; `bufferedEnd` 43,91; err 0 |
| Jendela ke-2 (786432) | 3x 403 (terakhir 21.269 ms) |
| Jendela ke-3 prefetch (1572864) | 403 (19.704 ms, memicu potong jendela ke 196.608) |
| Jendela target seek (3407872, byte untuk ~200 detik) | 3x 403 (terakhir 4.219 ms, jendela 131.072 = MIN_WINDOW) -> route 502 -> error media kode 2 -> fail-fast di ct=200 |
| Statistik relay | upstream fetch=10 (140.914 ms, 786.432 byte); dilayani=1 req; re-resolve=7; adaptasi=[potong 393.216; potong 196.608; potong 131.072]; gagal=9 |
| Durasi uji | 3,2 menit |

**Throughput rangkaian ini (batas bawah eksak):** total 4 fetch
upstream uji 90 detik = 28.087 ms, termasuk dua 403 terukur (15.011 ms
dan 6.771 ms). Fetch 206 jendela 0 memakan waktu kurang dari 28.087 -
15.011 - 6.771 = 6.305 ms (karena percobaan 403 ke-2 memakan waktu
lebih dari 0), sehingga throughputnya LEBIH dari 786.432 / 6,305 =
124.730 byte/detik, sekitar 7,4x kecepatan konsumsi (16.743
byte/detik). Berbeda dengan rangkaian 15:28 UTC, throughput BUKAN
kendala di sini: kendala tunggal yang konsisten adalah 403 pada semua
range non-nol (786432, 1572864, 3407872), sementara range 0 selalu 206
di semua rangkaian.

### S3.2.5 Probe diagnostik 403 (16:18-16:24 UTC)

Probe Node sisi server (`s3-403-probe.mjs`, log `s3-403-probe.log`)
menguji tiga hipotesis atas 403: sensitif terhadap awal range, acak
per URL, atau memburuk seiring waktu.

| Langkah | Hasil |
|---|---|
| URL1 segar, range 0-786431 | HTTP 206, 786.432 byte, 41.152 ms |
| URL2 segar, range 786432-1572863 | HTTP 403, 0 byte, 28.763 ms |
| URL3 segar, range 0-786431 | HTTP 206, 786.432 byte, 58.937 ms |
| URL4 segar, range 786432-1572863 | HTTP 403, 0 byte, 52.780 ms |
| URL1 dipakai ulang, range 786432-1310719 | TIMEOUT 120.018 ms (bukan 403, bukan 206: tidak meyakinkan) |

Kesimpulan probe ronde 1: pola "URL segar + range tengah pertama =
403" terkonfirmasi 2/2, dan "URL segar + range 0 = 206" terkonfirmasi
2/2. Hipotesis pemanasan (URL yang sudah melayani range 0 lalu
melayani range tengah) TIDAK TERBUKTI ronde ini karena langkah
penentunya timeout, bukan 403 dan bukan 206.

**Probe ronde 2 (17:05-17:06 UTC, log `s3-403-probe2.log`):
pemanasan TERBANTAH:**

| Langkah | Hasil |
|---|---|
| URL5 segar, pemanasan range 0-999 | HTTP 206, 1.000 byte, 18.872 ms |
| URL5 yang sama, range tengah 786432-1310719 | HTTP 403, 0 byte, 7.527 ms |
| URL6 segar, range 0-786431 | HTTP 206, 786.432 byte, 20.985 ms |
| URL6 yang sama, range tengah 786432-1310719 | HTTP 403, 0 byte, 15.909 ms |

URL yang BARU SAJA melayani range 0 dengan 206 tetap menolak range
tengah dengan 403, baik sesudah pemanasan kecil (1.000 byte) maupun
sesudah range 0 penuh (768 KiB). Hipotesis pemanasan TERBANTAH:
403 range tengah adalah blokir penuh dari IP VM ini, bukan soal
urutan request. Rekap gabungan kedua ronde: range 0 = 206 (4/4);
range tengah pertama = 403 (2/2); range tengah sesudah pemanasan =
403 (2/2) + timeout 1x. **Pemutaran relay penuh dari VM TIDAK MUNGKIN
dengan kebijakan jendela apa pun** selama blokir ini berlaku; tidak
ada jalan relay lagi yang perlu dicoba dari VM. (Catatan: probe
dinding §S3.1 pada ~15:00 UTC masih mendapat 206 untuk jendela ke-2
(512 KiB-1 MiB); pengetatan terjadi antara ~15:18 dan 15:28 UTC.
Bukti dinding 1 MiB tetap sah sebagai hasil ukur 15:00 UTC, tetapi
lingkungan sudah berubah sesudahnya.)

### S3.2.6 Yang terbukti dari relay (bukan dari kegagalannya)

- Byte Opus ASLI lagu kanari diputar nyata sampai ct 44,7 detik di
  enam uji independen (90 detik dan lagu penuh, chromium dua
  rangkaian + mobile), dengan angka decoded yang sama persis
  (769.947 byte) dan 0 error selama buffer tersedia. Rantai decode
  `<audio>` untuk byte Opus YouTube terbukti bekerja.
- Mekanisme re-resolve tengah lagu TERBUKTI di sisi relay: re-resolve
  anggaran 1 MiB berjalan, re-resolve sesudah 403 berjalan, re-resolve
  sesudah kegagalan jaringan berjalan (39.561 ms, live 16:05 UTC),
  dan kebijakan jendela baru berjalan sesuai rancangan (terbukti live
  di semua rangkaian + deterministik 19/19).
- Mekanisme seek TEREKSEKUSI: posisi melompat ke ct=200 dan tercatat
  (rangkaian 16:05 UTC); yang tidak terbukti hanyalah kelanjutan putar
  sesudah seek, karena jendela targetnya 403.
- Ganti sumber di posisi yang sama TERBUKTI di kedua proyek
  (chromium 16:40 UTC, log `s3-chromium-ganti-sumber-2-20261117.log`;
  mobile 17:04 UTC, log `s3-mobile-4-20261117.log`): nada lokal 60
  detik diputar sampai ct=8,21 (chromium) / 8,10 (mobile), lalu src
  diganti (simulasi URL segar hasil re-resolve), kembali ke posisi
  yang sama, dan lanjut bermain di ct=11,34 sesudah 3.291 ms
  (chromium) / ct=11,28 sesudah 3.394 ms (mobile), termasuk muat
  ulang + seek, tanpa error. Ini mekanisme re-resolve sisi browser
  yang dituntut arsitektur §3.3.
- Fail-fast TERBUKTI: semua uji relay yang gagal berhenti segera
  sesudah error media kode 2, dengan statistik relay tercetak lengkap,
  alih-alih membakar timeout sampling 300-600 detik.

### S3.2.7 Egress mati total, dua kali (15:42-16:04 UTC dan 16:26 UTC-)

Rangkaian ulang chromium relay (15:45 UTC) gagal di `beforeAll` dalam
57 detik (`TimeoutError`, tanpa satu pun resolve tercatat; log
`s3-chromium-relay-2-20261117.log`): config remote tidak bisa diambil.
Probe curl langsung membuktikan egress VM mati total pada level
koneksi (bukan hanya googlevideo):

| Waktu (UTC) | Target | Hasil |
|---|---|---|
| 15:47 | raw.githubusercontent.com, youtubei, google.com | HTTP 000, timeout koneksi 20-30 detik (curl 28) |
| 15:52 | google.com | HTTP 000, timeout 15 detik |
| 15:58 | google.com, raw.githubusercontent.com | HTTP 000, timeout 15 detik |

Karena `beforeAll` S3 butuh config + resolve, SELURUH uji S3 (termasuk
yang lokal seperti kontrol nada dan ganti sumber) tidak bisa berjalan
selama egress mati. Egress pulih 16:04 UTC (dipakai rangkaian 16:05
dan probe 16:18), lalu mati lagi ~16:26-16:39 UTC: probe ronde 2 gagal
16:26:35 dan rangkaian ganti sumber chromium gagal 16:27:32, keduanya
timeout `createResolver` 30 detik; probe curl 16:27-16:28 UTC
mengonfirmasi google.com dan config HTTP 000 (timeout koneksi).
Sesudah pulih 16:39 UTC egress masih berflap per menit (google.com
200 sementara config timeout, lalu sebaliknya) sampai ~16:53 UTC,
menggagalkan tiga percobaan mobile di `beforeAll` (16:43, 16:45,
16:47 UTC) sebelum percobaan ke-4 berhasil penuh 16:53-17:04 UTC.

### S3.2.8 Rangkaian mobile penuh (16:53-17:04 UTC)

Tiga percobaan sebelumnya gagal di `beforeAll` (16:43 UTC timeout
config; 16:45 UTC resolve ANDROID_VR ERROR; 16:47 UTC timeout config;
log `s3-mobile-20261117.log`, `s3-mobile-2-20261117.log`,
`s3-mobile-3-20261117.log`). Percobaan ke-4 berhasil penuh. Log:
`docs/spikes/s3-run-logs/s3-mobile-4-20261117.log`. Hasil: **3 lolos,
3 gagal (pola sama persis dengan chromium), 1 dilewati** (10,9 menit).

| Uji mobile | Hasil | Angka |
|---|---|---|
| Dinding 1 MiB | Dilewati | Uji sisi Node, cukup chromium (by design) |
| Jalur langsung | LOLOS (13,3 detik) | `play()` NotSupportedError (6.376 ms); `ERR_TUNNEL_CONNECTION_FAILED`; err 4; decoded 0 |
| Kontrol lokal 10 detik | LOLOS (10,8 detik) | Bunyi pertama 141 ms; decoded akhir 160.000 byte; event lengkap sampai `ended` |
| 90 detik via relay | GAGAL (2,4 menit) | Bunyi pertama 34.937 ms; ct 0,011 ke 44,774; decoded 769.947; jendela ke-2 3x 403 (23.710 ms, lalu 18.596 ms); fail-fast ct=44,774 err 2; upstream fetch=4 (109.337 ms), re-resolve=3, gagal=3 |
| Lagu penuh 2x via relay | GAGAL (1,2 menit) | ct 0,025 ke 44,735 pada 2x (ct maju ~2x waktu dinding); decoded 769.947; jendela ke-2 3x 403 (16.723 ms, lalu 11.839 ms); fail-fast ct=44,735 err 2; upstream fetch=5 (57.673 ms), gagal=4 |
| Seek via relay | GAGAL (1,9 menit) | Mencapai ct=6,025, seek ke 200, macet ~90 detik (decoded membeku 114.727); jendela ke-2 3x 403 (terakhir 14.563 ms); jendela target seek 3407872 3x 403 (terakhir 5.990 ms, 131.072 byte); fail-fast ct=200 err 2; upstream fetch=10 (93.284 ms), re-resolve=7, gagal=9 |
| Ganti sumber | LOLOS (12,2 detik) | Swap di 8,10 detik, lanjut ct=11,28 sesudah 3.394 ms |

Tidak ada perbedaan perilaku antara chromium dan mobile: kegagalan
relay mobile sama persis polanya (403 range non-nol, fail-fast di
ct~44,7 atau ct=200 sesudah seek), dan yang lolos di chromium lolos
juga di mobile (jalur langsung, kontrol lokal, ganti sumber).

### S3.2.9 Hasil jalan S3

| Rangkaian | Hasil |
|---|---|
| Chromium relay, rangkaian pertama (15:00-15:18 UTC) | 0 lolos, 3 timeout (90 detik, lagu penuh, seek); log hilang saat restart VM |
| Chromium relay, rangkaian lanjutan (15:28-15:42 UTC) | 0 lolos, 3 gagal karena jaringan VM (90 detik: 403 x3; lagu penuh: timeout re-resolve; seek: gagal beforeAll ke-3, timeout config) |
| Chromium relay, rangkaian ulang (15:45 UTC) | 1 gagal di beforeAll (egress mati #1), 2 tidak jalan |
| Chromium relay, rangkaian pasca-pulih (16:05-16:16 UTC) | 0 lolos, 3 gagal karena 403 range non-nol (90 detik, lagu penuh, seek); perbaikan retry re-resolve terbukti live |
| Probe diagnostik 403 ronde 1 (16:18-16:24 UTC) | Pola 403 terkonfirmasi (range 0: 206 2/2; range tengah URL segar: 403 2/2); pemanasan tidak meyakinkan (timeout) |
| Probe diagnostik 403 ronde 2 (16:26 UTC) | Gagal jalan (egress mati #2, timeout config) |
| Probe diagnostik 403 ronde 2 (17:05-17:06 UTC) | Pemanasan TERBANTAH (range tengah 403 2/2 walau URL sudah melayani range 0) |
| Chromium ganti sumber (16:26 UTC) | Gagal di beforeAll (egress mati #2) |
| Chromium ganti sumber (16:40-16:43 UTC) | LOLOS (swap di 8,21 detik, lanjut ct 11,34 sesudah 3.291 ms) |
| Mobile penuh, percobaan 1-3 (16:43-16:48 UTC) | Gagal di beforeAll (timeout config 2x, resolve ANDROID_VR ERROR 1x) |
| Mobile penuh, percobaan 4 (16:53-17:04 UTC) | 3 lolos (jalur langsung, kontrol lokal, ganti sumber), 3 gagal pola sama (90 detik, lagu penuh 2x, seek), 1 dilewati (dinding) |

### S3.3 MediaSession

| Butir | Hasil S3 | Keterangan |
|---|---|---|
| `setMediaSession` (judul, artis, album) | Didukung (`supported: true`) | Tercapai di uji 90 detik sesudah bunyi pertama, 15:32 UTC |
| Pembacaan kembali metadata + `playbackState` `'playing'` | TIDAK TERCAPAI di S3 | Pembacaan dijadwalkan sesudah ct 90; pemutaran mati di ct 44,7 karena jaringan (lihat §S3.2.3) |
| Bukti lengkap | Ada di S9 (§S9.1) | Metadata tersetel dan terbaca kembali; `playbackState` `'playing'` saat lagu berbunyi (dengan penyetelan eksplisit); action handler play, pause, previoustrack, nexttrack, seekto terdaftar |
| Pemicuan handler oleh OS | Butuh tes perangkat nyata | Tombol headset/lock screen tidak bisa disimulasikan di VM (lihat §S9.1) |

Temuan implementasi (terukur di S9, berlaku untuk S3): Chromium TIDAK
memperbarui `navigator.mediaSession.playbackState` otomatis dari
elemen media (tetap `'none'` saat lagu berbunyi). App produksi WAJIB
menyetel `playbackState` eksplisit di handler `playing`/`pause`/
`ended`. Harness meniru perilaku itu di `playback.html`.

### S3.4 Vonis S3

**LULUS SEBAGIAN (mekanisme), TIDAK TERBUKTI DARI VM (jalur langsung
dan relay penuh).** Rinciannya:

**Terbukti (mekanisme):**

- Dinding 1 MiB per URL terkonfirmasi (sisi Node, 3 jendela 512 KiB:
  206, 206, 403).
- Jalur langsung `<audio src=googlevideo>` gagal di jaringan VM (bukan
  kode): Range terbuka dibalas 403 oleh googlevideo; browser gagal di
  terowongan proxy (`ERR_TUNNEL_CONNECTION_FAILED`); kontrol nada
  lokal yang sama persis jalurnya diputar sampai habis.
- Byte Opus ASLI lagu kanari diputar nyata sampai ct 44,7 detik di
  enam uji independen (90 detik + lagu penuh, chromium dua rangkaian
  dan mobile; decoded 769.947 byte, 0 error selama buffer tersedia).
  Rantai decode `<audio>` untuk byte Opus YouTube terbukti.
- Mekanisme re-resolve tengah lagu terbukti di sisi relay (re-resolve
  anggaran + re-resolve sesudah 403 + kebijakan jendela baru, live dan
  deterministik 19/19).
- MediaSession: `setMediaSession` didukung (S3); bukti lengkap ada
  di S9.
- Fail-fast sampling terbukti bekerja (uji berhenti segera sesudah
  error media, statistik lengkap tercetak).
- **Ganti sumber:** LOLOS di kedua proyek (chromium 16:40 UTC: swap
  8,21 detik, lanjut ct 11,34 sesudah 3.291 ms; mobile 17:04 UTC:
  swap 8,10 detik, lanjut ct 11,28 sesudah 3.394 ms). Mekanisme
  re-resolve sisi browser terbukti.
- **Proyek mobile:** SELESAI 16:53-17:04 UTC: 3 lolos (jalur langsung,
  kontrol lokal, ganti sumber), 3 gagal dengan pola sama persis
  dengan chromium (90 detik, lagu penuh 2x, seek: 403 range non-nol),
  1 dilewati (dinding, cukup chromium). Tidak ada perbedaan perilaku
  mobile vs chromium.

**Tidak terbukti dari VM (bukan gagal):**

- **Relay penuh** (90 detik, lagu penuh): 403 pada SEMUA range yang
  tidak mulai dari 0 (786432, 1572864, 3407872), di semua ukuran
  jendela (768, 384, 192, 128 KiB), pada URL segar berkali-kali;
  pola ini dikonfirmasi probe diagnostik (range 0: 206 2/2; range
  tengah URL segar: 403 2/2; range tengah sesudah pemanasan: 403
  2/2). Throughput upstream 206 BERVARIASI antar rangkaian (41,5
  persen dari konsumsi pada 15:28 UTC; di atas 7x konsumsi pada
  16:05 UTC), jadi throughput bukan kendala yang konsisten;
  403-lah kendalanya. Hipotesis pemanasan URL TERBANTAH probe ronde
  2, sehingga tidak ada jalan relay lagi dari VM. Egress mati total
  dua kali (15:42-16:04 UTC dan 16:26-16:39 UTC, lalu berflap
  sampai ~16:53 UTC). Semuanya batas lingkungan VM, bukan cacat kode
  relay (kebijakan baru terbukti berjalan sesuai rancangan live dan
  unit 19/19; satu bug relay yang ditemukan di tengah jalan sudah
  diperbaiki dan terbukti live).
- **Jalur langsung** `<audio src=googlevideo>`: tidak bisa diuji dari
  VM karena egress memblokirnya (lihat §S3.1).
- **Seek tengah lagu:** mekanisme seek TEREKSEKUSI (posisi melompat
  ke ct=200 dan tercatat), tetapi kelanjutan putar sesudah seek tidak
  terbukti karena jendela target seek (byte 3407872) 403 tiga kali.
  Bukan gagal mekanisme: utang tes di luar VM.
- **Waktu sampai bunyi pertama di koneksi baik** (target <2 detik,
  arsitektur §3.9): angka VM (53.954 ms, didominasi egress) BUKAN
  angka produk; wajib diukur ulang di perangkat nyata.

**Yang masih butuh uji di luar VM (preview deploy + browser nyata,
IP residensial):** lagu penuh berbunyi tanpa relay (jalur langsung);
seek tengah lagu; ganti sumber dengan URL stream nyata di tengah lagu
(mekanismenya sudah terbukti dengan nada lokal); bunyi pertama
<2 detik; audio latar dan lock screen (lihat §S9.2-S9.3); dan apakah
dinding 1 MiB berlaku di IP residensial (bila berlaku, re-resolve
tengah lagu yang mekanismenya sudah terbukti di sini adalah
kebutuhan).

## S5. Web Audio CORS: vonis CORS TERTUTUP

### S5.1 Bukti (4 lapis, semuanya lolos)

**Lapis 1, header sisi Node** (URL googlevideo segar itag 251):

| Probe | Hasil |
|---|---|
| GET `Range: bytes=0-999` + `Origin: http://localhost:5229` | HTTP 206, 1.000 byte, `Access-Control-Allow-Origin: TIDAK ADA` |
| OPTIONS preflight (`Access-Control-Request-Method: GET`, `Access-Control-Request-Headers: range`) | HTTP 400, `Access-Control-Allow-Origin: TIDAK ADA`, `Access-Control-Allow-Methods: TIDAK ADA` |

googlevideo tidak mengirim header CORS apa pun untuk audio, bahkan
pada respons 206 yang sukses.

**Lapis 2, fetch CORS dari halaman browser:**

| Probe | Hasil |
|---|---|
| `fetch(url googlevideo, {mode: 'cors'})` tanpa Range | Ditolak: `TypeError: Failed to fetch` |
| `fetch(url googlevideo, {mode: 'cors'})` dengan Range | Ditolak: `TypeError: Failed to fetch` |
| `fetch(nada lokal same-origin, {mode: 'cors'})` dengan Range (kontrol) | Lolos: HTTP 206, 1.000 byte |

Kontrol same-origin membuktikan helper deteksi (`probeFetchCors`,
port deteksi runtime §3.4) berfungsi; penolakan googlevideo bukan
cacat helper.

**Lapis 3, kontrol positif graph same-origin** (membuktikan pengukuran
analyser valid sebelum uji penentu):

| Sumber | Analyser (51/31 sampel) | Arti |
|---|---|---|
| Nada lokal 440 Hz, 3 detik | max 255, avg 6,892, bin tak-nol maks 1.024/1.024 | Graph mengeluarkan suara |
| Byte Opus asli via relay same-origin, 5 detik | max 244, avg 13,817, bin tak-nol maks 188/1.024 | Graph mengeluarkan suara |

Konteks audio `running` di kedua kontrol (bukan `suspended`, yang
akan membuat angka nol tidak berarti).

**Lapis 4, uji penentu: graph pada sumber lintas origin tanpa CORS:**

Halaman di `http://localhost:5229`, sumber di `http://127.0.0.1:5229`
(lintas origin), relay TIDAK mengirim header CORS (sama seperti
googlevideo yang terbukti tidak mengirim ACAO). Byte Opus asli lagu
"Rahasia Hati" diputar lewat relay lintas origin.

| Ukuran | Nilai |
|---|---|
| Elemen saat sampling | `currentTime` 0,007 ke 5,075 detik; `decoded` bertambah 99.491 byte selama graph tersambung (audio PASTI mengalir ke elemen) |
| Analyser, 51 sampel selama 5 detik | max 0, avg 0, bin tak-nol maks 0/1.024 |
| Konteks audio | `running` |

Elemen terbukti memutar (decoded bertambah ~100 KB) tetapi graph
mengeluarkan NOL mutlak selama 5 detik penuh. Itulah perilaku sumber
tercemar CORS, terisolasi bersih dari "audio tidak termuat".

### S5.2 Vonis S5: LULUS (CORS TERTUTUP)

- EQ (graph Web Audio) TIDAK BISA dipakai untuk streaming langsung
  googlevideo. Desain §3.4 jalur kedua berlaku: EQ aktif untuk audio
  lokal dan cache (blob same-origin, selalu lolos CORS); untuk
  streaming langsung, pemutar memakai elemen audio tanpa graph dan
  kontrol EQ menampilkan penjelasan jujur.
- Deteksi runtime (§3.4) terbukti bekerja: satu fetch CORS Range
  kecil membedakan same-origin (lolos) dari googlevideo (ditolak).
  App memakai deteksi ini sebelum menyambung graph, dengan hasil
  di-cache per host.
- Tanpa proxy audio di v1 untuk mengejar EQ (keputusan arsitektur
  §3.4 dipertahankan; proxy audio akan menghabiskan kuota dan
  memusatkan beban ke IP datacenter bereputasi buruk).

### S5.3 Hasil jalan

`npx playwright test -c playwright.spikes.config.ts s5-webaudio-cors`:
4 lolos (chromium), 4 dilewati (mobile: mesin Blink sama, cukup
desktop). Durasi 1,7 menit.

## S9. PWA install + audio latar

### S9.1 Yang terbukti di VM

**Manifest valid** (desktop + mobile): `name`, `short_name`,
`start_url` `/`, `display` `standalone`, `theme_color` `#000000`,
`background_color` `#000000`, ikon 192x192 (HTTP 200, 397 byte) dan
512x512 (HTTP 200, 1.393 byte) benar-benar bisa diunduh.

**Installability tanpa error (CDP):** `Page.getInstallabilityErrors`
mengembalikan 0 error di kedua proyek, sesudah Service Worker aktif.
`beforeinstallprompt` TIDAK menyala di headless Chromium (kedua
proyek); itu perilaku headless yang sudah diketahui, bukan bukti
tidak-bisa-diinstal: CDP adalah patokan, dan CDP bersih. Prompt
install sungguhan tetap butuh tes perangkat nyata.

**Service Worker + offline:** SW terdaftar (`scope`
`http://localhost:5229/`, aktif, mengendalikan halaman). Halaman
terverifikasi ada di cache SW (`caches.match` mengembalikan respons),
lalu dimuat dari cache saat offline (`context.setOffline(true)` +
reload: heading tampil, `window.__spike` hidup). Catatan implementasi:
muatan pertama halaman terjadi sebelum SW terdaftar sehingga tidak
masuk cache runtime; uji memuat ulang sekali lewat SW untuk mengisi
cache. Perilaku ini wajar untuk SW P0 (precache shell + runtime cache).

**MediaSession:** metadata (judul, artis, album) tersetel dan terbaca
kembali; `playbackState` `'playing'` saat lagu berbunyi (dengan
penyetelan eksplisit, lihat temuan S3.3). Action handler play, pause,
previoustrack, nexttrack, seekto terdaftar; PEMICUAN handler oleh OS
(tombol headset/lock screen) tidak bisa disimulasikan di VM dan
butuh tes perangkat nyata.

### S9.2 Audio saat tab latar: TIDAK TERBUKTI DI VM (keterbatasan alat)

Temuan lingkungan yang diukur, bukan diasumsikan. Mesin tab-latar
Chromium tidak berfungsi di VM ini (tanpa window manager/compositor).
Yang sudah dicoba, semuanya gagal membentuk kondisi latar:

| Cara | Hasil |
|---|---|
| Ganti tab (`bringToFront`) headless | `visibilityState` tetap `'visible'` |
| Ganti tab headed + Xvfb | `visibilityState` tetap `'visible'`; `hasFocus()` true di kedua tab |
| CDP `Target.activateTarget` (tab sama, windowId sama) | `visibilityState` tetap `'visible'` |
| CDP `Page.setWebLifecycleState` `'hidden'` | Ditolak: `Protocol error: Unidentified lifecycle state` (Chromium 159 hanya menerima `'frozen'` dan `'active'`) |
| CDP `Page.setWebLifecycleState` `'frozen'` | Diterima tetapi `visibilityState` tetap `'visible'` (dan freeze menghentikan halaman, bukan simulasi latar) |
| CDP `Browser.setWindowBounds` `minimized` | `visibilityState` tetap `'visible'` |
| Hapus argumen backgrounding bawaan Playwright (`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`) | `visibilityState` tetap `'visible'` di headless maupun headed |
| Ukur throttling timer (bukti independen): `setInterval` 100 ms sesudah ganti tab, throttling AKTIF | 100 tick per 10 detik, jeda 99-101 ms (latar sejati ~10 tick): TIDAK ADA throttling. Browser tidak menganggap tab itu latar dalam cara apa pun. |

Karena kondisi "latar" tidak pernah terbentuk, audio latar TIDAK BISA
diklaim terbukti dari VM. Uji S9 mencatat keterbatasan ini eksplisit
dan hanya membuktikan audio tetap jalan saat tab lain diaktifkan
(ct 5,44 ke 14,97 detik dalam 10 detik, `decoded` 98.304 ke 249.856,
0 event pause, MediaSession `'playing'`), yang BUKAN bukti latar.
**Audio saat tab latar BUTUH TES PERANGKAT NYATA.**

### S9.3 Yang butuh tes perangkat nyata (tidak diklaim)

- Audio saat tab latar (Android Chrome + desktop Chrome).
- Audio saat layar terkunci + kontrol MediaSession di lock screen
  (Android Chrome dan iOS Safari).
- Instalasi PWA sungguhan + prompt install (Android Chrome).
- Seluruh perilaku iOS Safari: tidak ada WebKit di VM ini, dan
  WebKit desktop bukan iOS Safari. iOS adalah platform paling
  berisiko (kebijakan audio latar Safari, arsitektur §11).

### S9.4 Vonis S9: LULUS SEBAGIAN

Installability, SW/offline, dan MediaSession lolos di desktop +
emulasi HP. Audio latar dan seluruh ranah perangkat nyata berstatus
utang tes, bukan lolos dan bukan gagal.

### S9.5 Hasil jalan

`npx playwright test -c playwright.spikes.config.ts s9-pwa-background`:
8 lolos (4 uji x 2 proyek). Durasi 1,1 menit.

## Batasan dan utang tes

1. **Jalur langsung googlevideo** (S3): butuh uji perangkat nyata
   (IP residensial) untuk membuktikan lagu berbunyi dari `<audio>`
   tanpa relay. VM tidak bisa membuktikannya karena egress.
2. **Waktu sampai bunyi pertama di koneksi baik** (target <2 detik,
   arsitektur §3.9): angka VM (didominasi egress, puluhan detik)
   BUKAN angka produk. Wajib diukur ulang di perangkat nyata.
3. **Dinding 1 MiB di IP residensial** (arsitektur §11): belum
   terbukti apakah berlaku di perangkat pengguna. Bila berlaku,
   re-resolve tengah lagu (§3.3) adalah kebutuhan; mekanismenya
   sudah dibuktikan harness relay.
4. **Audio latar, lock screen, iOS** (S9): butuh tes perangkat nyata
   (lihat §S9.2-S9.3).
5. **WEB_REMIX/MWEB** (S3): menunggu solver S4 untuk format cipher.
   S3 memakai ANDROID_VR (URL langsung).
6. **Prompt install PWA** (S9): `beforeinstallprompt` tidak menyala
   di headless; butuh tes perangkat nyata walau CDP bersih.
7. **Pemanasan URL sebagai jalan relay** (S3): DITUTUP. Probe ronde 2
   (17:05 UTC) membantah hipotesis pemanasan: URL yang baru saja
   melayani range 0 dengan 206 tetap menolak range tengah dengan 403
   (2/2). Tidak ada jalan relay lagi yang perlu dicoba dari VM;
   pemutaran penuh menunggu uji di luar VM (lihat §S3.4).

## Cara menjalankan ulang harness

```sh
cd app
npx playwright test --config=playwright.spikes.config.ts s3-playback
npx playwright test --config=playwright.spikes.config.ts s5-webaudio-cors
npx playwright test --config=playwright.spikes.config.ts s9-pwa-background
```

Server spike (port 5229) dijalankan otomatis oleh Playwright
(`webServer`). Spesifikasi spike MELEWATI dirinya sendiri di bawah
konfigurasi E2E utama (port 4173) mengikuti pola tim S1, sehingga
`npm run test:e2e` tidak terganggu. Jangan jalankan `npm run build`
atau `npm ci` untuk spike ini.

## File deliverable

| File | Isi |
|---|---|
| `app/playwright.spikes.config.ts` | Konfigurasi Playwright khusus S3/S5/S9 (port 5229, 2 proyek) |
| `app/tests/e2e/spikes/canary.ts` | Data kanari + definisi client + allowlist (port APK) |
| `app/tests/e2e/spikes/resolve.ts` | Resolve InnerTube sisi Node (config, visitorData, player, pilih itag) |
| `app/tests/e2e/spikes/relay.ts` | Relay Range googlevideo (alat uji saja) + probe dinding + probe header CORS + kebijakan jendela baru (URL segar ukuran sama dulu, pulih sesudah 2 sukses) + retry re-resolve (lanjutan 17 Nov 2026) |
| `app/tests/e2e/spikes/helpers.ts` | Helper bersama: API halaman spike, route relay, sampling, statistik + fail-fast sampling (lanjutan 17 Nov 2026) |
| `app/tests/e2e/spikes/serve.mjs` | Server statis origin spike (public/ + fixture, dukung Range) |
| `app/tests/e2e/spikes/fixtures/playback.html` | Halaman harness (elemen audio, MediaSession, graph, probe CORS, SW) |
| `app/tests/e2e/spikes/fixtures/generate-tones.mjs` | Generator nada WAV kontrol |
| `app/tests/e2e/spikes/fixtures/tone-10s.wav` | Nada 440 Hz 10 detik (160.044 byte) |
| `app/tests/e2e/spikes/fixtures/tone-60s.wav` | Nada 440 Hz 60 detik (960.044 byte) |
| `app/tests/e2e/spikes/s3-playback.spec.ts` | Spesifikasi S3 (7 uji; lanjutan 17 Nov 2026: fail-fast di semua sampling kecuali jalur langsung) |
| `docs/spikes/s3-run-logs/` | Log rangkaian S3 lanjutan: relay chromium (`s3-chromium-relay-20261117.log`, `s3-chromium-relay-2-20261117.log`, `s3-chromium-relay-3-20261117.log`), ganti sumber chromium (`s3-chromium-ganti-sumber-20261117.log`, `s3-chromium-ganti-sumber-2-20261117.log`), mobile penuh (`s3-mobile-20261117.log`, `s3-mobile-2-20261117.log`, `s3-mobile-3-20261117.log`, `s3-mobile-4-20261117.log`), uji kebijakan relay (`relay-policy-check.mjs`, 19/19 lolos, `relay-policy-check.log`, `relay.bundle.mjs`), probe diagnostik 403 ronde 1+2 (`s3-403-probe.mjs`, `s3-403-probe.log`, `s3-403-probe2.mjs`, `s3-403-probe2.log`, `resolve.bundle.mjs`) |
| `app/tests/e2e/spikes/s5-webaudio-cors.spec.ts` | Spesifikasi S5 (4 uji) |
| `app/tests/e2e/spikes/s9-pwa-background.spec.ts` | Spesifikasi S9 (4 uji) |
| `docs/spikes/s3-s5-s9-playback.md` | Laporan ini |

## Catatan keamanan dan privasi

- URL stream TIDAK PERNAH dicetak ke log uji, laporan ini, atau file
  apa pun (aturan PRD B2.1). Log hanya mencatat host tersamar
  (`*.googlevideo.com`), itag, dan panjang URL.
- Kunci API InnerTube yang dipakai adalah kunci PUBLIK yang tertanam
  di halaman youtube.com (keputusan K-F2-10 APK), bukan secret.
- Relay hanya hidup di dalam proses uji dan tidak pernah masuk ke
  aplikasi. Nada WAV adalah sinus hasil generator, tanpa konten
  berhak cipta.
