/**
 * Daftar antrean di layar pemutar penuh: urutan putar, durasi sisa,
 * hapus per lagu, hapus semua (lagu saat ini tetap dipertahankan).
 */
import { X } from '@phosphor-icons/react';
import { selectCurrentTrack, usePlayerStore } from '../store/player';
import { getPlayerService } from '../player/service';
import { formatRemaining, formatTime } from '../player/format';
import { remainingDuration } from '../player/queue';
import { strings } from '../strings/id';

export default function QueueList() {
  const queue = usePlayerStore((s) => s.queue);
  const order = usePlayerStore((s) => s.order);
  const orderPos = usePlayerStore((s) => s.orderPos);
  const status = usePlayerStore((s) => s.status);
  const position = usePlayerStore((s) => s.position);
  const track = usePlayerStore(selectCurrentTrack);

  if (queue.length === 0) return null;

  const service = getPlayerService();
  const remaining = remainingDuration(
    { items: queue, order, orderPos },
    position,
  );
  const playing = status === 'playing';

  return (
    <section data-testid="queue-list" aria-label={strings.queue}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight">
          {strings.queue}
        </h3>
        <span
          data-testid="queue-remaining"
          className="text-xs tabular-nums text-zinc-400"
        >
          {formatRemaining(remaining.seconds)}
          {remaining.unknown > 0
            ? ` (+${remaining.unknown} belum diketahui)`
            : ''}
        </span>
      </div>
      <ul className="mt-3 divide-y divide-white/5">
        {order.map((queueIndex, pos) => {
          const item = queue[queueIndex];
          if (!item) return null;
          const isCurrent = pos === orderPos;
          return (
            <li key={item.id} data-testid={`queue-item-${item.id}`}>
              <div className="flex items-center gap-3 py-2">
                <button
                  type="button"
                  onClick={() => void service.playAt(pos)}
                  aria-label={`${strings.play}: ${item.title}`}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="w-6 shrink-0 text-center text-xs tabular-nums text-zinc-400">
                    {isCurrent ? (
                      <span
                        data-testid="queue-current-mark"
                        aria-label={strings.nowPlaying}
                        className={`inline-flex items-end gap-[2px] ${playing ? 'player-bars' : ''}`}
                      >
                        <span className="w-[3px] bg-white" style={{ height: 12 }} />
                        <span className="w-[3px] bg-white" style={{ height: 8 }} />
                        <span className="w-[3px] bg-white" style={{ height: 10 }} />
                      </span>
                    ) : (
                      pos + 1
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm ${
                        isCurrent ? 'font-medium text-zinc-100' : 'text-zinc-400'
                      }`}
                    >
                      {item.title}
                    </span>
                    {item.artist && (
                      <span className="block truncate text-xs text-zinc-400">
                        {item.artist}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                    {formatTime(item.durationSeconds ?? 0)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void service.removeFromQueue(queueIndex)}
                  aria-label={`${strings.removeFromQueue}: ${item.title}`}
                  data-testid={`queue-remove-${item.id}`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 active:scale-95"
                >
                  <X size={18} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {queue.length > 1 && (
        <button
          type="button"
          onClick={() => service.clearQueue()}
          data-testid="queue-clear"
          className="mt-3 h-11 w-full rounded-xl border border-white/10 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
        >
          {strings.clearQueue}
        </button>
      )}
      {track && (
        <span className="sr-only" data-testid="queue-current-title">
          {track.title}
        </span>
      )}
    </section>
  );
}
