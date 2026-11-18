import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStorage } from './configStore';
import {
  clearPlayerLog,
  getPlayerLog,
  loadPersistedPlayerLog,
  logPlayer,
  persistPlayerLog,
  PLAYER_LOG_KEY,
  PLAYER_LOG_MAX_LINES,
} from './playerLog';

describe('playerLog', () => {
  afterEach(() => {
    clearPlayerLog();
  });

  it('menyimpan maksimal 10 baris, yang lama terbuang', () => {
    for (let i = 0; i < 12; i++) logPlayer(`baris ${i}`);
    const lines = getPlayerLog();
    expect(lines).toHaveLength(PLAYER_LOG_MAX_LINES);
    expect(lines[0]).toContain('baris 2');
    expect(lines[9]).toContain('baris 11');
  });

  it('menyamarkan URL http(s) yang lolos dari pemanggil', () => {
    logPlayer(
      'gagal https://rr1---sn-a.googlevideo.com/videoplayback?expire=1&sig=abc',
    );
    const lines = getPlayerLog();
    expect(lines[0]).toContain('[url]');
    expect(lines[0]).not.toContain('googlevideo.com');
    expect(lines[0]).not.toContain('videoplayback');
    expect(lines[0]).not.toContain('expire=');
  });

  it('mengembalikan salinan (pengubah luar tidak merusak log)', () => {
    logPlayer('satu');
    const lines = getPlayerLog();
    lines.push('palsu');
    expect(getPlayerLog()).toHaveLength(1);
  });

  it('log bertahan melewati "reload": persist lalu muat ulang', async () => {
    const storage = createMemoryStorage();
    logPlayer('baris pertama');
    await persistPlayerLog(storage);
    logPlayer('baris kedua');
    await persistPlayerLog(storage);
    // Simulasi reload: memori dikosongkan, storage tetap.
    clearPlayerLog();
    expect(getPlayerLog()).toHaveLength(0);
    const loaded = await loadPersistedPlayerLog(storage);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toContain('baris pertama');
    expect(loaded[1]).toContain('baris kedua');
  });

  it('muat log rusak / hilang = array kosong, bukan galat', async () => {
    const empty = createMemoryStorage();
    expect(await loadPersistedPlayerLog(empty)).toEqual([]);
    const corrupt = createMemoryStorage({ [PLAYER_LOG_KEY]: '{bukan json' });
    expect(await loadPersistedPlayerLog(corrupt)).toEqual([]);
    const notArray = createMemoryStorage({
      [PLAYER_LOG_KEY]: JSON.stringify({ a: 1 }),
    });
    expect(await loadPersistedPlayerLog(notArray)).toEqual([]);
    const mixed = createMemoryStorage({
      [PLAYER_LOG_KEY]: JSON.stringify(['ok', 42, null, 'juga ok']),
    });
    expect(await loadPersistedPlayerLog(mixed)).toEqual([
      'ok',
      'juga ok',
    ]);
  });

  it('persist yang gagal tidak melempar (IndexedDB mati)', async () => {
    const failing = {
      get: async () => {
        throw new Error('db mati');
      },
      set: async () => {
        throw new Error('db mati');
      },
    };
    logPlayer('tetap di memori');
    await expect(persistPlayerLog(failing)).resolves.toBeUndefined();
    expect(await loadPersistedPlayerLog(failing)).toEqual([]);
    expect(getPlayerLog()).toHaveLength(1);
  });
});
