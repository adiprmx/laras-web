import { describe, expect, it } from 'vitest';
import {
  advanceLadder,
  BACKGROUND_RETRY_BACKOFF_MS,
  isLadderDue,
  isLoginRequiredOnly,
  RETRY_LADDER_MAX_PLAYER_REQUESTS,
  RETRY_LADDER_TOTAL_WAIT_MS,
  startLadder,
} from './retryLadder';
import { RESOLVE_RETRY_BACKOFF_MS } from './retry';

describe('tangga retry latar', () => {
  it('tangga penuh: 5 dtk / 15 dtk / 60 dtk / 5 mnt, total jeda 380 dtk', () => {
    expect(RESOLVE_RETRY_BACKOFF_MS).toEqual([5000, 15000]);
    expect(BACKGROUND_RETRY_BACKOFF_MS).toEqual([60_000, 300_000]);
    expect(RETRY_LADDER_TOTAL_WAIT_MS).toBe(380_000);
    // 5 putaran (1 awal + 2 cepat + 2 latar) x 3 client.
    expect(RETRY_LADDER_MAX_PLAYER_REQUESTS).toBe(15);
  });

  it('startLadder menjadwalkan percobaan pertama 60 dtk ke depan', () => {
    const state = startLadder('vid1', 1_000_000);
    expect(state).toEqual({
      videoId: 'vid1',
      step: 0,
      nextAttemptAt: 1_060_000,
    });
  });

  it('advanceLadder menjadwalkan langkah 5 menit, lalu tangga habis', () => {
    const first = startLadder('vid1', 1_000_000);
    expect(first).not.toBeNull();
    // Percobaan latar 1 gagal di tenggatnya: langkah berikut 5 mnt.
    const second = advanceLadder(first!, 1_060_000);
    expect(second).toEqual({
      videoId: 'vid1',
      step: 1,
      nextAttemptAt: 1_360_000,
    });
    // Percobaan latar 2 gagal: tidak ada langkah berikut.
    expect(advanceLadder(second!, 1_360_000)).toBeNull();
  });

  it('isLadderDue hanya benar sesudah tenggat lewat', () => {
    const state = startLadder('vid1', 1_000_000)!;
    expect(isLadderDue(state, 1_059_999)).toBe(false);
    expect(isLadderDue(state, 1_060_000)).toBe(true);
    // Tenggat yang sudah lama lewat (tab di latar berjam-jam)
    // tetap jatuh tempo: percobaan jalan segera saat tab kembali.
    expect(isLadderDue(state, 1_060_000 + 3_600_000)).toBe(true);
  });

  it('startLadder null bila daftar jeda kosong (tangga dimatikan)', () => {
    expect(startLadder('vid1', 1_000_000, [])).toBeNull();
  });

  it('tangga memakai jeda injeksi (tes service memakai jeda pendek)', () => {
    const state = startLadder('vid1', 1_000_000, [100, 200]);
    expect(state?.nextAttemptAt).toBe(1_000_100);
    const next = advanceLadder(state!, 1_000_100, [100, 200]);
    expect(next?.nextAttemptAt).toBe(1_000_300);
    expect(advanceLadder(next!, 1_000_300, [100, 200])).toBeNull();
  });
});

describe('isLoginRequiredOnly', () => {
  it('benar bila semua upaya LOGIN_REQUIRED', () => {
    expect(
      isLoginRequiredOnly([
        'WEB_REMIX=LOGIN_REQUIRED',
        'MWEB=LOGIN_REQUIRED',
        'ANDROID_VR=LOGIN_REQUIRED',
      ]),
    ).toBe(true);
  });

  it('benar untuk 9 upaya (3 putaran x 3 client) semua LOGIN_REQUIRED', () => {
    const attempts: string[] = [];
    for (let round = 0; round < 3; round++) {
      attempts.push(
        'WEB_REMIX=LOGIN_REQUIRED',
        'MWEB=LOGIN_REQUIRED',
        'ANDROID_VR=LOGIN_REQUIRED',
      );
    }
    expect(isLoginRequiredOnly(attempts)).toBe(true);
  });

  it('salah bila satu upaya UNPLAYABLE (bisa lagu yang tidak ada)', () => {
    expect(
      isLoginRequiredOnly([
        'WEB_REMIX=LOGIN_REQUIRED',
        'MWEB=LOGIN_REQUIRED',
        'ANDROID_VR=UNPLAYABLE',
      ]),
    ).toBe(false);
  });

  it('salah bila semua UNPLAYABLE', () => {
    expect(
      isLoginRequiredOnly([
        'WEB_REMIX=UNPLAYABLE',
        'MWEB=UNPLAYABLE',
        'ANDROID_VR=UNPLAYABLE',
      ]),
    ).toBe(false);
  });

  it('salah untuk OK tanpa format, proxy-gagal, jaringan-gagal, solver-gagal', () => {
    expect(
      isLoginRequiredOnly([
        'WEB_REMIX=OK',
        'MWEB=OK',
        'ANDROID_VR=OK',
      ]),
    ).toBe(false);
    expect(
      isLoginRequiredOnly([
        'WEB_REMIX=LOGIN_REQUIRED',
        'MWEB=proxy-gagal',
        'ANDROID_VR=LOGIN_REQUIRED',
      ]),
    ).toBe(false);
    expect(
      isLoginRequiredOnly([
        'WEB_REMIX=LOGIN_REQUIRED',
        'MWEB=jaringan-gagal',
        'ANDROID_VR=LOGIN_REQUIRED',
      ]),
    ).toBe(false);
    expect(
      isLoginRequiredOnly([
        'WEB_REMIX=LOGIN_REQUIRED',
        'MWEB=solver-gagal',
        'ANDROID_VR=LOGIN_REQUIRED',
      ]),
    ).toBe(false);
  });

  it('salah bila tidak ada upaya', () => {
    expect(isLoginRequiredOnly([])).toBe(false);
  });
});
