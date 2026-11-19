/**
 * Identitas perangkat untuk sinkronisasi (P7).
 *
 * Satu UUID acak per perangkat, disimpan di app_meta
 * (`sync-device-id`) dan TIDAK PERNAH berubah sesudah dibuat:
 * device_id dipakai sebagai tiebreak deterministik protokol
 * last-write-wins (S8) — bila berubah-ubah, tiebreak jadi
 * tidak stabil dan dua perangkat bisa saling menimpa tanpa
 * akhir. Bila database dihapus total, perangkat lahir kembali
 * dengan id baru dan dianggap perangkat baru (aman: data lama
 * di server tetap utuh, hanya tiebreak-nya berubah).
 */
import { getLibraryService } from '../data/library';

const DEVICE_ID_KEY = 'sync-device-id';

export async function getDeviceId(): Promise<string> {
  const library = await getLibraryService();
  const existing = await library.getMeta(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await library.setMeta(DEVICE_ID_KEY, id);
  return id;
}
