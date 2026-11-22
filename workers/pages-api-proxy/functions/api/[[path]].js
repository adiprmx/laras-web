// Rute catch-all /api/* -> proxy same-origin (P-SameSite).
// Logika ada di ../_lib/proxy.js (awalan _ = bukan rute).
// File ini TIDAK AKTIF sampai pohon functions/ disalin ke
// root repo saat aktivasi (lihat docs/same-site-sync.md).
export { onRequest } from '../_lib/proxy.js';
