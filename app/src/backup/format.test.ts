/**
 * Tes format file salinan (P8, PRD B10.1): round-trip, validasi,
 * penolakan versi lebih baru, dan batas ukuran. Tes murni (tanpa
 * database).
 *
 * Contoh utama (`APK_SAMPLE_JSON`) adalah bentuk JSON persis yang
 * ditulis APK untuk data yang sama dengan `sampleBackup()` di tes
 * APK `backup_format_test.dart` — membuktikan file APK bisa
 * dibaca web tanpa perubahan apa pun.
 */
import { describe, expect, it } from 'vitest';
import {
  BackupException,
  backupFileName,
  CURRENT_BACKUP_VERSION,
  downloadedSongIds,
  encodeBackupData,
  favoriteCount,
  formatBackupDate,
  MAX_BACKUP_BYTES,
  parseBackupBytes,
  parseBackupText,
  type BackupData,
} from './format';

/** JSON persis seperti yang ditulis APK (encode `sampleBackup()`). */
const APK_SAMPLE_JSON =
  '{"backupVersion":1,"appVersion":"0.9.0",' +
  '"exportedAt":"2026-11-17T04:38:00.000Z",' +
  '"songs":[' +
  '{"id":"vid-1","title":"Lagu Satu",' +
  '"artists":[{"id":"UC-1","name":"Artis Satu"}],' +
  '"albumId":"MPRE-1","durationSeconds":180,"thumbnailUrl":null,' +
  '"liked":true,"inLibrary":true,"totalPlayTimeMs":60000,' +
  '"dateAdded":1791926400000,"downloaded":true,"unplayable":false},' +
  '{"id":"vid-2","title":"Lagu Dua","artists":[],' +
  '"albumId":null,"durationSeconds":null,"thumbnailUrl":null,' +
  '"liked":false,"inLibrary":false,"totalPlayTimeMs":0,' +
  '"dateAdded":null,"downloaded":false,"unplayable":false}],' +
  '"albums":[{"id":"MPRE-1","title":"Album Satu","year":2024,' +
  '"thumbnailUrl":null,"liked":false,"dateAdded":null}],' +
  '"artists":[{"id":"UC-1","name":"Artis Satu","thumbnailUrl":null,' +
  '"liked":false,"dateAdded":null}],' +
  '"playlists":[{"name":"Favoritku","description":"Lagu-lagu pilihan",' +
  '"songIds":["vid-1","vid-2"],"createdAt":1792099200000}],' +
  '"playEvents":[{"songId":"vid-1","timestamp":1792519200000,' +
  '"playTimeMs":120000}],' +
  '"searchHistory":[{"query":"noah","timestamp":1792515600000}],' +
  '"queue":[{"songId":"vid-1","source":"library"},' +
  '{"songId":"vid-2","source":null}],' +
  '"playbackState":{"currentIndex":1,"positionMs":45000,' +
  '"shuffleEnabled":true,"repeatMode":1},' +
  '"settings":{"dataSaver":true,"defaultQuality":"balanced",' +
  '"wifiOnly":true,"cacheLimitBytes":1073741824,' +
  '"playbackSpeed":1.25,"playbackPitch":1.0,"skipSilence":true,' +
  '"sortSongs":"byName","eqEnabled":true,"eqPreset":2,' +
  '"lyricsEnabled":null,"eqPresetName":null,"eqGains":null}}';

function expectKind(fn: () => unknown, kind: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BackupException);
    expect((error as BackupException).kind).toBe(kind);
    return;
  }
  throw new Error(`diharapkan BackupException(${kind}), tidak ada yang dilempar`);
}

describe('parseBackupText (kompatibilitas APK)', () => {
  it('file APK dibaca utuh: semua bagian terisi', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    expect(parsed.version).toBe(CURRENT_BACKUP_VERSION);
    expect(parsed.appVersion).toBe('0.9.0');
    expect(parsed.songs.length).toBe(2);
    expect(parsed.songs[0]?.id).toBe('vid-1');
    expect(parsed.songs[0]?.title).toBe('Lagu Satu');
    expect(parsed.songs[0]?.artists.length).toBe(1);
    expect(parsed.songs[0]?.artists[0]?.name).toBe('Artis Satu');
    expect(parsed.songs[0]?.albumId).toBe('MPRE-1');
    expect(parsed.songs[0]?.liked).toBe(true);
    expect(parsed.songs[0]?.downloaded).toBe(true);
    expect(parsed.songs[0]?.totalPlayTimeMs).toBe(60000);
    expect(parsed.albums.length).toBe(1);
    expect(parsed.albums[0]?.year).toBe(2024);
    expect(parsed.artists.length).toBe(1);
    expect(parsed.playlists.length).toBe(1);
    expect(parsed.playlists[0]?.songIds).toEqual(['vid-1', 'vid-2']);
    expect(parsed.playEvents.length).toBe(1);
    expect(parsed.playEvents[0]?.playTimeMs).toBe(120000);
    expect(parsed.searchHistory.length).toBe(1);
    expect(parsed.searchHistory[0]?.query).toBe('noah');
    expect(parsed.queue.length).toBe(2);
    expect(parsed.queue[0]?.source).toBe('library');
    expect(parsed.playbackState?.currentIndex).toBe(1);
    expect(parsed.playbackState?.shuffleEnabled).toBe(true);
    expect(parsed.settings?.dataSaver).toBe(true);
    expect(parsed.settings?.defaultQuality).toBe('balanced');
    expect(parsed.settings?.cacheLimitBytes).toBe(1073741824);
    expect(parsed.settings?.playbackSpeed).toBe(1.25);
    expect(parsed.settings?.sortSongs).toBe('byName');
    expect(parsed.settings?.eqPreset).toBe(2);
    expect(downloadedSongIds(parsed)).toEqual(['vid-1']);
    expect(favoriteCount(parsed)).toBe(1);
  });

  it('round-trip: encode lalu parse mengembalikan isi yang sama', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const again = parseBackupText(encodeBackupData(parsed));
    expect(again.songs.length).toBe(2);
    expect(again.songs[0]?.title).toBe('Lagu Satu');
    expect(again.playlists[0]?.songIds).toEqual(['vid-1', 'vid-2']);
    expect(again.settings?.sortSongs).toBe('byName');
    expect(again.exportedAt.toISOString()).toBe('2026-11-17T04:38:00.000Z');
  });

  it('file kosong (hanya header) lolos: semua daftar kosong', () => {
    const parsed = parseBackupText(
      '{"backupVersion":1,"appVersion":"0.9.0",' +
        '"exportedAt":"2026-11-17T04:38:00.000Z"}',
    );
    expect(parsed.songs).toEqual([]);
    expect(parsed.playlists).toEqual([]);
    expect(parsed.settings).toBeNull();
  });

  it('JSON bukan objek -> notBackup', () => {
    expectKind(() => parseBackupText('[1,2,3]'), 'notBackup');
  });

  it('JSON rusak -> invalidJson', () => {
    expectKind(() => parseBackupText('{bukan json'), 'invalidJson');
  });

  it('UTF-8 tidak valid -> invalidJson', () => {
    expectKind(
      () => parseBackupBytes(new Uint8Array([0xff, 0xfe])),
      'invalidJson',
    );
  });

  it('tanpa backupVersion -> notBackup', () => {
    expectKind(
      () => parseBackupText('{"appVersion":"0.9.0"}'),
      'notBackup',
    );
  });

  it('backupVersion lebih baru ditolak (B10.1)', () => {
    expectKind(
      () =>
        parseBackupText(
          '{"backupVersion":99,"appVersion":"9.9.9",' +
            '"exportedAt":"2026-11-17T04:38:00.000Z"}',
        ),
      'newerVersion',
    );
  });

  it('backupVersion 0 -> notBackup', () => {
    expectKind(
      () =>
        parseBackupText(
          '{"backupVersion":0,"appVersion":"0.9.0",' +
            '"exportedAt":"2026-11-17T04:38:00.000Z"}',
        ),
      'notBackup',
    );
  });

  it('file di atas 10 MB ditolak sebelum parsing', () => {
    const big = new Uint8Array(MAX_BACKUP_BYTES + 1);
    expectKind(() => parseBackupBytes(big), 'tooLarge');
  });

  it('id lagu ganda -> invalidStructure', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const json = JSON.parse(encodeBackupData(parsed)) as {
      songs: unknown[];
    };
    json.songs.push(json.songs[0]);
    expectKind(
      () => parseBackupText(JSON.stringify(json)),
      'invalidStructure',
    );
  });

  it('playlist menunjuk lagu yang tidak ada -> invalidStructure', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const json = JSON.parse(encodeBackupData(parsed)) as {
      playlists: Array<{ songIds: string[] }>;
    };
    json.playlists[0]?.songIds.push('vid-hilang');
    expectKind(
      () => parseBackupText(JSON.stringify(json)),
      'invalidStructure',
    );
  });

  it('lagu menunjuk album yang tidak ada -> invalidStructure', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const json = JSON.parse(encodeBackupData(parsed)) as {
      songs: Array<{ albumId: string | null }>;
    };
    if (json.songs[0]) json.songs[0].albumId = 'MPRE-hilang';
    expectKind(
      () => parseBackupText(JSON.stringify(json)),
      'invalidStructure',
    );
  });

  it('riwayat menunjuk lagu yang tidak ada -> invalidStructure', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const json = JSON.parse(encodeBackupData(parsed)) as {
      playEvents: Array<{ songId: string }>;
    };
    if (json.playEvents[0]) json.playEvents[0].songId = 'vid-hilang';
    expectKind(
      () => parseBackupText(JSON.stringify(json)),
      'invalidStructure',
    );
  });

  it('antrean menunjuk lagu yang tidak ada -> invalidStructure', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const json = JSON.parse(encodeBackupData(parsed)) as {
      queue: Array<{ songId: string }>;
    };
    if (json.queue[0]) json.queue[0].songId = 'vid-hilang';
    expectKind(
      () => parseBackupText(JSON.stringify(json)),
      'invalidStructure',
    );
  });

  it('antrean lebih dari 200 item -> invalidStructure', () => {
    const songs: Array<Record<string, unknown>> = [];
    const queue: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 201; i++) {
      songs.push({
        id: `vid-${i}`,
        title: `Lagu ${i}`,
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
      });
      queue.push({ songId: `vid-${i}`, source: null });
    }
    expectKind(
      () =>
        parseBackupText(
          JSON.stringify({
            backupVersion: 1,
            appVersion: '0.9.0',
            exportedAt: '2026-11-17T04:38:00.000Z',
            songs,
            queue,
          }),
        ),
      'invalidStructure',
    );
  });

  it('playbackState rusak -> invalidStructure', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const json = JSON.parse(encodeBackupData(parsed)) as {
      playbackState: Record<string, unknown>;
    };
    json.playbackState.repeatMode = 9;
    expectKind(
      () => parseBackupText(JSON.stringify(json)),
      'invalidStructure',
    );
  });

  it('pengaturan salah tipe diabaikan, file tetap lolos', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const json = JSON.parse(encodeBackupData(parsed)) as {
      settings: Record<string, unknown>;
    };
    json.settings.sortSongs = 123;
    json.settings.dataSaver = 'ya';
    json.settings.eqGains = 'bukan-daftar';
    const again = parseBackupText(JSON.stringify(json));
    expect(again.settings?.sortSongs).toBeNull();
    expect(again.settings?.dataSaver).toBeNull();
    expect(again.settings?.eqGains).toBeNull();
    expect(again.songs.length).toBe(2);
  });

  it('field web (lirik + EQ) ikut round-trip', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const json = JSON.parse(encodeBackupData(parsed)) as {
      settings: Record<string, unknown>;
    };
    json.settings.lyricsEnabled = false;
    json.settings.eqPresetName = 'bass';
    json.settings.eqGains = [6, 5, 3, 1, 0, 0, 0, 0, 0, 0];
    const again = parseBackupText(JSON.stringify(json));
    expect(again.settings?.lyricsEnabled).toBe(false);
    expect(again.settings?.eqPresetName).toBe('bass');
    expect(again.settings?.eqGains).toEqual([6, 5, 3, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('kunci tak dikenal diabaikan (kompatibilitas maju)', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const json = JSON.parse(encodeBackupData(parsed)) as Record<
      string,
      unknown
    >;
    json['fiturMasaDepan'] = { aneh: true };
    const again = parseBackupText(JSON.stringify(json));
    expect(again.songs.length).toBe(2);
  });

  it('appVersion hilang -> invalidStructure', () => {
    expectKind(
      () =>
        parseBackupText(
          '{"backupVersion":1,"exportedAt":"2026-11-17T04:38:00.000Z"}',
        ),
      'invalidStructure',
    );
  });

  it('exportedAt bukan tanggal ISO -> invalidStructure', () => {
    expectKind(
      () =>
        parseBackupText(
          '{"backupVersion":1,"appVersion":"0.9.0",' +
            '"exportedAt":"kemarin"}',
        ),
      'invalidStructure',
    );
  });
});

describe('nama file + tanggal', () => {
  it('backupFileName memakai format APK', () => {
    // Zona waktu lokal VM: bangun tanggal dari komponen lokal.
    const when = new Date(2026, 10, 19, 9, 5, 7);
    expect(backupFileName(when)).toBe('backup-musik-20261119-090507.json');
  });

  it('formatBackupDate memakai bulan Indonesia', () => {
    const when = new Date(2026, 10, 17, 4, 38);
    expect(formatBackupDate(when)).toBe('17 Nov 2026, 04.38');
  });
});

describe('encodeBackupData', () => {
  it('tidak pernah menulis URL stream', () => {
    const parsed = parseBackupText(APK_SAMPLE_JSON);
    const text = encodeBackupData(parsed);
    expect(text).not.toContain('googlevideo');
    expect(text).not.toContain('streamUrl');
    expect(text).not.toContain('mimeType');
  });

  it('data kosong tetap menulis semua kunci', () => {
    const empty: BackupData = {
      version: 1,
      appVersion: '0.9.0',
      exportedAt: new Date('2026-11-19T00:00:00.000Z'),
      songs: [],
      albums: [],
      artists: [],
      playlists: [],
      playEvents: [],
      searchHistory: [],
      queue: [],
      playbackState: null,
      settings: null,
    };
    const json = JSON.parse(encodeBackupData(empty)) as Record<
      string,
      unknown
    >;
    expect(json['backupVersion']).toBe(1);
    expect(json['songs']).toEqual([]);
    expect(json['playlists']).toEqual([]);
    expect(json['playbackState']).toBeNull();
  });
});

describe('parseBackupText: cap per-field dan per-koleksi (Blue 3, R14)', () => {
  const base = {
    backupVersion: 1,
    appVersion: '0.9.0',
    exportedAt: '2026-11-17T04:38:00.000Z',
  };

  function song(overrides: Record<string, unknown> = {}) {
    return {
      id: 'vid-1',
      title: 'Lagu Satu',
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
      ...overrides,
    };
  }

  it('judul lagu 1.001 karakter ditolak, 1.000 diterima', () => {
    expectKind(
      () =>
        parseBackupText(
          JSON.stringify({ ...base, songs: [song({ title: 'x'.repeat(1001) })] }),
        ),
      'invalidStructure',
    );
    const ok = parseBackupText(
      JSON.stringify({ ...base, songs: [song({ title: 'x'.repeat(1000) })] }),
    );
    expect(ok.songs).toHaveLength(1);
  });

  it('query pencarian 501 karakter ditolak', () => {
    expectKind(
      () =>
        parseBackupText(
          JSON.stringify({
            ...base,
            searchHistory: [{ query: 'x'.repeat(501), timestamp: 1 }],
          }),
        ),
      'invalidStructure',
    );
  });

  it('1.001 playlist ditolak, 1.000 diterima', () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `P${i}`,
        description: null,
        songIds: [],
        createdAt: null,
      }));
    expectKind(
      () => parseBackupText(JSON.stringify({ ...base, playlists: make(1001) })),
      'invalidStructure',
    );
    const ok = parseBackupText(JSON.stringify({ ...base, playlists: make(1000) }));
    expect(ok.playlists).toHaveLength(1000);
  });

  it('10.001 entri riwayat putar ditolak', () => {
    const playEvents = Array.from({ length: 10001 }, (_, i) => ({
      songId: 'vid-1',
      timestamp: i,
      playTimeMs: 0,
    }));
    expectKind(
      () =>
        parseBackupText(
          JSON.stringify({ ...base, songs: [song()], playEvents }),
        ),
      'invalidStructure',
    );
  });

  it('101 query riwayat pencarian ditolak', () => {
    const searchHistory = Array.from({ length: 101 }, (_, i) => ({
      query: `q${i}`,
      timestamp: i,
    }));
    expectKind(
      () => parseBackupText(JSON.stringify({ ...base, searchHistory })),
      'invalidStructure',
    );
  });

  it('playlist dengan 1.001 lagu ditolak', () => {
    const songIds = Array.from({ length: 1001 }, () => 'vid-1');
    expectKind(
      () =>
        parseBackupText(
          JSON.stringify({
            ...base,
            songs: [song()],
            playlists: [
              { name: 'P', description: null, songIds, createdAt: null },
            ],
          }),
        ),
      'invalidStructure',
    );
  });

  it('lagu dengan 51 artis ditolak', () => {
    const artists = Array.from({ length: 51 }, (_, i) => ({
      id: `a${i}`,
      name: `Artis ${i}`,
    }));
    expectKind(
      () =>
        parseBackupText(
          JSON.stringify({ ...base, songs: [song({ artists })] }),
        ),
      'invalidStructure',
    );
  });

  it('50.001 lagu ditolak', () => {
    const songs = Array.from({ length: 50001 }, (_, i) =>
      song({ id: `vid-${i}` }),
    );
    expectKind(
      () => parseBackupText(JSON.stringify({ ...base, songs })),
      'invalidStructure',
    );
  });

  it('eqGains 11 angka diabaikan (jadi null), bukan menolak file', () => {
    const parsed = parseBackupText(
      JSON.stringify({
        ...base,
        settings: { eqGains: Array(11).fill(0), eqPresetName: 'custom' },
      }),
    );
    expect(parsed.settings?.eqGains).toBeNull();
  });
});
