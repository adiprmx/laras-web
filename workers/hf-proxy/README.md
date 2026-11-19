# Laras Proxy — Hugging Face Spaces (Docker)

Proxy InnerTube player byte-only, cermin `workers/render-proxy/server.js`
(rute `/healthz` + `POST /api/innertube/player` + `?ping=1` + preflight
CORS). Tanpa dependensi npm. Satu-satunya adaptasi vs Render: port
default **7860** (wajib di HF Spaces Docker SDK).

Status 19 Nov 2026 (TIM P2a): **TERBLOKIR-BUTUH-BROWSER (token)**.
Token Hugging Face TIDAK ditemukan di `~/.cache/huggingface/token`,
`secrets/`, `~/workspace/custom-connectors/`, maupun variabel env.
Artefak di direktori ini sudah siap deploy begitu token tersedia.

## Prasyarat

- Akun Hugging Face owner (email `adiprmx@gmail.com`) — sudah ada.
- Token akses HF peran **Write** — BELUM ADA, harus dibuat lewat dasbor
  web (langkah di bawah). Tanpa kartu kredit: Spaces CPU gratis tidak
  meminta kartu.

## Langkah 1 — Buat token (butuh browser, ~2 menit)

1. Login ke <https://huggingface.co> dengan akun owner.
2. Klik avatar (kanan atas) → **Settings** → **Access Tokens**
   (langsung: <https://huggingface.co/settings/tokens>).
3. **Create new token**:
   - Name: `laras-deploy`
   - Type: **Write** (wajib Write — token Read tidak bisa push ke Space)
4. Salin token (`hf_...`) — hanya tampil sekali.
5. Serahkan token ke agen lewat Secure Vault / kartu aman. JANGAN
   tempel token di chat polos. Agen menyimpannya di
   `secrets/hf-token` (0600) dan tidak pernah mencetak nilainya.

## Langkah 2 — Buat Space + deploy (bisa lewat CLI/API, tanpa browser)

Setelah token ada, agen menjalankan (ganti `<username>` dengan username
HF owner):

```bash
# 1. Buat Space Docker (API; tanpa browser)
curl -s -X POST https://huggingface.co/api/spaces \
  -H "Authorization: Bearer $HF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "laras-proxy", "sdk": "docker", "private": false}'

# 2. Push artefak ke repo Space (Space = repo git)
cd workers/hf-proxy
git init -b main
git remote add origin https://huggingface.co/spaces/<username>/laras-proxy
git add Dockerfile server.js README.md
git -c credential.helper= \
  -c http.extraHeader="Authorization: Bearer $HF_TOKEN" \
  push origin main
```

Space membangun image Docker otomatis. URL publik:

```
https://<username>-laras-proxy.hf.space
```

## Langkah 3 — Verifikasi

```bash
# Health check (200 {"status":"ok"})
curl -s https://<username>-laras-proxy.hf.space/healthz

# Diagnosis tanpa menyentuh YouTube (200 {"success":true,"ping":"ok"})
curl -s -X POST 'https://<username>-laras-proxy.hf.space/api/innertube/player?ping=1'
```

Lalu probe protokol standar (kontrol CF sebelum+sesudah, kandidat
3x/klien WEB_REMIX, MWEB, ANDROID_VR, lagu `hhn-nGSuenM`) — lihat
`hidden_files/koordinator/p2a_probe.py`.

## Catatan operasional

- **Tidur:** Space CPU gratis bisa tidur setelah tidak aktif — butuh
  keep-alive `GET /healthz` berkala bila dipakai produksi (cron yang
  sama seperti Render).
- **Cold start:** boot pertama setelah tidur butuh waktu build/boot
  image (puluhan detik); probe pertama sesudah tidur bisa timeout —
  ulangi setelah Space bangun.
- **Risiko egress:** HF Spaces berjalan di infrastruktur cloud (AWS),
  jadi hipotesis "YouTube menolak IP pusat data" berlaku juga di sini
  — vonis BERSIH/DITOLAK ditentukan probe nyata, bukan asumsi.
- **Privasi:** Space boleh publik — proxy ini tidak menyimpan data
  pengguna, tidak mencatat body, dan hanya meneruskan byte.
