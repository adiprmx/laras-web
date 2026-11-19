/**
 * Tes BackupService (P8): bangun salinan, payload ekspor +
 * batas 10 MB, preview impor, impor + terapkan pengaturan,
 * dan unduh lewat browser.
 *
 * Tes memakai database bersama (getLibraryService) lewat
 * fake-indexeddb; database dihapus + layanan di-reset tiap
 * tes supaya tidak bocor antar tes.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDatabase } from '../data/database';
import {
  getLibraryService,
  resetLibraryService,
  type LibraryService,
} from '../data/library';
import { LYRICS_ENABLED_KEY, resetLyricsService } from '../lyrics/lyricsService';
import { DEFAULT_EQ_SETTINGS } from '../player/equalizer';
import { EQ_SETTINGS_KEY, useEqualizerStore } from '../store/equalizer';
import { SORT_META_KEY, useLibraryStore } from '../store/library';
import {
  MAX_BACKUP_BYTES,
  type BackupData,
} from './format';
import {
  applyBackupSettings,
  buildBackupData,
  buildExportPayload,
  capRedownloadIds,
  importBackup,
  previewImport,
  triggerBrowserDownload,
} from './service';

beforeEach(async () => {
  resetLibraryService();
  resetLyricsService();
  await deleteDatabase();
  useLibraryStore.setState({ sort: 'newest', sortLoaded: false });
  useEqualizerStore.setState({
    settings: {
      ...DEFAULT_EQ_SETTINGS,
      gains: [...DEFAULT_EQ_SETTINGS.gains],
    },
    loaded: false,
  });
});

afterEach(async () => {
  resetLibraryService();
  resetLyricsService();
  await deleteDatabase();
});

async function seededService(): Promise<LibraryService> {
  const service = await getLibraryService();
  await service.mergeBackupData({
    version: 1,
    appVersion: '0.9.0',
    exportedAt: new Date('2026-11-17T04:38:00.000Z'),
    songs: [
      {
        id: 'vid-1',
        title: 'Lagu Satu',
        artists: [{ id: 'UC-1', name: 'Artis Satu' }],
        albumId: 'MPRE-1',
        durationSeconds: 180,
        thumbnailUrl: null,
        liked: true,
        inLibrary: true,
        totalPlayTimeMs: 60000,
        dateAdded: 1791926400000,
        downloaded: false,
        unplayable: false,
      },
    ],
    albums: [
      {
        id: 'MPRE-1',
        title: 'Album Satu',
        year: 2024,
        thumbnailUrl: null,
        liked: false,
        dateAdded: null,
      },
    ],
    artists: [
      {
        id: 'UC-1',
        name: 'Artis Satu',
        thumbnailUrl: null,
        liked: false,
        dateAdded: null,
      },
    ],
    playlists: [
      {
        name: 'Favoritku',
        description: 'Lagu-lagu pilihan',
        songIds: ['vid-1'],
        createdAt: 1792099200000,
      },
    ],
    playEvents: [
      { songId: 'vid-1', timestamp: 1792519200000, playTimeMs: 120000 },
    ],
    searchHistory: [{ query: 'noah', timestamp: 1792515600000 }],
    queue: [{ songId: 'vid-1', source: 'library' }],
    playbackState: {
      currentIndex: 0,
      positionMs: 45000,
      shuffleEnabled: true,
      repeatMode: 1,
    },
    settings: null,
  });
  return service;
}

describe('buildBackupData', () => {
  it('salinan berisi semua bagian + urutan artis benar', async () => {
    const service = await seededService();
    const data = await buildBackupData(service);
    expect(data.version).toBe(1);
    expect(data.songs.length).toBe(1);
    expect(data.songs[0]?.title).toBe('Lagu Satu');
    expect(data.songs[0]?.artists).toEqual([
      { id: 'UC-1', name: 'Artis Satu' },
    ]);
    expect(data.albums.length).toBe(1);
    expect(data.artists.length).toBe(1);
    expect(data.playlists.length).toBe(1);
    expect(data.playlists[0]?.songIds).toEqual(['vid-1']);
    expect(data.playEvents.length).toBe(1);
    expect(data.searchHistory.length).toBe(1);
    expect(data.queue).toEqual([{ songId: 'vid-1', source: 'library' }]);
    expect(data.playbackState?.positionMs).toBe(45000);
    expect(data.playbackState?.repeatMode).toBe(1);
  });

  it('pengaturan ikut salinan (urutan, lirik, EQ)', async () => {
    const service = await seededService();
    await service.setMeta(SORT_META_KEY, 'byName');
    await service.setMeta(LYRICS_ENABLED_KEY, '0');
    await service.setMeta(
      EQ_SETTINGS_KEY,
      JSON.stringify({
        preset: 'bass',
        // Gain kanonis bass (normalizeEqSettings menghitung ulang
        // preset dari gain; gain lain jadi 'custom').
        gains: [6, 5, 3, 1, 0, 0, 0, 0, -1, -2],
      }),
    );
    const data = await buildBackupData(service);
    expect(data.settings?.sortSongs).toBe('byName');
    expect(data.settings?.lyricsEnabled).toBe(false);
    expect(data.settings?.eqPresetName).toBe('bass');
    expect(data.settings?.eqGains?.[0]).toBe(6);
    // Field APK tanpa padanan web ditulis null.
    expect(data.settings?.dataSaver).toBeNull();
    expect(data.settings?.defaultQuality).toBeNull();
    expect(data.settings?.playbackSpeed).toBeNull();
  });

  it('database kosong -> salinan kosong yang sah', async () => {
    const service = await getLibraryService();
    const data = await buildBackupData(service);
    expect(data.songs).toEqual([]);
    expect(data.playlists).toEqual([]);
    expect(data.playbackState).toBeNull();
    expect(data.version).toBe(1);
  });

  it('salinan TIDAK PERNAH berisi URL stream', async () => {
    const service = await seededService();
    const data = await buildBackupData(service);
    const text = JSON.stringify(data);
    expect(text).not.toContain('googlevideo.com');
    expect(text).not.toContain('youtube.com/watch');
  });
});

describe('buildExportPayload', () => {
  it('payload normal: nama file sesuai pola APK + ukuran benar', async () => {
    const service = await seededService();
    const data = await buildBackupData(service);
    const payload = buildExportPayload(data);
    expect(payload.outcome).toBe('downloaded');
    expect(payload.text).not.toBeNull();
    expect(payload.fileName).toMatch(
      /^backup-musik-\d{8}-\d{6}\.json$/,
    );
    expect(payload.sizeBytes).toBe(
      new TextEncoder().encode(payload.text ?? '').length,
    );
    expect(payload.sizeBytes).toBeLessThanOrEqual(MAX_BACKUP_BYTES);
  });

  it('salinan di atas 10 MB ditolak dengan outcome tooLarge', () => {
    const data: BackupData = {
      version: 1,
      appVersion: '0.9.0',
      exportedAt: new Date('2026-11-19T00:00:00.000Z'),
      songs: [
        {
          id: 'vid-big',
          title: 'X'.repeat(MAX_BACKUP_BYTES + 1),
          artists: [],
          albumId: null,
          durationSeconds: null,
          thumbnailUrl: null,
          liked: false,
          inLibrary: false,
          totalPlayTimeMs: 0,
          dateAdded: null,
          downloaded: false,
          unplayable: false,
        },
      ],
      albums: [],
      artists: [],
      playlists: [],
      playEvents: [],
      searchHistory: [],
      queue: [],
      playbackState: null,
      settings: null,
    };
    const payload = buildExportPayload(data);
    expect(payload.outcome).toBe('tooLarge');
    expect(payload.text).toBeNull();
    expect(payload.sizeBytes).toBeGreaterThan(MAX_BACKUP_BYTES);
  });
});

describe('triggerBrowserDownload', () => {
  it('membuat Blob + klik tautan unduhan', () => {
    const createSpy = vi.fn<typeof URL.createObjectURL>(() => 'blob:test-url');
    const revokeSpy = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createSpy,
      revokeObjectURL: revokeSpy,
    });
    const clickSpy = vi.fn();
    const originalCreate = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement');
    createElementSpy.mockImplementation(((
      tag: string,
      options?: ElementCreationOptions,
    ) => {
      const el = originalCreate(tag, options);
      if (tag === 'a') {
        el.click = clickSpy as unknown as () => void;
      }
      return el;
    }) as typeof document.createElement);
    try {
      const ok = triggerBrowserDownload('{"v":1}', 'backup-musik-20261119-000000.json');
      expect(ok).toBe(true);
      expect(createSpy).toHaveBeenCalledTimes(1);
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toBe('application/json');
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      createElementSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('gagal membuat URL -> false (bukan throw)', () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        throw new Error('blocked');
      },
      revokeObjectURL: () => undefined,
    });
    try {
      expect(triggerBrowserDownload('{}', 'f.json')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('previewImport + importBackup', () => {
  function sampleBytes(): Uint8Array {
    const json = JSON.stringify({
      backupVersion: 1,
      appVersion: '0.9.0',
      exportedAt: '2026-11-17T04:38:00.000Z',
      songs: [
        {
          id: 'vid-1',
          title: 'Lagu Satu',
          artists: [{ id: 'UC-1', name: 'Artis Satu' }],
          albumId: 'MPRE-1',
          durationSeconds: 180,
          thumbnailUrl: null,
          liked: true,
          inLibrary: true,
          totalPlayTimeMs: 60000,
          dateAdded: 1791926400000,
          downloaded: true,
          unplayable: false,
        },
      ],
      albums: [
        {
          id: 'MPRE-1',
          title: 'Album Satu',
          year: 2024,
          thumbnailUrl: null,
          liked: false,
          dateAdded: null,
        },
      ],
      artists: [{ id: 'UC-1', name: 'Artis Satu' }],
      playlists: [
        {
          name: 'Favoritku',
          description: 'Lagu-lagu pilihan',
          songIds: ['vid-1'],
          createdAt: 1792099200000,
        },
      ],
      playEvents: [],
      searchHistory: [],
      queue: [],
      playbackState: null,
      settings: {
        sortSongs: 'byName',
        lyricsEnabled: false,
        eqPresetName: 'vocal',
        // Gain kanonis vocal (lihat EQ_PRESET_GAINS).
        eqGains: [-2, -1, 0, 1, 2, 3, 3, 2, 1, 0],
      },
    });
    return new TextEncoder().encode(json);
  }

  it('preview tidak mengubah database; impor mengisi + laporan benar', async () => {
    const data = previewImport(sampleBytes());
    const service = await getLibraryService();
    expect((await service.libraryCounts()).songs).toBe(0);
    const report = await importBackup(data, { applySettings: false });
    expect(report.succeeded).toBe(1 + 1 + 1); // lagu + playlist + lagu di playlist
    expect(report.alreadyExisted).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.downloadedSongIds).toEqual(['vid-1']);
    expect(report.appVersion).toBe('0.9.0');
    const counts = await service.libraryCounts();
    expect(counts.songs).toBe(1);
    expect(counts.playlists).toBe(1);
  });

  it('applySettings: urutan + lirik + EQ dari file diterapkan', async () => {
    const data = previewImport(sampleBytes());
    await importBackup(data, { applySettings: true });
    expect(useLibraryStore.getState().sort).toBe('byName');
    const service = await getLibraryService();
    expect(await service.getMeta(LYRICS_ENABLED_KEY)).toBe('0');
    expect(useEqualizerStore.getState().settings.preset).toBe('vocal');
    expect(useEqualizerStore.getState().settings.gains[5]).toBe(3);
    const saved = await service.getMeta(EQ_SETTINGS_KEY);
    expect(saved).toContain('"vocal"');
  });

  it('applySettings false: pengaturan lokal tidak berubah', async () => {
    const service = await getLibraryService();
    await service.setMeta(SORT_META_KEY, 'mostPlayed');
    const data = previewImport(sampleBytes());
    await importBackup(data, { applySettings: false });
    expect(useLibraryStore.getState().sort).toBe('newest');
    expect(await service.getMeta(SORT_META_KEY)).toBe('mostPlayed');
    expect(useEqualizerStore.getState().settings.preset).toBe('flat');
  });

  it('file rusak ditolak preview (bukan crash)', () => {
    expect(() =>
      previewImport(new TextEncoder().encode('bukan json')),
    ).toThrow();
  });
});

describe('applyBackupSettings', () => {
  it('nilai sampah diabaikan, nilai sah diterapkan', async () => {
    await applyBackupSettings({
      dataSaver: true,
      defaultQuality: 'high',
      wifiOnly: true,
      cacheLimitBytes: 123,
      playbackSpeed: 2,
      playbackPitch: 1,
      skipSilence: true,
      sortSongs: 'nonsense' as never,
      eqEnabled: true,
      eqPreset: 5,
      lyricsEnabled: true,
      eqPresetName: 'bass',
      eqGains: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9],
    });
    // Urutan tidak berubah (nilai sampah diabaikan).
    expect(useLibraryStore.getState().sort).toBe('newest');
    // EQ diterapkan; gain [9x10] bukan gain kanonis preset mana
    // pun, jadi preset dihitung ulang jadi 'custom' (perilaku
    // normalizeEqSettings) — gain-nya sendiri tetap dipakai.
    expect(useEqualizerStore.getState().settings.preset).toBe('custom');
    expect(useEqualizerStore.getState().settings.gains[0]).toBe(9);
  });

  it('EQ tanpa gains tidak diterapkan (pasangan tidak lengkap)', async () => {
    await applyBackupSettings({
      dataSaver: null,
      defaultQuality: null,
      wifiOnly: null,
      cacheLimitBytes: null,
      playbackSpeed: null,
      playbackPitch: null,
      skipSilence: null,
      sortSongs: null,
      eqEnabled: null,
      eqPreset: null,
      lyricsEnabled: null,
      eqPresetName: 'bass',
      eqGains: null,
    });
    expect(useEqualizerStore.getState().settings.preset).toBe('flat');
  });
});

describe('capRedownloadIds (Blue 3, R14)', () => {
  it('250 lagu -> 200 diantre + 50 dilewati', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `vid-${i}`);
    const { queued, skipped } = capRedownloadIds(ids);
    expect(queued).toHaveLength(200);
    expect(queued[0]).toBe('vid-0');
    expect(queued[199]).toBe('vid-199');
    expect(skipped).toBe(50);
  });

  it('100 lagu -> semua diantre, tidak ada yang dilewati', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `vid-${i}`);
    const { queued, skipped } = capRedownloadIds(ids);
    expect(queued).toHaveLength(100);
    expect(skipped).toBe(0);
  });
});
