/**
 * Panel lirik di layar pemutar penuh (P7).
 *
 * Lirik tersinkron: baris aktif mengikuti posisi lagu, ketuk
 * baris mencari ke waktunya, gulir manual menghentikan gulir
 * otomatis 5 detik (PRD B5.1). Lirik polos tampil tanpa sorot
 * bila hanya itu yang tersedia. Footer atribusi LRCLIB/lyrics.ovh
 * selalu tampil saat lirik ada.
 *
 * Pemberitahuan privasi satu kali (PRD B5.5) tampil sebelum
 * request jaringan pertama; lirik dari cache tidak butuh
 * persetujuan karena tidak ada request yang keluar.
 *
 * Komponen ini lazy-load dari FullPlayer supaya kode lirik tidak
 * masuk bundle awal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { strings } from '../strings/id';
import { activeLineIndex, parseLrc } from './lrc';
import {
  getLyricsService,
  type LyricsServiceResult,
} from './lyricsService';

/** Jeda gulir otomatis sesudah pengguna menggulir manual (ms). */
const MANUAL_SCROLL_PAUSE_MS = 5000;

interface LyricsPanelProps {
  songId: string;
  title: string;
  artist?: string;
  durationSeconds?: number;
  /** Posisi putar detik (dari store pemutar). */
  position: number;
  onSeek: (seconds: number) => void;
}

export default function LyricsPanel({
  songId,
  title,
  artist,
  durationSeconds,
  position,
  onSeek,
}: LyricsPanelProps) {
  const [noticeSeen, setNoticeSeen] = useState<boolean | null>(null);
  const [result, setResult] = useState<LyricsServiceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastManualScrollAt = useRef(0);

  // Cek pemberitahuan privasi sekali saat panel dibuka.
  useEffect(() => {
    let cancelled = false;
    void getLyricsService()
      .then((service) => service.hasSeenNotice())
      .then((seen) => {
        if (!cancelled) setNoticeSeen(seen);
      })
      .catch(() => {
        if (!cancelled) setNoticeSeen(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Ambil lirik saat lagu berubah atau pengguna menekan coba lagi.
  // Sebelum pemberitahuan privasi diterima, tidak ada fetch sama
  // sekali (judul lagu tidak boleh keluar sebelum "Mengerti");
  // lirik tersimpan tetap bisa dibaca sesudah persetujuan.
  useEffect(() => {
    if (noticeSeen === null) return;
    if (!noticeSeen) {
      setLoading(false);
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setResult(null);
    void getLyricsService()
      .then((service) =>
        service.getLyrics(songId, {
          artist: artist ?? '',
          title,
          durationSeconds,
        }),
      )
      .then((next) => {
        if (cancelled) return;
        setResult(next);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setResult({ status: 'error' });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [noticeSeen, songId, title, artist, durationSeconds, reloadKey]);

  const lines = useMemo(() => {
    if (result?.status !== 'ok' || !result.syncedLyrics) return null;
    const parsed = parseLrc(result.syncedLyrics);
    return parsed.length > 0 ? parsed : null;
  }, [result]);

  const active = lines ? activeLineIndex(lines, position) : -1;

  // Gulir otomatis ke baris aktif, kecuali 5 detik sesudah
  // pengguna menggulir manual.
  useEffect(() => {
    if (active < 0) return;
    if (Date.now() - lastManualScrollAt.current < MANUAL_SCROLL_PAUSE_MS) {
      return;
    }
    const el = lineRefs.current[active];
    if (!el) return;
    el.scrollIntoView({
      block: 'center',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  }, [active]);

  const acceptNotice = useCallback(() => {
    void getLyricsService()
      .then((service) => service.markNoticeSeen())
      .catch(() => undefined);
    setNoticeSeen(true);
  }, []);

  const onManualScroll = useCallback(() => {
    lastManualScrollAt.current = Date.now();
  }, []);

  const plainLines = useMemo(() => {
    if (result?.status !== 'ok' || lines) return null;
    return result.plainLyrics.split('\n');
  }, [result, lines]);

  return (
    <div
      data-testid="lyrics-panel"
      className="mt-6 rounded-2xl border border-white/10 bg-zinc-900/60 px-4 py-4"
    >
      <h3 className="text-sm font-semibold">{strings.lyrics}</h3>

      {noticeSeen === false && (
        <div data-testid="lyrics-notice" className="mt-3">
          <p className="text-sm leading-relaxed text-zinc-400">
            {strings.lyricsNoticeBody}
          </p>
          <button
            type="button"
            onClick={acceptNotice}
            data-testid="lyrics-accept"
            className="mt-3 h-11 rounded-full bg-white px-5 text-sm font-medium text-black transition-transform active:scale-95"
          >
            {strings.lyricsNoticeAccept}
          </button>
        </div>
      )}

      {noticeSeen !== false && loading && (
        <p
          data-testid="lyrics-loading"
          className="mt-3 text-sm text-zinc-400"
        >
          {strings.lyricsLoading}
        </p>
      )}

      {noticeSeen !== false && !loading && result?.status === 'not-found' && (
        <p data-testid="lyrics-empty" className="mt-3 text-sm text-zinc-400">
          {!navigator.onLine
            ? strings.lyricsOfflineNotSaved
            : strings.lyricsNotAvailable}
        </p>
      )}

      {noticeSeen !== false && !loading && result?.status === 'error' && (
        <div className="mt-3">
          <p data-testid="lyrics-error" className="text-sm text-zinc-400">
            {strings.lyricsLoadFailed}
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            data-testid="lyrics-retry"
            className="mt-3 h-11 rounded-full border border-white/15 px-5 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
          >
            {strings.retry}
          </button>
        </div>
      )}

      {noticeSeen !== false &&
        !loading &&
        result?.status === 'rate-limited' && (
          <div className="mt-3">
            <p
              data-testid="lyrics-rate-limited"
              className="text-sm text-zinc-400"
            >
              {strings.lyricsRateLimited}
            </p>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              data-testid="lyrics-retry"
              className="mt-3 h-11 rounded-full border border-white/15 px-5 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
            >
              {strings.retry}
            </button>
          </div>
        )}

      {noticeSeen !== false && !loading && result?.status === 'disabled' && (
        <p
          data-testid="lyrics-disabled"
          className="mt-3 text-sm text-zinc-400"
        >
          {strings.lyricsDisabledNote}
        </p>
      )}

      {noticeSeen !== false && !loading && result?.status === 'ok' && lines && (
        <div
          ref={listRef}
          data-testid="lyrics-synced"
          onScroll={onManualScroll}
          className="mt-3 max-h-[40vh] space-y-1 overflow-y-auto pr-1"
        >
          {lines.map((line, index) => (
            <button
              key={`${line.timeSeconds}-${index}`}
              ref={(el) => {
                lineRefs.current[index] = el;
              }}
              type="button"
              onClick={() => onSeek(line.timeSeconds)}
              data-testid="lyrics-line"
              data-active={index === active ? 'true' : 'false'}
              aria-label={`Cari ke ${Math.floor(line.timeSeconds / 60)}:${String(
                Math.floor(line.timeSeconds % 60),
              ).padStart(2, '0')}`}
              className={`block w-full rounded-lg px-2 py-2 text-left text-base leading-relaxed transition-colors active:scale-[0.99] ${
                index === active
                  ? 'bg-white text-black'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
              }`}
            >
              {line.text || ' '}
            </button>
          ))}
        </div>
      )}

      {noticeSeen !== false &&
        !loading &&
        result?.status === 'ok' &&
        !lines &&
        plainLines && (
          <div data-testid="lyrics-plain" className="mt-3 max-h-[40vh] overflow-y-auto pr-1">
            {plainLines.map((line, index) => (
              <p
                key={index}
                className="py-1 text-base leading-relaxed text-zinc-100"
              >
                {line || ' '}
              </p>
            ))}
          </div>
        )}

      {noticeSeen !== false && !loading && result?.status === 'ok' && (
        <p className="mt-4 text-xs text-zinc-500">
          {result.source === 'ovh'
            ? strings.lyricsByOvh
            : strings.lyricsByLrclib}
        </p>
      )}
    </div>
  );
}
