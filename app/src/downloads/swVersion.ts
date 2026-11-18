/**
 * Versi Service Worker dari build (menutup utang Blue 1 R3).
 *
 * Dipakai plugin Vite (`vite.config.ts`) untuk mengganti
 * placeholder `__LARAS_SW_VERSION__` di `dist/sw.js`, dan
 * dipakai tes (`sw.test.ts`) untuk memverifikasi formatnya.
 * Modul ini sengaja tanpa dependensi proyek supaya bisa
 * diimpor dari konfigurasi build.
 */
import { createHash } from 'node:crypto';

/**
 * `<versi package.json>-<hash 8 karakter isi sw.js>`.
 * Tiap perubahan SW (atau bump versi rilis) otomatis menaikkan
 * versi cache shell tanpa bump manual.
 */
export function computeSwVersion(
  packageVersion: string,
  swContent: string,
): string {
  const hash = createHash('sha256')
    .update(swContent, 'utf8')
    .digest('hex')
    .slice(0, 8);
  return `${packageVersion}-${hash}`;
}
