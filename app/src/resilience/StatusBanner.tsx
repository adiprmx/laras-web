/**
 * Banner status 3 tingkat di beranda (P6, PRD B9.8).
 *
 * - info: config memakai cadangan basi (tipis, tanpa tombol).
 * - warning: layanan terganggu, kanari degraded (tipis).
 * - outage: layanan bermasalah, kanari broken (jelas + tombol
 *   "Periksa pembaruan" yang langsung menjalankan pemeriksaan).
 * Normal: tanpa banner sama sekali.
 *
 * Warna hanya fungsi/status (design lock): kuning = peringatan,
 * merah = gangguan, abu = info. Tanpa jargon, tanpa em dash.
 */
import { strings } from '../strings/id';
import { useResilienceStore, type BannerLevel } from './store';

const LEVEL_STYLE: Record<
  Exclude<BannerLevel, 'none'>,
  { box: string; title: string }
> = {
  info: {
    box: 'border-white/10 bg-zinc-900',
    title: 'text-zinc-100',
  },
  warning: {
    box: 'border-amber-400/30 bg-amber-400/10',
    title: 'text-amber-200',
  },
  outage: {
    box: 'border-red-400/30 bg-red-400/10',
    title: 'text-red-200',
  },
};

const LEVEL_COPY: Record<
  Exclude<BannerLevel, 'none'>,
  { title: string; body: string }
> = {
  info: { title: strings.statusInfoTitle, body: strings.statusInfoBody },
  warning: {
    title: strings.statusWarningTitle,
    body: strings.statusWarningBody,
  },
  outage: {
    title: strings.statusOutageTitle,
    body: strings.statusOutageBody,
  },
};

export default function StatusBanner() {
  const level = useResilienceStore((s) => s.bannerLevel);
  const updateStatus = useResilienceStore((s) => s.updateStatus);
  const updateMessage = useResilienceStore((s) => s.updateMessage);
  const runUpdateCheck = useResilienceStore((s) => s.runUpdateCheck);

  if (level === 'none') return null;
  const style = LEVEL_STYLE[level];
  const copy = LEVEL_COPY[level];
  const checking = updateStatus === 'checking';

  return (
    <div
      role="status"
      data-testid="status-banner"
      data-level={level}
      className={`rounded-xl border px-4 py-3 ${style.box}`}
    >
      <p className={`text-sm font-semibold ${style.title}`}>{copy.title}</p>
      <p className="mt-1 text-sm leading-relaxed text-zinc-400">
        {copy.body}
      </p>
      {level === 'outage' ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void runUpdateCheck()}
            disabled={checking}
            data-testid="status-banner-update"
            className="h-11 rounded-full bg-white px-5 text-sm font-medium text-black transition-transform active:scale-95 disabled:opacity-50"
          >
            {checking ? strings.checkingUpdate : strings.checkUpdate}
          </button>
          {updateMessage ? (
            <p
              data-testid="status-banner-update-result"
              className="mt-2 text-sm text-zinc-300"
            >
              {updateMessage}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
