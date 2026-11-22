// Deklarasi tipe untuk proxy.js (P-SameSite) — supaya impor
// dari tes TypeScript tidak TS7016. JANGAN edit manual tanpa
// mengubah proxy.js: kontraknya harus sama (lihat tes
// pagesApiProxy.test.ts).

export declare const UPSTREAM_BASE: string;
export declare const FORWARDED_IP_HEADER: string;
export declare const PROXY_SECRET_HEADER: string;

export interface PagesProxyContext {
  request: Request;
  env: Record<string, string | undefined>;
}

export declare function onRequest(
  context: PagesProxyContext,
): Promise<Response>;
