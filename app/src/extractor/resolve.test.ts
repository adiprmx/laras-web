import { describe, expect, it } from 'vitest';
import {
  chooseHash,
  describeStreamUrl,
  maxSts,
  parseAudioFormats,
  parsePlayerConfig,
  parseSignatureCipher,
  pickAudioFormat,
  type AudioFormat,
} from './resolve';
import { kCipherUrlFad, kCipheredS } from '../solver/spikeOracles';

describe('parsePlayerConfig', () => {
  it('memparse config-v1 asli', () => {
    const parsed = parsePlayerConfig({
      canaryVideoIds: ['hhn-nGSuenM'],
      clients: [
        {
          clientId: '67',
          name: 'WEB_REMIX',
          version: '1.20261110.04.00',
          userAgent: 'Mozilla/5.0',
        },
        {
          clientId: '14',
          name: 'ANDROID_VR',
          requiresScript: false,
          version: '1.65.10',
          userAgent: 'com.google.android.youtube/21.26.364',
        },
      ],
      playerHashes: {
        ad8d59ae: { signatureTimestamp: 20768 },
        b559f50c: { signatureTimestamp: 20770 },
        fad7e4e9: { signatureTimestamp: 20767 },
      },
      version: 1,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.stsByHash).toEqual({
      ad8d59ae: 20768,
      b559f50c: 20770,
      fad7e4e9: 20767,
    });
    expect(parsed!.clients).toHaveLength(2);
    expect(parsed!.clients[0]).toMatchObject({
      name: 'WEB_REMIX',
      requiresScript: true,
    });
    expect(parsed!.clients[1]).toMatchObject({
      name: 'ANDROID_VR',
      requiresScript: false,
    });
    expect(parsed!.clients[1].context).toMatchObject({
      androidSdkVersion: 34,
    });
  });

  it('mengembalikan null untuk JSON tanpa isi yang bisa dipakai', () => {
    expect(parsePlayerConfig(null)).toBeNull();
    expect(parsePlayerConfig({})).toBeNull();
    expect(parsePlayerConfig('bukan-json')).toBeNull();
    expect(parsePlayerConfig({ playerHashes: {}, clients: [] })).toBeNull();
  });

  it('mengabaikan client yang field wajibnya hilang', () => {
    const parsed = parsePlayerConfig({
      clients: [{ name: 'RUSAK' }],
      playerHashes: { b559f50c: { signatureTimestamp: 20770 } },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.clients).toHaveLength(0);
    expect(parsed!.stsByHash).toEqual({ b559f50c: 20770 });
  });
});

describe('chooseHash dan maxSts', () => {
  it('memilih hash dengan sts terbesar', () => {
    const stsByHash = { ad8d59ae: 20768, b559f50c: 20770, fad7e4e9: 20767 };
    expect(chooseHash(stsByHash)).toBe('b559f50c');
    expect(maxSts(stsByHash)).toBe(20770);
  });

  it('mengembalikan null untuk config kosong', () => {
    expect(chooseHash({})).toBeNull();
    expect(maxSts({})).toBeNull();
  });
});

describe('parseSignatureCipher', () => {
  it('memparse cipher nyata itag 251', () => {
    const cipher =
      `s=${encodeURIComponent(kCipheredS)}&sp=sig&url=${encodeURIComponent(kCipherUrlFad)}`;
    const parsed = parseSignatureCipher(cipher);
    expect(parsed).not.toBeNull();
    expect(parsed!.cipheredS).toBe(kCipheredS);
    expect(parsed!.sigParam).toBe('sig');
    expect(parsed!.cipherUrl).toBe(kCipherUrlFad);
  });

  it('memakai sp default sig bila sp hilang', () => {
    const cipher =
      `s=${encodeURIComponent(kCipheredS)}&url=${encodeURIComponent(kCipherUrlFad)}`;
    const parsed = parseSignatureCipher(cipher);
    expect(parsed?.sigParam).toBe('sig');
  });

  it('menolak cipher tanpa s atau url, dan host di luar allowlist', () => {
    expect(parseSignatureCipher('sp=sig')).toBeNull();
    expect(
      parseSignatureCipher(`s=abc&url=${encodeURIComponent('https://example.com/x')}`),
    ).toBeNull();
    expect(
      parseSignatureCipher(`s=abc&url=${encodeURIComponent('http://rr1---sn-a.googlevideo.com/x')}`),
    ).toBeNull();
  });
});

describe('parseAudioFormats', () => {
  it('memparse playability dan format audio', () => {
    const { playability, formats } = parseAudioFormats({
      playabilityStatus: { status: 'OK' },
      streamingData: {
        adaptiveFormats: [
          { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000, url: 'https://x' },
          { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, signatureCipher: 's=a&sp=sig&url=b' },
          { itag: 18, mimeType: 'video/mp4', bitrate: 500000, url: 'https://y' },
        ],
      },
    });
    expect(playability).toBe('OK');
    expect(formats).toHaveLength(2);
    expect(formats[0]).toMatchObject({ itag: 251, isSabr: false });
    expect(formats[1]).toMatchObject({ itag: 140, isSabr: false });
  });

  it('menandai SABR dan status tidak diketahui', () => {
    const { playability, formats } = parseAudioFormats({
      streamingData: {
        serverAbrStreamingUrl: 'https://example.test/sabr',
        adaptiveFormats: [
          { itag: 251, mimeType: 'audio/webm', bitrate: 160000 },
        ],
      },
    });
    expect(playability).toBe('?');
    expect(formats[0].isSabr).toBe(true);
  });
});

describe('pickAudioFormat', () => {
  const format = (patch: Partial<AudioFormat>): AudioFormat => ({
    itag: 251,
    mimeType: 'audio/webm',
    bitrate: 160000,
    isSabr: false,
    ...patch,
  });

  it('memilih sesuai urutan itag kanonis', () => {
    const picked = pickAudioFormat([
      format({ itag: 140, bitrate: 128000, url: 'https://a' }),
      format({ itag: 251, bitrate: 160000, url: 'https://b' }),
      format({ itag: 249, bitrate: 50000, url: 'https://c' }),
    ]);
    expect(picked?.itag).toBe(251);
  });

  it('menerima cipher bila tidak ada URL langsung', () => {
    const picked = pickAudioFormat([
      format({ itag: 251, signatureCipher: 's=a&sp=sig&url=b' }),
    ]);
    expect(picked?.itag).toBe(251);
    expect(picked?.signatureCipher).toBeDefined();
  });

  it('menolak SABR dan memilih bitrate tertinggi bila itag di luar urutan', () => {
    const picked = pickAudioFormat([
      format({ itag: 251, isSabr: true, url: 'https://a' }),
      format({ itag: 271, bitrate: 100000, url: 'https://b' }),
      format({ itag: 272, bitrate: 200000, url: 'https://c' }),
    ]);
    expect(picked?.itag).toBe(272);
  });

  it('mengembalikan null bila tidak ada format yang bisa dipakai', () => {
    expect(pickAudioFormat([])).toBeNull();
    expect(
      pickAudioFormat([format({ itag: 251, isSabr: true })]),
    ).toBeNull();
  });
});

describe('describeStreamUrl', () => {
  it('menyamarkan host dan tidak memuat URL lengkap', () => {
    const summary = describeStreamUrl(kCipherUrlFad, 251);
    expect(summary).toContain('host=*.googlevideo.com');
    expect(summary).toContain('itag=251');
    expect(summary).not.toContain('videoplayback');
    expect(summary).not.toContain('expire=');
  });
});
