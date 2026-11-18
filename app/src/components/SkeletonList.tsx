/**
 * Skeleton daftar: meniru bentuk baris lagu (sampul + dua garis
 * teks), bukan sekadar tulisan "Memuat". Dipakai pencarian
 * (6 baris, PRD B1.1), beranda, dan halaman browse.
 */
import { strings } from '../strings/id';

export default function SkeletonList({
  rows = 6,
  testId = 'skeleton-list',
}: {
  rows?: number;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      role="status"
      aria-label={strings.loadingLabel}
      className="animate-pulse"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 py-2">
          <div className="h-12 w-12 shrink-0 rounded-lg bg-zinc-800/80" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-3/4 rounded bg-zinc-800/80" />
            <div className="h-3 w-1/2 rounded bg-zinc-800/60" />
          </div>
        </div>
      ))}
    </div>
  );
}
