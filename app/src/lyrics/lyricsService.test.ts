/**
 * Tes layanan lirik (P7): cache, penanda tidak ditemukan 7 hari,
 * saklar lirik, pemberitahuan privasi. Jaringan di-mock; IndexedDB
 * memakai fake-indexeddb seperti tes library.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarasDatabase, deleteDatabase } from '../data/database';
import { LibraryService } from '../data/library';
import {
  LYRICS_MISS_TTL_MS,
  LyricsService,
  resetLyricsService,
} from './lyricsService';
import type { LyricsFetchResult } from './lrclib';

const DB_NAME = 'laras-lyrics-service-test';

describe('LyricsService', () => {
  let service: LyricsService;

  beforeEach(async () => {
    // Mock jaringan dipakai bersama antar-tes di file ini;
    // bersihkan hitungan panggilan supaya asersi "tidak
    // dipanggil" tiap tes mengukur tes itu saja.
    vi.clearAllMocks();
    await deleteDatabase(DB_NAME);
    const db = new LarasDatabase(DB_NAME);
    await db.open();
    service = new LyricsService(new LibraryService(db));
  });

  afterEach(async () => {
    resetLyricsService();
    await deleteDatabase(DB_NAME);
  });

  const networkOk = vi.fn(async (): Promise<LyricsFetchResult> => ({
    status: 'ok',
    syncedLyrics: '[00:01.00]Halo',
    plainLyrics: 'Halo',
    source: 'lrclib',
  }));

  it('jaringan lalu tersimpan, panggilan kedua dari cache tanpa jaringan', async () => {
    const query = { artist: 'A', title: 'B', durationSeconds: 100 };
    const first = await service.getLyrics('v1', query, networkOk);
    expect(first.status).toBe('ok');
    expect(networkOk).toHaveBeenCalledTimes(1);
    const second = await service.getLyrics('v1', query, networkOk);
    expect(second).toEqual({
      status: 'ok',
      syncedLyrics: '[00:01.00]Halo',
      plainLyrics: 'Halo',
      // Cache mengembalikan sumber asli yang tersimpan (lrclib),
      // bukan label 'cache' — atribusi tetap benar.
      source: 'lrclib',
    });
    expect(networkOk).toHaveBeenCalledTimes(1);
  });

  it('sumber ovh tetap diakui ovh sesudah tersimpan di cache', async () => {
    const networkOvh = vi.fn(async (): Promise<LyricsFetchResult> => ({
      status: 'ok',
      syncedLyrics: null,
      plainLyrics: 'Halo polos',
      source: 'ovh',
    }));
    const query = { artist: 'A', title: 'C', durationSeconds: 100 };
    const first = await service.getLyrics('v-ovh', query, networkOvh);
    expect(first).toEqual({
      status: 'ok',
      syncedLyrics: null,
      plainLyrics: 'Halo polos',
      source: 'ovh',
    });
    const second = await service.getLyrics('v-ovh', query, networkOvh);
    expect(second).toEqual({
      status: 'ok',
      syncedLyrics: null,
      plainLyrics: 'Halo polos',
      source: 'ovh',
    });
    expect(networkOvh).toHaveBeenCalledTimes(1);
  });

  it('tidak ditemukan dicatat 7 hari, lalu jaringan dicoba lagi', async () => {
    const network = vi.fn(async (): Promise<LyricsFetchResult> => ({
      status: 'not-found',
    }));
    const query = { artist: 'A', title: 'Tidak Ada' };
    const now = Date.now();
    expect(await service.getLyrics('v2', query, network, now)).toEqual({
      status: 'not-found',
    });
    expect(network).toHaveBeenCalledTimes(1);
    // Di dalam 7 hari: tidak ada request jaringan lagi.
    expect(
      await service.getLyrics('v2', query, network, now + 60_000),
    ).toEqual({ status: 'not-found' });
    expect(network).toHaveBeenCalledTimes(1);
    // Sesudah 7 hari: jaringan dicoba lagi.
    expect(
      await service.getLyrics(
        'v2',
        query,
        network,
        now + LYRICS_MISS_TTL_MS + 1,
      ),
    ).toEqual({ status: 'not-found' });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('galat jaringan tidak dicatat sebagai tidak ditemukan', async () => {
    const network = vi.fn(async (): Promise<LyricsFetchResult> => ({
      status: 'error',
    }));
    const query = { artist: 'A', title: 'B' };
    expect(await service.getLyrics('v3', query, network)).toEqual({
      status: 'error',
    });
    expect(await service.getLyrics('v3', query, network)).toEqual({
      status: 'error',
    });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('rate-limited diteruskan apa adanya tanpa cache', async () => {
    const network = vi.fn(async (): Promise<LyricsFetchResult> => ({
      status: 'rate-limited',
      retryAfterSeconds: 30,
    }));
    const query = { artist: 'A', title: 'B' };
    expect(await service.getLyrics('v4', query, network)).toEqual({
      status: 'rate-limited',
      retryAfterSeconds: 30,
    });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('lirik mati berarti disabled tanpa menyentuh jaringan', async () => {
    await service.setEnabled(false);
    expect(await service.isEnabled()).toBe(false);
    const result = await service.getLyrics(
      'v5',
      { artist: 'A', title: 'B' },
      networkOk,
    );
    expect(result).toEqual({ status: 'disabled' });
    expect(networkOk).not.toHaveBeenCalled();
    await service.setEnabled(true);
    expect(await service.isEnabled()).toBe(true);
  });

  it('pemberitahuan privasi dicatat sesudah diterima', async () => {
    expect(await service.hasSeenNotice()).toBe(false);
    await service.markNoticeSeen();
    expect(await service.hasSeenNotice()).toBe(true);
  });
});
