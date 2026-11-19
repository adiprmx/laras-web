# Laras Proxy — Supabase Edge Functions (Deno)

Proxy InnerTube player byte-only, cermin `workers/render-proxy/server.js`
(rute `/healthz` + `POST /api/innertube/player` + `?ping=1` + preflight
CORS). Tanpa import/dependensi — satu file `laras-proxy/index.ts`.

## Proyek

- **Proyek:** `adipmusic` — ref `jebafddwupyqpwevhsqn`, region
  `ap-southeast-2`, status `ACTIVE_HEALTHY`.
- **Slug fungsi:** `laras-proxy`, `verify_jwt=false` (publik, tanpa JWT).
- **URL:**
  `https://jebafddwupyqpwevhsqn.supabase.co/functions/v1/laras-proxy`
- **Alasan pilih:** proyek musik yang sama dengan Laras; konektor
  `custom.legacy-supabase-mgmt` + skrip deploy sudah menargetkan ref
  ini; proyek kedua (`adipqris-sg`, AyoQris) TIDAK disentuh. Org
  sudah punya 2 proyek aktif (batas Free plan), jadi proyek baru
  tidak dibuat.

## Free tier — terverifikasi dari dokumentasi resmi (19 Nov 2026)

- Edge Functions termasuk Free plan: 500.000 invokasi/bulan, $0,
  tanpa kartu kredit (dok billing resmi: "Paid plans require a
  credit card to be on file" — Free tidak).
  Sumber: <https://supabase.com/pricing>,
  <https://supabase.com/docs/guides/platform/get-set-up-for-billing>
- Batas Edge Functions Free plan (dok resmi, diperbarui 29 Okt 2026):
  memori 256 MB, wall clock 150 dtk, CPU 2 dtk/request (tidak termasuk
  async I/O), idle timeout 150 dtk, ukuran fungsi maks 5 MB bila
  di-bundle server-side (Management API), maks 100 fungsi/proyek.
  Sumber: <https://supabase.com/docs/guides/functions/limits>
- Bukti empiris di akun ini: proyek `adipmusic` sudah menjalankan
  fungsi `tq-*` (ACTIVE) di Free plan — Edge Functions memang jalan
  tanpa kartu di akun owner.

## Deploy (CLI/API, tanpa browser)

Kredensial: konektor `custom.supabase-mgmt` (tersimpan di Secure
Vault, diakses via surrogate — jangan pernah minta/paste token mentah).

```bash
# Deploy memakai skrip P2a (hidden_files/koordinator/):
#   - menghapus fungsi slug-UUID bila ada (kecelakaan deploy #1)
#   - deploy dengan ?slug=laras-proxy (WAJIB — tanpa ini Management
#     API membuat fungsi dengan slug UUID acak)
#   - PATCH verify_jwt=false + GET verifikasi
cd ~/workspace/music-app-web/hidden_files/koordinator
PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin python3 \
  deploy_laras_proxy.py

# JANGAN pakai deploy_function.py konektor legacy untuk fungsi baru:
# skrip itu tidak mengirim ?slug= sehingga slug menjadi UUID.
# (verify_jwt di metadata deploy DIABAIKAN server untuk update —
# ubah via PATCH terpisah; skrip di atas sudah melakukannya.)

# Verifikasi
curl -s https://jebafddwupyqpwevhsqn.supabase.co/functions/v1/laras-proxy/healthz
curl -s -X POST 'https://jebafddwupyqpwevhsqn.supabase.co/functions/v1/laras-proxy/api/innertube/player?ping=1'
```

## Gotcha routing (temuan P2a, 19 Nov 2026)

Gateway Supabase memotong `/functions/v1/` dan meneruskan
`/<slug>/...` ke fungsi — pathname mentah yang diterima adalah
`/laras-proxy/healthz`, BUKAN `/functions/v1/laras-proxy/healthz`
(terbukti via diagnostik 404 pada deploy v2). Karena itu `index.ts`
mencocokkan rute dari ujung (`endsWith`), bukan dengan memotong
prefix `/functions/v1/<slug>`.

## Catatan operasional

- **Cold start:** isolate pertama butuh boot Deno (ratusan ms);
  probe pertama bisa lebih lambat — bukan vonis.
- **CPU 2 dtk/request:** proxy ini I/O-bound (salin byte); respons
  player tipikal <1 MB, jauh di bawah batas. Bila YouTube mengembalikan
  JSON raksasa, cap 10 MB + `readCapped` melindungi memori.
- **Egress:** Edge Functions berjalan di jaringan edge Deno Deploy
  global (bukan region proyek) — vonis BERSIH/DITOLAK ditentukan
  probe nyata, bukan asumsi region.
- **Proyek tidur:** proyek Free dijeda setelah 1 minggu tidak aktif
  — proyek `adipmusic` aktif dipakai, jadi risiko rendah; fungsi ikut
  mati bila proyek dijeda.
- **Log:** `console.log` JSON operasional saja (status + ukuran +
  durasi, tanpa videoId/body/URL stream).
