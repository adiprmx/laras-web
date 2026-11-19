/**
 * Halaman uji pemutar TERSEMBUNYI (rute /player-test): memutar nada
 * lokal lewat jalur graph Web Audio tanpa jaringan. File nada
 * disajikan Playwright dari fixture tests/e2e/spikes/fixtures/.
 * Tidak ditautkan dari mana pun; hanya untuk verifikasi E2E.
 */
import { selectCurrentTrack, usePlayerStore } from '../store/player';
import { getPlayerService } from '../player/service';
import { localTrack } from '../player/types';

const TONE_TRACKS = [
  localTrack('/__player-test__/tone-10s.wav', 'Nada 10 detik', 10),
  localTrack('/__player-test__/tone-60s.wav', 'Nada 60 detik', 60),
  localTrack('/__player-test__/tone-10s-b.wav', 'Nada 10 detik B', 10),
];

export default function PlayerTestPage() {
  const track = usePlayerStore(selectCurrentTrack);
  const status = usePlayerStore((s) => s.status);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const audioPath = usePlayerStore((s) => s.audioPath);
  const service = getPlayerService();

  return (
    <div className="min-h-dvh bg-black px-4 py-8 text-zinc-100">
      <h1 className="text-xl font-bold">Uji pemutar (nada lokal)</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Halaman ini hanya untuk tes otomatis. Nada disajikan dari fixture
        lokal, tanpa jaringan.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void service.playQueue(TONE_TRACKS, 0)}
          data-testid="player-test-play"
          className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black"
        >
          Putar nada
        </button>
      </div>
      <dl className="mt-6 space-y-1 text-sm">
        <div>
          <dt className="inline text-zinc-400">Status: </dt>
          <dd className="inline" data-testid="player-test-status">
            {status}
          </dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">Lagu: </dt>
          <dd className="inline" data-testid="player-test-track">
            {track ? track.title : '-'}
          </dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">Jalur audio: </dt>
          <dd className="inline" data-testid="player-test-audio-path">
            {audioPath ?? '-'}
          </dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">Posisi: </dt>
          <dd className="inline" data-testid="player-test-position">
            {position.toFixed(1)} / {duration.toFixed(1)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
