# Spike S1 + S4: Solver di Browser (QuickJS-WASM di Web Worker)

**Proyek:** Laras Web App Full-Stack, Paket P1, Tim Solver (A13, A7, A6, A11)
**Tanggal:** 17 November 2026 (21:20-21:50 WIB)
**Dokumen mengikat:** `keputusan-solver.md` §7-§8, `arsitektur.md` §8,
`transfer-ekstraktor.md`
**Status:** SELESAI, kedua spike LULUS dengan bukti

---

## 1. Vonis

| Spike | Vonis | Bukti ringkas |
|---|---|---|
| S1: QuickJS-WASM di Web Worker khusus | **LULUS** | Solve lolos ketiga hash di Chromium nyata (Web Worker asli) dan di Node; sig fad7e4e9 dan transform n ad8d59ae byte-identik dengan oracle APK; median solve 2,1-2,8 ms |
| S4: Port `buildPlayerScript` + kolektor transitif + `_extractUrlInfo` | **LULUS** | 39/39 tes Vitest lolos, termasuk tes base.js asli ketiga hash, kasus Vm, helper builtin String, delimiter tabel `;` vs `{`, dan kelas URL tf/bs/JH |

**Keputusan fallback:** fallback lapis 1 (eval langsung di Web Worker
khusus, `keputusan-solver.md` §7.1) TERBUKTI bekerja untuk ketiga hash
dan sepakat byte-identik dengan QuickJS-WASM - tetapi TIDAK dibutuhkan
sekarang karena jalur utama lulus. QuickJS-WASM tetap jalur utama.
Alasannya ada di §6.

**Dampak proyek:** S1/S4 adalah spike inti. Keduanya lulus, jadi proyek
tidak berhenti; Fase 2 boleh membangun di atas solver ini.

---

## 2. S4: hasil port

### 2.1 Kode yang dipindah

Port TypeScript baris-per-baris dari `player_script.dart` APK
(RC v1.0.0), termasuk pemindai JS kecil (blanking string/komentar/
regex/template), kolektor lokal, kolektor dependensi transitif BFS,
dan validasi pengerasan Blue 4 (R4-I1/I2/I3):

| Berkas web | Sumber APK | Isi |
|---|---|---|
| `app/src/solver/playerScript.ts` (1.258 baris) | `lib/extractor/cipher/player_script.dart` | `buildPlayerScript`, `extractStringTable`, `parseStringTable`, `extractSigCallSite`, `extractFunction`, `extractObjectLiteral`, `extractClassDefinition`, kolektor transitif BFS (cap 64, cap byte 1 MB), `_extractUrlInfo`, `buildSolveDriver`, `buildSolverInitScript`, `kJsBuiltinGlobals` |
| `app/src/solver/jsStubs.ts` | `lib/extractor/cipher/js_stubs.dart` | Stub DOM, isi byte-identik dengan versi Dart |
| `app/src/solver/errors.ts` | `lib/extractor/errors.dart` (subset) | `ExtractorException` + penyebab `unknownPlayerHash` / `solverTimeout` / `parseFailed` |
| `app/src/solver/limits.ts` | `signature_solver.dart` (`QuickJsLimits`) | Memori 192 MiB, stack 256 KiB, timeout 10 detik |
| `app/src/solver/urlAllowlist.ts` | `lib/extractor/url_allowlist.dart` | `isAllowedStreamUrl` / `isAllowedThumbnailUrl` (`*.googlevideo.com`, tanpa userinfo, HTTPS) |

Satu penyesuaian port yang dicatat: Dart `int.tryParse` mengembalikan
null untuk angka di atas int64, sementara `Number()` JavaScript
membulatkannya diam-diam. Port memakai `BigInt` dengan cek rentang
int64 supaya perilaku gagal-kerasnya sama persis (dibuktikan tes
R4-I2).

### 2.2 Hasil ekstraksi dari base.js asli ketiga hash

Pola URL base.js diambil dari kode APK
(`player_script_loader.dart`): HTML `https://www.youtube.com/` memberi
`jsUrl` lewat `"jsUrl":"..."`, lalu base.js diunduh dari
`https://www.youtube.com` + jsUrl. Bentuk jsUrl:
`/s/player/<hash>/player_es6.vflset/en_US/base.js`. Varian tcl
diganti ke non-tcl dengan mengubah infiks `player_es6_tcl` menjadi
`player_es6`.

| Hash | sts | Rantai (luar/tengah/dalam) | Helper | Kelas URL / serialisasi | Indeks set | Prelude | Definisi |
|---|---|---|---|---|---|---|---|
| fad7e4e9 | 20767 | vf / Ne / uf | jB | tf / gf | 8 | 11.519 byte | 21 |
| ad8d59ae | 20768 | ld / Xm / Ip | String (builtin) | bs / ff | 14 | 12.656 byte | 20 |
| b559f50c | 20770 | dy / dy / IH | mV | JH / gf | 6 | 10.449 byte | 13 |

Catatan koreksi terhadap dokumen transfer: dokumen mencatat fad7e4e9
"4 definisi". Angka itu adalah hitungan CUPLIKAN fixture (4.711 byte),
bukan base.js penuh - cuplikan fad7e4e9 hanya memuat uf/Ne/vf/jB.
Base.js penuh fad7e4e9 menghasilkan 21 definisi (11.519 byte).
Cuplikan ad8d59ae dan b559f50c memuat rantai transitif lengkap,
sehingga hitungan dan byte preludenya identik dengan base.js penuh
(20 definisi / 12.656 byte dan 13 definisi / 10.449 byte). Ketiganya
jauh di bawah cap 64 definisi dan cap 1 MB.

### 2.3 Tes S4: 39/39 lolos

`npx vitest run src/solver/playerScript.test.ts` - 39 tes lolos,
0 gagal. Cakupan:

- Port lengkap `player_script_test.dart` Dart: ekstraksi cuplikan
  fad7e4e9, bentuk tabel baru (kutip ganda + delimiter `;` dan `{`,
  escape `\"`), helper builtin String tanpa literal (lolos) vs helper
  kustom tanpa literal (gagal keras), dependensi transitif ad8d59ae
  (Vm + 3 cincin: bk/Wm/kd, Gn/Vz/hB/Bp/Bd, Tz/Uz/zp/Ela/yp) dan
  b559f50c (mV + ay/by/cy/ey/Iz/Jz/lc/hha, dy ganda cukup sekali),
  pemindai referensi (lokal koma, isi string, dan properti bukan
  dependensi), pengerasan Blue 4 (cap 64 memotong rantai 70 fungsi
  tepat di F60, siklus A-B-A terminasi, cap byte 1 MB gagal keras,
  angka di atas int64 mengembalikan null, template 100 level gagal
  keras dan 3 level jalan, kelas `9x` dan serialisasi `9f` ditolak).
- Tes base.js ASLI ketiga hash (dibaca dari arsip koordinator Fase 2
  APK): hash, sts, nama fungsi tengah, indeks set, kelas URL, dan
  metode serialisasi per hash; prelude ad8d59ae memuat `Vm={`;
  tabel b559f50c memakai delimiter `{`; tabel ad8d59ae memakai
  delimiter `;`.

Fixture cuplikan disalin byte-identik dari
`laras/test/fixtures/base-js-snippet*.js` (sha256 cocok, diverifikasi
saat penyalinan). Tes base.js penuh dilewati dengan peringatan bila
berkas arsip tidak ada di mesin - di mesin ini ketiganya ada dan
semua tes jalan.

---

## 3. S1: hasil QuickJS-WASM di Web Worker

### 3.1 Mesin yang dipilih (dengan bukti, bukan pendapat)

Paket yang dipakai (dipin pasti di `package.json`):

| Paket | Versi | Peran |
|---|---|---|
| `quickjs-emscripten-core` | 0.32.0 | API runtime/konteks QuickJS-WASM |
| `@jitl/quickjs-singlefile-browser-release-sync` | 0.32.0 | Varian WASM tertanam base64 di modul JS (tidak butuh fetch berkas .wasm terpisah di dalam Web Worker) |

Varian singlefile dipilih atas varian wasmfile karena keandalan
pemuatan di dalam worker Vite (dev maupun build): tidak ada fetch
berkas `.wasm` terpisah yang bisa gagal karena path aset. Harganya
adalah ukuran (lihat §3.4).

**Keputusan varian bellard vs quickjs-ng.** Varian quickjs-ng di paket
yang sama membundel quickjs-ng **v0.12.1** - DI BAWAH lantai 0.16.0
yang dipin APK untuk perbaikan CVE-2026-120438/120439/120440. Varian
default (bellard) membundel QuickJS 2025-09-13+f1139494 (vendored
2026-02-15). Karena itu varian bellard yang dipakai. Pilihan ini
didasarkan kebijakan versi, BUKAN kemampuan: probe terpisah di /tmp
membuktikan varian ng v0.12.1 JUGA menyelesaikan kedua oracle dengan
benar (sig fad7e4e9 cocok, n ad8d59ae `M3WoXUP3VXHCEA` cocok;
init 1.123/688 ms, solve 5/4 ms). Bila quickjs-emscripten suatu hari
membundel quickjs-ng >= 0.16.0, pindah varian hanya mengganti satu
impor - jalurnya sudah dicatat sebagai utang di §8.

Batas operasi dipin dari APK tanpa perubahan: memori 192 MiB
(`setMemoryLimit`), stack 256 KiB (`setMaxStackSize`), timeout
10 detik per evaluasi (interrupt handler QuickJS + backstop terminasi
worker di klien). Tidak ada callback host yang didaftarkan dan tidak
ada fetch dari dalam JS.

### 3.2 Bukti solve: oracle APK

| Pemeriksaan | Hasil |
|---|---|
| fad7e4e9: sig hasil decipher vs oracle `sig-result.json` (terverifikasi pytubefix 11.2.1) | **Byte-identik** (Vitest, browser, dan probe ng) |
| ad8d59ae: transform n vs oracle `ad8d59ae_n_diag.log` (`avtzUIaCevXHJKjFf` ke `M3WoXUP3VXHCEA`) | **Byte-identik** (Vitest, browser, dan probe ng) |
| fad7e4e9: transform n (`AN4ZrqC9mKvCumNnl` ke `4kdLuLGx-Us4iQ`) | Cocok dengan `final-url.json` APK; kedua mesin sepakat |
| b559f50c: transform n (`AN4ZrqC9mKvCumNnl` ke `BZYbwxE49XgSs7`) | Tanpa oracle tersimpan; kedua mesin sepakat byte-identik |
| URL final ketiga hash | Host `*.googlevideo.com`, lolos allowlist, membawa param `sig` + `n` |
| Kesepakatan antar-mesin (QuickJS-WASM vs eval V8, browser) | URL final **byte-identik untuk ketiga hash** |

Catatan tentang `sig-result.json`: berkas itu menyimpan finalUrl
dengan n yang SAMA dengan n input. Itu bukan hasil transform n -
finalUrl di berkas itu dibangun tanpa melewati kelas URL internal
(atau tanpa serialisasi yang menjalankan transform). Transform n yang
benar untuk input tersebut adalah `4kdLuLGx-Us4iQ`, sebagaimana
tercatat di `final-url.json` dan dibuktikan kedua mesin di spike ini.
Asersi oracle S1 memakai sig dari `sig-result.json` (sah) dan n dari
`ad8d59ae_n_diag.log` (sah), bukan n dari `sig-result.json`.

### 3.3 Waktu solve dan init (angka ukur)

**Browser Chromium nyata (Playwright, Web Worker asli, vite dev,
7 putaran per hash)** - `docs/spikes/s1-s4-browser-measurements.json`:

| Hash | Init (ms) | Median solve (ms) | Min (ms) | Max (ms) |
|---|---|---|---|---|
| fad7e4e9 | 2.720,7 (cold start worker: muat WASM + init + solve pertama) | 2,60 | 2,40 | 3,90 |
| ad8d59ae | 1.022,5 (ganti hash) | 2,30 | 2,10 | 5,20 |
| b559f50c | 946,0 (ganti hash) | 2,80 | 2,50 | 4,40 |

**Node v24.22.1 (vite-node, runtime segar per hash, 21 putaran per
hash, dua run)** - `docs/spikes/s1-s4-node-measurements.json`:

| Hash | Init run 1 / run 2 (ms) | Median run 1 / run 2 (ms) | p95 run 1 / run 2 (ms) |
|---|---|---|---|
| fad7e4e9 | 1.117,8 / 1.822,1 | 2,19 / 2,27 | 4,72 / 5,65 |
| ad8d59ae | 1.877,1 / 1.471,8 | 2,53 / 2,13 | 5,87 / 4,65 |
| b559f50c | 1.547,5 / 2.376,4 | 2,40 / 4,02 | 3,03 / 46,47 |

Waktu muat modul WASM pertama: 74,3 ms (run 1) dan 176,8 ms (run 2).
Waktu init bervariasi antar-run (1,0-2,4 detik) karena CPU VM yang
dipakai bersama; median solve stabil di 2,1-2,8 ms di semua run
kecuali satu run b559f50c (median 4,02 ms, p95 46,47 ms - ada solve
pencilan sampai 56,18 ms, konsisten dengan jeda GC atau perebutan
CPU, bukan perilaku steady-state; min run itu 2,30 ms).

Perbandingan dengan APK: median solve APK 10,5 ms (Node di VM).
Median web 2,1-2,8 ms - sekitar 4x lebih cepat, dan jauh di bawah
batas 10 detik maupun di bawah request player (~4 detik). Solver
tetap bukan bottleneck resolve.

### 3.4 Ukuran bundle WASM (angka ukur dari disk)

| Artefak | Mentah (byte) | gzip (byte) |
|---|---|---|
| Modul singlefile browser (dipakai worker) | 589.792 | 250.370 (gzip CLI) / 251.910 (zlib Node) |
| WASM mentah bellard (varian wasmfile, pembanding) | 503.134 | 232.232 |
| WASM mentah ng v0.12.1 (pembanding) | 528.551 | 247.879 |
| `quickjs-emscripten-core` index.mjs | 7.103 | 2.076 |
| Chunk utama core | 3.052 | 1.088 |

Konteks: kontribusi QuickJS di APK rilis adalah 1.240.840 byte -
bundle web (589.792 byte) sekitar 48% dari angka itu. Namun bundle
solver saja (~250 KB gzip) SUDAH melewati anggaran bundle awal
200 KB gzip (`arsitektur.md` §3). Ini tidak melanggar anggaran
selama modul solver di-lazy-load (hanya diunduh saat lagu pertama
di-resolve, lalu di-cache permanen), sesuai mitigasi yang sudah
tertulis di `keputusan-solver.md` §5.5. Tim Fase 2 WAJIB
mempertahankan lazy-load ini; memasukkan solver ke bundle awal
adalah pelanggaran anggaran.

### 3.5 Memori puncak (angka ukur)

| Pengukuran | Nilai |
|---|---|
| `memory_used_size` QuickJS sesudah init, runtime segar per hash (Node) | 10.766.542 / 10.776.391 / 10.786.415 byte (fad/ad8/b55) - stabil ~10,8 MB |
| `memory_used_size` sesudah 21 solve (Node) | 10.794.007 / 10.805.222 / 10.817.324 byte - solve menambah ~27 KB |
| `memory_used_size` sesudah 3 init berurutan dalam SATU runtime (browser) | 10.781.049, lalu 20.383.832, lalu 29.965.158 byte (puncak ~30 MB) |
| `malloc_limit` terpasang | 201.326.592 byte (192 MiB, terkonfirmasi dari runtime) |
| `jsHeapUsedBytes` halaman sesudah semua solve (browser) | 23.100.000 byte |
| RSS puncak proses harness Node (bukan memori solver saja) | 198,9 MB (run 1) / 225,9 MB (run 2) - mencakup vite-node + 3 runtime + string base.js |

Semua angka jauh di bawah batas 192 MiB. Observasi yang dicatat:
memori runtime TUMBUH sekitar 10 MB setiap ganti hash dalam satu
runtime (AST dan objek base.js lama tidak langsung dibebaskan).
Untuk 3 hash puncaknya ~30 MB - aman. Ekstrapolasi linear (berlabel
estimasi, bukan ukur): 10 rotasi hash dalam satu sesi akan mencapai
sekitar 100 MB, masih di bawah 192 MiB. Bila rotasi hash menjadi
sering di satu sesi, Fase 2 dapat mempertimbangkan runtime segar per
hash; bukan kebutuhan sekarang.

---

## 4. Fallback lapis 1: eval langsung di Web Worker (TERBUKTI)

Sesuai `keputusan-solver.md` §7.1, fallback lapis 1 dibuktikan walau
jalur utama lulus - supaya cadangannya nyata, bukan janji.

| Hash | Median solve browser (ms) | Median solve Node (ms) | Init browser (ms) | Oracle |
|---|---|---|---|---|
| fad7e4e9 | 0,60 | 0,38 | 221,4 (cold start worker) | sig cocok |
| ad8d59ae | 0,90 | 0,50 | 152,3 | n cocok |
| b559f50c | 0,50 | 0,41 | 146,6 | sepakat dengan QuickJS |

Eval V8 3-5x lebih cepat dari QuickJS-WASM pada solve, dan cold
start worker-nya 221,4 ms (vs 2.720,7 ms QuickJS-WASM yang mencakup
muat modul WASM). URL final byte-identik dengan QuickJS-WASM untuk
ketiga hash di browser.

Harga fallback ini (dicatat jujur): butuh `unsafe-eval` di CSP
worker/halaman, base.js berjalan di V8 dengan akses API worker
(fetch dan lain-lain) sehingga permukaannya lebih luas dari
QuickJS-WASM yang ter-sandbox, dan stub DOM menimpa global worker
(termasuk `performance`) - karena itu eval HANYA boleh jalan di
dalam worker khusus, tidak pernah di thread utama. Implementasi
memakai eval tidak langsung lewat `globalThis.eval` (bentuk
`(0, eval)` yang setara ditolak tsc TS2695; keduanya adalah eval
tidak langsung menurut spesifikasi ECMAScript).

---

## 5. Keputusan

1. **Solver jalan di browser dengan QuickJS-WASM di Web Worker
   khusus** (sesuai `keputusan-solver.md` §1). Bukti S1 mendukung
   penuh: solve cepat (median ~2-3 ms), memori kecil (~11-30 MB),
   bundle terukur (~250 KB gzip, lazy-load), oracle cocok.
2. **Fallback lapis 1 (eval di worker) siap pakai** bila suatu hari
   QuickJS-WASM gagal di perangkat tertentu. Klien yang sama
   (`SolverClient`) dapat bertukar worker lewat parameter URL worker;
   protokol pesan kedua worker identik.
3. **Varian bellard dipakai; varian ng ditunda** sampai
   quickjs-emscripten membundel quickjs-ng >= 0.16.0 (lantai CVE
   APK). Lihat §3.1 dan utang di §8.
4. **Tidak ada perubahan keputusan arsitektur lain.** S2 (CORS),
   S3 (pemutaran), dan spike lain tetap berjalan di timnya
   masing-masing.

---

## 6. Berkas yang dihasilkan

Kode produksi (`app/src/solver/`):

- `playerScript.ts` - port ekstraksi (1.258 baris)
- `jsStubs.ts` - stub DOM (byte-identik dengan APK)
- `quickJsEngine.ts` - mesin QuickJS-WASM (batas APK, interrupt
  handler, statistik memori)
- `solverWorker.ts` - Web Worker khusus QuickJS-WASM (protokol
  init/solve/memory)
- `solverClient.ts` - klien thread utama (antrean serial, cache
  hash, backstop terminasi 10 detik, cek allowlist)
- `evalEngine.ts` + `evalFallbackWorker.ts` - fallback lapis 1
- `errors.ts`, `limits.ts`, `urlAllowlist.ts` - pendukung port APK
- `spikeOracles.ts` - cipher nyata + oracle (dipakai tes dan halaman
  spike)

Tes dan harness:

- `playerScript.test.ts` - 39 tes S4
- `solverEngine.test.ts` - 6 tes S1 (env node, oracle APK)
- `test-fixtures/` - 3 cuplikan fixture APK (sha256 cocok)
- `spikePage.ts` + `app/spike-s1.html` - halaman ukur browser
- `spike/measure-s1.mts` - harness ukur Node
  (`npx vite-node src/solver/spike/measure-s1.mts`)
- `tests/e2e/spikes/s1-solver.spec.ts` - tes browser Playwright
  (melewati diri sendiri di konfigurasi preview build)
- `playwright.spike-s1.config.ts` + `vite.spike-s1.config.ts` -
  konfigurasi khusus spike (vite dev port 5199, HMR mati)

Bukti ukur:

- `docs/spikes/s1-s4-browser-measurements.json` (hasil mentah
  Playwright, ditulis otomatis oleh tes)
- `docs/spikes/s1-s4-node-measurements.json` (hasil mentah harness
  Node, 21 putaran per hash)

Dependensi baru (semua dipin pasti, `--save-exact`):

- `quickjs-emscripten-core` 0.32.0
- `@jitl/quickjs-singlefile-browser-release-sync` 0.32.0
- `@types/node` 24.19.2 (dev, dibutuhkan `tsc -b` untuk tes yang
  memakai `node:fs`/`process`)

Playwright tetap 1.65.1 (tidak diubah). Tidak ada dependensi lain
yang disentuh.

Perubahan kecil di berkas bersama (satu baris tiap berkas):

- `app/eslint.config.js` - `src/solver/test-fixtures` masuk daftar
  ignore (fixture adalah fragmen base.js, bukan modul yang bisa
  di-parse).

Yang TIDAK dilakukan (sesuai aturan): tidak ada push ke GitHub
(koordinator yang push); `hidden_files/koordinator/log.md` tidak
disentuh; `npm run build` dan `npm ci` tidak dijalankan; QIKO dan
@adipjasebbot tidak disentuh; tidak ada kredensial di berkas mana
pun (kunci InnerTube tidak dipakai di paket ini).

---

## 7. Perintah verifikasi ulang

```bash
cd app
npx vitest run src/solver/            # 45 tes (39 S4 + 6 S1)
npx tsc -b                            # 0 galat
npx eslint src/solver/                # bersih
npx playwright test -c playwright.spike-s1.config.ts   # 1 tes browser
npx vite-node src/solver/spike/measure-s1.mts          # ukur ulang Node
```

Hasil terakhir yang tercatat (17 Nov 2026, 14:44 WIB): Vitest
47/47 lolos untuk seluruh app (45 solver + 2 app), Playwright spike
lulus, `tsc -b` 0 galat, eslint bersih.

---

## 8. Utang dan tindak lanjut untuk Fase 2

1. **Varian quickjs-ng:** bila quickjs-emscripten membundel
   quickjs-ng >= 0.16.0, ganti satu impor di `quickJsEngine.ts` ke
   `@jitl/quickjs-ng-wasmfile-release-sync` (atau varian singlefile
   ng bila tersedia) dan jalankan ulang `solverEngine.test.ts` +
   tes Playwright. Varian ng v0.12.1 sudah terbukti menyelesaikan
   oracle, jadi risikonya hanya versi, bukan kemampuan.
2. **Varian wasmfile (optimasi ukuran):** WASM mentah bellard
   503.134 byte (232.232 gzip) vs singlefile 589.792 byte
   (250.370 gzip) - selisih sekitar 18 KB gzip. Bila Fase 2 mau
   mengambilnya, verifikasi dulu pemuatan berkas `.wasm` sebagai
   aset Vite di dalam worker (dev + build) sebelum mengganti.
3. **Lazy-load solver:** modul solver WAJIB tetap di-lazy-load
   (bukan bagian bundle awal) karena ukurannya melewati anggaran
   200 KB gzip sendirian.
4. **Memori rotasi hash:** init ulang hash dalam satu runtime
   menambah sekitar 10 MB per hash. Bila rotasi menjadi sering,
   pertimbangkan runtime segar per hash.
5. **Waktu init di perangkat nyata:** init 1,0-2,4 detik diukur di
   VM CPU-bersama. Ukur ulang di HP saat S3/pengujian perangkat
   berjalan; init terjadi sekali per hash dan di-cache, jadi
   dampaknya terbatas pada lagu pertama sesudah rotasi hash.
6. **Oracle b559f50c:** belum ada oracle tersimpan untuk hash ini;
   verifikasinya adalah kesepakatan antar-mesin. Resolve live
   terhadap respons player segar akan memperkuatnya.
7. **Artefak spike:** halaman `spike-s1.html`, `spikePage.ts`, dan
   konfigurasi `*.spike-s1.config.ts` adalah artefak spike.
   Koordinator memutuskan apakah dipertahankan sebagai regresi
   atau dihapus setelah Fase 1.

---

## 9. Pelajaran selama spike (untuk dicatat tim)

- **HMR Vite mematikan tes Playwright yang panjang:** run pertama
  tes browser gagal di detik ke-2,5 karena halaman me-reload
  (kemungkinan besar save berkas dari tim paralel memicu HMR).
  Server spike memakai konfigurasi Vite khusus dengan `hmr: false`.
- **`import.meta.url` di Vitest menunjuk path virtual** (`/src/...`)
  sehingga `readFileSync` fixture gagal; pemuatan fixture memakai
  `process.cwd()`.
- **Objek `computeMemoryUsage` tidak punya kunci `malloc_size`:**
  angka yang tersedia adalah `memory_used_size` (dan
  `js_func_code_size`, `malloc_limit`). Kode memakai kunci yang
  benar-benar ada.
- **Stub DOM menimpa `globalThis.performance`:** di harness Node,
  `performance.now()` sesudah init eval mengembalikan `Date.now()`.
  Harness memakai `process.hrtime.bigint()` untuk eval. Di worker
  browser hal ini tidak berpengaruh ke halaman.
- **`(0, eval)` ditolak tsc (TS2695):** dipakai `globalThis.eval`
  sebagai bentuk eval tidak langsung yang sah.
- **Tes memakai API Node butuh `@types/node`:** proyek belum
  memilikinya; dipasang sebagai devDependency pasti (24.19.2).
