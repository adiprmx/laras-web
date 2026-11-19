/**
 * Tes identitas perangkat sinkronisasi (P7): dibuat sekali,
 * stabil antar panggilan, tersimpan di app_meta.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LARAS_DB_NAME, deleteDatabase } from '../data/database';
import {
  getLibraryService,
  resetLibraryService,
} from '../data/library';
import { getDeviceId } from './deviceId';

describe('getDeviceId', () => {
  beforeEach(async () => {
    resetLibraryService();
    await deleteDatabase(LARAS_DB_NAME);
  });

  afterEach(async () => {
    resetLibraryService();
    await deleteDatabase(LARAS_DB_NAME);
  });

  it('mengembalikan UUID yang sama di panggilan berikutnya', async () => {
    const first = await getDeviceId();
    const second = await getDeviceId();
    expect(first).toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('tersimpan di app_meta dan dipakai ulang sesudah reset layanan', async () => {
    const first = await getDeviceId();
    const library = await getLibraryService();
    expect(await library.getMeta('sync-device-id')).toBe(first);
    resetLibraryService();
    expect(await getDeviceId()).toBe(first);
  });
});
