import { describe, expect, it, vi } from 'vitest';
import {
  CANARY_CHECK_INTERVAL_MS,
  CANARY_HEALTH_FRESH_MS,
  canaryHealthSignal,
  computeCanaryStatus,
  createCanaryChecker,
  loadCanaryRecord,
  parseCanaryRecord,
  shouldRunCanary,
  CANARY_RECORD_KEY,
  type CanaryRecord,
} from './canary';
import { createMemoryStorage } from './configStore';
import { ResolveError } from '../extractor/resolve';

const refused = () =>
  new ResolveError('x', 'y', [
    'WEB_REMIX=LOGIN_REQUIRED',
    'MWEB=LOGIN_REQUIRED',
    'ANDROID_VR=LOGIN_REQUIRED',
  ]);

describe('computeCanaryStatus', () => {
  it('ok bila tidak ada yang gagal', () => {
    expect(computeCanaryStatus(0, 0)).toBe('ok');
  });

  it('degraded bila 1-2 gagal', () => {
    expect(computeCanaryStatus(1, 1)).toBe('degraded');
    expect(computeCanaryStatus(2, 1)).toBe('degraded');
  });

  it('broken bila 3+ gagal dalam satu cek', () => {
    expect(computeCanaryStatus(3, 1)).toBe('broken');
    expect(computeCanaryStatus(5, 1)).toBe('broken');
  });

  it('broken bila 3 cek gagal berturut-turut penyebab sama', () => {
    expect(computeCanaryStatus(1, 3)).toBe('broken');
  });
});

describe('shouldRunCanary', () => {
  it('jatuh tempo bila belum pernah cek', () => {
    expect(shouldRunCanary(null, 1_000_000)).toBe(true);
  });

  it('belum jatuh tempo dalam 24 jam', () => {
    expect(
      shouldRunCanary(1_000_000, 1_000_000 + CANARY_CHECK_INTERVAL_MS - 1),
    ).toBe(false);
  });

  it('jatuh tempo sesudah 24 jam', () => {
    expect(
      shouldRunCanary(1_000_000, 1_000_000 + CANARY_CHECK_INTERVAL_MS),
    ).toBe(true);
  });
});

describe('parseCanaryRecord', () => {
  it('menolak JSON rusak atau status tak dikenal', () => {
    expect(parseCanaryRecord(null)).toBeNull();
    expect(parseCanaryRecord('bukan-json')).toBeNull();
    expect(
      parseCanaryRecord(JSON.stringify({ checkedAt: 1, status: 'aneh' })),
    ).toBeNull();
  });

  it('memparse rekaman valid', () => {
    const record = parseCanaryRecord(
      JSON.stringify({
        checkedAt: 123,
        succeeded: 5,
        failed: 0,
        networkFailures: 0,
        dominantCause: null,
        status: 'ok',
        streak: 0,
        streakCause: null,
      }),
    );
    expect(record?.status).toBe('ok');
    expect(record?.succeeded).toBe(5);
  });
});

describe('createCanaryChecker', () => {
  const noDelay = async () => undefined;

  it('semua lolos: ok, tersimpan', async () => {
    const storage = createMemoryStorage();
    const resolveSong = vi.fn(async () => undefined);
    const checker = createCanaryChecker({
      resolveSong,
      now: () => 5_000_000,
      storage,
      delay: noDelay,
      gapMs: 0,
    });
    const outcome = await checker.runCheck();
    expect(outcome.outcome).toBe('ran');
    expect(outcome.record?.status).toBe('ok');
    expect(outcome.record?.succeeded).toBe(5);
    expect(resolveSong).toHaveBeenCalledTimes(5);
    const saved = await checker.loadRecord();
    expect(saved?.checkedAt).toBe(5_000_000);
  });

  it('3 gagal non-jaringan: broken + penyebab dominan', async () => {
    const storage = createMemoryStorage();
    let calls = 0;
    const resolveSong = vi.fn(async () => {
      calls += 1;
      if (calls <= 3) throw refused();
    });
    const checker = createCanaryChecker({
      resolveSong,
      now: () => 5_000_000,
      storage,
      delay: noDelay,
      gapMs: 0,
    });
    const outcome = await checker.runCheck();
    expect(outcome.record?.status).toBe('broken');
    expect(outcome.record?.failed).toBe(3);
    expect(outcome.record?.succeeded).toBe(2);
    expect(outcome.record?.dominantCause).toBe('refused');
  });

  it('semua gagal jaringan: skip, waktu cek tidak dimajukan', async () => {
    const storage = createMemoryStorage();
    const resolveSong = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const checker = createCanaryChecker({
      resolveSong,
      now: () => 5_000_000,
      storage,
      delay: noDelay,
      gapMs: 0,
    });
    const outcome = await checker.runCheck();
    expect(outcome.outcome).toBe('skipped');
    expect(outcome.skippedReason).toBe('offline');
    expect(await checker.loadRecord()).toBeNull();
    expect(await checker.isDue()).toBe(true);
  });

  it('offline (navigator): skip tanpa memanggil resolver', async () => {
    const resolveSong = vi.fn(async () => undefined);
    const checker = createCanaryChecker({
      resolveSong,
      storage: createMemoryStorage(),
      delay: noDelay,
      gapMs: 0,
      online: () => false,
    });
    const outcome = await checker.runCheck();
    expect(outcome.outcome).toBe('skipped');
    expect(resolveSong).not.toHaveBeenCalled();
  });

  it('streak naik bila penyebab dominan sama dengan cek sebelumnya', async () => {
    const storage = createMemoryStorage();
    const resolveSong = vi.fn(async () => {
      throw refused();
    });
    const mk = (nowMs: number) =>
      createCanaryChecker({
        resolveSong,
        now: () => nowMs,
        storage,
        delay: noDelay,
        gapMs: 0,
      });
    const first = await mk(5_000_000).runCheck();
    expect(first.record?.streak).toBe(1);
    const second = await mk(6_000_000).runCheck();
    expect(second.record?.streak).toBe(2);
    expect(second.record?.status).toBe('broken');
  });

  it('streak reset bila cek berikut lolos', async () => {
    const storage = createMemoryStorage();
    let fail = true;
    const resolveSong = vi.fn(async () => {
      if (fail) throw refused();
    });
    const mk = (nowMs: number) =>
      createCanaryChecker({
        resolveSong,
        now: () => nowMs,
        storage,
        delay: noDelay,
        gapMs: 0,
      });
    await mk(5_000_000).runCheck();
    fail = false;
    const second = await mk(6_000_000).runCheck();
    expect(second.record?.status).toBe('ok');
    expect(second.record?.streak).toBe(0);
  });

  it('timeout per lagu dihitung gagal (bukan macet selamanya)', async () => {
    const storage = createMemoryStorage();
    const resolveSong = vi.fn(
      () => new Promise<void>(() => undefined),
    );
    const checker = createCanaryChecker({
      resolveSong,
      now: () => 5_000_000,
      storage,
      delay: noDelay,
      gapMs: 0,
      timeoutMs: 5,
    });
    const outcome = await checker.runCheck();
    expect(outcome.record?.failed).toBe(5);
    expect(outcome.record?.status).toBe('broken');
  }, 10000);

  it('jeda antar lagu dipanggil (hormati rate limit)', async () => {
    const storage = createMemoryStorage();
    const delay = vi.fn(async () => undefined);
    const checker = createCanaryChecker({
      resolveSong: async () => undefined,
      now: () => 5_000_000,
      storage,
      delay,
      gapMs: 1000,
    });
    await checker.runCheck();
    expect(delay).toHaveBeenCalledTimes(4);
    expect(delay).toHaveBeenCalledWith(1000);
  });
});

describe('canaryHealthSignal (hotfix resolve: sinyal untuk pemutar)', () => {
  const NOW = 10_000_000;

  function record(
    overrides: Partial<CanaryRecord> = {},
  ): CanaryRecord {
    return {
      checkedAt: NOW,
      succeeded: 5,
      failed: 0,
      networkFailures: 0,
      dominantCause: null,
      status: 'ok',
      streak: 0,
      streakCause: null,
      ...overrides,
    };
  }

  it('recent-fail: broken baru-baru ini karena YouTube menolak', () => {
    expect(
      canaryHealthSignal(
        record({
          status: 'broken',
          succeeded: 1,
          failed: 4,
          dominantCause: 'refused',
        }),
        NOW,
      ),
    ).toBe('recent-fail');
  });

  it('recent-fail: degraded baru-baru ini karena YouTube menolak', () => {
    expect(
      canaryHealthSignal(
        record({
          status: 'degraded',
          succeeded: 4,
          failed: 1,
          dominantCause: 'refused',
        }),
        NOW,
      ),
    ).toBe('recent-fail');
  });

  it('recent-pass: ok baru-baru ini', () => {
    expect(canaryHealthSignal(record(), NOW)).toBe('recent-pass');
  });

  it('unknown: belum pernah cek', () => {
    expect(canaryHealthSignal(null, NOW)).toBe('unknown');
  });

  it('unknown: gagal tapi sudah basi (> 1 jam)', () => {
    expect(
      canaryHealthSignal(
        record({
          checkedAt: NOW - CANARY_HEALTH_FRESH_MS,
          status: 'broken',
          succeeded: 0,
          failed: 5,
          dominantCause: 'refused',
        }),
        NOW,
      ),
    ).toBe('unknown');
  });

  it('recent-fail: gagal 59 menit lalu masih segar', () => {
    expect(
      canaryHealthSignal(
        record({
          checkedAt: NOW - CANARY_HEALTH_FRESH_MS + 60_000,
          status: 'broken',
          succeeded: 0,
          failed: 5,
          dominantCause: 'refused',
        }),
        NOW,
      ),
    ).toBe('recent-fail');
  });

  it('unknown: gagal baru-baru ini tapi BUKAN karena penolakan', () => {
    expect(
      canaryHealthSignal(
        record({
          status: 'degraded',
          succeeded: 4,
          failed: 1,
          dominantCause: 'no-format',
        }),
        NOW,
      ),
    ).toBe('unknown');
  });
});

describe('loadCanaryRecord', () => {
  it('membaca rekaman tersimpan', async () => {
    const stored: CanaryRecord = {
      checkedAt: 5_000_000,
      succeeded: 2,
      failed: 3,
      networkFailures: 0,
      dominantCause: 'refused',
      status: 'broken',
      streak: 1,
      streakCause: 'refused',
    };
    const storage = createMemoryStorage({
      [CANARY_RECORD_KEY]: JSON.stringify(stored),
    });
    expect(await loadCanaryRecord(storage)).toEqual(stored);
  });

  it('null bila tidak ada rekaman atau storage gagal', async () => {
    expect(await loadCanaryRecord(createMemoryStorage())).toBeNull();
    const broken: Parameters<typeof loadCanaryRecord>[0] = {
      get: async () => {
        throw new Error('DB mati');
      },
      set: async () => undefined,
    };
    expect(await loadCanaryRecord(broken)).toBeNull();
  });
});
