/**
 * Panel pengatur suara 10 band di layar pemutar penuh (P7).
 *
 * Hanya berfungsi untuk lagu lokal/unduhan (jalur graph). Saat
 * streaming, panel menampilkan pesan jujur bahwa EQ tidak
 * tersedia untuk streaming (S5: googlevideo tanpa header CORS,
 * graph akan membisukan audio). Tanpa proxy audio di v1.
 *
 * Preset: Rata, Bass, Vokal, Akustik. Mengubah satu band membuat
 * preset menjadi "Atur sendiri". Pengaturan tersimpan di
 * IndexedDB dan berlaku langsung ke graph.
 *
 * Lazy-load dari FullPlayer supaya tidak masuk bundle awal.
 */
import { strings } from '../strings/id';
import { getPlayerService } from '../player/service';
import {
  EQ_FREQUENCIES,
  EQ_MAX_DB,
  EQ_MIN_DB,
  EQ_PRESET_NAMES,
  formatFrequency,
  formatGain,
  type EqPresetName,
} from '../player/equalizer';
import { useEqualizerStore } from '../store/equalizer';

const PRESET_LABELS: Record<Exclude<EqPresetName, 'custom'>, string> = {
  flat: strings.eqPresetFlat,
  bass: strings.eqPresetBass,
  vocal: strings.eqPresetVocal,
  acoustic: strings.eqPresetAcoustic,
};

export default function EqPanel({ available }: { available: boolean }) {
  const settings = useEqualizerStore((s) => s.settings);
  const service = getPlayerService();

  return (
    <div
      data-testid="eq-panel"
      className="mt-6 rounded-2xl border border-white/10 bg-zinc-900/60 px-4 py-4"
    >
      <h3 className="text-sm font-semibold">{strings.eqTitle}</h3>

      {!available && (
        <p data-testid="eq-unavailable" className="mt-3 text-sm leading-relaxed text-zinc-400">
          {strings.eqStreamingNote}
        </p>
      )}

      {available && (
        <>
          <div
            role="group"
            aria-label={strings.eqTitle}
            className="mt-3 flex flex-wrap gap-2"
          >
            {EQ_PRESET_NAMES.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => void service.setEqPreset(preset)}
                aria-pressed={settings.preset === preset}
                data-testid={`eq-preset-${preset}`}
                className={`h-11 rounded-full px-4 text-sm font-medium transition-colors active:scale-95 ${
                  settings.preset === preset
                    ? 'bg-white text-black'
                    : 'border border-white/15 text-zinc-100 hover:bg-white/5'
                }`}
              >
                {PRESET_LABELS[preset]}
              </button>
            ))}
            {settings.preset === 'custom' && (
              <span
                data-testid="eq-preset-custom"
                className="flex h-11 items-center rounded-full bg-white px-4 text-sm font-medium text-black"
              >
                {strings.eqPresetCustom}
              </span>
            )}
          </div>

          <div className="mt-4 space-y-3">
            {EQ_FREQUENCIES.map((freq, index) => (
              <div key={freq} className="flex items-center gap-3">
                <label
                  htmlFor={`eq-band-${index}`}
                  className="w-14 shrink-0 text-xs tabular-nums text-zinc-400"
                >
                  {formatFrequency(freq)}
                </label>
                <input
                  id={`eq-band-${index}`}
                  type="range"
                  min={EQ_MIN_DB}
                  max={EQ_MAX_DB}
                  step={1}
                  value={settings.gains[index] ?? 0}
                  aria-label={strings.eqBandLabel(formatFrequency(freq))}
                  data-testid={`eq-band-${index}`}
                  className="player-range w-full"
                  onChange={(e) =>
                    void service.setEqBand(index, Number(e.target.value))
                  }
                />
                <span className="w-12 shrink-0 text-right text-xs tabular-nums text-zinc-400">
                  {formatGain(settings.gains[index] ?? 0)}
                </span>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void service.resetEq()}
            data-testid="eq-reset"
            className="mt-4 h-11 rounded-full border border-white/15 px-5 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
          >
            {strings.eqReset}
          </button>
        </>
      )}
    </div>
  );
}
