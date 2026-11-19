/**
 * Penanda perubahan pengaturan lokal untuk sinkronisasi (P7).
 *
 * Pengaturan (EQ + lirik) hanya didorong ke server bila berubah
 * sejak sinkronisasi terakhir — kalau tidak, dorong akan menimpa
 * pengaturan yang baru saja ditarik dari perangkat lain (server
 * menstempel waktu dorong dengan jam server, jadi dorong selalu
 * "lebih baru"). Dua penanda di app_meta:
 *   - `sync-settings-local-updated-at`: terakhir kali pengaturan
 *     diubah di perangkat ini (diperbarui setiap EQ/lirik berubah).
 *   - `sync-settings-applied-at`: updatedAt server dari pengaturan
 *     terakhir yang diterapkan/didorong (titik "sudah sinkron").
 * Dorong pengaturan hanya bila local > applied.
 */
import { getLibraryService } from '../data/library';

export const SYNC_SETTINGS_LOCAL_KEY = 'sync-settings-local-updated-at';
export const SYNC_SETTINGS_APPLIED_KEY = 'sync-settings-applied-at';

/** Catat bahwa pengaturan berubah di perangkat ini (best-effort). */
export async function markSettingsChanged(): Promise<void> {
  try {
    const library = await getLibraryService();
    await library.setMeta(SYNC_SETTINGS_LOCAL_KEY, String(Date.now()));
  } catch {
    // Gagal catat = pengaturan mungkin tidak terdorong di
    // sinkronisasi berikut; bukan galat yang merusak pemutaran.
  }
}

export async function getSettingsMarkers(): Promise<{
  localUpdatedAt: number;
  appliedAt: number;
}> {
  const library = await getLibraryService();
  const local = Number((await library.getMeta(SYNC_SETTINGS_LOCAL_KEY)) ?? 0);
  const applied = Number(
    (await library.getMeta(SYNC_SETTINGS_APPLIED_KEY)) ?? 0,
  );
  return {
    localUpdatedAt: Number.isFinite(local) ? local : 0,
    appliedAt: Number.isFinite(applied) ? applied : 0,
  };
}

export async function setSettingsAppliedAt(serverTime: number): Promise<void> {
  const library = await getLibraryService();
  await library.setMeta(SYNC_SETTINGS_APPLIED_KEY, String(serverTime));
  await library.setMeta(SYNC_SETTINGS_LOCAL_KEY, String(serverTime));
}
