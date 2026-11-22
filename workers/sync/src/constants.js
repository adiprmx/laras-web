// Konstanta worker sync (P-SyncSplit): batas, anggaran, URL
// OAuth, jendela rate limit. Satu tempat — modul ini tidak
// mengimpor apa pun (tanpa risiko impor melingkar).
// WORKER_VERSION sengaja TIDAK di sini: tetap di index.js
// (hanya router yang melaporkannya di /health).

export const SESSION_COOKIE = 'laras_session';
export const STATE_COOKIE = 'laras_oauth_state';
// PKCE (P-Auth): cookie verifier sekali pakai — nama + masa berlaku
// sama dengan state cookie (10 menit, Path /api/auth).
export const VERIFIER_COOKIE = 'laras_oauth_verifier';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const STATE_MAX_AGE_SECONDS = 600;
export const MAX_PUSH_ENTRIES = 100;
export const MAX_PULL_ROWS = 1000;
export const MAX_SETTINGS_BYTES = 4096;
export const MAX_META_CHARS = 500;
// Batas TOTAL per pengguna (arsitektur §4.3, S7): tanpa ini
// satu akun bisa membakar kuota tulis D1 bersama (100.000
// baris/hari) dalam <5 menit lewat push 700 baris x 30/mnt.
export const MAX_PLAYLISTS_PER_USER = 100;
export const MAX_ITEMS_PER_PLAYLIST = 1000;
export const MAX_LIKES_PER_USER = 10000;
export const MAX_HISTORY_PER_USER = 1000;
// Anggaran tulis harian per akun (arsitektur §4.3, S8b): 20.000
// baris/hari/akun. Longgar untuk pemakaian normal (sinkron penuh
// akun yang sudah maksimal pun ~12.100 baris: 100 playlist +
// 1.000 item + 10.000 suka + 1.000 riwayat), tetapi satu akun
// paling banyak memakai 20% kuota tulis bersama (100.000/hari),
// jadi TIDAK BISA mengurasnya sendirian — butuh 5 akun penuh
// berkoordinasi. Dihitung dari ISI BODY push (termasuk entri
// yang dilewati cap / bukan milik pendorong) supaya push "gratis"
// tidak bisa dipakai membakar kuota BACA lewat probe (S9).
// Sejak Blue 6, tagihan push ditambah 1 untuk baris rate-limit
// push itu sendiri (S12a), dan anggaran diikat ke identitas
// provider lewat tombstone (S10b) supaya hapus + daftar lagi
// tidak me-resetnya.
export const DAILY_WRITE_BUDGET = 20000;
// Anggaran BACA pull harian per akun (S11b): 40.000 baris/hari/
// akun = 0,8% kuota baca bersama (5.000.000/hari). Longgar untuk
// pemakaian normal: sinkronisasi penuh akun di batas koleksi
// skalar (~12.100 baris: 100 playlist + 1.000 item + 10.000 suka
// + 1.000 riwayat) muat 3x sehari; akun ekstrem 100.000 item
// (111.101 baris) tersinkron bertahap ~3 hari — simetris dengan
// sisi tulis yang butuh ~6 hari untuk mendorongnya, dan klien
// sudah inkremental (kursor `since` dipertahankan), jadi bukan
// gagal total. Satu akun tidak bisa menguras kuota baca
// sendirian: butuh 125 akun yang kompak menghabiskan anggaran
// penuh (sebelum S11: 1 akun, 49 pull, ~1,6 menit).
export const DAILY_READ_BUDGET = 40000;
// Cadangan anggaran baca per pull (S11b): maksimum baris yang
// bisa disentuh satu pull (4 koleksi x 1.001 — LIMIT 1001,
// baris ke-1001 adalah probe pemotongan P-Pull — + settings 1)
// + 1 untuk baris rate-limit pull itu (S12a). Dicadangkan
// SEBELUM query jalan (atomik, seperti anggaran tulis); selisih
// yang tidak terpakai dikembalikan sesudah query (refund).
// Refund menghitung baris yang benar-benar DIKEMBALIKAN (<=1000
// per koleksi); 4 baris probe tidak ditagih — 0,1% cadangan.
export const READ_BUDGET_RESERVE_PER_PULL = 4 * (MAX_PULL_ROWS + 1) + 1 + 1;
// Tagihan anggaran TULIS per pull (S12a): satu pull menulis
// paling banyak 4 baris D1 — baris rate-limit (1) + cadangan
// anggaran tulis (1) + cadangan anggaran baca (1) + refund
// anggaran baca (1). Tanpa tagihan ini, pull kosong (bersih
// 1 baris baca) bisa diulang 36.000x/hari dan menulis 108.000
// baris — satu akun membunuh kuota tulis (ditemukan saat
// verifikasi Blue 6). Dengan tagihan ini, pull + push berbagi
// anggaran 20.000: total tulis per akun/hari <= ~20.000.
export const PULL_WRITE_CHARGE = 4;
// Rate limit hapus akun (S10a): hapus akun adalah tindakan
// sekali seumur hidup akun — 3/jam/IP longgar untuk satu rumah
// tangga/NAT yang menghapus beberapa akun berdekatan, dan
// 1/jam/akun menahan percobaan ulang bila hapus gagal di tengah
// (akun yang berhasil dihapus tidak bisa dihapus lagi: sesinya
// sudah hilang). Batas per jam (bukan per menit) karena siklus
// serang S10 diukur dalam menit; digabung cooldown 24 jam (S10c),
// laju daur ulang maksimal 3/jam/IP itupun butuh identitas baru
// tiap siklus (identitas yang sama diblokir cooldown).
export const RATE_DELETE_PER_HOUR_IP = 3;
export const RATE_DELETE_PER_HOUR_ACCOUNT = 1;
export const DELETE_RATE_WINDOW_MS = 60 * 60 * 1000;
// Cooldown daftar ulang sesudah hapus akun (S10c): 24 jam.
// DIPILIH: daftar ulang dalam masa cooldown DITOLAK dengan
// pesan jelas (bukan "diizinkan tapi mewarisi anggaran").
// Alasan: (1) penolakan menutup reset anggaran BACA juga
// (anggaran baca per user_id ikut segar bila daftar ulang
// diizinkan — celah S11 lewat daur ulang); (2) UX: jeda 24 jam
// sesudah menghapus akun adalah perilaku yang sudah umum
// (masa tenggang), dan pesannya menyebut kapan bisa kembali;
// (3) privasi: tombstone tetap hanya hash + angka selama
// cooldown, tidak ada data pribadi yang dipertahankan.
// Warisan anggaran/stempel (S10b) tetap diterapkan sebagai
// lapis kedua bila cooldown gagal ditegakkan.
export const RE_REGISTER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Blue 7 (S13): cooldown SEBANDING ukuran akun — batch hapus
// akun penuh menulis ~111.210 baris sekali (melebihi kuota tulis
// harian bersama 100.000 sendirian). Cooldown = 24 jam + 1 hari
// per 20.000 baris di atas 20.000, maks 30 hari (= retensi
// tombstone; cooldown lebih lama tidak bisa ditegakkan karena
// tombstone disapu sesudah 30 hari). Akun normal (<=20.000 baris,
// mencakup sinkronisasi penuh di batas skalar ~12.100) TIDAK
// berubah (24 jam); akun penuh ~111.210 baris mendapat 6 hari
// (24 jam + 5 hari). Jumlah baris dicatat delete handler di
// kolom deleted_rows (migrasi 0007); hitungannya di
// reRegisterCooldownMs (di bawah, dekat helper tombstone).
export const RE_REGISTER_COOLDOWN_ROWS_FREE = 20000;
export const RE_REGISTER_COOLDOWN_ROWS_PER_DAY = 20000;
export const RE_REGISTER_COOLDOWN_MAX_DAYS = 30;
// Tombstone identitas dipertahankan 30 hari, lalu disapu malas
// tiap pendaftaran akun baru (1 pernyataan best-effort).
export const DELETED_IDENTITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Sapu tombstone malas (I22): tiap push menghapus paling banyak
// 100 tombstone lama per koleksi yang disentuh push itu.
// DIPILIH sapu malas (bukan cron terjadwal): tanpa perubahan
// deploy (tanpa scheduled handler, tanpa trigger wrangler,
// tanpa perluasan metadata deploy_sync.py), tanpa job yang bisa
// gagal diam-diam, dan cap hanya penting saat pengguna mendorong
// — koleksi yang tidak pernah didorong tidak butuh disapu.
// Tombstone baru (<30 hari) tidak pernah disentuh.
export const TOMBSTONE_PRUNE_PER_PUSH = 100;
export const TOMBSTONE_PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Blue 7 (S14/I26): cap TOTAL baris yang disapu satu push
// (tombstone + item yatim dari playlist yang disapu). Tanpa cap,
// satu push bisa menghapus 100 playlist x 1.000 item = 100.000
// baris. Pengecualian: satu playlist penuh (1.000 item) selalu
// disapu utuh (1.001 baris) supaya tidak pernah macet di cap.
// Cadangan anggaran sapu (S14) menagih biaya PERSIS (hapus +
// UPDATE penghitung + 1 upsert cadangan); maksimum cadangan
// adalah 1.203 (1.000 hapus + 202 UPDATE + 1), atau 1.004 untuk
// satu playlist penuh (1.001 hapus + 2 UPDATE + 1).
export const TOMBSTONE_PRUNE_MAX_ROWS_PER_PUSH = 1000;
// Hapus riwayat dihonori paling sering sekali per 24 jam per
// pengguna (S8a). Menghapus riwayat adalah tindakan sadar yang
// jarang (seperti membersihkan riwayat browser); sekali sehari
// jauh di atas kebutuhan sahih, dan menutup putaran
// insert-100 + DELETE-keras yang memutar kuota tulis tanpa henti.
export const HISTORY_CLEAR_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Rekonsiliasi penghitung (S9): hitung ulang via COUNT bila
// penghitung melenceng di atas batas + 30 (tidak mungkin tanpa
// drift — guard R19 menahan jumlah nyata di dekat batas), atau
// lebih tua dari 24 jam saat sudah dalam 500 baris dari batas.
export const COUNTER_RECONCILE_OVER_CAP_SLACK = 30;
export const COUNTER_RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const COUNTER_RECONCILE_NEAR_CAP = 500;
export const RATE_AUTH_PER_MIN = 10;
export const RATE_SYNC_PER_MIN = 30;
export const RATE_ME_PER_MIN = 60;
export const FETCH_TIMEOUT_MS = 15000;

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER = 'https://api.github.com/user';
