/**
 * Generator lagu contoh deterministik untuk halaman uji
 * `/library-test` dan tes E2E.
 *
 * Data ini JELAS-JELAS contoh: id `sample-0001`, artis "Artis
 * Contoh 01", album "Album Contoh 01". Judul dirakit dari bank
 * kata generik supaya tidak meniru judul lagu asli. Seed tetap
 * (42) membuat hasil sama persis setiap kali, sehingga tes E2E
 * bisa menghitung ekspektasi dari generator yang sama.
 *
 * Lagu contoh TIDAK PERNAH masuk Library pengguna tanpa
 * perintah eksplisit: tombol isi di halaman uji tersembunyi
 * `/library-test` hanya dipakai tes dan demo internal.
 */
import type { SongImport } from './types';

/** PRNG deterministik mulberry32. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLE_FIRST = [
  'Semua',
  'Rindu',
  'Cinta',
  'Hujan',
  'Senja',
  'Malam',
  'Pagi',
  'Biru',
  'Jingga',
  'Tenang',
  'Lelah',
  'Sunyi',
  'Bunga',
  'Angin',
  'Pelangi',
  'Bintang',
  'Rembulan',
  'Samudra',
  'Embun',
  'Lentera',
];

const TITLE_SECOND = [
  'di Ujung',
  'yang Hilang',
  'Tanpa Kata',
  'di Antara',
  'di Balik',
  'yang Tersisa',
  'di Tepi',
  'dalam Diam',
  'di Langit',
  'di Jalan',
  'yang Lalu',
  'di Hati',
  'di Sana',
  'di Sini',
  'di Malam',
  'di Pagi',
  'di Kota',
  'di Desa',
  'di Pantai',
  'di Gunung',
];

const ARTIST_COUNT = 40;
const ALBUM_COUNT = 60;

function artistName(index: number): string {
  return `Artis Contoh ${String((index % ARTIST_COUNT) + 1).padStart(2, '0')}`;
}

function albumTitle(index: number): string {
  return `Album Contoh ${String((index % ALBUM_COUNT) + 1).padStart(2, '0')}`;
}

/** Id album contoh: stabil per judul album. */
export function sampleAlbumId(index: number): string {
  return `sample-album-${String((index % ALBUM_COUNT) + 1).padStart(2, '0')}`;
}

export interface SampleSongOptions {
  /** Seed PRNG (default 42). */
  seed?: number;
  /** Tanggal tambah lagu pertama, milidetik epoch. */
  baseDateAdded?: number;
}

/**
 * Hasilkan `count` lagu contoh. `sample-0000` adalah lagu
 * terbaru (dateAdded paling besar), `sample-(count-1)` tertua.
 * Setiap lagu ke-10 difavoritkan, supaya tab Favorit terisi.
 */
export function generateSampleSongs(
  count: number,
  opts: SampleSongOptions = {},
): SongImport[] {
  const rng = mulberry32(opts.seed ?? 42);
  const base = opts.baseDateAdded ?? Date.UTC(2026, 10, 18, 0, 0, 0);
  const out: SongImport[] = [];
  for (let i = 0; i < count; i++) {
    const first = TITLE_FIRST[Math.floor(rng() * TITLE_FIRST.length)] as string;
    const second = TITLE_SECOND[
      Math.floor(rng() * TITLE_SECOND.length)
    ] as string;
    const title = `${first} ${second}`;
    const artistIndex = Math.floor(rng() * ARTIST_COUNT);
    const albumIndex = Math.floor(rng() * ALBUM_COUNT);
    const durationSeconds = 120 + Math.floor(rng() * 241);
    const liked = i % 10 === 0 ? 1 : 0;
    // Waktu putar bervariasi supaya urutan "Sering diputar"
    // punya pemenang yang jelas dan deterministik.
    const totalPlayTimeMs = Math.floor(rng() * 3_600_000);
    out.push({
      song: {
        id: `sample-${String(i).padStart(4, '0')}`,
        title,
        albumId: sampleAlbumId(albumIndex),
        durationSeconds,
        thumbnailUrl: null,
        liked,
        totalPlayTimeMs,
        inLibrary: 0,
        downloadState: 0,
        filePath: null,
        fileSizeBytes: null,
        downloadedAt: null,
        formatId: null,
        unplayable: 0,
        // Lagu pertama terbaru; tiap lagu lebih tua 1 jam.
        dateAdded: base - i * 3_600_000,
        dateModified: base - i * 3_600_000,
      },
      artistNames: [artistName(artistIndex)],
      album: {
        id: sampleAlbumId(albumIndex),
        title: albumTitle(albumIndex),
        year: 2020 + (albumIndex % 6),
        thumbnailUrl: null,
        liked: 0,
      },
    });
  }
  return out;
}
