/**
 * Tes kontrak API sync (P-Types): validator runtime di
 * workers/sync/src/contract.js — dipakai worker DAN app.
 * Tes ini membuktikan kedua sisi sepakat soal bentuk wire:
 * body push yang dibangun app lolos validator server, dan
 * respons pull/push yang cacat ditolak klien sebelum dipakai.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  validatePullResponse,
  validatePushBody,
  validatePushData,
} from '../../../workers/sync/src/contract';
import { fetchPull, fetchPush } from './syncClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_PULL = {
  serverTime: 1700000000000,
  hasMore: false,
  nextSince: null,
  maxUpdatedAt: 1700000000000,
  tieOverflow: false,
  playlists: [
    {
      clientId: 'pl-1',
      nama: 'Favorit',
      deskripsi: null,
      updatedAt: 1700000000000,
      deletedAt: null,
    },
  ],
  playlistItems: [
    {
      playlistClientId: 'pl-1',
      videoId: 'hhn-nGSuenM',
      posisi: 0,
      title: 'Semua Tentang Kita',
      artist: 'Peterpan',
      updatedAt: 1700000000000,
      deletedAt: null,
    },
  ],
  likes: [
    {
      videoId: 'hhn-nGSuenM',
      likedAt: 1700000000000,
      title: null,
      artist: null,
      updatedAt: 1700000000000,
      deletedAt: null,
    },
  ],
  history: [
    {
      videoId: 'hhn-nGSuenM',
      playedAt: 1700000000000,
      secondsPlayed: 30,
      title: null,
      artist: null,
      updatedAt: 1700000000000,
    },
  ],
  settings: { settingsJson: '{}', updatedAt: 1700000000000 },
};

describe('validatePullResponse', () => {
  it('pull lengkap (server baru) valid', () => {
    expect(validatePullResponse(VALID_PULL)).toBeNull();
  });

  it('pull tanpa field paginasi (server lama) valid', () => {
    const { hasMore, nextSince, maxUpdatedAt, tieOverflow, ...old } =
      VALID_PULL;
    void hasMore;
    void nextSince;
    void maxUpdatedAt;
    void tieOverflow;
    expect(validatePullResponse(old)).toBeNull();
  });

  it('serverTime hilang ditolak', () => {
    const { serverTime, ...rest } = VALID_PULL;
    void serverTime;
    expect(validatePullResponse(rest)).toMatch(/serverTime/);
  });

  it('koleksi bukan array ditolak', () => {
    expect(
      validatePullResponse({ ...VALID_PULL, likes: {} }),
    ).toMatch(/likes/);
  });

  it('settings hilang ditolak (worker selalu mengembalikannya)', () => {
    const { settings, ...rest } = VALID_PULL;
    void settings;
    expect(validatePullResponse(rest)).toMatch(/settings/);
  });

  it('settings bentuk salah ditolak', () => {
    expect(
      validatePullResponse({
        ...VALID_PULL,
        settings: { settingsJson: 42, updatedAt: 1 },
      }),
    ).toMatch(/settings/);
  });

  it('hasMore bukan boolean ditolak', () => {
    expect(
      validatePullResponse({ ...VALID_PULL, hasMore: 'ya' }),
    ).toMatch(/hasMore/);
  });

  it('entri tanpa field wajib ditolak', () => {
    expect(
      validatePullResponse({
        ...VALID_PULL,
        likes: [{ videoId: 'hhn-nGSuenM' }],
      }),
    ).toMatch(/like/);
  });
});

describe('validatePushData', () => {
  it('respons push valid', () => {
    expect(
      validatePushData({
        serverTime: 1,
        applied: 2,
        pruned: 0,
        skippedOverLimit: { playlists: 0, playlistItems: 0, likes: 0, history: 0 },
        limits: { playlists: 100, itemsPerPlaylist: 1000, likes: 10000, history: 1000 },
      }),
    ).toBeNull();
  });

  it('applied hilang ditolak', () => {
    expect(validatePushData({ serverTime: 1 })).toMatch(/applied/);
  });

  it('skippedOverLimit bentuk salah ditolak', () => {
    expect(
      validatePushData({ serverTime: 1, applied: 1, skippedOverLimit: { playlists: 0 } }),
    ).toMatch(/skippedOverLimit/);
  });
});

describe('kontrak push app <-> worker (anti-drift)', () => {
  it('PushBody lengkap lolos validator server', () => {
    expect(
      validatePushBody({
        deviceId: 'dev-1',
        playlists: [{ clientId: 'pl-1', nama: 'Favorit', deskripsi: null }],
        playlistItems: [
          { playlistClientId: 'pl-1', videoId: 'hhn-nGSuenM', posisi: 0, title: 'Lagu', artist: 'Artis' },
        ],
        likes: [{ videoId: 'hhn-nGSuenM', likedAt: 1, title: null, artist: null }],
        history: [{ videoId: 'hhn-nGSuenM', playedAt: 1, secondsPlayed: 30, title: null, artist: null }],
        deletedPlaylists: [{ clientId: 'pl-9' }],
        deletedPlaylistItems: [{ playlistClientId: 'pl-9', videoId: 'hhn-nGSuenM' }],
        deletedLikes: [{ videoId: 'hhn-nGSuenM' }],
        settings: { settingsJson: '{}' },
        historyClearedBefore: 1700000000000,
      }),
    ).toBeNull();
  });

  it('fetchPush menolak body cacat TANPA memanggil fetch', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ success: true, data: { serverTime: 1, applied: 0 } }),
    );
    await expect(
      fetchPush({ deviceId: '' }, fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'INVALID_PUSH_BODY', status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetchPull menolak respons cacat sebagai BAD_RESPONSE', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: { serverTime: 1, playlists: [], settings: null },
      }),
    );
    await expect(
      fetchPull(0, fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE', status: 200 });
  });

  it('fetchPush menolak respons push cacat sebagai BAD_RESPONSE', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ success: true, data: { serverTime: 1 } }),
    );
    await expect(
      fetchPush(
        { deviceId: 'dev-1' },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
