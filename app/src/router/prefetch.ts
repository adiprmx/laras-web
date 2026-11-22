/**
 * Prefetch chunk rute on-intent (P-Links, Koordinator #18).
 *
 * App.tsx mendaftarkan pemuat lazy tiap rute sekali di scope
 * modul; AppLink memanggil prefetchRoute(to) saat hover/fokus.
 * Chunk yang sama dipakai lazy() — import() kedua kalinya
 * langsung selesai dari cache modul, jadi navigasi sesudah
 * hover tidak lagi menunggu unduhan chunk.
 *
 * Pencocokan awalan terpanjang: '/library/playlist/5' memakai
 * pemuat '/library/playlist' (bukan '/library'). '/' hanya
 * cocok persis (beranda tidak lazy — tidak ada yang di-prefetch).
 * Tiap awalan hanya di-prefetch sekali per sesi.
 */
type RouteLoader = () => Promise<unknown>;

const loaders = new Map<string, RouteLoader>();
const prefetched = new Set<string>();

export function registerRoutePreload(
  prefix: string,
  load: RouteLoader,
): void {
  if (!loaders.has(prefix)) loaders.set(prefix, load);
}

export function prefetchRoute(path: string): void {
  const clean = path.split('#')[0];
  let best: string | null = null;
  for (const prefix of loaders.keys()) {
    if (prefix === '/') {
      if (clean === '/' && best === null) best = prefix;
      continue;
    }
    const matches =
      clean === prefix ||
      clean.startsWith(`${prefix}/`) ||
      clean.startsWith(`${prefix}?`);
    if (matches && (best === null || prefix.length > best.length)) {
      best = prefix;
    }
  }
  if (best === null || prefetched.has(best)) return;
  prefetched.add(best);
  void loaders.get(best)!().catch(() => undefined);
}

/** Hanya untuk tes. */
export function __resetRoutePreloads(): void {
  loaders.clear();
  prefetched.clear();
}
