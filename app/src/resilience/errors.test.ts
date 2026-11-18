import { describe, expect, it } from 'vitest';
import {
  classifyPlaybackFailure,
  failureMessage,
} from './errors';
import { ResolveError } from '../extractor/resolve';

describe('classifyPlaybackFailure', () => {
  it('offline bila navigator offline, apa pun galatnya', () => {
    const failure = classifyPlaybackFailure({
      online: false,
      error: new Error('apa pun'),
    });
    expect(failure.cause).toBe('offline');
    expect(failure.title).toBe('Tidak ada internet');
  });

  it('offline bila semua upaya gagal jaringan', () => {
    const failure = classifyPlaybackFailure({
      online: true,
      error: new ResolveError('x', 'y', [
        'WEB_REMIX=jaringan-gagal',
        'MWEB=jaringan-gagal',
      ]),
    });
    expect(failure.cause).toBe('offline');
  });

  it('offline bila galat fetch mentah (TypeError) tanpa upaya', () => {
    const failure = classifyPlaybackFailure({
      online: true,
      error: new TypeError('Failed to fetch'),
    });
    expect(failure.cause).toBe('offline');
  });

  it('refused bila semua client LOGIN_REQUIRED/UNPLAYABLE', () => {
    const failure = classifyPlaybackFailure({
      online: true,
      error: new ResolveError('x', 'y', [
        'WEB_REMIX=LOGIN_REQUIRED',
        'MWEB=LOGIN_REQUIRED',
        'ANDROID_VR=UNPLAYABLE',
      ]),
    });
    expect(failure.cause).toBe('refused');
    expect(failure.body).not.toContain('LOGIN_REQUIRED');
    expect(failure.body).not.toContain('UNPLAYABLE');
  });

  it('proxy-down bila ada upaya proxy-gagal', () => {
    const failure = classifyPlaybackFailure({
      online: true,
      error: new ResolveError('x', 'y', [
        'WEB_REMIX=proxy-gagal',
        'MWEB=LOGIN_REQUIRED',
      ]),
    });
    expect(failure.cause).toBe('proxy-down');
  });

  it('proxy-down + isTimeout bila resolve melewati batas waktu', () => {
    const failure = classifyPlaybackFailure({
      online: true,
      error: new ResolveError(
        'resolve melewati batas 90 detik',
        'Lagu terlalu lama dicari.',
      ),
    });
    expect(failure.cause).toBe('proxy-down');
    expect(failure.isTimeout).toBe(true);
  });

  it('no-format bila semua client OK tapi tidak ada format', () => {
    const failure = classifyPlaybackFailure({
      online: true,
      error: new ResolveError('x', 'y', [
        'WEB_REMIX=OK',
        'MWEB=OK',
        'ANDROID_VR=OK',
      ]),
    });
    expect(failure.cause).toBe('no-format');
  });

  it('config-stale bila pesan menyebut hash/config', () => {
    const failure = classifyPlaybackFailure({
      online: true,
      error: new ResolveError(
        'tidak ada hash player di config',
        'Config tidak membawa info pemutar lagu.',
      ),
    });
    expect(failure.cause).toBe('config-stale');
  });

  it('unknown bila tidak ada sinyal yang cocok', () => {
    const failure = classifyPlaybackFailure({
      online: true,
      error: new Error('sesuatu yang aneh'),
    });
    expect(failure.cause).toBe('unknown');
    expect(failure.isTimeout).toBe(false);
  });

  it('unknown bila tidak ada error sama sekali', () => {
    expect(
      classifyPlaybackFailure({ online: true }).cause,
    ).toBe('unknown');
  });

  it('pesan gabungan berisi judul + isi, tanpa jargon', () => {
    const message = failureMessage(
      classifyPlaybackFailure({
        online: true,
        error: new ResolveError('x', 'y', ['WEB_REMIX=LOGIN_REQUIRED']),
      }),
    );
    expect(message).toContain('Lagu tidak bisa dibuka sekarang');
    expect(message).not.toContain('LOGIN_REQUIRED');
    expect(message).not.toContain('—');
  });

  it('tidak ada pesan yang memakai em dash atau kata cache', () => {
    const causes = [
      new Error('x'),
      new TypeError('fetch'),
      new ResolveError('x', 'y', ['WEB_REMIX=LOGIN_REQUIRED']),
      new ResolveError('x', 'y', ['WEB_REMIX=proxy-gagal']),
      new ResolveError('x', 'y', ['WEB_REMIX=OK']),
      new ResolveError('tidak ada hash player di config', 'y'),
    ];
    for (const error of causes) {
      const message = failureMessage(
        classifyPlaybackFailure({ online: true, error }),
      );
      expect(message).not.toContain('—');
      expect(message.toLowerCase()).not.toContain('cache');
    }
  });
});
