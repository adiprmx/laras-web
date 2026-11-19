# Tangga Retry Lebih Panjang — Hotfix Resolve

**Tanggal:** 19 November 2026.
**Tim:** hotfix resolve (tangga retry).
**Dokumen acuan:** `docs/p6-resilience.md` §1.1 (retry P6),
`docs/spikes/egress-dan-opsi-resolve.md` §5-§7 (bukti
LOGIN_REQUIRED + rekomendasi Opsi 1),
`hidden_files/koordinator/log.md` §5 + P6.
**Status:** selesai di workdir, TANPA push/deploy (koordinator
yang memverifikasi, push, dan deploy).
**Remote HEAD saat dikerjakan:** `b5edcf7e` (Blue 5).

## 1. Masalah

Uji §5 19 Nov 2026 15:50 WIB: **0/5 TOTAL** — ketiga client
(WEB_REMIX, MWEB, ANDROID_VR) x 3 putaran retry P6 =
LOGIN_REQUIRED ("Sign in to confirm you're not a bot") untuk
kelima lagu. Uji ulang 15:57 WIB identik 0/5: jendela buruk
persisten 15:50-15:59 WIB (10+ menit). Proxy sendiri SEHAT
(yang menolak adalah YouTube, terhadap IP egress Worker).

Retry P6 (3 putaran, backoff 5 dtk + 15 dtk, maks 9 request/
lagu, total ~20 dtk) TERLALU PENDEK untuk jendela buruk 10+
menit. Lagu gagal dalam ~20 detik, pemutar langsung pindah ke
lagu berikut (yang juga gagal), dan pengguna tidak pernah
melihat jendela berbalik.

## 2. Desain tangga

### 2.1 Tangga penuh per lagu

```
putaran 1 (tangga cepat P6) ── +5 dtk ──► putaran 2
── +15 dtk ──► putaran 3 ── +60 dtk ──► putaran latar 1
── +5 mnt ──► putaran latar 2 ──► habis (pesan akhir)
```

- **Tangga cepat (P6, tidak diubah):** 3 putaran, backoff 5 dtk
  + 15 dtk, di dalam satu panggilan `StreamResolver.resolve()`.
- **Tangga latar (BARU, di `PlayerService`):** 2 putaran lagi,
  jeda 60 dtk lalu 5 menit, masing-masing satu putaran resolve
  (`maxRounds: 1`).
- **Total jendela mencoba:** 380 dtk jeda (~6,3 menit) + waktu
  resolve tiap putaran — bukan ~20 detik.
- **Total request maks per lagu:** 15 (5 putaran x 3 client),
  tersebar dalam ~7 menit: 9 di ~20 detik pertama, lalu 3/menit.
  Jauh di bawah rate limit proxy 60/menit di setiap menitnya.

### 2.2 Alasan angka

- **60 dtk:** menangkap jendela buruk PENDEK. Bukti §5:
  WEB_REMIX buruk 08:00 WIB, lolos 08:05 WIB — penanda berbalik
  per client x waktu dalam hitungan menit. Percobaan di +60 dtk
  murah (3 request) dan memberi peluang lolos tanpa menunggu
  lama.
- **5 menit:** menangkap jendela MENENGAH (bukti §5 yang sama:
  berbalik dalam ~5 menit). Sesudah +5 menit, peluang lolos
  tambahan mengecil sementara penantian pengguna membesar.
- **Berhenti di 2 langkah latar:** langkah ketiga (+10 mnt)
  hanya menambah penantian dengan peluang lolos yang makin
  kecil; pengguna selalu bisa menekan "Coba lagi" atau skip
  kapan saja. Tangga adalah jembatan, bukan penantian tanpa
  ujung.
- **Tidak menaikkan request/putaran:** tiap putaran tetap
  mencoba client sesuai urutan config (maks 3 request).
  Hemat kuota proxy adalah syarat desain, bukan efek samping.

### 2.3 Mayoritas LOGIN_REQUIRED (Blue 7, R21)

Tangga latar mulai (dan lanjut) bila MAYORITAS upaya tercatat
adalah `=LOGIN_REQUIRED` (>50% dari `allAttempts`), tanpa satu
pun upaya `=OK` (`isLoginRequiredOnly`, modul
`resilience/retryLadder.ts`):

- Satu upaya `UNPLAYABLE` tidak lagi membatalkan tangga:
  UNPLAYABLE dihitung sebagai penolakan (konsisten dengan
  `isRefusalPlayability`), dan pola campuran LOGIN_REQUIRED +
  UNPLAYABLE TERBUKTI NYATA di jendela buruk (probe parent
  19 Nov 2026 15:57 WIB: WEB_REMIX=UNPLAYABLE +
  ANDROID_VR=LOGIN_REQUIRED pada video kanari yang diketahui
  bagus; Red 7 R21).
- Lagu semua-UNPLAYABLE (0 LOGIN_REQUIRED) tetap gagal cepat —
  tidak ada tangga latar.
- Satu saja upaya `OK` berarti setidaknya satu client lolos
  bot-check — bukan jendela buruk, jadi tangga tidak jalan.
- `proxy-gagal`, `jaringan-gagal`, `solver-gagal`: tidak
  menghalangi bila mayoritas tetap LOGIN_REQUIRED.
- Percobaan latar yang membuat mayoritas hilang (mis. proxy
  mati di tengah tangga sehingga LOGIN_REQUIRED tidak lagi
  mayoritas): tangga BERHENTI (`failCurrentTrack` dengan
  pesan klasifikasi).

Riwayat: aturan awal hotfix mensyaratkan SEMUA upaya
`=LOGIN_REQUIRED`. Aturan itu dilonggarkan ke mayoritas oleh
Blue 7 (Red 7 R21, keputusan parent 19 Nov 2026 18:43 WIB)
karena pola campuran terbukti nyata dan tiga lapis kode lain
(retry cepat P6, klasifikasi `errors.ts`, sinyal kanari)
sama-sama mendefinisikan "penolakan" lebih longgar dari
tangga. Biaya pelonggaran terbatas: video campuran yang
ternyata permanen hanya menelan maks 6 request tambahan +
penantian maks ~7 menit yang bisa di-skip kapan saja.

### 2.4 Di mana tangga hidup

Tangga latar hidup di `PlayerService`, BUKAN di dalam
`StreamResolver.resolve()`. Alasan: `resolveWithTimeout`
membatasi satu resolve sampai 90 detik — jeda 60 dtk + 5 mnt
tidak muat di dalam satu panggilan resolve. Resolver tidak
diubah sama sekali (tangga cepat P6 + `maxRounds` injeksi
sudah cukup); service yang menjadwalkan percobaan latar
sebagai panggilan `resolve()` baru dengan `maxRounds: 1`.

## 3. Perilaku pemutar

### 3.1 Per state

| State | Yang dilihat pengguna |
|---|---|
| Tangga cepat berjalan (0-20 dtk) | Status `loading`, notice "Mencari jalur lain untuk lagu ini." (P6, tidak berubah) |
| Tangga latar berjalan | Status `loading`, notice **"YouTube sedang membatasi, mencoba lagi otomatis."** Lagu tetap di antrean sebagai lagu saat ini. Tombol skip/next tetap aktif. |
| Percobaan latar lolos | Lagu langsung diputar dari awal; notice hilang; status `playing`. |
| Tangga habis | Status `error`, pesan akhir **"YouTube masih membatasi. Coba lagi nanti."** + tombol "Coba lagi". TIDAK pindah otomatis ke lagu berikut (lihat §3.2). |
| Bukan LOGIN_REQUIRED | Perilaku lama persis (klasifikasi P6 + `failCurrentTrack`). |

Tidak ada status pemutar baru: `loading` + notice jujur sudah
menggambarkan keadaan dengan tepat (pemutar memang masih
memuat lagu itu), dan menambah nilai status baru akan
merembet ke semua komponen UI + persist + tes tanpa manfaat
bagi pengguna.

### 3.2 Mengapa tangga habis TIDAK pindah lagu

Selama jendela buruk SEMUA lagu gagal. Pindah otomatis hanya
membakar antrean (tiap lagu menelan ~7 menit tangga sebelum
gagal) dan menyembunyikan pesan akhir. Berhenti di lagu ini
dengan pesan jujur menghormati perhatian pengguna: dia bisa
menekan "Coba lagi" (resolve segar dari awal) atau skip
sendiri ke lagu berikut (yang menjalankan tangganya sendiri).

### 3.3 Kapan retry berhenti

- Lagu berhasil (percobaan latar lolos).
- Pengguna skip / prev / pilih lagu lain / hapus lagu saat ini
  dari antrean (semua lewat `loadTrack`, yang membatalkan
  tangga + menaikkan `playToken`).
- Pengguna menjeda (tangga dibatalkan supaya lagu tidak mulai
  sendiri sesudah dijeda; berlaku juga untuk timer tidur).
- Pengguna menjeda SELAMA tangga cepat berjalan: tangga latar
  tidak pernah mulai (guard di `onResolveFailed`); perilaku
  lama yang berlaku.
- Pengguna menutup pemutar total / hapus data (`stopPlayback`,
  `stopForWipe`).
- Percobaan latar gagal bukan LOGIN_REQUIRED.
- Tangga habis (pesan akhir, §3.1).

Tangga hanya hidup di memori (tidak dipersist): reload halaman
menghentikan tangga; pengguna menekan putar untuk memulai lagi.
Mempersist retry lintas reload akan mengejutkan pengguna dan
merumitkan restore antrean.

### 3.4 Tab latar: tenggat, bukan setTimeout

Browser me-throttle `setTimeout` di tab tersembunyi (~1/menit),
jadi tangga 5 menit TIDAK BOLEH mengandalkan timer presisi.
Tiap langkah menyimpan **tenggat stempel waktu**
(`nextAttemptAt`, epoch ms), dicek dari TIGA pemicu:

1. `setTimeout` untuk tenggat berikut (pemicu cepat saat tab
   terlihat),
2. watchdog service tiap 1 detik (`checkBackgroundRetry`),
3. `visibilitychange` saat tab kembali terlihat.

Tenggat yang sudah lewat berarti "coba SEKARANG" — percobaan
jalan segera saat tab kembali, walau timer tertahan berjam-jam.
Logika tenggatnya murni (`resilience/retryLadder.ts`: tanpa DOM,
tanpa timer), jadi mudah dites dengan jam palsu.

## 4. Sinyal kesehatan kanari

Kanari P6 sudah berjalan harian (5 lagu, resolve-only, hasil di
app_meta `p6.canary.last`). Hotfix ini mengeksposnya sebagai
sinyal yang bisa dibaca pemutar (`canaryHealthSignal` di
`resilience/canary.ts` + `loadCanaryRecord` mandiri — pemutar
tidak boleh mengimpor store ketahanan karena store itu
mengimpor service pemutar, siklus impor).

| Sinyal | Syarat | Efek di pemutar |
|---|---|---|
| `recent-fail` | Cek terakhir < 1 jam lalu, status `broken`/`degraded`, penyebab dominan `refused` | Status "YouTube sedang membatasi..." tampil SEJAK AWAL (sebelum resolve pertama) + putaran cepat dilewati (`maxRounds: 1`, 3 request bukan 9) + tangga latar tetap jalan |
| `recent-pass` | Cek terakhir < 1 jam lalu, status `ok` | Resolve normal (tangga cepat P6) |
| `unknown` | Belum pernah cek, hasil basi (> 1 jam), atau gagal karena penyebab BUKAN penolakan | Resolve normal |

### Alasan ambang 1 jam

Jendela buruk terukur 10+ menit; sinyal gagal berumur di bawah
1 jam masih bukti kuat jendela buruk sedang (atau baru saja)
berjalan, sehingga melewati putaran cepat yang hampir pasti
gagal adalah hemat yang benar (6 request dihemat per lagu).
Sesudah 1 jam sinyal kedaluwarsa — jendela buruk sudah lewat
atau memang bukan jendela buruk — supaya putaran cepat tidak
dilewati selamanya gara-gara satu kegagalan lama. Kanari hanya
jalan sekali sehari, jadi sinyal basi adalah keadaan normal di
sebagian besar sesi.

### Mengapa syarat penyebab `refused`

Kanari `degraded` karena satu lagu tidak punya format bukanlah
sinyal jendela buruk — melewati putaran cepat karenanya hanya
merugikan. Sinyal `recent-fail` mensyaratkan penyebab dominan
`refused` (YouTube menolak), bukan sekadar "ada yang gagal".

### Mengapa putaran cepat dilewati (bukan tangga latar)

Bila jendela buruk sedang berjalan, putaran di +5 dtk/+15 dtk
hampir pasti gagal juga — membuang 6 request + 20 detik
penantian pengguna. Putaran pertama TETAP jalan: bila jendela
ternyata sudah pulih, lagu langsung lolos tanpa rugi apa pun.
Risikonya kecil: bila jendela berbalik persis dalam 15 detik
sesudah lagu dimulai, pemulihan tertunda sampai percobaan
+60 dtk. Tangga latarnya sendiri tidak berubah (langkah 60 dtk
tetap ada — murah dan bisa menangkap jendela yang berbalik
lebih cepat).

## 5. File yang diubah / ditambah

Baru:

- `app/src/resilience/retryLadder.ts` (logika tangga murni:
  konstanta jeda, `startLadder`/`advanceLadder`/`isLadderDue`,
  `isLoginRequiredOnly`).
- `app/src/resilience/retryLadder.test.ts` (12 tes).
- `app/src/player/service.retryLadder.test.ts` (15 tes service
  dengan jam palsu + port palsu + fetch stub + fake-indexeddb).
- `app/tests/e2e/retry-ladder.spec.ts` (3 tes E2E).
- `docs/retry-ladder.md` (dokumen ini).

Diubah:

- `app/src/resilience/canary.ts`: `CANARY_HEALTH_FRESH_MS`,
  `canaryHealthSignal`, `loadCanaryRecord` mandiri (checker
  memakai fungsi yang sama; perilaku checker tidak berubah).
- `app/src/resilience/canary.test.ts`: +9 tes sinyal/loader.
- `app/src/player/service.ts`: tangga latar (mulai/batal/
  cek/percobaan/habis), sinyal kanari di `loadTrack`,
  `maxRounds` di `resolveWithTimeout`, cek tangga di watchdog
  + `visibilitychange`, `retryLadder` di `debugState`.
- `app/src/strings/id.ts`: `retryLimitingAuto`,
  `retryExhausted` (Bahasa Indonesia sehari-hari, tanpa jargon,
  tanpa em dash).
- `CHANGELOG.md`: entri hotfix.

Tidak diubah: `resolve.ts` (resolver sama sekali tidak
disentuh), `workers/` (modul apa pun), kode sync worker /
backup / Spotify / lirik / EQ / sleep timer, `failDetail`
laporan spike, klasifikasi P6 (`errors.ts`), banner, kode
diagnostik LRS1.

## 6. Bukti tes

### 6.1 Vitest

**820/820, 52 file, exit 0** (67 dtk; baseline Blue 5 784/784
+ 36 tes baru, 0 regresi, 0 tes dihapus/dilonggarkan). Jalan
dengan `--configLoader runner --pool=threads` (config loader
bawaan gagal `mkdir .vite-temp` saat gelombang TERBATAS —
lingkungan, bukan kode; symlink `.vite-temp` yang gantung
diperbaiki dengan `mkdir -p /tmp/p5-vite-temp`).

Satu kegagalan sempat muncul di jalan penuh pertama (tes
kehabisan, 818/819): tes kehabisan tangga memakan 4,7 dtk
waktu nyata (majukan 392 dtk jam palsu + ~400 detak watchdog)
dan melewati batas default 5 dtk saat CPU penuh. Perbaikan:
batas eksplisit per tes (30 dtk untuk tes kehabisan, 20 dtk
untuk dua tes majuan panjang) — bukan pelonggaran asersi;
jalan penuh kedua 820/820.

| File | Tes | Yang dibuktikan |
|---|---|---|
| `retryLadder.test.ts` | 12 | Tangga penuh 5/15/60/300 dtk, total 380 dtk, maks 15 request; start/advance/due/habis; `isLoginRequiredOnly` ketat (UNPLAYABLE/OK/proxy/jaringan/solver ditolak) |
| `canary.test.ts` (+9) | 9 baru | Sinyal recent-fail/recent-pass/unknown; ambang 1 jam (59 mnt segar, 60 mnt basi); penyebab bukan-refused = unknown; `loadCanaryRecord` |
| `service.retryLadder.test.ts` | 15 | Tangga mulai + notice + lagu tetap (9 request cepat); lolos +60 dtk (10 request); gagal +60 dtk lalu lolos +5 mnt (13 request); habis + pesan akhir + TIDAK pindah (15 request) + "Coba lagi" manual; skip membatalkan; jeda membatalkan; jeda SELAMA tangga cepat = tangga tidak mulai; TIDAK ada tangga untuk OK-tanpa-format / UNPLAYABLE / campuran / proxy-mati-di-tengah; kanari recent-fail = 3 request + status awal; recent-pass/basi = normal; tab latar (tenggat + visibilitychange tanpa timer) |

Semua tes tangga memakai jam palsu (`vi.useFakeTimers` +
`advanceTimersByTimeAsync`); tidak ada tidur sungguhan.
Satu pelajaran tes: port palsu WAJIB memicu `timeupdate`
dengan posisi yang maju, kalau tidak watchdog mengira stream
macet dan me-resolve ulang (stall 10 dtk) — tes pertama
gagal 5/14 karena ini, diperbaiki di port palsu (bukan di
produk).

### 6.2 Playwright E2E

**3/3 chromium (1,3 mnt) + 3/3 mobile Pixel 7 (1,2 mnt)**,
Chromium jalan lokal (gelombang TERBATAS reda; symlink
`.vite-temp` diperbaiki dulu). 3 tes di
`tests/e2e/retry-ladder.spec.ts` (mock penuh, tanpa jaringan
live): tangga mulai (notice + lagu tetap + tenggat +60 dtk +
9 request), kanari recent-fail (3 request), skip membatalkan.
Penembakan percobaan latar (+60 dtk/+5 mnt) sengaja TIDAK
diuji E2E — menunggu 60 dtk nyata per tes terlalu lambat dan
rapuh; dibuktikan Vitest dengan jam palsu.

Satu kegagalan sempat muncul di jalan pertama (1/3): hitungan
request 15 bukan 9 — lagu uji `hhn-nGSuenM` adalah lagu kanari
#1, dan cek kanari harian (StrictMode double-mount di dev =
2x jalan) menambah 6 request untuk videoId yang sama.
Perbaikan di SPEC (bukan produk): tes yang menghitung request
men-seed kanari OK segar dulu lewat `/p6-test` supaya cek
harian belum jatuh tempo; jalan ulang 3/3 di kedua proyek.

### 6.3 Typecheck + lint

- `tsc --noEmit -p tsconfig.app.json`: bersih, 0 galat.
- `tsc --noEmit -p tsconfig.node.json`: bersih, 0 galat.
- `npm run build` (`tsc -b` + vite build): LOLOS (34 dtk) —
  `tsc -b` jalan karena gelombang TERBATAS reda saat build.
- ESLint seluruh app: bersih, 0 warning (satu galat impor tak
  terpakai di tes baru ditemukan + diperbaiki selama kerja).

### 6.4 Bundle awal

Build produksi lokal (`npm run build`, chunk utama
`index-nwkEvaMQ.js`), diukur dengan metode gerbang CI
(`dist/index.html` -> gzip per JS awal) + CSS:

- **JS awal (gerbang CI): 175.766 byte gzip** (batas 204.800;
  baseline Blue 5 174.815; **+951** untuk hotfix ini).
- **JS + CSS: 182.942 byte gzip** (CSS 7.176), sisa 21.858.
- **0 chunk `*TestPage*` di dist/** (gerbang H1 aman).
- String baru terkonfirmasi ada di chunk utama (2 kecocokan
  "YouTube sedang membatasi" di `index-*.js`).

## 7. Yang TIDAK diubah (eksplisit)

- Perilaku galat BUKAN LOGIN_REQUIRED: identik dengan sebelum
  hotfix, KECUALI pola campuran mayoritas LOGIN_REQUIRED yang
  kini memicu tangga latar (Blue 7 R21, lihat §2.3). Lagu
  semua-UNPLAYABLE, OK-tanpa-format, dan proxy-gagal tanpa
  mayoritas LOGIN_REQUIRED tetap gagal cepat seperti sebelum
  hotfix.
- Resolve ulang tengah lagu (`doReResolve`, stream putus saat
  diputar): tetap memakai jalur lama, tanpa tangga latar.
  Alasan: lagu yang sudah berbunyi lalu putus adalah kasus
  berbeda (URL kedaluwarsa / 403 googlevideo, bukan bot-check
  resolve); tangga 7 menit di tengah lagu akan menahan antrean
  tanpa manfaat yang sama.
- Kanari itu sendiri: jadwal, ambang broken/degraded, dan
  perilaku checker tidak berubah — hanya sinyalnya yang
  dibaca pemutar.
- `failDetail` laporan spike: tidak disentuh.
- Status pemutar: tidak ada nilai status baru.
- `workers/`: tidak disentuh sama sekali (failover egress
  Vercel dikerjakan tim lain secara paralel).

## 8. Batasan + utang

1. **Aturan LOGIN_REQUIRED ketat vs campuran: SELESAI
   (Blue 7 R21)** — aturan dilonggarkan ke mayoritas
   LOGIN_REQUIRED (>50%, tanpa OK); lihat §2.3. Campuran
   mayoritas kini memicu tangga; lagu semua-UNPLAYABLE tetap
   gagal cepat.
2. **Bukti live menunggu §5 ulang:** tangga hanya terbukti di
   tes (mock). Bukti live butuh deploy + uji §5 di jendela
   buruk nyata (di luar jangkauan VM, seperti P6 K6/K7).
3. **Tangga tidak dipersist lintas reload** (§3.3) — keputusan
   sadar, bukan kelalaian.
4. **E2E penembakan latar tidak ada** (§6.2) — sengaja,
   dibuktikan Vitest.
