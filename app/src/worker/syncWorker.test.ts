/**
 * Tes Vitest Worker sinkronisasi (P7).
 *
 * Worker (`workers/sync/src/index.js`) diimpor langsung dengan
 * D1 palsu in-memory yang meniru pernyataan SQL yang dipakai
 * Worker (termasuk semantik upsert LWW + tiebreak device_id
 * dari protokol S8). Ini menguji logika routing, auth, LWW,
 * tombstone, dan batasan tanpa Cloudflare; perilaku D1 aslinya
 * diverifikasi koordinator saat deploy (smoke test README).
 *
 * fetch global di-stub hanya untuk tes alur OAuth (tukar kode +
 * profil); tes lain tidak menyentuh jaringan.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import worker from '../../../workers/sync/src/index.js';

// ------------------------------------------------------------------
// D1 palsu
// ------------------------------------------------------------------

interface UserRow {
  id: string;
  provider: string;
  provider_id: string;
  display_name: string;
  created_at: number;
}
interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  created_at: number;
}
interface PlaylistRow {
  id: string;
  user_id: string;
  client_id: string;
  nama: string;
  deskripsi: string | null;
  device_id: string;
  updated_at: number;
  deleted_at: number | null;
}
interface ItemRow {
  playlist_id: string;
  video_id: string;
  posisi: number;
  added_at: number;
  device_id: string;
  updated_at: number;
  deleted_at: number | null;
  title: string | null;
  artist: string | null;
  user_id: string | null;
}
interface LikeRow {
  user_id: string;
  video_id: string;
  liked_at: number;
  device_id: string;
  updated_at: number;
  deleted_at: number | null;
  title: string | null;
  artist: string | null;
}
interface HistoryRow {
  user_id: string;
  video_id: string;
  played_at: number;
  seconds_played: number;
  device_id: string;
  updated_at: number;
  title: string | null;
  artist: string | null;
}

class FakeD1 {
  users = new Map<string, UserRow>();
  sessions = new Map<string, SessionRow>();
  playlists = new Map<string, PlaylistRow>();
  items = new Map<string, ItemRow>();
  likes = new Map<string, LikeRow>();
  history = new Map<string, HistoryRow>();
  settings = new Map<
    string,
    { user_id: string; settings_json: string; device_id: string; updated_at: number }
  >();
  rateLimits = new Map<string, number>();
  oauthStates = new Map<
    string,
    { provider: string; expires_at: number; created_at: number }
  >();

  prepare(query: string) {
    const sql = query;
    let values: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        values = v;
        return stmt;
      },
      // Arrow function supaya `this` tetap FakeD1 (bukan stmt).
      run: async (): Promise<{ success: boolean }> => {
        this.runSql(sql, values);
        return { success: true };
      },
      first: async <T,>(): Promise<T | null> => {
        return this.firstSql(sql, values) as T | null;
      },
      all: async <T,>(): Promise<{ results: T[] }> => {
        return { results: this.allSql(sql, values) as T[] };
      },
    };
    return stmt;
  }

  async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }

  /** LWW: baris baru menang bila updated_at lebih besar, atau sama + device_id lebih besar. */
  private wins(newUpdatedAt: number, newDeviceId: string, old: { updated_at: number; device_id: string }): boolean {
    return (
      newUpdatedAt > old.updated_at ||
      (newUpdatedAt === old.updated_at && newDeviceId > old.device_id)
    );
  }

  runSql(sql: string, v: unknown[]): void {
    // Rate limit (proxy rateLimit.js).
    if (sql.startsWith('INSERT INTO rate_limits')) {
      const k = `${String(v[0])}|${Number(v[1])}`;
      this.rateLimits.set(k, (this.rateLimits.get(k) ?? 0) + 1);
      return;
    }
    if (sql.startsWith('DELETE FROM rate_limits')) {
      const cutoff = Number(v[0]);
      for (const [k] of [...this.rateLimits]) {
        if (Number(k.split('|')[1]) < cutoff) this.rateLimits.delete(k);
      }
      return;
    }
    if (sql.startsWith('INSERT INTO oauth_states')) {
      this.oauthStates.set(String(v[0]), {
        provider: String(v[1]),
        expires_at: Number(v[2]),
        created_at: Number(v[3]),
      });
      return;
    }
    if (sql.startsWith('DELETE FROM oauth_states WHERE expires_at < ?')) {
      const cutoff = Number(v[0]);
      for (const [k, s] of [...this.oauthStates]) {
        if (s.expires_at < cutoff) this.oauthStates.delete(k);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM oauth_states WHERE state_hash = ?')) {
      this.oauthStates.delete(String(v[0]));
      return;
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      this.sessions.set(String(v[0]), {
        id: String(v[0]),
        user_id: String(v[1]),
        token_hash: String(v[2]),
        expires_at: Number(v[3]),
        created_at: Number(v[4]),
      });
      return;
    }
    if (sql.startsWith('DELETE FROM sessions WHERE user_id = ? AND id NOT IN')) {
      const userId = String(v[0]);
      const mine = [...this.sessions.values()]
        .filter((s) => s.user_id === userId)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(10);
      for (const s of mine) this.sessions.delete(s.id);
      return;
    }
    if (sql.startsWith('DELETE FROM sessions WHERE id = ?')) {
      this.sessions.delete(String(v[0]));
      return;
    }
    if (sql.startsWith('DELETE FROM sessions WHERE user_id = ?')) {
      for (const [id, s] of [...this.sessions]) {
        if (s.user_id === String(v[0])) this.sessions.delete(id);
      }
      return;
    }
    if (sql.startsWith('INSERT INTO users')) {
      this.users.set(String(v[0]), {
        id: String(v[0]),
        provider: String(v[1]),
        provider_id: String(v[2]),
        display_name: String(v[3]),
        created_at: Number(v[4]),
      });
      return;
    }
    if (sql.startsWith('UPDATE users SET display_name')) {
      const u = this.users.get(String(v[1]));
      if (u) u.display_name = String(v[0]);
      return;
    }
    if (sql.startsWith('DELETE FROM users WHERE id = ?')) {
      this.users.delete(String(v[0]));
      return;
    }
    if (sql.startsWith('INSERT INTO sync_playlists')) {
      const tombstone = !sql.includes('?, NULL)');
      const id = String(v[0]);
      const existing = this.playlists.get(id);
      const row: PlaylistRow = {
        id,
        user_id: String(v[1]),
        client_id: String(v[2]),
        nama: tombstone ? (existing?.nama ?? '') : String(v[3]),
        deskripsi: tombstone ? (existing?.deskripsi ?? null) : (v[4] as string | null),
        device_id: String(v[5]),
        updated_at: Number(v[6]),
        deleted_at: tombstone ? Number(v[7]) : null,
      };
      if (
        !existing ||
        // R11: upsert hanya menimpa bila baris yang ada milik pendorong.
        (existing.user_id === row.user_id &&
          this.wins(row.updated_at, row.device_id, existing))
      ) {
        this.playlists.set(id, row);
      }
      return;
    }
    if (sql.startsWith('INSERT INTO sync_playlist_items')) {
      const tombstone = sql.includes('VALUES (?, ?, 0,');
      const key = `${String(v[0])}|${String(v[1])}`;
      const existing = this.items.get(key);
      const row: ItemRow = tombstone
        ? {
            playlist_id: String(v[0]),
            video_id: String(v[1]),
            posisi: existing?.posisi ?? 0,
            added_at: Number(v[2]),
            device_id: String(v[3]),
            updated_at: Number(v[4]),
            deleted_at: Number(v[5]),
            title: existing?.title ?? null,
            artist: existing?.artist ?? null,
            user_id: String(v[6]),
          }
        : {
            playlist_id: String(v[0]),
            video_id: String(v[1]),
            posisi: Number(v[2]),
            added_at: Number(v[3]),
            device_id: String(v[4]),
            updated_at: Number(v[5]),
            deleted_at: null,
            title: v[6] as string | null,
            artist: v[7] as string | null,
            user_id: String(v[8]),
          };
      if (!existing || this.wins(row.updated_at, row.device_id, existing)) {
        this.items.set(key, row);
      }
      return;
    }
    if (sql.startsWith('INSERT INTO sync_likes')) {
      const tombstone = sql.includes('VALUES (?, ?, ?, ?, ?, ?)');
      const key = `${String(v[0])}|${String(v[1])}`;
      const existing = this.likes.get(key);
      const row: LikeRow = tombstone
        ? {
            user_id: String(v[0]),
            video_id: String(v[1]),
            liked_at: existing?.liked_at ?? Number(v[2]),
            device_id: String(v[3]),
            updated_at: Number(v[4]),
            deleted_at: Number(v[5]),
            title: existing?.title ?? null,
            artist: existing?.artist ?? null,
          }
        : {
            user_id: String(v[0]),
            video_id: String(v[1]),
            liked_at: Number(v[2]),
            device_id: String(v[3]),
            updated_at: Number(v[4]),
            deleted_at: null,
            title: v[5] as string | null,
            artist: v[6] as string | null,
          };
      if (!existing || this.wins(row.updated_at, row.device_id, existing)) {
        this.likes.set(key, row);
      }
      return;
    }
    if (sql.startsWith('INSERT INTO sync_history')) {
      const key = `${String(v[0])}|${String(v[1])}|${Number(v[2])}`;
      const existing = this.history.get(key);
      const row: HistoryRow = {
        user_id: String(v[0]),
        video_id: String(v[1]),
        played_at: Number(v[2]),
        seconds_played: Math.max(
          existing?.seconds_played ?? 0,
          Number(v[3]),
        ),
        device_id: String(v[4]),
        updated_at: Number(v[5]),
        title: v[6] as string | null,
        artist: v[7] as string | null,
      };
      this.history.set(key, row);
      return;
    }
    if (sql.startsWith('INSERT INTO sync_settings')) {
      const userId = String(v[0]);
      const existing = this.settings.get(userId);
      const row = {
        user_id: userId,
        settings_json: String(v[1]),
        device_id: String(v[2]),
        updated_at: Number(v[3]),
      };
      if (!existing || this.wins(row.updated_at, row.device_id, existing)) {
        this.settings.set(userId, row);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM sync_history WHERE user_id = ? AND played_at <= ?')) {
      for (const [k, h] of [...this.history]) {
        if (h.user_id === String(v[0]) && h.played_at <= Number(v[1])) {
          this.history.delete(k);
        }
      }
      return;
    }
    if (
      sql.startsWith(
        'DELETE FROM sync_playlist_items WHERE playlist_id IN (SELECT id FROM sync_playlists WHERE user_id = ?)',
      )
    ) {
      const userPlaylistIds = new Set(
        [...this.playlists.values()]
          .filter((p) => p.user_id === String(v[0]))
          .map((p) => p.id),
      );
      for (const [k, item] of [...this.items]) {
        if (userPlaylistIds.has(item.playlist_id)) this.items.delete(k);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM sync_playlists WHERE user_id = ?')) {
      for (const [id, p] of [...this.playlists]) {
        if (p.user_id === String(v[0])) this.playlists.delete(id);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM sync_likes WHERE user_id = ?')) {
      for (const [k, l] of [...this.likes]) {
        if (l.user_id === String(v[0])) this.likes.delete(k);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM sync_history WHERE user_id = ?')) {
      for (const [k, h] of [...this.history]) {
        if (h.user_id === String(v[0])) this.history.delete(k);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM sync_settings WHERE user_id = ?')) {
      this.settings.delete(String(v[0]));
      return;
    }
    throw new Error(`pernyataan tak dikenal: ${sql}`);
  }

  firstSql(sql: string, v: unknown[]): unknown {
    if (sql.startsWith('SELECT count FROM rate_limits')) {
      const count = this.rateLimits.get(`${String(v[0])}|${Number(v[1])}`);
      return count === undefined ? null : { count };
    }
    if (sql.startsWith('SELECT provider, expires_at FROM oauth_states')) {
      const s = this.oauthStates.get(String(v[0]));
      return s
        ? { provider: s.provider, expires_at: s.expires_at }
        : null;
    }
    if (sql.startsWith('SELECT user_id FROM sync_playlists WHERE id = ?')) {
      const p = this.playlists.get(String(v[0]));
      return p ? { user_id: p.user_id } : null;
    }
    if (sql.startsWith('SELECT id, user_id, expires_at FROM sessions')) {
      for (const s of this.sessions.values()) {
        if (s.token_hash === String(v[0])) {
          return { id: s.id, user_id: s.user_id, expires_at: s.expires_at };
        }
      }
      return null;
    }
    if (sql.startsWith('SELECT id, display_name, provider FROM users WHERE id = ?')) {
      const u = this.users.get(String(v[0]));
      return u
        ? { id: u.id, display_name: u.display_name, provider: u.provider }
        : null;
    }
    if (
      sql.startsWith(
        'SELECT id, provider, provider_id, display_name FROM users WHERE provider = ?',
      )
    ) {
      for (const u of this.users.values()) {
        if (u.provider === String(v[0]) && u.provider_id === String(v[1])) {
          return {
            id: u.id,
            provider: u.provider,
            provider_id: u.provider_id,
            display_name: u.display_name,
          };
        }
      }
      return null;
    }
    if (sql.startsWith('SELECT settings_json, updated_at FROM sync_settings')) {
      const s = this.settings.get(String(v[0]));
      return s
        ? { settings_json: s.settings_json, updated_at: s.updated_at }
        : null;
    }
    throw new Error(`select tak dikenal: ${sql}`);
  }

  allSql(sql: string, v: unknown[]): unknown[] {
    const userId = String(v[0]);
    const since = Number(v[1]);
    const limit = Number(v[2]);
    if (sql.startsWith('SELECT client_id, nama, deskripsi, updated_at, deleted_at FROM sync_playlists')) {
      return [...this.playlists.values()]
        .filter((p) => p.user_id === userId && p.updated_at > since)
        .sort((a, b) => a.updated_at - b.updated_at)
        .slice(0, limit)
        .map((p) => ({
          client_id: p.client_id,
          nama: p.nama,
          deskripsi: p.deskripsi,
          updated_at: p.updated_at,
          deleted_at: p.deleted_at,
        }));
    }
    if (sql.startsWith('SELECT p.client_id AS playlist_client_id')) {
      const playlistById = new Map(
        [...this.playlists.values()].map((p) => [p.id, p]),
      );
      return [...this.items.values()]
        .filter((item) => {
          const p = playlistById.get(item.playlist_id);
          return p?.user_id === userId && item.updated_at > since;
        })
        .sort((a, b) => a.updated_at - b.updated_at)
        .slice(0, limit)
        .map((item) => ({
          playlist_client_id: playlistById.get(item.playlist_id)?.client_id,
          video_id: item.video_id,
          posisi: item.posisi,
          title: item.title,
          artist: item.artist,
          updated_at: item.updated_at,
          deleted_at: item.deleted_at,
        }));
    }
    if (sql.startsWith('SELECT video_id, liked_at, title, artist, updated_at, deleted_at FROM sync_likes')) {
      return [...this.likes.values()]
        .filter((l) => l.user_id === userId && l.updated_at > since)
        .sort((a, b) => a.updated_at - b.updated_at)
        .slice(0, limit)
        .map((l) => ({
          video_id: l.video_id,
          liked_at: l.liked_at,
          title: l.title,
          artist: l.artist,
          updated_at: l.updated_at,
          deleted_at: l.deleted_at,
        }));
    }
    if (sql.startsWith('SELECT video_id, played_at, seconds_played, title, artist, updated_at FROM sync_history')) {
      return [...this.history.values()]
        .filter((h) => h.user_id === userId && h.updated_at > since)
        .sort((a, b) => a.updated_at - b.updated_at)
        .slice(0, limit)
        .map((h) => ({
          video_id: h.video_id,
          played_at: h.played_at,
          seconds_played: h.seconds_played,
          title: h.title,
          artist: h.artist,
          updated_at: h.updated_at,
        }));
    }
    throw new Error(`select tak dikenal: ${sql}`);
  }
}

// ------------------------------------------------------------------
// Bantuan tes
// ------------------------------------------------------------------

const WORKER_ORIGIN = 'https://laras-sync.test';
const APP_ORIGIN = 'https://laras.adipmusic.my.id';

function makeEnv(db: FakeD1, extra: Record<string, unknown> = {}) {
  return {
    DB: db as never,
    APP_URL: APP_ORIGIN,
    ALLOWED_ORIGINS: APP_ORIGIN,
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    GITHUB_CLIENT_ID: 'test-gh-id',
    GITHUB_CLIENT_SECRET: 'test-gh-secret',
    ...extra,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Buat pengguna + sesi langsung di D1 palsu; kembalikan header Cookie. */
async function seedSession(
  db: FakeD1,
  opts: { userId?: string; displayName?: string } = {},
): Promise<{ cookie: string; userId: string }> {
  const userId = opts.userId ?? 'user-1';
  const token = `token-${userId}-${Math.random().toString(36).slice(2)}`;
  db.users.set(userId, {
    id: userId,
    provider: 'google',
    provider_id: 'google-1',
    display_name: opts.displayName ?? 'Pengguna Uji',
    created_at: Date.now(),
  });
  db.sessions.set(`session-${userId}`, {
    id: `session-${userId}`,
    user_id: userId,
    token_hash: await sha256Hex(token),
    expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
    created_at: Date.now(),
  });
  return { cookie: `laras_session=${token}`, userId };
}

function call(
  env: ReturnType<typeof makeEnv>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_ORIGIN}${path}`, init),
    env as never,
    {} as never,
  ) as Promise<Response>;
}

async function push(
  env: ReturnType<typeof makeEnv>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return call(env, '/api/sync/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: APP_ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

async function pull(
  env: ReturnType<typeof makeEnv>,
  cookie: string,
  since = 0,
): Promise<Response> {
  return call(env, `/api/sync/pull?since=${since}`, {
    headers: { Cookie: cookie, Origin: APP_ORIGIN },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------
// Auth
// ------------------------------------------------------------------

describe('Worker sync: /api/auth/me', () => {
  it('401 tanpa cookie sesi', async () => {
    const env = makeEnv(new FakeD1());
    const res = await call(env, '/api/auth/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('I12: cookie dengan % malformed tidak membuat 500', async () => {
    const env = makeEnv(new FakeD1());
    const res = await call(env, '/api/auth/me', {
      headers: { Cookie: 'laras_session=%E0%A4%A' },
    });
    // Nilai rusak dipakai mentah; sesi tidak ditemukan -> 401, bukan 500.
    expect(res.status).toBe(401);
  });

  it('I14: respons JSON membawa nosniff, halaman 503 membawa CSP + nosniff', async () => {
    const env = makeEnv(new FakeD1());
    const me = await call(env, '/api/auth/me');
    expect(me.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const pending = makeEnv(new FakeD1(), {
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    });
    const res = await call(pending, '/api/auth/login?provider=google');
    expect(res.status).toBe(503);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain(
      "default-src 'none'",
    );
  });

  it('200 + nama tampil dengan cookie sesi valid', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db, { displayName: 'Adip Uji' });
    const res = await call(env, '/api/auth/me', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { displayName: string; provider: string };
    };
    expect(body.data.displayName).toBe('Adip Uji');
    expect(body.data.provider).toBe('google');
  });

  it('401 bila sesi kedaluwarsa', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    const session = db.sessions.get(`session-${userId}`);
    if (session) session.expires_at = Date.now() - 1000;
    const res = await call(env, '/api/auth/me', { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
  });
});

describe('Worker sync: /api/auth/login', () => {
  it('503 jujur bila secret OAuth belum dipasang', async () => {
    const env = makeEnv(new FakeD1(), {
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    });
    const res = await call(env, '/api/auth/login?provider=google');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Masuk belum tersedia');
  });

  it('302 ke Google + cookie state bila secret ada', async () => {
    const env = makeEnv(new FakeD1());
    const res = await call(env, '/api/auth/login?provider=google');
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') ?? '';
    expect(location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(location).toContain('client_id=test-google-id');
    expect(location).toContain('state=');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('laras_oauth_state='))).toBe(true);
    expect(cookies.some((c) => c.includes('SameSite=Lax'))).toBe(true);
  });

  it('400 untuk provider tidak dikenal', async () => {
    const env = makeEnv(new FakeD1());
    const res = await call(env, '/api/auth/login?provider=facebook');
    expect(res.status).toBe(400);
  });
});

describe('Worker sync: /api/auth/callback (OAuth Google, fetch di-stub)', () => {
  function stubGoogleProfile(displayName: string) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'access-123' });
      }
      if (u.includes('openidconnect.googleapis.com')) {
        return Response.json({ sub: 'google-sub-9', name: displayName });
      }
      throw new Error(`fetch tak terduga: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('tukar kode -> buat pengguna + sesi -> 302 ke /settings?auth=ok', async () => {
    stubGoogleProfile('Nama Google');
    const db = new FakeD1();
    const env = makeEnv(db);
    // 1) Login untuk mendapat cookie state.
    const login = await call(env, '/api/auth/login?provider=google');
    const stateCookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith('laras_oauth_state=')) as string;
    const stateValue = stateCookie
      .split(';')[0]
      .split('=')[1];
    const state = stateValue.split('.')[0];
    // 2) Callback dengan state yang cocok.
    const res = await call(
      env,
      `/api/auth/callback?code=code-abc&state=${state}`,
      { headers: { Cookie: `laras_oauth_state=${stateValue}` } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `${APP_ORIGIN}/settings?auth=ok`,
    );
    const cookies = res.headers.getSetCookie();
    const sessionCookie = cookies.find((c) =>
      c.startsWith('laras_session='),
    ) as string;
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=None');
    // 3) Sesi baru bisa dipakai /api/auth/me.
    const token = sessionCookie.split(';')[0].split('=')[1];
    const me = await call(env, '/api/auth/me', {
      headers: { Cookie: `laras_session=${token}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      data: { displayName: string };
    };
    expect(body.data.displayName).toBe('Nama Google');
    expect(db.users.size).toBe(1);
  });

  it('state tidak cocok -> 302 ke ?auth=error&reason=state', async () => {
    stubGoogleProfile('Nama Google');
    const db = new FakeD1();
    const env = makeEnv(db);
    const res = await call(
      env,
      '/api/auth/callback?code=code-abc&state=salah',
      { headers: { Cookie: 'laras_oauth_state=benar.google' } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('auth=error&reason=state');
    expect(db.users.size).toBe(0);
  });

  it('login kedua dengan provider_id sama tidak menduplikasi pengguna', async () => {
    stubGoogleProfile('Nama Baru');
    const db = new FakeD1();
    const env = makeEnv(db);
    const doLogin = async () => {
      const login = await call(env, '/api/auth/login?provider=google');
      const stateCookie = login.headers
        .getSetCookie()
        .find((c) => c.startsWith('laras_oauth_state=')) as string;
      const stateValue = stateCookie.split(';')[0].split('=')[1];
      const state = stateValue.split('.')[0];
      return call(
        env,
        `/api/auth/callback?code=code-abc&state=${state}`,
        { headers: { Cookie: `laras_oauth_state=${stateValue}` } },
      );
    };
    await doLogin();
    await doLogin();
    expect(db.users.size).toBe(1);
    expect([...db.users.values()][0].display_name).toBe('Nama Baru');
  });

  // ---- Blue 3 (Red 3 S6): rate limit callback + state sekali pakai ----

  /** Login dari satu IP, kembalikan nilai cookie state + state-nya. */
  async function loginState(
    env: ReturnType<typeof makeEnv>,
    ip: string,
  ): Promise<{ stateValue: string; state: string }> {
    const login = await call(env, '/api/auth/login?provider=google', {
      headers: { 'CF-Connecting-IP': ip },
    });
    expect(login.status).toBe(302);
    const stateCookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith('laras_oauth_state=')) as string;
    const stateValue = stateCookie.split(';')[0].split('=')[1];
    return { stateValue, state: stateValue.split('.')[0] };
  }

  it('S6: 11 callback cepat dari satu IP -> 10 diproses + 1 ditolak 429', async () => {
    // Kode palsu: tukar kode gagal (token endpoint 400) sehingga
    // tiap callback "diproses" sampai exchange lalu 302 error.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 400 })),
    );
    const db = new FakeD1();
    const env = makeEnv(db);
    const callbackIp = '203.0.113.99';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      // Login dari IP berbeda tiap kali supaya rate limit login
      // (10/mnt/IP) tidak menghalangi pembuatan 11 state valid.
      const { stateValue, state } = await loginState(
        env,
        `198.51.100.${i + 1}`,
      );
      const res = await call(
        env,
        `/api/auth/callback?code=kode-palsu&state=${state}`,
        {
          headers: {
            Cookie: `laras_oauth_state=${stateValue}`,
            'CF-Connecting-IP': callbackIp,
          },
        },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(302));
    expect(statuses[10]).toBe(429);
    // Tidak ada pengguna yang tercipta dari kode palsu.
    expect(db.users.size).toBe(0);
  });

  it('S6: callback kedua dengan state yang sama ditolak', async () => {
    stubGoogleProfile('Nama Google');
    const db = new FakeD1();
    const env = makeEnv(db);
    const { stateValue, state } = await loginState(env, '203.0.113.5');
    const first = await call(
      env,
      `/api/auth/callback?code=code-abc&state=${state}`,
      { headers: { Cookie: `laras_oauth_state=${stateValue}` } },
    );
    expect(first.status).toBe(302);
    expect(first.headers.get('Location')).toBe(
      `${APP_ORIGIN}/settings?auth=ok`,
    );
    expect(db.sessions.size).toBe(1);
    const second = await call(
      env,
      `/api/auth/callback?code=code-abc&state=${state}`,
      { headers: { Cookie: `laras_oauth_state=${stateValue}` } },
    );
    expect(second.status).toBe(302);
    expect(second.headers.get('Location')).toContain('auth=error&reason=state');
    expect(db.sessions.size).toBe(1);
  });

  it('S6: state yang tidak pernah dikeluarkan login ditolak', async () => {
    stubGoogleProfile('Nama Google');
    const db = new FakeD1();
    const env = makeEnv(db);
    // Cookie dan query cocok, tetapi tidak ada login yang
    // mengeluarkan state ini (tidak ada baris di oauth_states).
    const res = await call(
      env,
      '/api/auth/callback?code=code-abc&state=0123456789abcdef0123456789abcdef',
      {
        headers: {
          Cookie:
            'laras_oauth_state=0123456789abcdef0123456789abcdef.google',
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('auth=error&reason=state');
    expect(db.users.size).toBe(0);
  });
});

describe('Worker sync: /api/auth/logout + /api/auth/delete', () => {
  it('logout menghapus sesi; /api/auth/me sesudahnya 401', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    const res = await call(env, '/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: APP_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(db.sessions.has(`session-${userId}`)).toBe(false);
    const me = await call(env, '/api/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(401);
  });

  it('logout dari origin tidak dikenal ditolak 403', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await call(env, '/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://jahat.example' },
    });
    expect(res.status).toBe(403);
  });

  it('hapus akun menghapus pengguna + semua data sync-nya', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    const pushed = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:1', nama: 'Favorit', deskripsi: null }],
      likes: [{ videoId: 'vid-1', likedAt: 1000, title: 'Lagu', artist: null }],
    });
    expect(pushed.status).toBe(200);
    expect(db.playlists.size).toBe(1);
    const res = await call(env, '/api/auth/delete', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: APP_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(db.users.has(userId)).toBe(false);
    expect(db.playlists.size).toBe(0);
    expect(db.likes.size).toBe(0);
    expect(db.sessions.size).toBe(0);
    const me = await call(env, '/api/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(401);
  });
});

// ------------------------------------------------------------------
// Sync: tarik + dorong
// ------------------------------------------------------------------

describe('Worker sync: /api/sync/pull + /api/sync/push', () => {
  it('401 tanpa sesi untuk pull dan push', async () => {
    const env = makeEnv(new FakeD1());
    expect((await pull(env, '')).status).toBe(401);
    expect(
      (
        await push(env, '', { deviceId: 'dev-1' })
      ).status,
    ).toBe(401);
  });

  it('pull kosong untuk pengguna baru', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await pull(env, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        playlists: unknown[];
        playlistItems: unknown[];
        likes: unknown[];
        history: unknown[];
        settings: unknown;
      };
    };
    expect(body.data.playlists).toEqual([]);
    expect(body.data.playlistItems).toEqual([]);
    expect(body.data.likes).toEqual([]);
    expect(body.data.history).toEqual([]);
    expect(body.data.settings).toBeNull();
  });

  it('push lalu pull mengembalikan data yang sama (round-trip)', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const pushed = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [
        { clientId: 'dev-1:1', nama: 'Favorit', deskripsi: 'Pilihan' },
      ],
      playlistItems: [
        {
          playlistClientId: 'dev-1:1',
          videoId: 'vid-1',
          posisi: 0,
          title: 'Lagu Satu',
          artist: 'Artis A',
        },
      ],
      likes: [
        { videoId: 'vid-2', likedAt: 5000, title: 'Lagu Dua', artist: null },
      ],
      history: [
        {
          videoId: 'vid-1',
          playedAt: 6000,
          secondsPlayed: 120,
          title: 'Lagu Satu',
          artist: 'Artis A',
        },
      ],
      settings: { settingsJson: '{"version":1}' },
    });
    expect(pushed.status).toBe(200);
    const res = await pull(env, cookie, 0);
    const body = (await res.json()) as {
      data: {
        playlists: Array<{ clientId: string; nama: string }>;
        playlistItems: Array<{
          playlistClientId: string;
          videoId: string;
          title: string | null;
        }>;
        likes: Array<{ videoId: string }>;
        history: Array<{ videoId: string; secondsPlayed: number }>;
        settings: { settingsJson: string } | null;
      };
    };
    expect(body.data.playlists).toHaveLength(1);
    expect(body.data.playlists[0].nama).toBe('Favorit');
    expect(body.data.playlistItems).toHaveLength(1);
    expect(body.data.playlistItems[0].title).toBe('Lagu Satu');
    expect(body.data.likes).toHaveLength(1);
    expect(body.data.history[0].secondsPlayed).toBe(120);
    expect(body.data.settings?.settingsJson).toBe('{"version":1}');
  });

  it('pull dengan since hanya mengembalikan yang berubah sesudahnya', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const first = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:1', nama: 'Satu', deskripsi: null }],
    });
    const firstBody = (await first.json()) as {
      data: { serverTime: number };
    };
    const since = firstBody.data.serverTime;
    // Dorong kedua di milidetik yang sama mungkin terjadi bila
    // jam belum bergeser; pastikan updated_at kedua > since
    // dengan menunggu 2 ms.
    await new Promise((r) => setTimeout(r, 2));
    await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:2', nama: 'Dua', deskripsi: null }],
    });
    const res = await pull(env, cookie, since);
    const body = (await res.json()) as {
      data: { playlists: Array<{ clientId: string }> };
    };
    expect(body.data.playlists.map((p) => p.clientId)).toEqual(['dev-1:2']);
  });

  it('tombstone: playlist yang dihapus muncul dengan deletedAt', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:1', nama: 'Satu', deskripsi: null }],
    });
    await push(env, cookie, {
      deviceId: 'dev-1',
      deletedPlaylists: [{ clientId: 'dev-1:1' }],
    });
    const res = await pull(env, cookie, 0);
    const body = (await res.json()) as {
      data: { playlists: Array<{ clientId: string; deletedAt: number | null }> };
    };
    expect(body.data.playlists).toHaveLength(1);
    expect(body.data.playlists[0].deletedAt).not.toBeNull();
  });

  it('LWW tiebreak: jam sama, device_id lebih besar menang', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1794784800000);
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    // Dua dorong di milidetik yang sama (jam dibekukan).
    await push(env, cookie, {
      deviceId: 'dev-a',
      playlists: [{ clientId: 'dev-a:1', nama: 'Dari A', deskripsi: null }],
    });
    await push(env, cookie, {
      deviceId: 'dev-b',
      playlists: [{ clientId: 'dev-a:1', nama: 'Dari B', deskripsi: null }],
    });
    // dev-a mencoba lagi di jam yang sama: kalah tiebreak.
    await push(env, cookie, {
      deviceId: 'dev-a',
      playlists: [{ clientId: 'dev-a:1', nama: 'Dari A lagi', deskripsi: null }],
    });
    const res = await pull(env, cookie, 0);
    const body = (await res.json()) as {
      data: { playlists: Array<{ nama: string }> };
    };
    expect(body.data.playlists).toHaveLength(1);
    expect(body.data.playlists[0].nama).toBe('Dari B');
  });

  it('riwayat: dorong kedua menyimpan max(seconds_played)', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const event = {
      videoId: 'vid-1',
      playedAt: 6000,
      secondsPlayed: 30,
      title: null,
      artist: null,
    };
    await push(env, cookie, { deviceId: 'dev-1', history: [event] });
    await push(env, cookie, {
      deviceId: 'dev-1',
      history: [{ ...event, secondsPlayed: 120 }],
    });
    await push(env, cookie, {
      deviceId: 'dev-1',
      history: [{ ...event, secondsPlayed: 45 }],
    });
    const res = await pull(env, cookie, 0);
    const body = (await res.json()) as {
      data: { history: Array<{ secondsPlayed: number }> };
    };
    expect(body.data.history).toHaveLength(1);
    expect(body.data.history[0].secondsPlayed).toBe(120);
  });

  it('historyClearedBefore menghapus riwayat sampai waktu itu', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    await push(env, cookie, {
      deviceId: 'dev-1',
      history: [
        { videoId: 'vid-1', playedAt: 1000, secondsPlayed: 10, title: null, artist: null },
        { videoId: 'vid-2', playedAt: 9000, secondsPlayed: 10, title: null, artist: null },
      ],
    });
    await push(env, cookie, {
      deviceId: 'dev-1',
      historyClearedBefore: 5000,
    });
    const res = await pull(env, cookie, 0);
    const body = (await res.json()) as {
      data: { history: Array<{ videoId: string }> };
    };
    expect(body.data.history.map((h) => h.videoId)).toEqual(['vid-2']);
  });

  it('settings di atas 4 KB ditolak 400', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      settings: { settingsJson: 'x'.repeat(5000) },
    });
    expect(res.status).toBe(400);
  });

  it('lebih dari 100 entri per koleksi ditolak 400', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const likes = Array.from({ length: 101 }, (_, i) => ({
      videoId: `vid-${i}`,
      likedAt: i,
      title: null,
      artist: null,
    }));
    const res = await push(env, cookie, { deviceId: 'dev-1', likes });
    expect(res.status).toBe(400);
  });

  it('body di atas 1 MB (Content-Length) ditolak 413', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await call(env, '/api/sync/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(2 * 1024 * 1024),
        Cookie: cookie,
        Origin: APP_ORIGIN,
      },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('body bukan JSON ditolak 400', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await call(env, '/api/sync/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: APP_ORIGIN,
      },
      body: '{bukan json',
    });
    expect(res.status).toBe(400);
  });

  it('push dari origin tidak dikenal ditolak 403 (CSRF)', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await call(env, '/api/sync/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'https://jahat.example',
      },
      body: JSON.stringify({ deviceId: 'dev-1' }),
    });
    expect(res.status).toBe(403);
  });

  it('CORS: origin diizinkan mendapat header + credentials', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await pull(env, cookie);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('rate limit sync: request ke-31 dalam semenit ditolak 429', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const res = await pull(env, cookie);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('data pengguna A tidak terlihat pengguna B', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const a = await seedSession(db, { userId: 'user-a' });
    const b = await seedSession(db, { userId: 'user-b' });
    await push(env, a.cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:1', nama: 'Punya A', deskripsi: null }],
    });
    const res = await pull(env, b.cookie, 0);
    const body = (await res.json()) as {
      data: { playlists: unknown[] };
    };
    expect(body.data.playlists).toEqual([]);
  });

  // ---- Blue 3 (Red 3 R11): push tanpa cek kepemilikan ----

  it('R11: B mendorong playlist dengan clientId milik A -> data A tidak berubah', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const a = await seedSession(db, { userId: 'user-a' });
    const b = await seedSession(db, { userId: 'user-b' });
    await push(env, a.cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:1', nama: 'Punya A', deskripsi: 'Asli' }],
    });
    const attack = await push(env, b.cookie, {
      deviceId: 'dev-9',
      playlists: [{ clientId: 'dev-1:1', nama: 'Diambil B', deskripsi: null }],
    });
    expect(attack.status).toBe(200);
    const res = await pull(env, a.cookie, 0);
    const body = (await res.json()) as {
      data: { playlists: Array<{ nama: string; deskripsi: string | null }> };
    };
    expect(body.data.playlists).toHaveLength(1);
    expect(body.data.playlists[0]?.nama).toBe('Punya A');
    expect(body.data.playlists[0]?.deskripsi).toBe('Asli');
    // B juga tidak melihat playlist itu sebagai miliknya.
    const resB = await pull(env, b.cookie, 0);
    const bodyB = (await resB.json()) as {
      data: { playlists: unknown[] };
    };
    expect(bodyB.data.playlists).toEqual([]);
  });

  it('R11: B mendorong item ke playlist milik A -> item ditolak, pull A tidak berubah', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const a = await seedSession(db, { userId: 'user-a' });
    const b = await seedSession(db, { userId: 'user-b' });
    await push(env, a.cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:1', nama: 'Punya A', deskripsi: null }],
      playlistItems: [
        {
          playlistClientId: 'dev-1:1',
          videoId: 'vid-asli',
          posisi: 0,
          title: 'Lagu Asli',
          artist: null,
        },
      ],
    });
    const attack = await push(env, b.cookie, {
      deviceId: 'dev-9',
      playlistItems: [
        {
          playlistClientId: 'dev-1:1',
          videoId: 'vid-jahat',
          posisi: 1,
          title: 'Lagu Jahat',
          artist: null,
        },
      ],
    });
    expect(attack.status).toBe(200);
    const attackBody = (await attack.json()) as {
      data: { skippedNotOwned: number };
    };
    expect(attackBody.data.skippedNotOwned).toBe(1);
    const res = await pull(env, a.cookie, 0);
    const body = (await res.json()) as {
      data: { playlistItems: Array<{ videoId: string }> };
    };
    expect(body.data.playlistItems.map((i) => i.videoId)).toEqual(['vid-asli']);
  });

  it('R11: tombstone playlist milik A dari B tidak menghapus playlist A', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const a = await seedSession(db, { userId: 'user-a' });
    const b = await seedSession(db, { userId: 'user-b' });
    await push(env, a.cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:1', nama: 'Punya A', deskripsi: null }],
    });
    await push(env, b.cookie, {
      deviceId: 'dev-9',
      deletedPlaylists: [{ clientId: 'dev-1:1' }],
    });
    const res = await pull(env, a.cookie, 0);
    const body = (await res.json()) as {
      data: { playlists: Array<{ deletedAt: number | null }> };
    };
    expect(body.data.playlists).toHaveLength(1);
    expect(body.data.playlists[0]?.deletedAt).toBeNull();
  });

  it('R11: item untuk playlist yang tidak ada (yatim) ditolak', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      playlistItems: [
        {
          playlistClientId: 'dev-1:tidak-ada',
          videoId: 'vid-1',
          posisi: 0,
          title: null,
          artist: null,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { applied: number; skippedNotOwned: number };
    };
    expect(body.data.skippedNotOwned).toBe(1);
    expect(body.data.applied).toBe(0);
    expect(db.items.size).toBe(0);
  });

  it('R11: playlist baru + item-nya dalam satu push tetap jalan', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:1', nama: 'Baru', deskripsi: null }],
      playlistItems: [
        {
          playlistClientId: 'dev-1:1',
          videoId: 'vid-1',
          posisi: 0,
          title: 'Lagu',
          artist: null,
        },
      ],
    });
    const body = (await res.json()) as {
      data: { skippedNotOwned: number };
    };
    expect(body.data.skippedNotOwned).toBe(0);
    expect(db.items.size).toBe(1);
  });
});
