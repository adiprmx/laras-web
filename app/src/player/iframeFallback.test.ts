/**
 * Tes Vitest logika fallback pemutar YouTube (P3).
 *
 * Menutup: gerbang masuk mode fallback (mayoritas
 * LOGIN_REQUIRED + belum dijeda), pemuat API IFrame on-demand
 * (script ditambah sekali, promise di-cache, gagal = tolak),
 * dan registry kontroler (daftar/lepas).
 *
 * Komponen React-nya (IframeFallbackPlayer.tsx) tidak diuji di
 * sini: ia tipis (efek + JSX) dan bergantung pada YT global;
 * logika keputusannya hidup di modul ini.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getIframeController,
  loadYouTubeIframeApi,
  registerIframeController,
  resetYouTubeIframeApiForTests,
  shouldEnterIframeFallback,
  YOUTUBE_IFRAME_API_URL,
  type IframePlayerController,
} from './iframeFallback';

describe('shouldEnterIframeFallback', () => {
  it('mayoritas LOGIN_REQUIRED + sedang memutar -> masuk fallback', () => {
    // Campuran LOGIN_REQUIRED + UNPLAYABLE adalah pola nyata
    // jendela buruk (Blue 7 R21): mayoritas menolak tetap
    // masuk fallback.
    expect(
      shouldEnterIframeFallback({
        attempts: [
          'WEB_REMIX=LOGIN_REQUIRED',
          'MWEB=LOGIN_REQUIRED',
          'ANDROID_VR=UNPLAYABLE',
        ],
        status: 'loading',
      }),
    ).toBe(true);
  });

  it('satu upaya OK -> TIDAK masuk fallback (bukan jendela buruk)', () => {
    expect(
      shouldEnterIframeFallback({
        attempts: [
          'WEB_REMIX=LOGIN_REQUIRED',
          'MWEB=LOGIN_REQUIRED',
          'ANDROID_VR=OK',
        ],
        status: 'loading',
      }),
    ).toBe(false);
  });

  it('semua LOGIN_REQUIRED + idle -> masuk fallback', () => {
    expect(
      shouldEnterIframeFallback({
        attempts: ['WEB_REMIX=LOGIN_REQUIRED', 'MWEB=LOGIN_REQUIRED'],
        status: 'idle',
      }),
    ).toBe(true);
  });

  it('pengguna sudah menjeda -> TIDAK masuk fallback (jangan mulai sendiri)', () => {
    expect(
      shouldEnterIframeFallback({
        attempts: ['WEB_REMIX=LOGIN_REQUIRED', 'MWEB=LOGIN_REQUIRED'],
        status: 'paused',
      }),
    ).toBe(false);
  });

  it('UNPLAYABLE murni (lagu memang tidak ada) -> TIDAK masuk fallback', () => {
    expect(
      shouldEnterIframeFallback({
        attempts: ['WEB_REMIX=UNPLAYABLE', 'MWEB=UNPLAYABLE'],
        status: 'loading',
      }),
    ).toBe(false);
  });

  it('galat proxy saja -> TIDAK masuk fallback', () => {
    expect(
      shouldEnterIframeFallback({
        attempts: ['WEB_REMIX=proxy-gagal', 'MWEB=proxy-gagal'],
        status: 'loading',
      }),
    ).toBe(false);
  });

  it('tanpa upaya sama sekali -> TIDAK masuk fallback', () => {
    expect(
      shouldEnterIframeFallback({ attempts: [], status: 'loading' }),
    ).toBe(false);
  });
});

describe('loadYouTubeIframeApi', () => {
  beforeEach(() => {
    resetYouTubeIframeApiForTests();
    const w = window as unknown as {
      YT?: unknown;
      onYouTubeIframeAPIReady?: unknown;
    };
    delete w.YT;
    delete w.onYouTubeIframeAPIReady;
    document.head
      .querySelectorAll(`script[src="${YOUTUBE_IFRAME_API_URL}"]`)
      .forEach((el) => el.remove());
  });

  afterEach(() => {
    resetYouTubeIframeApiForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('YT sudah ada -> langsung dipakai tanpa menambah script', async () => {
    const fakeYt = { Player: class {} };
    (window as unknown as { YT: unknown }).YT = fakeYt;
    const before = document.head.querySelectorAll('script').length;
    const api = await loadYouTubeIframeApi();
    expect(api).toBe(fakeYt);
    expect(document.head.querySelectorAll('script').length).toBe(before);
  });

  it('script ditambah sekali; callback siap me-resolve; panggilan ke-2 memakai cache', async () => {
    const p1 = loadYouTubeIframeApi();
    const p2 = loadYouTubeIframeApi();
    expect(p1).toBe(p2);
    const scripts = document.head.querySelectorAll(
      `script[src="${YOUTUBE_IFRAME_API_URL}"]`,
    );
    expect(scripts.length).toBe(1);
    const w = window as unknown as {
      YT?: unknown;
      onYouTubeIframeAPIReady?: () => void;
    };
    const fakeYt = { Player: class {} };
    w.YT = fakeYt;
    expect(typeof w.onYouTubeIframeAPIReady).toBe('function');
    w.onYouTubeIframeAPIReady?.();
    await expect(p1).resolves.toBe(fakeYt);
    // Panggilan ketiga sesudah resolve: promise cache yang sama.
    await expect(loadYouTubeIframeApi()).resolves.toBe(fakeYt);
    expect(
      document.head.querySelectorAll(
        `script[src="${YOUTUBE_IFRAME_API_URL}"]`,
      ).length,
    ).toBe(1);
  });

  it('callback siap yang sudah ada tetap dipanggil (dirangkai)', async () => {
    const previous = vi.fn();
    (window as unknown as { onYouTubeIframeAPIReady: () => void })
      .onYouTubeIframeAPIReady = previous;
    const p = loadYouTubeIframeApi();
    const w = window as unknown as {
      YT?: unknown;
      onYouTubeIframeAPIReady?: () => void;
    };
    w.YT = { Player: class {} };
    w.onYouTubeIframeAPIReady?.();
    await p;
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it('script gagal dimuat -> tolak; panggilan berikut mencoba lagi', async () => {
    const p = loadYouTubeIframeApi();
    const script = document.head.querySelector(
      `script[src="${YOUTUBE_IFRAME_API_URL}"]`,
    ) as HTMLScriptElement;
    expect(script).not.toBeNull();
    script.dispatchEvent(new Event('error'));
    await expect(p).rejects.toThrow('gagal dimuat');
    // Cache dikosongkan sesudah gagal: panggilan berikut membuat
    // script baru (bukan promise gagal yang sama).
    const p2 = loadYouTubeIframeApi();
    expect(p2).not.toBe(p);
    expect(
      document.head.querySelectorAll(
        `script[src="${YOUTUBE_IFRAME_API_URL}"]`,
      ).length,
    ).toBe(2);
    // Bersihkan: gagalkan juga yang kedua supaya tidak menggantung.
    const script2 = document.head.querySelectorAll(
      `script[src="${YOUTUBE_IFRAME_API_URL}"]`,
    )[1] as HTMLScriptElement;
    script2.dispatchEvent(new Event('error'));
    await expect(p2).rejects.toThrow('gagal dimuat');
  });

  it('timeout -> tolak', async () => {
    const p = loadYouTubeIframeApi(10);
    await expect(p).rejects.toThrow('timeout');
  });
});

describe('registry kontroler iframe', () => {
  afterEach(() => {
    registerIframeController(null);
  });

  it('daftar -> terbaca; lepas (null) -> null', () => {
    expect(getIframeController()).toBeNull();
    const controller: IframePlayerController = {
      play: () => undefined,
      pause: () => undefined,
      seekTo: () => undefined,
    };
    registerIframeController(controller);
    expect(getIframeController()).toBe(controller);
    registerIframeController(null);
    expect(getIframeController()).toBeNull();
  });

  it('kontroler baru menggantikan yang lama', () => {
    const first: IframePlayerController = {
      play: () => undefined,
      pause: () => undefined,
      seekTo: () => undefined,
    };
    const second: IframePlayerController = {
      play: () => undefined,
      pause: () => undefined,
      seekTo: () => undefined,
    };
    registerIframeController(first);
    registerIframeController(second);
    expect(getIframeController()).toBe(second);
  });
});
