# Proxy API same-origin (Pages Functions) — P-SameSite

Proxy `/api/*` di domain app ke sync worker, supaya cookie
sesi bisa `SameSite=Lax` (saat ini `None` karena API lintas
situs di `*.workers.dev`).

**Status: TIDAK AKTIF.** Pohon `functions/` di sini disimpan
di luar root repo DENGAN SENGAJA — Wrangler mengunggah
folder `functions/` yang ada di CWD saat `wrangler pages
deploy`, jadi menaruhnya di root akan mengaktifkannya pada
deploy biasa berikutnya tanpa sengaja.

**Jangan pindahkan / aktifkan tanpa mengikuti runbook:**
[`docs/same-site-sync.md`](../../docs/same-site-sync.md)
(urutan aktivasi, secret, redirect URI OAuth, flip Lax,
verifikasi live, rollback).

Tes logika proxy (fetch di-stub, tanpa jaringan):
`app/src/worker/pagesApiProxy.test.ts`.
