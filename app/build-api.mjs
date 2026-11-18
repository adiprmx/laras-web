// Build Laras Web via Vite API (bukan CLI) — fallback gelombang EPERM.
// CLI Vite gagal di loadConfigFromBundledFile (tulis temp config
// ditolak sandbox); API build dengan configFile: false melewati
// langkah itu. Konfigurasi disalin persis dari vite.config.ts
// (plugins react + tailwindcss, sourcemap, worker format 'es').
// publicDir: false — salin public/ manual (fs.copyFile diblokir
// EPERM: copyfile _redirects gagal 18 Nov 2026, dist jadi kosong).
// Jalankan dari app/: node build-api.mjs
// lalu: for f in public/_redirects public/manifest.webmanifest public/sw.js; do cat "$f" > "dist/$(basename $f)"; done
// + salin public/icons/ ke dist/icons/ (mkdir + cat tiap file).
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

await build({
  configFile: false,
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: { sourcemap: true },
  worker: { format: 'es' },
});
console.log('BUILD API BERHASIL');
