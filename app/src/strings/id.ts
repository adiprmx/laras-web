// String Bahasa Indonesia — satu sumber kebenaran untuk copy pengguna.
// v1 hanya Bahasa Indonesia; struktur ini memungkinkan bahasa lain pasca-v1.
// Aturan copy: bahasa sehari-hari, tanpa istilah teknis, tanpa kata "cache".
export const strings = {
  appName: 'Laras',
  comingSoon: 'Segera hadir',
  homeEmptyTitle: 'Belum ada lagu di sini',
  homeEmptyBody:
    'Sambungkan internet sekali untuk mulai mencari lagu, atau buka Unduhan bila kamu sudah punya lagu tersimpan.',
  searchPlaceholder: 'Cari lagu, artis, atau album',
  searchButton: 'Cari',
  searchNotReady: 'Pencarian belum aktif di versi awal ini.',
  downloads: 'Unduhan',
  library: 'Library',
  settings: 'Pengaturan',
} as const;

export type Strings = typeof strings;
