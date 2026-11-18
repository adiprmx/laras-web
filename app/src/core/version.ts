/**
 * Versi app web (satu sumber kebenaran di runtime).
 *
 * WAJIB sama dengan `version` di package.json — tes
 * `version.test.ts` menegakkannya, supaya kode diagnostik LRS1
 * tidak pernah membawa versi basi sesudah bump rilis.
 * Web tidak punya nomor build native; APP_BUILD selalu 0
 * (segmen app di kode LRS1 menjadi mis. `0900` untuk 0.9.0).
 */
export const APP_VERSION = '0.9.0';
export const APP_BUILD = 0;
