// @vitest-environment jsdom
/**
 * Tes komponen SpikePage (diagnostik media error + cache).
 *
 * Kontrak yang diuji (diimplementasikan Tim A):
 * - Listener error audio dipasang SEBELUM play() pertama, sehingga
 *   event error yang datang bersamaan dengan penolakan play() tetap
 *   tertangkap dan kodenya masuk laporan.
 * - playTrack mengembalikan mediaError yang ditangkap; startRun
 *   mencatat fromCache dari track + mediaErrorCode/Message dari hasil
 *   putar ke hasil lagu.
 * - failCause di layar tetap bahasa sehari-hari; detail media error
 *   HANYA di teks laporan, bukan di daftar lagu yang terlihat.
 *
 * Stub play() mendispatch event 'error' SECARA SINKRON sebelum
 * menolak promise-nya — ini meniru browser (event error datang
 * sebelum play() ditolak) dan membuktikan listener sudah terpasang
 * sebelum play: bila listener dipasang sesudah play seperti kode
 * lama, event ini terlewat dan laporan tidak berisi kode error.
 *
 * Tes error tengah lagu (S-2) memakai playMode 'resolve': play()
 * resolve sehingga executor jalan, lalu tes mendispatch event error
 * sendiri sekali per lagu. Mode 'resolveThenRetryFail' membuat
 * panggilan play() ke-2 (retry tengah lagu) gagal dengan MediaError
 * kode 4 — membuktikan finish() memakai kode segar (S-1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SpikePage from './SpikePage';

const mockConfig = vi.hoisted(() => ({
  fromCache: false,
  dispatchError: false,
  playMode: 'reject' as 'reject' | 'resolve' | 'resolveThenRetryFail',
  playCalls: 0,
}));

vi.mock('../extractor/resolve', () => {
  class ResolveError extends Error {
    readonly causeText: string;

    constructor(message: string, causeText: string) {
      super(message);
      this.name = 'ResolveError';
      this.causeText = causeText;
    }
  }

  class StreamResolver {
    playerHash: string | null = null;

    async init(): Promise<{ fromRemote: boolean }> {
      return { fromRemote: false };
    }

    async resolve(song: { videoId: string; title: string }) {
      return {
        videoId: song.videoId,
        title: song.title,
        url: 'https://example.invalid/audio.webm',
        itag: 251,
        bitrate: 160000,
        client: 'ANDROID_VR',
        usedSolver: false,
        hash: null,
        resolveMs: 100,
        fromCache: mockConfig.fromCache,
      };
    }

    dispose(): void {
      // no-op
    }
  }

  return { ResolveError, StreamResolver };
});

// React 19: tandai lingkungan tes supaya act() tidak memperingatkan.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const originalPlay = HTMLMediaElement.prototype.play;
const originalPause = HTMLMediaElement.prototype.pause;
const originalLoad = HTMLMediaElement.prototype.load;

async function renderSpike(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<SpikePage />);
  });
}

async function clickCepat(): Promise<void> {
  const button = container?.querySelector(
    '[data-testid="spike-mode-cepat"]',
  );
  if (!button) throw new Error('tombol spike-mode-cepat tidak ditemukan');
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function reportText(): string {
  return (
    container?.querySelector('[data-testid="spike-report"]')?.textContent ?? ''
  );
}

function songListText(): string {
  return (
    container?.querySelector('[data-testid="spike-song-list"]')?.textContent ??
    ''
  );
}

function audioElement(): HTMLAudioElement {
  const audio = container?.querySelector('[data-testid="spike-audio"]');
  if (!(audio instanceof HTMLAudioElement)) {
    throw new Error('elemen spike-audio tidak ditemukan');
  }
  return audio;
}

/**
 * Picu error tengah lagu: pasang MediaError di elemen audio lalu
 * dispatch event 'error'. Dipanggil sekali per lagu, tiap panggilan
 * dalam act tersendiri — lagu berikut sudah masuk fase executor saat
 * dispatch berikutnya (resolve + play mock adalah microtask).
 */
function dispatchMidSongError(
  code = 2,
  message = 'The network connection was lost.',
): void {
  const audio = audioElement();
  Object.defineProperty(audio, 'error', {
    value: { code, message },
    configurable: true,
  });
  audio.dispatchEvent(new Event('error'));
}

/** Ambil potongan laporan untuk satu lagu (nomor 1-5). */
function songSection(report: string, songNumber: number): string {
  const lines = report.split('\n');
  const start = lines.findIndex((line) =>
    line.startsWith(`${songNumber}. `),
  );
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\d+\. /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

beforeEach(() => {
  mockConfig.fromCache = false;
  mockConfig.dispatchError = false;
  mockConfig.playMode = 'reject';
  mockConfig.playCalls = 0;
  HTMLMediaElement.prototype.play = vi.fn(function (
    this: HTMLMediaElement,
  ): Promise<void> {
    mockConfig.playCalls += 1;
    if (mockConfig.dispatchError) {
      Object.defineProperty(this, 'error', {
        value: { code: 2, message: 'The network connection was lost.' },
        configurable: true,
      });
      // Sinkron: meniru browser, event error datang sebelum play()
      // ditolak — listener yang dipasang sesudah play akan melewatkannya.
      this.dispatchEvent(new Event('error'));
    }
    // Mode 'resolveThenRetryFail': panggilan play() ke-2 (retry tengah
    // lagu) gagal dengan MediaError kode 4. Event error-nya ditunda
    // tepat 3 microtask-hop: cukup lama supaya penolakan play()
    // merambat sampai resumeAfterRetry mengembalikan false, tapi
    // cukup cepat supaya penangkap media error sempat memperbarui
    // lastMediaError SEBELUM onError pertama memanggil finish().
    // Tanpa jeda ini, onError kedua yang ikut terpicu event error
    // akan finish duluan dengan kodenya sendiri (MAX_MID_SONG_RETRY
    // = 1, jadi retry keduanya langsung ditolak) dan tes (b) di bawah
    // akan lolos di kode lama juga — tidak lagi membuktikan S-1.
    if (
      mockConfig.playMode === 'resolveThenRetryFail' &&
      mockConfig.playCalls === 2
    ) {
      // Arrow menangkap `this` (elemen audio) secara leksikal.
      void Promise.resolve()
        .then(() => undefined)
        .then(() => undefined)
        .then(() => {
          Object.defineProperty(this, 'error', {
            value: { code: 4, message: 'The media resource is not supported.' },
            configurable: true,
          });
          this.dispatchEvent(new Event('error'));
        });
      return Promise.reject(new Error('play failed'));
    }
    if (
      mockConfig.playMode === 'resolve' ||
      mockConfig.playMode === 'resolveThenRetryFail'
    ) {
      return Promise.resolve();
    }
    return Promise.reject(new Error('play failed'));
  });
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  HTMLMediaElement.prototype.play = originalPlay;
  HTMLMediaElement.prototype.pause = originalPause;
  HTMLMediaElement.prototype.load = originalLoad;
});

describe('SpikePage (diagnostik media error + cache)', () => {
  it('cache + media error: laporan berisi keduanya, layar tetap bahasa sehari-hari', async () => {
    mockConfig.fromCache = true;
    mockConfig.dispatchError = true;
    await renderSpike();
    await clickCepat();

    const report = reportText();
    // Penjaga anti-vakum: run selesai (kelima lagu gagal di play).
    expect(report).toContain('Hasil: 0/5 lagu selesai');
    expect(report).toContain('dari cache');
    expect(report).toContain('Media error: kode 2');
    expect(report).toContain('The network connection was lost.');

    // Layar: penyebab gagal bahasa sehari-hari, tanpa jargon media error.
    const list = songListText();
    expect(list).toContain('Pemutar gagal memulai lagu.');
    expect(list).not.toContain('Media error');
  });

  it('tanpa media error: laporan tidak berisi baris Media error', async () => {
    mockConfig.dispatchError = false;
    await renderSpike();
    await clickCepat();

    const report = reportText();
    expect(report).toContain('Hasil: 0/5 lagu selesai');
    expect(report).not.toContain('Media error');
  });

  it('tanpa cache: laporan tidak berisi "dari cache"', async () => {
    mockConfig.fromCache = false;
    await renderSpike();
    await clickCepat();

    const report = reportText();
    expect(report).toContain('Hasil: 0/5 lagu selesai');
    expect(report).not.toContain('dari cache');
  });
});

describe('SpikePage (error tengah lagu, S-2)', () => {
  it('error tengah lagu: kode media error dan penyebab konsisten', async () => {
    mockConfig.playMode = 'resolve';
    await renderSpike();
    await clickCepat();

    // Kelima lagu: play resolve, lalu error tengah lagu (heard=0,
    // jadi tanpa retry) — tiap dispatch dalam act tersendiri.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        dispatchMidSongError();
      });
    }

    const report = reportText();
    // Penjaga anti-vakum: run selesai (kelima lagu gagal di tengah).
    expect(report).toContain('Hasil: 0/5 lagu selesai');
    expect(report).toContain('Media error: kode 2');
    expect(report).toContain('Penyebab: Jaringan terputus saat memutar.');
  });

  it('error tengah lagu + retry gagal kode berbeda: penyebab memakai kode segar (S-1)', async () => {
    mockConfig.playMode = 'resolveThenRetryFail';
    await renderSpike();

    // Palsukan posisi putar lagu 1 jadi 10 detik supaya poller
    // mencatat heard > 5 dan onError memicu retry.
    const audio = audioElement();
    let fakeTime = 0;
    Object.defineProperty(audio, 'currentTime', {
      get: () => fakeTime,
      set: (next: number) => {
        fakeTime = next;
      },
      configurable: true,
    });
    await clickCepat();

    fakeTime = 10;
    // Tunggu 1 tick poller (500 ms) supaya heard tercatat 10.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });

    // Error tengah lagu kode 2 -> retry -> play ke-2 gagal kode 4.
    await act(async () => {
      dispatchMidSongError();
    });

    // Lagu 2-5: seperti tes (a) — heard=0, tanpa retry.
    fakeTime = 0;
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        dispatchMidSongError();
      });
    }

    const report = reportText();
    expect(report).toContain('Hasil: 0/5 lagu selesai');
    const first = songSection(report, 1);
    expect(first).toContain('Media error: kode 4');
    expect(first).toContain(
      'Penyebab: Format audio tidak didukung browser ini.',
    );
    // Bukti S-1: dengan kode lama, penyebab lagu 1 akan berkode 2.
    expect(first).not.toContain('Jaringan terputus saat memutar.');
    // Lagu 2 tetap berperilaku seperti tes (a).
    expect(songSection(report, 2)).toContain(
      'Penyebab: Jaringan terputus saat memutar.',
    );
  });
});
