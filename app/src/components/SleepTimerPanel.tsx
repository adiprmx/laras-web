/**
 * Panel timer tidur di layar pemutar penuh (P7).
 *
 * Pilihan: 5/10/15/30/45/60 menit atau sampai lagu ini selesai.
 * Sisa waktu tampil dan diperbarui tiap detik. Timer bisa
 * dibatalkan. Pesan jujur: timer berhenti kalau tab ditutup.
 *
 * Lazy-load dari FullPlayer supaya tidak masuk bundle awal.
 */
import { useEffect, useState } from 'react';
import { strings } from '../strings/id';
import { getPlayerService } from '../player/service';
import {
  SLEEP_TIMER_MINUTES,
  sleepTimerText,
} from '../player/sleepTimer';
import { usePlayerStore } from '../store/player';

/** Jam lokal yang berdetak tiap detik supaya sisa waktu hidup. */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Segarkan segera saat timer aktif: nilai state lama (sejak
    // panel dibuka) + pembulatan ke atas membuat timer 30 menit
    // tampil sebagai "31 menit" di render pertama.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export default function SleepTimerPanel() {
  const timer = usePlayerStore((s) => s.sleepTimer);
  const now = useNowTick(timer?.mode === 'minutes');
  const service = getPlayerService();

  return (
    <div
      data-testid="sleep-timer-panel"
      className="mt-6 rounded-2xl border border-white/10 bg-zinc-900/60 px-4 py-4"
    >
      <h3 className="text-sm font-semibold">{strings.sleepTimer}</h3>

      {timer && (
        <p
          data-testid="sleep-timer-active"
          className="mt-3 text-sm text-zinc-100"
        >
          {sleepTimerText(timer, now)}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={strings.sleepTimer}>
        {SLEEP_TIMER_MINUTES.map((minutes) => {
          const selected =
            timer?.mode === 'minutes' && timer.minutes === minutes;
          return (
            <button
              key={minutes}
              type="button"
              onClick={() => service.setSleepTimerMinutes(minutes)}
              aria-pressed={selected}
              data-testid={`sleep-option-${minutes}`}
              className={`h-11 rounded-full px-4 text-sm font-medium tabular-nums transition-colors active:scale-95 ${
                selected
                  ? 'bg-white text-black'
                  : 'border border-white/15 text-zinc-100 hover:bg-white/5'
              }`}
            >
              {strings.sleepTimerMinutes(minutes)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => service.setSleepTimerEndOfSong()}
          aria-pressed={timer?.mode === 'end-of-song'}
          data-testid="sleep-option-end"
          className={`h-11 rounded-full px-4 text-sm font-medium transition-colors active:scale-95 ${
            timer?.mode === 'end-of-song'
              ? 'bg-white text-black'
              : 'border border-white/15 text-zinc-100 hover:bg-white/5'
          }`}
        >
          {strings.sleepTimerEndOfSong}
        </button>
      </div>

      {timer && (
        <button
          type="button"
          onClick={() => service.clearSleepTimer()}
          data-testid="sleep-cancel"
          className="mt-3 h-11 rounded-full border border-white/15 px-5 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
        >
          {strings.sleepTimerCancel}
        </button>
      )}

      <p className="mt-3 text-xs leading-relaxed text-zinc-500">
        {strings.sleepTimerStopsWhenTabClosed}
      </p>
    </div>
  );
}
