/**
 * Layar pemutar penuh: sampul, judul, bilah cari, kontrol putar,
 * kecepatan, volume, pengatur suara, panel galat, dan antrean.
 * Desain: hitam murni, aksen putih, warna hanya untuk status.
 */
import { useEffect, useRef, useState } from 'react';
import {
  CaretDown,
  Pause,
  Play,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  SpeakerHigh,
  SpeakerX,
} from '@phosphor-icons/react';
import { selectCurrentTrack, usePlayerStore } from '../store/player';
import { getPlayerService } from '../player/service';
import { formatTime } from '../player/format';
import { PLAYBACK_RATES } from '../player/types';
import { strings } from '../strings/id';
import QueueList from './QueueList';
import FavoriteButton from './library/FavoriteButton';

function formatRate(rate: number): string {
  return `${rate}x`.replace('.0x', 'x');
}

export default function FullPlayer() {
  const open = usePlayerStore((s) => s.fullPlayerOpen);
  const track = usePlayerStore(selectCurrentTrack);
  const status = usePlayerStore((s) => s.status);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const rate = usePlayerStore((s) => s.rate);
  const volume = usePlayerStore((s) => s.volume);
  const errorMessage = usePlayerStore((s) => s.errorMessage);
  const notice = usePlayerStore((s) => s.notice);
  const eqNote = usePlayerStore((s) => s.eqNote);
  const setFullPlayerOpen = usePlayerStore((s) => s.setFullPlayerOpen);
  const setEqNote = usePlayerStore((s) => s.setEqNote);
  const dismissNotice = usePlayerStore((s) => s.dismissNotice);

  const [dragValue, setDragValue] = useState<number | null>(null);
  const [speedOpen, setSpeedOpen] = useState(false);
  const draggingRef = useRef(false);

  // Kunci scroll latar saat layar penuh terbuka.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open ]);

  if (!open || !track) return null;

  const playing = status === 'playing';
  const loading = status === 'loading';
  const shownPosition = dragValue ?? position;
  const service = getPlayerService();

  const repeatLabel =
    repeat === 'one'
      ? strings.repeatOne
      : repeat === 'all'
        ? strings.repeatAll
        : strings.repeatOff;

  return (
    <div
      data-testid="full-player"
      role="dialog"
      aria-modal="true"
      aria-label={strings.nowPlaying}
      className="fixed inset-0 z-50 overflow-y-auto bg-black text-zinc-100"
    >
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-10 pt-3 sm:max-w-lg">
        {/* Bilah atas */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setFullPlayerOpen(false)}
            aria-label={strings.closePlayer}
            data-testid="close-player"
            className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            <CaretDown size={24} />
          </button>
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            {strings.nowPlaying}
          </span>
          <span className="h-11 w-11" aria-hidden="true" />
        </div>

        {/* Sampul */}
        <div className="mt-6 flex justify-center">
          {track.artwork ? (
            <img
              src={track.artwork}
              alt=""
              width={480}
              height={360}
              className="aspect-[4/3] w-full max-w-[320px] rounded-xl object-cover"
            />
          ) : (
            <div className="flex aspect-[4/3] w-full max-w-[320px] items-center justify-center rounded-xl bg-zinc-900">
              <span className="text-4xl font-bold text-zinc-400">
                {track.title.charAt(0)}
              </span>
            </div>
          )}
        </div>

        {/* Judul */}
        <div className="mt-6 text-center">
          <h2 className="text-xl font-semibold tracking-tight">
            {track.title}
          </h2>
          {track.artist && (
            <p className="mt-1 text-sm text-zinc-400">{track.artist}</p>
          )}
          <div className="mt-2 flex justify-center">
            <FavoriteButton
              songId={track.id}
              title={track.title}
              artist={track.artist}
              durationSeconds={track.durationSeconds ?? null}
              artwork={track.artwork ?? null}
              testId="full-favorite"
            />
          </div>
        </div>

        {/* Bilah cari: angka mengikuti seret, seek dikirim saat lepas. */}
        <div className="mt-8">
          <input
            type="range"
            min={0}
            max={duration > 0 ? duration : 0}
            step={0.1}
            value={shownPosition}
            disabled={duration <= 0}
            aria-label="Posisi lagu"
            data-testid="full-seek"
            className="player-range w-full"
            onPointerDown={() => {
              draggingRef.current = true;
            }}
            onPointerUp={() => {
              draggingRef.current = false;
              if (dragValue !== null) {
                service.seek(dragValue);
                setDragValue(null);
              }
            }}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (draggingRef.current) {
                setDragValue(value);
              } else {
                // Keyboard: kirim seek langsung.
                service.seek(value);
              }
            }}
          />
          <div className="mt-1 flex justify-between text-xs tabular-nums text-zinc-400">
            <span data-testid="position-label">{formatTime(shownPosition)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Kontrol utama */}
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => service.setShuffle(!shuffle)}
            aria-label={strings.shuffle}
            aria-pressed={shuffle}
            title={shuffle ? strings.shuffleOn : strings.shuffleOff}
            data-testid="full-shuffle"
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors active:scale-95 ${
              shuffle ? 'text-white' : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            <Shuffle size={22} weight={shuffle ? 'fill' : 'regular'} />
          </button>
          <button
            type="button"
            onClick={() => void service.prev()}
            aria-label={strings.prevTrack}
            data-testid="full-prev"
            className="flex h-12 w-12 items-center justify-center rounded-full text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            <SkipBack size={28} weight="fill" />
          </button>
          <button
            type="button"
            onClick={() => void service.toggle()}
            aria-label={playing ? strings.pause : strings.play}
            data-testid="full-play"
            disabled={loading}
            className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-white text-black transition-transform duration-150 active:scale-95 disabled:opacity-60"
          >
            {loading ? (
              <span
                aria-hidden="true"
                className="player-spinner h-6 w-6 rounded-full border-2 border-black/20 border-t-black"
              />
            ) : playing ? (
              <Pause size={32} weight="fill" />
            ) : (
              <Play size={32} weight="fill" className="ml-1" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void service.next()}
            aria-label={strings.nextTrack}
            data-testid="full-next"
            className="flex h-12 w-12 items-center justify-center rounded-full text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            <SkipForward size={28} weight="fill" />
          </button>
          <button
            type="button"
            onClick={() => service.cycleRepeat()}
            aria-label={repeatLabel}
            aria-pressed={repeat !== 'off'}
            title={repeatLabel}
            data-testid="full-repeat"
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors active:scale-95 ${
              repeat !== 'off' ? 'text-white' : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            {repeat === 'one' ? (
              <RepeatOnce size={22} weight="fill" />
            ) : (
              <Repeat size={22} weight={repeat === 'all' ? 'fill' : 'regular'} />
            )}
          </button>
        </div>

        {/* Kecepatan + pengatur suara */}
        <div className="relative mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => setSpeedOpen((v) => !v)}
            aria-label={strings.speed}
            aria-expanded={speedOpen}
            data-testid="full-speed"
            className="flex h-11 items-center rounded-full border border-white/10 px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            {formatRate(rate)}
          </button>
          <button
            type="button"
            onClick={() => setEqNote(service.eqInfo().note)}
            aria-label={strings.sound}
            data-testid="full-eq"
            className="flex h-11 items-center gap-2 rounded-full border border-white/10 px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            <SlidersHorizontal size={18} />
            {strings.sound}
          </button>
          {speedOpen && (
            <div
              role="menu"
              aria-label={strings.speed}
              className="absolute bottom-full left-1/2 z-10 mb-2 flex -translate-x-1/2 gap-1 rounded-2xl border border-white/10 bg-zinc-900 p-2 shadow-xl"
            >
              {PLAYBACK_RATES.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    service.setRate(r);
                    setSpeedOpen(false);
                  }}
                  data-testid={`speed-option-${r}`}
                  className={`h-10 min-w-11 rounded-xl px-2 text-sm tabular-nums transition-colors active:scale-95 ${
                    r === rate
                      ? 'bg-white font-medium text-black'
                      : 'text-zinc-100 hover:bg-white/10'
                  }`}
                >
                  {formatRate(r)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Volume */}
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => service.setVolume(volume > 0 ? 0 : 1)}
            aria-label={strings.volumeInApp}
            data-testid="volume-mute"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
          >
            {volume === 0 ? <SpeakerX size={22} /> : <SpeakerHigh size={22} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label={strings.volumeInApp}
            data-testid="full-volume"
            className="player-range w-full"
            onChange={(e) => service.setVolume(Number(e.target.value))}
          />
        </div>

        {/* Pesan info singkat */}
        {notice && (
          <button
            type="button"
            onClick={dismissNotice}
            data-testid="player-notice"
            className="mt-6 rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-left text-sm text-zinc-100"
          >
            {notice}
          </button>
        )}

        {/* Panel galat */}
        {errorMessage && (
          <div
            data-testid="player-error"
            className="mt-6 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3"
          >
            <p className="text-sm leading-relaxed text-zinc-100">
              {errorMessage}
            </p>
            <button
              type="button"
              onClick={() => void service.retry()}
              data-testid="retry-button"
              className="mt-3 h-11 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform duration-150 active:scale-95"
            >
              {strings.retry}
            </button>
          </div>
        )}

        {/* Catatan pengatur suara */}
        {eqNote && (
          <div
            data-testid="eq-note"
            className="mt-6 rounded-xl border border-white/10 bg-zinc-900 px-4 py-3"
          >
            <p className="text-sm leading-relaxed text-zinc-100">{eqNote}</p>
            <button
              type="button"
              onClick={() => setEqNote(null)}
              className="mt-2 text-sm font-medium text-zinc-400 underline-offset-2 hover:underline"
            >
              {strings.close}
            </button>
          </div>
        )}

        {/* Antrean */}
        <div className="mt-8">
          <QueueList />
        </div>
      </div>
    </div>
  );
}
