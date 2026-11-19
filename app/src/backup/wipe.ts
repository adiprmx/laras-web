/**
 * Hapus semua data (P8, PRD B7.5): pustaka, playlist, favorit,
 * riwayat, antrean, pengaturan, file unduhan, dan jejak
 * penyimpanan lokal — lalu app kembali ke keadaan kosong total
 * (UI memuat ulang halaman sesudah pemanggilan ini berhasil).
 *
 * Urutan penting: hentikan pemutar dulu (supaya tidak ada tulis
 * database di tengah penghapusan), lalu unduhan, lalu database,
 * lalu cache, lalu localStorage. Setiap langkah gagal-diam
 * (best-effort) kecuali database: kegagalan langkah lain dicatat
 * di hasil, bukan melempar — pengguna sudah menekan "Hapus"
 * dua kali; membatalkan separuh jalan meninggalkan keadaan
 * setengah-hapus yang lebih membingungkan.
 *
 * Yang TIDAK dihapus (bukan data pengguna, dicatat di laporan):
 * registrasi service worker (kerangka app, bukan data), cookie
 * sesi sinkronisasi (HttpOnly, tidak bisa dihapus dari JS), dan
 * data sinkronisasi di server (penghapusan akun terpisah, PRD
 * B10.3 — tombol hapus akun ada di bagian Sinkronisasi).
 *
 * PENTING (Blue 3, Red 3 R15): pemanggil (WipeFlow) WAJIB
 * memanggil POST /api/auth/logout SEBELUM wipeAllData ini bila
 * pengguna sedang masuk. Tanpa logout, sesi server tetap hidup
 * dan sync otomatis 20 detik sesudah reload mengembalikan
 * seluruh data dari server — wipe jadi tidak ada artinya.
 */
import { deleteDatabase } from '../data/database';
import { resetLibraryService } from '../data/library';
import { getDownloadManager } from '../downloads/downloadManager';
import { getPlayerService } from '../player/service';

/** Hasil penghapusan (untuk log + tes; UI tidak menampilkannya). */
export interface WipeResult {
  /** Database IndexedDB terhapus. */
  dbDeleted: boolean;
  /** Nama cache yang terhapus. */
  cachesDeleted: string[];
  /** Kunci localStorage yang terhapus. */
  localKeysRemoved: string[];
  /** Jumlah file unduhan yang terhapus. */
  downloadsDeleted: number;
  /** Langkah yang gagal (nama langkah). */
  failedSteps: string[];
}

/** Dependensi yang bisa diganti di tes. */
export interface WipeDeps {
  stopPlayer: () => void | Promise<void>;
  deleteDownloads: () => Promise<number>;
  deleteDb: () => Promise<void>;
  resetLibrary: () => void;
  listCaches: () => Promise<string[]>;
  deleteCache: (name: string) => Promise<boolean>;
  listLocalKeys: () => string[];
  removeLocalKey: (key: string) => void;
}

const defaultDeps: WipeDeps = {
  // stopForWipe() (bukan pause + clearQueue): clearQueue()
  // mempertahankan lagu yang sedang diputar dan persist-nya
  // ter-debounce 500 ms — tulis itu bisa mendarat SESUDAH
  // database dihapus dan membangkitkan antrean (bug E2E P8).
  // stopForWipe() mengosongkan antrean sepenuhnya dan menunggu
  // rantai tulis selesai sebelum wipe melangkah ke database.
  stopPlayer: async () => {
    await getPlayerService().stopForWipe();
  },
  // getDownloadManager() ASYNC (membuka library dulu): wajib
  // di-await — memanggil .deleteAllDownloads() langsung pada
  // Promise-nya meninggalkan rejection tak tertangani.
  deleteDownloads: async () => {
    const manager = await getDownloadManager();
    return manager.deleteAllDownloads();
  },
  deleteDb: () => deleteDatabase(),
  resetLibrary: () => resetLibraryService(),
  listCaches: async () =>
    typeof caches === 'undefined' ? [] : caches.keys(),
  deleteCache: async (name) =>
    typeof caches === 'undefined' ? false : caches.delete(name),
  listLocalKeys: () => {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  },
  removeLocalKey: (key) => localStorage.removeItem(key),
};

/**
 * Hapus semua data pengguna. Mengembalikan hasil per langkah.
 * Pemanggil WAJIB memuat ulang halaman sesudah ini (state
 * memori — store Zustand, antrean pemutar — dibersihkan oleh
 * reload, sama seperti APK yang menutup app sesudah wipe).
 */
export async function wipeAllData(
  deps: Partial<WipeDeps> = {},
): Promise<WipeResult> {
  const d: WipeDeps = { ...defaultDeps, ...deps };
  const result: WipeResult = {
    dbDeleted: false,
    cachesDeleted: [],
    localKeysRemoved: [],
    downloadsDeleted: 0,
    failedSteps: [],
  };
  // 1. Hentikan pemutar (tulis database berhenti).
  try {
    await d.stopPlayer();
  } catch {
    result.failedSteps.push('player');
  }
  // 2. Hapus file unduhan (cache + antrean unduhan + job DB).
  try {
    result.downloadsDeleted = await d.deleteDownloads();
  } catch {
    result.failedSteps.push('downloads');
  }
  // 3. Hapus database IndexedDB.
  try {
    await d.deleteDb();
    result.dbDeleted = true;
  } catch {
    result.failedSteps.push('database');
  }
  d.resetLibrary();
  // 4. Hapus SEMUA cache (unduhan, runtime, kerangka — semuanya
  //    bisa berisi data pengguna; kerangka diunduh ulang).
  try {
    const names = await d.listCaches();
    for (const name of names) {
      try {
        if (await d.deleteCache(name)) result.cachesDeleted.push(name);
      } catch {
        result.failedSteps.push(`cache:${name}`);
      }
    }
  } catch {
    result.failedSteps.push('caches');
  }
  // 5. Hapus kunci localStorage milik app (awalan laras.).
  try {
    const keys = d.listLocalKeys();
    for (const key of keys) {
      if (!key.startsWith('laras.')) continue;
      try {
        d.removeLocalKey(key);
        result.localKeysRemoved.push(key);
      } catch {
        result.failedSteps.push(`localStorage:${key}`);
      }
    }
  } catch {
    result.failedSteps.push('localStorage');
  }
  return result;
}
