/**
 * Tautan semantik (P-Links, Koordinator #18).
 *
 * Merender <a href> asli (bisa dibuka di tab baru, disalin
 * tautannya, dibaca screen reader sebagai tautan) tapi klik
 * kiri polos dicegat menjadi navigasi SPA (tanpa muat ulang
 * halaman). Klik termodifikasi (Ctrl/Cmd/Shift/Alt, klik
 * tengah) dibiarkan ke perilaku native browser — SPA fallback
 * di public/_redirects melayani deep link dengan index.html.
 *
 * Hover/fokus memicu prefetch chunk rute tujuan (lihat
 * router/prefetch.ts) supaya navigasi terasa instan.
 */
import type { MouseEvent, ReactNode } from 'react';
import { prefetchRoute } from '../router/prefetch';

interface AppLinkProps {
  to: string;
  onNavigate: (path: string) => void;
  children: ReactNode;
  className?: string;
  testId?: string;
  ariaLabel?: string;
  ariaCurrent?: 'page';
  /** Dijalankan sebelum navigasi (efek samping, mis. set sort). */
  onBeforeNavigate?: () => void;
  /** Prefetch chunk rute saat hover/fokus. Default true. */
  prefetch?: boolean;
}

export default function AppLink({
  to,
  onNavigate,
  children,
  className,
  testId,
  ariaLabel,
  ariaCurrent,
  onBeforeNavigate,
  prefetch = true,
}: AppLinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    e.preventDefault();
    onBeforeNavigate?.();
    onNavigate(to);
  };

  const handleIntent = (): void => {
    if (prefetch) prefetchRoute(to);
  };

  return (
    <a
      href={to}
      onClick={handleClick}
      onMouseEnter={handleIntent}
      onFocus={handleIntent}
      data-testid={testId}
      aria-label={ariaLabel}
      aria-current={ariaCurrent}
      className={className}
    >
      {children}
    </a>
  );
}
