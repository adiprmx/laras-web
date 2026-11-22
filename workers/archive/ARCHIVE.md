# Arsip proxy mati (P-Archive, 22 Nov 2026)

Delapan percobaan egress alternatif untuk Laras — semuanya gagal atau
terblokir selama program "1 Juta Cara" (19–20 Nov 2026). Kode TIDAK
dihapus: disimpan di sini sebagai catatan, supaya tidak ada yang
mengulangi percobaan yang sama. TIDAK ADA kode di direktori ini yang
dipakai produksi atau diimpor dari mana pun (terverifikasi grep:
0 rujukan di luar `docs/` dan log koordinator historis).

Proxy yang LIVE tetap di `workers/proxy/` (laras-proxy-spike) dan
`workers/sync/` (laras-sync) — bukan di arsip ini.

## Vonis per proxy

| Proxy | Vonis | Bukti / tanggal |
|---|---|---|
| `appwrite-proxy/` | TERBLOKIR — akun ada, kata sandi tak diketahui (signup API 409 `user_already_exists`, login 401) | P2b, 19 Nov 2026 |
| `fly-proxy/` | TERBLOKIR-KARTU — Fly.io mewajibkan kartu | Koordinator #11, 20 Nov 2026 01:07 WIB |
| `hf-proxy/` | TERBLOKIR-BAYAR — Hugging Face Spaces butuh pembayaran | Koordinator #10, 20 Nov 2026 00:45 WIB (sebelumnya TERBLOKIR-BUTUH-BROWSER: token) |
| `railway-proxy/` | TERBLOKIR — butuh browser + gerbang bayar sementara (pelanggan baru wajib berlangganan berbayar) | P2b, 19 Nov 2026 |
| `render-proxy/` | DITOLAK — egress ditolak YouTube (0 OK / 18 ditolak, probe 19 Nov 22:28–22:33 WIB). Service `laras-proxy-render` tetap live $0 tapi TIDAK di-wire sebagai failover | 19 Nov 2026 |
| `replit-proxy/` | TERBLOKIR — butuh browser; tautan mati 30 hari | P2b, 19 Nov 2026 |
| `supabase-proxy/` | DITOLAK — Supabase Edge Functions, 0/9 probe (fungsi tetap live $0, tidak dipakai) | P2a, 19 Nov 2026 |
| `vercel-proxy/` | DITOLAK — egress Vercel/AWS ditolak YouTube (`LOGIN_REQUIRED`, 0 format audio, 15,3 dtk) | 19 Nov 2026 16:48 WIB |

## Rujukan

- `docs/egress-1-juta-cara.md` — matriks lengkap program 1 Juta Cara (P0–P4).
- `docs/vercel-egress.md`, `docs/render-egress.md` — laporan probe Vercel + Render.
- `hidden_files/koordinator/p2a.md`, `p2a-log.md` — Supabase + HF (tim P2a).
- `hidden_files/koordinator/log.md` — log koordinator (vonis Fly.io #11, HF #10).

## Aturan arsip

- Jangan menghidupkan kembali proxy di sini tanpa bukti baru bahwa
  vonisnya sudah tidak berlaku (mis. kebijakan platform berubah).
- Jangan menghapus direktori ini untuk "merapikan" — riwayat vonis
  adalah bagian dari dokumentasi proyek.
