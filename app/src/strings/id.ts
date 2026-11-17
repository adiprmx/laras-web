// String Bahasa Indonesia: satu sumber kebenaran untuk copy pengguna.
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
  // Pemutar (P2)
  tryPlayerTitle: 'Coba pemutar',
  tryPlayerBody:
    'Lima lagu ini bisa diputar sekarang. Pencarian penuh hadir di versi berikutnya.',
  play: 'Putar',
  pause: 'Jeda',
  nextTrack: 'Lagu berikutnya',
  prevTrack: 'Lagu sebelumnya',
  shuffle: 'Acak',
  shuffleOn: 'Acak aktif',
  shuffleOff: 'Acak mati',
  repeatOff: 'Ulang mati',
  repeatAll: 'Ulang semua',
  repeatOne: 'Ulang satu lagu',
  speed: 'Kecepatan',
  volumeInApp: 'Volume di app ini',
  sound: 'Suara',
  queue: 'Antrean',
  clearQueue: 'Hapus semua',
  removeFromQueue: 'Hapus dari antrean',
  retry: 'Coba lagi',
  close: 'Tutup',
  closePlayer: 'Tutup pemutar',
  openPlayer: 'Buka pemutar',
  loadingSong: 'Memuat lagu',
  nowPlaying: 'Sedang diputar',
  playbackError:
    'Lagu tidak bisa diputar sekarang. Periksa koneksi internet kamu, lalu coba lagi.',
  resolveSlow:
    'Lagu terlalu lama dicari. Periksa koneksi internet kamu.',
  resolveFailed:
    'Lagu tidak bisa dicari. Periksa koneksi internet kamu.',
  autoplayBlocked: 'Ketuk tombol putar untuk melanjutkan lagu.',
  eqStreamingNote:
    'Pengatur suara hanya bisa dipakai untuk lagu yang tersimpan di perangkat.',
  eqLocalNote: 'Pengatur suara belum tersedia di versi ini.',
} as const;

export type Strings = typeof strings;
