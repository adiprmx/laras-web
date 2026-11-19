/**
 * Tautan masuk OAuth (P7).
 *
 * Masuk adalah navigasi top-level ke Worker (bukan fetch):
 * provider OAuth tidak mengizinkan alurnya di dalam iframe /
 * fetch. Worker membalas 302 ke Google/GitHub, lalu kembali
 * ke `/settings?auth=ok`. Bila aplikasi OAuth belum dibuat
 * owner, Worker membalas halaman 503 yang jujur ("Masuk belum
 * tersedia") — bukan login palsu.
 */
import { SYNC_API_BASE_URL } from './config';

export type OAuthProvider = 'google' | 'github';

export function loginUrl(provider: OAuthProvider): string {
  return `${SYNC_API_BASE_URL}/api/auth/login?provider=${provider}`;
}
