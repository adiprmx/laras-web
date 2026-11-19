/**
 * Tes orkestrasi sinkronisasi (P7): tarik-terapkan, kumpulkan
 * dorong, satu putaran penuh. IndexedDB memakai fake-indexeddb;
 * jaringan diganti stub SyncDeps (tanpa fetch sungguhan).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LARAS_DB_NAME,
  deleteDatabase,
} from '../data/database';
import {
  SYNC_HISTORY_CLEARED_KEY,
  getLibraryService,
  resetLibraryService,
  type LibraryService,
} from '../data/library';
import {
  LYRICS_ENABLED_KEY,
  resetLyricsService,
} from '../lyrics/lyricsService';
import { DEFAULT_EQ_SETTINGS, EQ_PRESET_GAINS } from '../player/equalizer';
import { getPlayerService } from '../player/service';
import { useEqualizerStore } from '../store/equalizer';
import { getDeviceId } from './deviceId';
import {
  currentSyncEpoch,
  invalidateSyncEpoch,
} from './syncEpoch';
import {
  getSettingsMarkers,
  setSettingsAppliedAt,
  markSettingsChanged,
} from './settingsMarkers';
import {
  applyPull,
  collectPushBody,
  parseSettingsPayload,
  syncNow,
  SYNC_LAST_PULL_KEY,
  SYNC_HISTORY_PUSHED_KEY,
  type SyncSettingsPayload,
} from './syncService';
import type { PullData, PushBody } from './syncClient';

function emptyPull(serverTime = 10_000): PullData {
  return {
    serverTime,
    playlists: [],
    playlistItems: [],
    likes: [],
    history: [],
    settings: null,
  };
}

async function seedSong(
  library: LibraryService,
  id: string,
  title: string,
  artist?: string,
): Promise<void> {
  const at = Date.now();
  await library.importSongs([
    {
      song: {
        id,
        title,
        albumId: null,
        durationSeconds: 180,
        thumbnailUrl: null,
        liked: 0,
        totalPlayTimeMs: 0,
        inLibrary: 1,
        dateAdded: at,
        dateModified: at,
        downloadState: 0,
        filePath: null,
        fileSizeBytes: null,
        downloadedAt: null,
        formatId: null,
        unplayable: 0,
      },
      artistNames: artist ? [artist] : [],
    },
  ]);
}

describe('syncService', () => {
  let library: LibraryService;

  beforeEach(async () => {
    resetLibraryService();
    resetLyricsService();
    await deleteDatabase(LARAS_DB_NAME);
    library = await getLibraryService();
    useEqualizerStore.setState({
      settings: { ...DEFAULT_EQ_SETTINGS, gains: [...DEFAULT_EQ_SETTINGS.gains] },
      loaded: true,
    });
  });

  afterEach(async () => {
    resetLibraryService();
    resetLyricsService();
    await deleteDatabase(LARAS_DB_NAME);
  });

  describe('applyPull', () => {
    it('membuat playlist + item + suka + riwayat dari server', async () => {
      const pull: PullData = {
        ...emptyPull(),
        playlists: [
          {
            clientId: 'dev-x:1',
            nama: 'Dari Server',
            deskripsi: null,
            updatedAt: 9000,
            deletedAt: null,
          },
        ],
        playlistItems: [
          {
            playlistClientId: 'dev-x:1',
            videoId: 'vid-1',
            posisi: 0,
            title: 'Lagu Satu',
            artist: 'Artis A',
            updatedAt: 9001,
            deletedAt: null,
          },
        ],
        likes: [
          {
            videoId: 'vid-2',
            likedAt: 8000,
            title: 'Lagu Dua',
            artist: null,
            updatedAt: 9002,
            deletedAt: null,
          },
        ],
        history: [
          {
            videoId: 'vid-1',
            playedAt: 7000,
            secondsPlayed: 90,
            title: 'Lagu Satu',
            artist: 'Artis A',
            updatedAt: 9003,
          },
        ],
      };
      await applyPull(library, pull);
      const playlist = await library.playlistByClientId('dev-x:1');
      expect(playlist).not.toBeNull();
      expect(playlist?.name).toBe('Dari Server');
      const songs = await library.playlistSongsAll(playlist?.id as number);
      expect(songs).toHaveLength(1);
      expect(songs[0].songId).toBe('vid-1');
      // Baris lagu minimal dibuat dari metadata server.
      const views = await library.songsByIds(['vid-1', 'vid-2']);
      expect(views.find((v) => v.song.id === 'vid-1')?.song.title).toBe(
        'Lagu Satu',
      );
      expect(views.find((v) => v.song.id === 'vid-2')?.song.title).toBe(
        'Lagu Dua',
      );
      expect(views.find((v) => v.song.id === 'vid-2')?.song.liked).toBe(1);
      expect(await library.hasPlayEvent('vid-1', 7000)).toBe(true);
    });

    it('menerapkan ganti nama playlist server ke playlist lokal', async () => {
      const id = await library.createPlaylist('Nama Lama');
      await library.setPlaylistClientId(id, 'dev-x:5');
      await applyPull(library, {
        ...emptyPull(),
        playlists: [
          {
            clientId: 'dev-x:5',
            nama: 'Nama Baru',
            deskripsi: 'Deskripsi baru',
            updatedAt: 9000,
            deletedAt: null,
          },
        ],
      });
      const playlist = await library.playlistByClientId('dev-x:5');
      expect(playlist?.name).toBe('Nama Baru');
      expect(playlist?.description).toBe('Deskripsi baru');
    });

    it('tombstone menghapus lokal tanpa mencatat tombstone baru', async () => {
      const id = await library.createPlaylist('Hapus Saya');
      await library.setPlaylistClientId(id, 'dev-x:9');
      await seedSong(library, 'vid-9', 'Lagu Sembilan');
      await library.setLiked('vid-9', true);
      await applyPull(library, {
        ...emptyPull(),
        playlists: [
          {
            clientId: 'dev-x:9',
            nama: '',
            deskripsi: null,
            updatedAt: 9000,
            deletedAt: 9000,
          },
        ],
        likes: [
          {
            videoId: 'vid-9',
            likedAt: 0,
            title: null,
            artist: null,
            updatedAt: 9000,
            deletedAt: 9000,
          },
        ],
      });
      expect(await library.playlistByClientId('dev-x:9')).toBeNull();
      const views = await library.songsByIds(['vid-9']);
      expect(views[0].song.liked).toBe(0);
      // Jalur tarik (quiet) tidak mencatat tombstone.
      expect(await library.listTombstones()).toEqual([]);
    });

    it('riwayat yang sama (lagu + waktu) tidak diduplikasi', async () => {
      await seedSong(library, 'vid-1', 'Lagu Satu');
      await library.recordPlay({
        songId: 'vid-1',
        timestamp: 7000,
        playTimeMs: 90_000,
      });
      const pull: PullData = {
        ...emptyPull(),
        history: [
          {
            videoId: 'vid-1',
            playedAt: 7000,
            secondsPlayed: 90,
            title: 'Lagu Satu',
            artist: null,
            updatedAt: 9000,
          },
        ],
      };
      await applyPull(library, pull);
      await applyPull(library, pull);
      const events = await library.historyEvents(10);
      expect(events.filter((e) => e.timestamp === 7000)).toHaveLength(1);
    });

    it('pengaturan server yang lebih baru diterapkan; yang lama diabaikan', async () => {
      const payload: SyncSettingsPayload = {
        version: 1,
        eq: { preset: 'bass', gains: [...EQ_PRESET_GAINS.bass] },
        lyricsEnabled: false,
      };
      await applyPull(library, {
        ...emptyPull(),
        settings: {
          settingsJson: JSON.stringify(payload),
          updatedAt: 9000,
        },
      });
      expect(useEqualizerStore.getState().settings.preset).toBe('bass');
      const lyrics = await import('../lyrics/lyricsService').then((m) =>
        m.getLyricsService(),
      );
      expect(await lyrics.isEnabled()).toBe(false);
      expect((await getSettingsMarkers()).appliedAt).toBe(9000);

      // Pengaturan lebih lama (updatedAt 8000) tidak menimpa.
      const older: SyncSettingsPayload = {
        version: 1,
        eq: { preset: 'vocal', gains: [...EQ_PRESET_GAINS.vocal] },
        lyricsEnabled: true,
      };
      await applyPull(library, {
        ...emptyPull(),
        settings: {
          settingsJson: JSON.stringify(older),
          updatedAt: 8000,
        },
      });
      expect(useEqualizerStore.getState().settings.preset).toBe('bass');
    });

    it('item tanpa playlist-nya dilewati (tidak crash)', async () => {
      await applyPull(library, {
        ...emptyPull(),
        playlistItems: [
          {
            playlistClientId: 'dev-x:tidak-ada',
            videoId: 'vid-1',
            posisi: 0,
            title: 'Lagu',
            artist: null,
            updatedAt: 9000,
            deletedAt: null,
          },
        ],
      });
      const views = await library.songsByIds(['vid-1']);
      expect(views).toHaveLength(0);
    });

    it('S7: tarik playlist ke-101 ditolak saat lokal sudah 100 playlist', async () => {
      for (let i = 0; i < 100; i++) {
        await library.createPlaylist(`Lokal ${i}`);
      }
      await applyPull(library, {
        ...emptyPull(),
        playlists: [
          {
            clientId: 'dev-x:lebih',
            nama: 'Kelebihan',
            deskripsi: null,
            updatedAt: 9000,
            deletedAt: null,
          },
        ],
      });
      expect(await library.playlistByClientId('dev-x:lebih')).toBeNull();
      expect((await library.allPlaylists()).length).toBe(100);
    });

    it('S7: tarik playlist ke-100 diterima saat lokal 99', async () => {
      for (let i = 0; i < 99; i++) {
        await library.createPlaylist(`Lokal ${i}`);
      }
      await applyPull(library, {
        ...emptyPull(),
        playlists: [
          {
            clientId: 'dev-x:100',
            nama: 'Ke-100',
            deskripsi: null,
            updatedAt: 9000,
            deletedAt: null,
          },
        ],
      });
      expect(await library.playlistByClientId('dev-x:100')).not.toBeNull();
      expect((await library.allPlaylists()).length).toBe(100);
    });

    it('R18: applyPull berhenti menulis bila generasi berubah di tengah jalan', async () => {
      // Library stub: baca playlist kedua menggantung supaya tes
      // bisa membatalkan (wipe) di tengah applyPull.
      const created: string[] = [];
      const gate: { release: (() => void) | null } = { release: null };
      let readCount = 0;
      const stubLibrary = {
        playlistByClientId: async () => {
          readCount += 1;
          if (readCount === 2) {
            await new Promise<void>((resolve) => {
              gate.release = resolve;
            });
          }
          return null;
        },
        createPlaylistFromRemote: async (opts: { clientId: string }) => {
          created.push(opts.clientId);
          return created.length;
        },
      } as unknown as LibraryService;
      const pull: PullData = {
        ...emptyPull(),
        playlists: [1, 2, 3].map((n) => ({
          clientId: `dev-x:${n}`,
          nama: `Playlist ${n}`,
          deskripsi: null,
          updatedAt: 9000,
          deletedAt: null,
        })),
      };
      const running = applyPull(stubLibrary, pull, currentSyncEpoch());
      await vi.waitFor(() => expect(gate.release).not.toBeNull());
      // Wipe dimulai saat baca kedua masih menggantung.
      invalidateSyncEpoch();
      gate.release?.();
      await running;
      // Hanya playlist pertama yang sempat dibuat; cek generasi
      // sesudah baca kedua membatalkan sisanya.
      expect(created).toEqual(['dev-x:1']);
    });

    it('R20: setEnabled tidak dipanggil bila generasi berubah selama applySyncedEqSettings', async () => {
      // Wipe mendarat di jendela antara dua await cabang
      // pengaturan (applySyncedEqSettings + getLyricsService):
      // preferensi lirik server tidak boleh bangkit di database
      // segar sesudah wipe.
      const player = getPlayerService();
      const spy = vi
        .spyOn(player, 'applySyncedEqSettings')
        .mockImplementation(async () => {
          invalidateSyncEpoch();
        });
      try {
        const payload: SyncSettingsPayload = {
          version: 1,
          eq: { preset: 'bass', gains: [...EQ_PRESET_GAINS.bass] },
          lyricsEnabled: false,
        };
        await applyPull(library, {
          ...emptyPull(),
          settings: {
            settingsJson: JSON.stringify(payload),
            updatedAt: 9000,
          },
        });
        const lyrics = await import('../lyrics/lyricsService').then((m) =>
          m.getLyricsService(),
        );
        // setEnabled tidak berjalan: meta lirik tidak tertulis,
        // nilai tetap default (aktif), penanda tidak ditulis.
        expect(await library.getMeta(LYRICS_ENABLED_KEY)).toBeNull();
        expect(await lyrics.isEnabled()).toBe(true);
        expect((await getSettingsMarkers()).appliedAt).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('collectPushBody', () => {
    it('memberi clientId ke playlist lokal + mengirim item/suka/riwayat', async () => {
      const deviceId = await getDeviceId();
      const id = await library.createPlaylist('Lokal');
      await seedSong(library, 'vid-1', 'Lagu Satu', 'Artis A');
      await library.addSongToPlaylist(id, 'vid-1');
      await library.setLiked('vid-1', true);
      await library.recordPlay({
        songId: 'vid-1',
        timestamp: 5000,
        playTimeMs: 60_000,
      });
      const body = await collectPushBody(library, deviceId);
      expect(body.deviceId).toBe(deviceId);
      expect(body.playlists).toHaveLength(1);
      expect(body.playlists?.[0].clientId).toBe(`${deviceId}:${id}`);
      expect(body.playlistItems).toHaveLength(1);
      expect(body.playlistItems?.[0].title).toBe('Lagu Satu');
      expect(body.playlistItems?.[0].artist).toBe('Artis A');
      expect(body.likes).toHaveLength(1);
      expect(body.history).toHaveLength(1);
      expect(body.history?.[0].secondsPlayed).toBe(60);
      // clientId tersimpan di lokal untuk dorong berikutnya.
      const playlist = await library.playlistByClientId(
        `${deviceId}:${id}`,
      );
      expect(playlist?.id).toBe(id);
    });

    it('tombstone hapus ikut terkirim dengan format yang benar', async () => {
      const deviceId = await getDeviceId();
      const id = await library.createPlaylist('Hapus');
      await library.setPlaylistClientId(id, 'dev-x:1');
      await seedSong(library, 'vid-1', 'Lagu Satu');
      await library.addSongToPlaylist(id, 'vid-1');
      await library.removeSongFromPlaylist(id, 'vid-1');
      await library.setLiked('vid-1', true);
      await library.toggleLiked('vid-1');
      await library.deletePlaylist(id);
      const body = await collectPushBody(library, deviceId);
      expect(body.deletedPlaylists).toEqual([{ clientId: 'dev-x:1' }]);
      expect(body.deletedPlaylistItems).toEqual([
        { playlistClientId: 'dev-x:1', videoId: 'vid-1' },
      ]);
      expect(body.deletedLikes).toEqual([{ videoId: 'vid-1' }]);
    });

    it('pengaturan hanya dikirim bila berubah sejak terakhir sinkron', async () => {
      const deviceId = await getDeviceId();
      // Belum pernah berubah: tidak ada settings di body.
      const first = await collectPushBody(library, deviceId);
      expect(first.settings).toBeUndefined();
      // Ubah EQ: penanda lokal naik, settings ikut.
      await markSettingsChanged();
      const second = await collectPushBody(library, deviceId);
      expect(second.settings).toBeDefined();
      const parsed = parseSettingsPayload(second.settings?.settingsJson ?? '');
      expect(parsed?.version).toBe(1);
      // Sesudah "sinkron", tidak dikirim lagi.
      await setSettingsAppliedAt(Date.now() + 1000);
      const third = await collectPushBody(library, deviceId);
      expect(third.settings).toBeUndefined();
    });

    it('penanda hapus riwayat ikut terkirim', async () => {
      const deviceId = await getDeviceId();
      await library.setMeta(SYNC_HISTORY_CLEARED_KEY, '12345');
      const body = await collectPushBody(library, deviceId);
      expect(body.historyClearedBefore).toBe(12345);
    });
  });

  describe('parseSettingsPayload', () => {
    it('menolak JSON rusak / versi lain / lyricsEnabled bukan boolean', () => {
      expect(parseSettingsPayload('bukan json')).toBeNull();
      expect(
        parseSettingsPayload(JSON.stringify({ version: 2 })),
      ).toBeNull();
      expect(
        parseSettingsPayload(
          JSON.stringify({ version: 1, lyricsEnabled: 'ya' }),
        ),
      ).toBeNull();
    });

    it('menormalkan EQ yang tidak valid ke default', () => {
      const parsed = parseSettingsPayload(
        JSON.stringify({
          version: 1,
          eq: { preset: 'tidak-ada', gains: [999, -999] },
          lyricsEnabled: true,
        }),
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.eq.gains).toHaveLength(10);
      expect(parsed?.eq.gains.every((g) => g >= -12 && g <= 12)).toBe(true);
    });
  });

  describe('syncNow', () => {
    it('putaran penuh: tarik diterapkan, dorong terkirim, penanda tersimpan', async () => {
      const id = await library.createPlaylist('Lokal');
      await seedSong(library, 'vid-1', 'Lagu Satu');
      await library.addSongToPlaylist(id, 'vid-1');
      await library.setLiked('vid-1', true);
      await library.recordPlay({
        songId: 'vid-1',
        timestamp: 5000,
        playTimeMs: 30_000,
      });
      await library.toggleLiked('vid-1'); // batal suka -> tombstone

      const pushed: PushBody[] = [];
      const deps = {
        pull: async (since: number) => {
          expect(since).toBe(0);
          return {
            ...emptyPull(20_000),
            playlists: [
              {
                clientId: 'dev-x:7',
                nama: 'Dari Server',
                deskripsi: null,
                updatedAt: 9000,
                deletedAt: null,
              },
            ],
          };
        },
        push: async (body: PushBody) => {
          pushed.push(body);
          return { serverTime: 21_000, applied: 3 };
        },
      };
      const result = await syncNow(deps);
      expect(result.serverTime).toBe(21_000);
      // Tarik diterapkan.
      expect(await library.playlistByClientId('dev-x:7')).not.toBeNull();
      // Dorong terkirim (satu ronde: semua koleksi < 100).
      expect(pushed).toHaveLength(1);
      expect(pushed[0].playlists?.length).toBe(2); // lokal + dari server
      expect(pushed[0].deletedLikes).toEqual([{ videoId: 'vid-1' }]);
      // Tombstone terhapus, penanda tersimpan.
      expect(await library.listTombstones()).toEqual([]);
      expect(await library.getMeta(SYNC_LAST_PULL_KEY)).toBe('21000');
      expect(await library.getMeta(SYNC_HISTORY_PUSHED_KEY)).toBe('5000');
    });

    it('dorong gagal: tombstone tetap ada, penanda tidak berubah', async () => {
      await seedSong(library, 'vid-1', 'Lagu Satu');
      await library.setLiked('vid-1', true);
      await library.toggleLiked('vid-1');
      const deps = {
        pull: async () => emptyPull(20_000),
        push: async () => {
          throw new Error('jaringan putus');
        },
      };
      await expect(syncNow(deps)).rejects.toThrow('jaringan putus');
      expect(await library.listTombstones()).toHaveLength(1);
      expect(await library.getMeta(SYNC_LAST_PULL_KEY)).toBeNull();
    });

    it('dorong kedua hanya mengirim riwayat baru', async () => {
      await seedSong(library, 'vid-1', 'Lagu Satu');
      await library.recordPlay({
        songId: 'vid-1',
        timestamp: 5000,
        playTimeMs: 30_000,
      });
      const pushed: PushBody[] = [];
      const deps = {
        pull: async () => emptyPull(20_000),
        push: async (body: PushBody) => {
          pushed.push(body);
          return { serverTime: 21_000, applied: 1 };
        },
      };
      await syncNow(deps);
      expect(pushed[0].history).toHaveLength(1);
      await library.recordPlay({
        songId: 'vid-1',
        timestamp: 9000,
        playTimeMs: 45_000,
      });
      await syncNow(deps);
      expect(pushed[1].history).toHaveLength(1);
      expect(pushed[1].history?.[0].playedAt).toBe(9000);
    });

    it('koleksi besar dipecah batch 100', async () => {
      // 120 suka -> 2 ronde dorong (100 + 20). Seed 120 lagu
      // memakan waktu di bawah beban suite penuh; timeout tes
      // dinaikkan dari default 5 detik.
      for (let i = 0; i < 120; i++) {
        await seedSong(library, `vid-${i}`, `Lagu ${i}`);
        await library.setLiked(`vid-${i}`, true);
      }
      const pushed: PushBody[] = [];
      const deps = {
        pull: async () => emptyPull(20_000),
        push: async (body: PushBody) => {
          pushed.push(body);
          return { serverTime: 21_000, applied: 100 };
        },
      };
      await syncNow(deps);
      expect(pushed).toHaveLength(2);
      expect(pushed[0].likes).toHaveLength(100);
      expect(pushed[1].likes).toHaveLength(20);
    }, 15000);

    it('R18: syncNow yang dibatalkan wipe tidak mendorong dan tidak menulis penanda', async () => {
      const id = await library.createPlaylist('Lokal');
      await seedSong(library, 'vid-1', 'Lagu Satu');
      await library.addSongToPlaylist(id, 'vid-1');
      const pushed: PushBody[] = [];
      const deps = {
        pull: async () => {
          // Wipe dimulai saat tarik sedang berjalan.
          invalidateSyncEpoch();
          return {
            ...emptyPull(20_000),
            playlists: [
              {
                clientId: 'dev-x:7',
                nama: 'Dari Server',
                deskripsi: null,
                updatedAt: 9000,
                deletedAt: null,
              },
            ],
          };
        },
        push: async (body: PushBody) => {
          pushed.push(body);
          return { serverTime: 21_000, applied: 1 };
        },
      };
      const result = await syncNow(deps);
      expect(result.pushed).toBe(0);
      expect(pushed).toHaveLength(0);
      // Tarik tidak diterapkan (generasi sudah berubah).
      expect(await library.playlistByClientId('dev-x:7')).toBeNull();
      // Penanda sukses tidak ditulis ke database.
      expect(await library.getMeta(SYNC_LAST_PULL_KEY)).toBeNull();
    });

    it('S8: penanda hapus riwayat dipertahankan bila server mengabaikan clear', async () => {
      await library.setMeta(SYNC_HISTORY_CLEARED_KEY, '12345');
      const deps = {
        pull: async () => emptyPull(20_000),
        push: async (body: PushBody) => {
          expect(body.historyClearedBefore).toBe(12345);
          return {
            serverTime: 21_000,
            applied: 0,
            historyClearIgnored: true,
          };
        },
      };
      await syncNow(deps);
      // Penanda dipertahankan — sinkronisasi berikut mencoba lagi.
      expect(await library.getMeta(SYNC_HISTORY_CLEARED_KEY)).toBe('12345');
      // Bila server menghormati clear, penanda dibersihkan.
      const deps2 = {
        pull: async () => emptyPull(22_000),
        push: async () => ({ serverTime: 23_000, applied: 1 }),
      };
      await syncNow(deps2);
      expect(await library.getMeta(SYNC_HISTORY_CLEARED_KEY)).toBe('');
    });
  });
});
