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
  // Baris yang diubah pernyataan run() terakhir (meniru
  // meta.changes D1; dipakai I19 untuk konsumsi state atomik).
  lastChanges = 0;
  // Blue 5 (migrasi 0005): penghitung batas, anggaran tulis
  // harian, stempel hapus riwayat.
  counts = new Map<string, { n: number; updated_at: number }>();
  writeBudget = new Map<string, number>();
  userMeta = new Map<string, number>();
  // Bila true, baca sync_counts melempar (meniru tabel 0005
  // belum termigrasi) — untuk tes jalur fallback S9.
  throwOnCounts = false;
  // Model meteran baca D1 (Red 5 S9): baris yang DIPINDAI.
  // - first(): 1 baris (lookup); COUNT(*): + jumlah baris cocok.
  // - all(): jumlah baris dikembalikan, DITAMBAH seek IN yang
  //   tidak cocok (cabang probe/penghitung menambah selisihnya),
  //   jadi probe dihitung per kunci yang dicek (<= entri body).
  // - subquery guard (INSERT...SELECT): 1 per pernyataan.
  // Upsert biasa tidak dihitung sebagai baca (konsisten dengan
  // model Red 5; laporan menunjukkan batas tetap aman walau
  // probe konflik upsert ikut dihitung).
  rowsRead = 0;
  // Jumlah query COUNT(*) yang jalan (untuk tes S9).
  countQueries = 0;

  resetReadCount(): void {
    this.rowsRead = 0;
    this.countQueries = 0;
  }

  /** Kunci map penghitung: userId|collection|playlistId. */
  static countKey(userId: string, collection: string, playlistId: string): string {
    return `${userId}|${collection}|${playlistId}`;
  }

  /**
   * Evaluasi guard-WHERE R19 (6 bind terakhir: userId, collection,
   * playlistId, delta, k, cap). SQL tanpa subquery penghitung
   * (upsert biasa) selalu lolos.
   */
  guardPasses(sql: string, v: unknown[]): boolean {
    if (!sql.includes('FROM sync_counts')) return true;
    this.rowsRead += 1; // subquery penghitung
    const [userId, collection, playlistId, delta, k, cap] = v.slice(-6) as [
      string,
      string,
      string,
      number,
      number,
      number,
    ];
    const n =
      this.counts.get(
        FakeD1.countKey(userId, collection, playlistId),
      )?.n ?? 0;
    return n - Number(delta) + Number(k) < Number(cap);
  }

  prepare(query: string) {
    const sql = query;
    let values: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        values = v;
        return stmt;
      },
      // Arrow function supaya `this` tetap FakeD1 (bukan stmt).
      run: async (): Promise<{ success: boolean; meta: { changes: number } }> => {
        this.runSql(sql, values);
        return { success: true, meta: { changes: this.lastChanges } };
      },
      first: async <T,>(): Promise<T | null> => {
        this.rowsRead += 1; // lookup (COUNT menambah sisanya)
        return this.firstSql(sql, values) as T | null;
      },
      all: async <T,>(): Promise<{ results: T[] }> => {
        const results = this.allSql(sql, values) as T[];
        this.rowsRead += results.length;
        return { results };
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
    this.lastChanges = 0;
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
    // I19: DELETE berkondisi atomik — hanya hapus bila provider
    // cocok DAN belum kedaluwarsa; lastChanges 1 = berhasil
    // dipakai, 0 = tidak dikenal/kedaluwarsa/sudah dipakai.
    // Cabang ini WAJIB sebelum cabang state_hash polos di bawah
    // (awalan SQL-nya sama).
    if (
      sql.startsWith(
        'DELETE FROM oauth_states WHERE state_hash = ? AND provider = ?',
      )
    ) {
      const s = this.oauthStates.get(String(v[0]));
      if (
        s &&
        s.provider === String(v[1]) &&
        s.expires_at > Number(v[2])
      ) {
        this.oauthStates.delete(String(v[0]));
        this.lastChanges = 1;
      }
      return;
    }
    if (sql.startsWith('DELETE FROM oauth_states WHERE state_hash = ?')) {
      this.oauthStates.delete(String(v[0]));
      return;
    }
    // S8b: cadangan anggaran atomik — upsert berkondisi: gagal
    // (changes 0) bila pemakaian + tagihan melewati anggaran.
    if (sql.startsWith('INSERT INTO sync_write_budget')) {
      const key = `${String(v[0])}|${String(v[1])}`;
      const charge = Number(v[2]);
      const budget = Number(v[3]);
      const used = this.writeBudget.get(key) ?? 0;
      if (used + charge <= budget) {
        this.writeBudget.set(key, used + charge);
        this.lastChanges = 1;
      } else {
        this.lastChanges = 0;
      }
      return;
    }
    // S9: penghitung — tiga bentuk DO UPDATE: increment
    // (n = n + delta), nilai absolut (rekonsiliasi), sentinel -1.
    if (sql.startsWith('INSERT INTO sync_counts')) {
      const key = FakeD1.countKey(
        String(v[0]),
        String(v[1]),
        String(v[2]),
      );
      if (sql.includes('sync_counts.n + excluded.n')) {
        const cur = this.counts.get(key);
        this.counts.set(key, {
          n: (cur?.n ?? 0) + Number(v[3]),
          updated_at: Number(v[4]),
        });
      } else if (sql.includes('SET n = -1')) {
        this.counts.set(key, { n: -1, updated_at: Number(v[3]) });
      } else {
        this.counts.set(key, {
          n: Number(v[3]),
          updated_at: Number(v[4]),
        });
      }
      this.lastChanges = 1;
      return;
    }
    // S8a: stempel hapus riwayat terakhir.
    if (sql.startsWith('INSERT INTO sync_user_meta')) {
      this.userMeta.set(String(v[0]), Number(v[1]));
      this.lastChanges = 1;
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
      // R19: INSERT terjaga diblokir bila guard-WHERE gagal.
      if (!this.guardPasses(sql, v)) return;
      const id = String(v[0]);
      const existing = this.playlists.get(id);
      const row: PlaylistRow = {
        id,
        user_id: String(v[1]),
        client_id: String(v[2]),
        nama: String(v[3]),
        deskripsi: v[4] as string | null,
        device_id: String(v[5]),
        updated_at: Number(v[6]),
        deleted_at: null,
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
    // S7: tombstone playlist memakai UPDATE — hanya menyentuh
    // baris yang sudah ada dan milik pendorong (LWW); tombstone
    // untuk baris yang tidak ada adalah no-op, bukan baris baru.
    if (sql.startsWith('UPDATE sync_playlists SET')) {
      const existing = this.playlists.get(String(v[3]));
      if (
        existing &&
        existing.user_id === String(v[4]) &&
        this.wins(Number(v[1]), String(v[0]), existing)
      ) {
        existing.device_id = String(v[0]);
        existing.updated_at = Number(v[1]);
        existing.deleted_at = Number(v[2]);
        this.lastChanges = 1;
      }
      return;
    }
    if (sql.startsWith('INSERT INTO sync_playlist_items')) {
      // R19: INSERT terjaga diblokir bila guard-WHERE gagal.
      if (!this.guardPasses(sql, v)) return;
      const key = `${String(v[0])}|${String(v[1])}`;
      const existing = this.items.get(key);
      const row: ItemRow = {
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
    // S7: tombstone item memakai UPDATE (no-op bila baris tidak ada).
    if (sql.startsWith('UPDATE sync_playlist_items SET')) {
      const existing = this.items.get(
        `${String(v[3])}|${String(v[4])}`,
      );
      if (
        existing &&
        existing.user_id === String(v[5]) &&
        this.wins(Number(v[1]), String(v[0]), existing)
      ) {
        existing.device_id = String(v[0]);
        existing.updated_at = Number(v[1]);
        existing.deleted_at = Number(v[2]);
        this.lastChanges = 1;
      }
      return;
    }
    if (sql.startsWith('INSERT INTO sync_likes')) {
      // R19: INSERT terjaga diblokir bila guard-WHERE gagal.
      if (!this.guardPasses(sql, v)) return;
      const key = `${String(v[0])}|${String(v[1])}`;
      const existing = this.likes.get(key);
      const row: LikeRow = {
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
    // S7: tombstone suka memakai UPDATE (no-op bila baris tidak ada).
    if (sql.startsWith('UPDATE sync_likes SET')) {
      const existing = this.likes.get(`${String(v[3])}|${String(v[4])}`);
      if (existing && this.wins(Number(v[1]), String(v[0]), existing)) {
        existing.device_id = String(v[0]);
        existing.updated_at = Number(v[1]);
        existing.deleted_at = Number(v[2]);
        this.lastChanges = 1;
      }
      return;
    }
    if (sql.startsWith('INSERT INTO sync_history')) {
      // R19: INSERT terjaga diblokir bila guard-WHERE gagal.
      if (!this.guardPasses(sql, v)) return;
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
    // Blue 5: hapus akun juga menghapus kuota pengguna (0005).
    if (sql.startsWith('DELETE FROM sync_counts WHERE user_id = ?')) {
      const prefix = `${String(v[0])}|`;
      for (const k of [...this.counts.keys()]) {
        if (k.startsWith(prefix)) this.counts.delete(k);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM sync_write_budget WHERE user_id = ?')) {
      const prefix = `${String(v[0])}|`;
      for (const k of [...this.writeBudget.keys()]) {
        if (k.startsWith(prefix)) this.writeBudget.delete(k);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM sync_user_meta WHERE user_id = ?')) {
      this.userMeta.delete(String(v[0]));
      return;
    }
    throw new Error(`pernyataan tak dikenal: ${sql}`);
  }

  firstSql(sql: string, v: unknown[]): unknown {
    if (sql.startsWith('SELECT count FROM rate_limits')) {
      const count = this.rateLimits.get(`${String(v[0])}|${Number(v[1])}`);
      return count === undefined ? null : { count };
    }
    // S7: COUNT total baris milik pengguna (termasuk tombstone).
    // S9: COUNT memindai seluruh baris yang cocok (model meteran
    // baca D1) — dipakai hanya rekonsiliasi + fallback.
    if (sql.startsWith('SELECT COUNT(*) AS n FROM ')) {
      this.countQueries += 1;
      let n = 0;
      if (sql.includes('FROM sync_playlist_items')) {
        // countItemsForPlaylist: bind playlistId, userId.
        const playlistId = String(v[0]);
        const userId = String(v[1]);
        n = [...this.items.values()].filter(
          (item) =>
            item.playlist_id === playlistId && item.user_id === userId,
        ).length;
      } else {
        const userId = String(v[0]);
        if (sql.includes('FROM sync_playlists')) {
          n = [...this.playlists.values()].filter(
            (p) => p.user_id === userId,
          ).length;
        } else if (sql.includes('FROM sync_likes')) {
          n = [...this.likes.values()].filter(
            (l) => l.user_id === userId,
          ).length;
        } else if (sql.includes('FROM sync_history')) {
          n = [...this.history.values()].filter(
            (h) => h.user_id === userId,
          ).length;
        }
      }
      this.rowsRead += n;
      return { n };
    }
    // S8a: stempel hapus riwayat terakhir.
    if (sql.startsWith('SELECT history_cleared_at FROM sync_user_meta')) {
      const at = this.userMeta.get(String(v[0]));
      return at === undefined ? null : { history_cleared_at: at };
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
    // S9: baca penghitung (1 baris per koleksi/playlist). Seek IN
    // yang tidak cocok tetap dihitung (wrapper all() menambah
    // baris dikembalikan; selisihnya ditambah di sini).
    if (
      sql.startsWith(
        'SELECT collection, n, updated_at FROM sync_counts',
      )
    ) {
      if (this.throwOnCounts) throw new Error('no such table: sync_counts');
      const userId = String(v[0]);
      const wanted = v.slice(1).map((x) => String(x));
      const out = wanted
        .filter((c) =>
          this.counts.has(FakeD1.countKey(userId, c, '')),
        )
        .map((c) => {
          const row = this.counts.get(FakeD1.countKey(userId, c, ''))!;
          return { collection: c, n: row.n, updated_at: row.updated_at };
        });
      this.rowsRead += wanted.length - out.length;
      return out;
    }
    if (
      sql.startsWith(
        'SELECT playlist_id, n, updated_at FROM sync_counts',
      )
    ) {
      if (this.throwOnCounts) throw new Error('no such table: sync_counts');
      const userId = String(v[0]);
      const wanted = v.slice(1).map((x) => String(x));
      const out = wanted
        .filter((pid) =>
          this.counts.has(FakeD1.countKey(userId, 'items', pid)),
        )
        .map((pid) => {
          const row = this.counts.get(
            FakeD1.countKey(userId, 'items', pid),
          )!;
          return { playlist_id: pid, n: row.n, updated_at: row.updated_at };
        });
      this.rowsRead += wanted.length - out.length;
      return out;
    }
    // S7: jumlah item per playlist (GROUP BY atas playlist yang
    // disentuh) — jalur fallback S9, difilter user_id (I20).
    if (
      sql.startsWith(
        'SELECT playlist_id, COUNT(*) AS n FROM sync_playlist_items',
      )
    ) {
      const userId = String(v[0]);
      const wanted = new Set(v.slice(1).map((x) => String(x)));
      const counts = new Map<string, number>();
      let scanned = 0;
      for (const item of this.items.values()) {
        if (item.user_id === userId && wanted.has(item.playlist_id)) {
          scanned += 1;
          counts.set(
            item.playlist_id,
            (counts.get(item.playlist_id) ?? 0) + 1,
          );
        }
      }
      const out = [...counts.entries()].map(([playlist_id, n]) => ({
        playlist_id,
        n,
      }));
      // GROUP BY memindai semua item yang cocok (bukan hanya
      // baris grup yang dikembalikan).
      this.rowsRead += scanned - out.length;
      return out;
    }
    // S9: kunci yang sudah ada (membedakan update vs penambahan)
    // — query TERBATAS: hanya kunci dari entri yang didorong.
    if (
      sql.startsWith(
        'SELECT client_id FROM sync_playlists WHERE user_id = ? AND client_id IN (',
      )
    ) {
      const userId = String(v[0]);
      const wanted = new Set(v.slice(1).map((x) => String(x)));
      const out = [...this.playlists.values()]
        .filter((p) => p.user_id === userId && wanted.has(p.client_id))
        .map((p) => ({ client_id: p.client_id }));
      this.rowsRead += wanted.size - out.length;
      return out;
    }
    if (
      sql.startsWith(
        'SELECT video_id FROM sync_likes WHERE user_id = ? AND video_id IN (',
      )
    ) {
      const userId = String(v[0]);
      const wanted = new Set(v.slice(1).map((x) => String(x)));
      const out = [...this.likes.values()]
        .filter((l) => l.user_id === userId && wanted.has(l.video_id))
        .map((l) => ({ video_id: l.video_id }));
      this.rowsRead += wanted.size - out.length;
      return out;
    }
    if (
      sql.startsWith(
        'SELECT video_id, played_at FROM sync_history WHERE user_id = ? AND (video_id, played_at) IN (',
      )
    ) {
      const userId = String(v[0]);
      const wanted = new Set<string>();
      for (let i = 1; i + 1 < v.length; i += 2) {
        wanted.add(`${String(v[i])}|${Number(v[i + 1])}`);
      }
      const out = [...this.history.values()]
        .filter(
          (h) =>
            h.user_id === userId &&
            wanted.has(`${h.video_id}|${h.played_at}`),
        )
        .map((h) => ({ video_id: h.video_id, played_at: h.played_at }));
      this.rowsRead += wanted.size - out.length;
      return out;
    }
    if (
      sql.startsWith(
        'SELECT video_id FROM sync_playlist_items WHERE playlist_id = ? AND user_id = ? AND video_id IN (',
      )
    ) {
      const playlistId = String(v[0]);
      const userId = String(v[1]);
      const wanted = new Set(v.slice(2).map((x) => String(x)));
      const out = [...this.items.values()]
        .filter(
          (item) =>
            item.playlist_id === playlistId &&
            item.user_id === userId &&
            wanted.has(item.video_id),
        )
        .map((item) => ({ video_id: item.video_id }));
      this.rowsRead += wanted.size - out.length;
      return out;
    }
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

/** Seed satu baris penghitung (mensimulasikan keadaan pasca-migrasi 0005). */
function seedCounter(
  db: FakeD1,
  userId: string,
  collection: string,
  playlistId: string,
  n: number,
  updatedAt: number = Date.now(),
): void {
  db.counts.set(FakeD1.countKey(userId, collection, playlistId), {
    n,
    updated_at: updatedAt,
  });
}

/** Total anggaran tulis terpakai pengguna di semua hari (tes S8). */
function budgetUsed(db: FakeD1, userId: string): number {
  let total = 0;
  for (const [k, v] of db.writeBudget) {
    if (k.startsWith(`${userId}|`)) total += v;
  }
  return total;
}

/** Seed satu baris playlist langsung di D1 palsu (untuk tes batas S7). */
function seedPlaylist(
  db: FakeD1,
  userId: string,
  clientId: string,
  nama: string,
): void {
  db.playlists.set(clientId, {
    id: clientId,
    user_id: userId,
    client_id: clientId,
    nama,
    deskripsi: null,
    device_id: 'dev-seed',
    updated_at: 1000,
    deleted_at: null,
  });
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

  // ---- Blue 4 (Red 4 I19): konsumsi state atomik ----

  it('I19: dua callback PARALEL dengan state yang sama — hanya satu yang lanjut', async () => {
    stubGoogleProfile('Nama Google');
    const db = new FakeD1();
    const env = makeEnv(db);
    const { stateValue, state } = await loginState(env, '203.0.113.5');
    const doCallback = () =>
      call(env, `/api/auth/callback?code=code-abc&state=${state}`, {
        headers: { Cookie: `laras_oauth_state=${stateValue}` },
      });
    // Dengan SELECT-lalu-DELETE (kode lama), keduanya lolos
    // SELECT sebelum salah satu DELETE; dengan DELETE
    // berkondisi atomik, hanya satu yang mengubah 1 baris.
    const [a, b] = await Promise.all([doCallback(), doCallback()]);
    const locations = [
      a.headers.get('Location') ?? '',
      b.headers.get('Location') ?? '',
    ].sort();
    expect(locations).toEqual([
      `${APP_ORIGIN}/settings?auth=error&reason=state`,
      `${APP_ORIGIN}/settings?auth=ok`,
    ]);
    expect(db.users.size).toBe(1);
    expect(db.sessions.size).toBe(1);
  });

  it('I19: state kedaluwarsa ditolak (reason=state)', async () => {
    stubGoogleProfile('Nama Google');
    const db = new FakeD1();
    const env = makeEnv(db);
    const state = '0123456789abcdef0123456789abcdef';
    db.oauthStates.set(await sha256Hex(state), {
      provider: 'google',
      expires_at: Date.now() - 1000,
      created_at: Date.now() - 700_000,
    });
    const res = await call(
      env,
      `/api/auth/callback?code=code-abc&state=${state}`,
      { headers: { Cookie: `laras_oauth_state=${state}.google` } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('auth=error&reason=state');
    expect(db.users.size).toBe(0);
  });

  it('I19: provider salah ditolak (reason=state)', async () => {
    stubGoogleProfile('Nama Google');
    const db = new FakeD1();
    const env = makeEnv(db);
    const state = 'fedcba9876543210fedcba9876543210';
    db.oauthStates.set(await sha256Hex(state), {
      provider: 'github',
      expires_at: Date.now() + 600_000,
      created_at: Date.now(),
    });
    const res = await call(
      env,
      `/api/auth/callback?code=code-abc&state=${state}`,
      { headers: { Cookie: `laras_oauth_state=${state}.google` } },
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

  // ------------------------------------------------------------
  // S7 (Blue 4, Red 4): batas TOTAL per pengguna (arsitektur §4.3)
  // ------------------------------------------------------------

  it('S7: pengguna dengan 100 playlist yang mendorong ke-101 ditolak + batas dilaporkan', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 100; i++) {
      seedPlaylist(db, userId, `dev-1:${i}`, `Playlist ${i}`);
    }
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:101', nama: 'Kelebihan', deskripsi: null }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        applied: number;
        skippedOverLimit: { playlists: number };
        limits: {
          playlists: number;
          itemsPerPlaylist: number;
          likes: number;
          history: number;
        };
      };
    };
    expect(body.data.skippedOverLimit.playlists).toBe(1);
    expect(body.data.applied).toBe(0);
    expect(body.data.limits).toEqual({
      playlists: 100,
      itemsPerPlaylist: 1000,
      likes: 10000,
      history: 1000,
    });
    expect(db.playlists.size).toBe(100);
    expect(db.playlists.has('dev-1:101')).toBe(false);
  });

  it('S7: update playlist lama tetap jalan saat sudah di batas 100', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 100; i++) {
      seedPlaylist(db, userId, `dev-1:${i}`, `Playlist ${i}`);
    }
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:5', nama: 'Nama Baru', deskripsi: null }],
    });
    const body = (await res.json()) as {
      data: { applied: number; skippedOverLimit: { playlists: number } };
    };
    expect(body.data.skippedOverLimit.playlists).toBe(0);
    expect(body.data.applied).toBe(1);
    expect(db.playlists.get('dev-1:5')?.nama).toBe('Nama Baru');
    expect(db.playlists.size).toBe(100);
  });

  it('S7: penghapusan playlist tetap jalan saat sudah di batas 100', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 100; i++) {
      seedPlaylist(db, userId, `dev-1:${i}`, `Playlist ${i}`);
    }
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      deletedPlaylists: [{ clientId: 'dev-1:7' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { skippedOverLimit: { playlists: number } };
    };
    expect(body.data.skippedOverLimit.playlists).toBe(0);
    expect(db.playlists.get('dev-1:7')?.deleted_at).not.toBeNull();
    // Tombstone tetap dihitung sebagai baris (menutup putaran
    // hapus-buat-ulang): playlist baru tetap ditolak.
    const res2 = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:baru', nama: 'Baru', deskripsi: null }],
    });
    const body2 = (await res2.json()) as {
      data: { skippedOverLimit: { playlists: number } };
    };
    expect(body2.data.skippedOverLimit.playlists).toBe(1);
  });

  it('S7: tombstone untuk playlist yang tidak ada tidak membuat baris', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      deletedPlaylists: [{ clientId: 'dev-1:hantu' }],
      deletedLikes: [{ videoId: 'vid-hantu' }],
    });
    expect(res.status).toBe(200);
    expect(db.playlists.size).toBe(0);
    expect(db.likes.size).toBe(0);
  });

  it('S7: push suka berulang tidak melewati total 10.000', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 9950; i++) {
      db.likes.set(`${userId}|vid-${i}`, {
        user_id: userId,
        video_id: `vid-${i}`,
        liked_at: 1000 + i,
        device_id: 'dev-seed',
        updated_at: 1000,
        deleted_at: null,
        title: null,
        artist: null,
      });
    }
    const newLikes = (from: number, n: number) =>
      Array.from({ length: n }, (_, k) => ({
        videoId: `vid-baru-${from + k}`,
        likedAt: 5000,
        title: null,
        artist: null,
      }));
    const res1 = await push(env, cookie, {
      deviceId: 'dev-1',
      likes: newLikes(0, 100),
    });
    const body1 = (await res1.json()) as {
      data: { skippedOverLimit: { likes: number } };
    };
    // Headroom 50: 50 masuk, 50 dilewati.
    expect(body1.data.skippedOverLimit.likes).toBe(50);
    expect(db.likes.size).toBe(10000);
    const res2 = await push(env, cookie, {
      deviceId: 'dev-1',
      likes: newLikes(100, 100),
    });
    const body2 = (await res2.json()) as {
      data: { skippedOverLimit: { likes: number } };
    };
    expect(body2.data.skippedOverLimit.likes).toBe(100);
    expect(db.likes.size).toBe(10000);
    // Update suka lama (videoId sudah ada) tetap jalan di batas.
    const res3 = await push(env, cookie, {
      deviceId: 'dev-1',
      likes: [{ videoId: 'vid-0', likedAt: 9999, title: 'Baru', artist: null }],
    });
    const body3 = (await res3.json()) as {
      data: { applied: number; skippedOverLimit: { likes: number } };
    };
    expect(body3.data.skippedOverLimit.likes).toBe(0);
    expect(body3.data.applied).toBe(1);
    expect(db.likes.get(`${userId}|vid-0`)?.title).toBe('Baru');
  });

  it('S7: item ke-1.001 di satu playlist ditolak, playlist lain tidak kena', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    seedPlaylist(db, userId, 'dev-1:penuh', 'Penuh');
    seedPlaylist(db, userId, 'dev-1:kosong', 'Kosong');
    for (let i = 0; i < 1000; i++) {
      db.items.set(`dev-1:penuh|vid-${i}`, {
        playlist_id: 'dev-1:penuh',
        video_id: `vid-${i}`,
        posisi: i,
        added_at: 1000,
        device_id: 'dev-seed',
        updated_at: 1000,
        deleted_at: null,
        title: null,
        artist: null,
        user_id: userId,
      });
    }
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      playlistItems: [
        {
          playlistClientId: 'dev-1:penuh',
          videoId: 'vid-lebih',
          posisi: 1000,
          title: null,
          artist: null,
        },
        {
          playlistClientId: 'dev-1:kosong',
          videoId: 'vid-ok',
          posisi: 0,
          title: null,
          artist: null,
        },
      ],
    });
    const body = (await res.json()) as {
      data: { applied: number; skippedOverLimit: { playlistItems: number } };
    };
    expect(body.data.skippedOverLimit.playlistItems).toBe(1);
    expect(body.data.applied).toBe(1);
    expect(db.items.has('dev-1:penuh|vid-lebih')).toBe(false);
    expect(db.items.has('dev-1:kosong|vid-ok')).toBe(true);
    // Update item lama di playlist penuh tetap jalan.
    const res2 = await push(env, cookie, {
      deviceId: 'dev-1',
      playlistItems: [
        {
          playlistClientId: 'dev-1:penuh',
          videoId: 'vid-0',
          posisi: 999,
          title: 'Pindah',
          artist: null,
        },
      ],
    });
    const body2 = (await res2.json()) as {
      data: { applied: number; skippedOverLimit: { playlistItems: number } };
    };
    expect(body2.data.skippedOverLimit.playlistItems).toBe(0);
    expect(body2.data.applied).toBe(1);
  });

  it('S7: riwayat ke-1.001 ditolak; update entri lama jalan', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 1000; i++) {
      db.history.set(`${userId}|vid-${i}|${1000 + i}`, {
        user_id: userId,
        video_id: `vid-${i}`,
        played_at: 1000 + i,
        seconds_played: 30,
        device_id: 'dev-seed',
        updated_at: 1000,
        title: null,
        artist: null,
      });
    }
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      history: [
        {
          videoId: 'vid-baru',
          playedAt: 99999,
          secondsPlayed: 10,
          title: null,
          artist: null,
        },
      ],
    });
    const body = (await res.json()) as {
      data: { skippedOverLimit: { history: number } };
    };
    expect(body.data.skippedOverLimit.history).toBe(1);
    expect(db.history.size).toBe(1000);
    const res2 = await push(env, cookie, {
      deviceId: 'dev-1',
      history: [
        {
          videoId: 'vid-0',
          playedAt: 1000,
          secondsPlayed: 90,
          title: null,
          artist: null,
        },
      ],
    });
    const body2 = (await res2.json()) as {
      data: { applied: number; skippedOverLimit: { history: number } };
    };
    expect(body2.data.skippedOverLimit.history).toBe(0);
    expect(body2.data.applied).toBe(1);
    expect(db.history.get(`${userId}|vid-0|1000`)?.seconds_played).toBe(90);
  });

  it('S7: batas berlaku per pengguna (B tidak kena batas A)', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const a = await seedSession(db, { userId: 'user-a' });
    const b = await seedSession(db, { userId: 'user-b' });
    for (let i = 0; i < 100; i++) {
      seedPlaylist(db, a.userId, `dev-a:${i}`, `A ${i}`);
    }
    const res = await push(env, b.cookie, {
      deviceId: 'dev-b',
      playlists: [{ clientId: 'dev-b:1', nama: 'Punya B', deskripsi: null }],
    });
    const body = (await res.json()) as {
      data: { applied: number; skippedOverLimit: { playlists: number } };
    };
    expect(body.data.skippedOverLimit.playlists).toBe(0);
    expect(body.data.applied).toBe(1);
  });
});

// ------------------------------------------------------------------
// Blue 5 (Red 5: S8, S9, R19, I20)
// ------------------------------------------------------------------

describe('Worker sync: Blue 5 (S8/S9/R19/I20)', () => {
  it('S8: clear riwayat kedua dalam 24 jam diabaikan, data tidak terhapus', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie } = await seedSession(db);
    const history100 = (from: number) =>
      Array.from({ length: 100 }, (_, k) => ({
        videoId: `vid-${from + k}`,
        playedAt: from + k,
        secondsPlayed: 30,
        title: null,
        artist: null,
      }));
    // Clear pertama (sahih): 100 masuk lalu terhapus semua.
    const res1 = await push(env, cookie, {
      deviceId: 'dev-1',
      history: history100(0),
      historyClearedBefore: 9999999999999,
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      data: { historyClearIgnored?: boolean };
    };
    expect(body1.data.historyClearIgnored).toBeUndefined();
    expect(db.history.size).toBe(0);
    // Isi lagi 100 (tanpa clear).
    await push(env, cookie, {
      deviceId: 'dev-1',
      history: history100(1000),
    });
    expect(db.history.size).toBe(100);
    // Clear kedua dalam 24 jam: DIABAIKAN dengan respons jelas.
    const res3 = await push(env, cookie, {
      deviceId: 'dev-1',
      historyClearedBefore: 9999999999999,
    });
    expect(res3.status).toBe(200);
    const body3 = (await res3.json()) as {
      data: {
        applied: number;
        historyClearIgnored?: boolean;
        historyClearRetryAfterSeconds?: number;
      };
    };
    expect(body3.data.historyClearIgnored).toBe(true);
    expect(body3.data.historyClearRetryAfterSeconds).toBeGreaterThan(0);
    expect(body3.data.historyClearRetryAfterSeconds).toBeLessThanOrEqual(
      86400,
    );
    expect(body3.data.applied).toBe(0);
    expect(db.history.size).toBe(100);
  });

  it('S8: siklus insert 100 + clear berulang tidak bisa menguras anggaran', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let r = 0; r < 25; r++) {
      const res = await push(env, cookie, {
        deviceId: 'dev-1',
        history: Array.from({ length: 100 }, (_, k) => ({
          videoId: `vid-${r * 1000 + k}`,
          playedAt: r * 1000 + k,
          secondsPlayed: 30,
          title: null,
          artist: null,
        })),
        historyClearedBefore: 9999999999999,
      });
      expect(res.status).toBe(200);
    }
    // Clear ke-2 dan seterusnya diabaikan: riwayat mentok di batas
    // 1.000 (bukan berputar tanpa henti seperti sebelum Blue 5).
    expect(db.history.size).toBe(1000);
    // Tagihan: push 1 = 100 + 1.000 (clear) + 5 tunjangan = 1.105;
    // 24 push berikut = 100 + 5 = 105 tiap push. Total 3.625 —
    // jauh di bawah anggaran 20.000, dan tidak bisa tumbuh lagi
    // (entri baru dilewati cap, tetapi TETAP ditagih 105/push).
    expect(budgetUsed(db, userId)).toBe(3625);
  });

  it('S8: anggaran tulis habis -> 429 + Retry-After; push kecil masih jalan; besok bisa lagi', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    // Push muatan penuh: 700 entri + settings. Tagihan 712/push
    // (700 + 1 settings + tunjangan 2x(3 skalar + 1 playlist) + 3).
    const maxBody = () => ({
      deviceId: 'dev-1',
      playlists: Array.from({ length: 100 }, (_, i) => ({
        clientId: `dev-1:${i}`,
        nama: `P${i}`,
        deskripsi: null,
      })),
      playlistItems: Array.from({ length: 100 }, (_, i) => ({
        playlistClientId: 'dev-1:0',
        videoId: `vid-${i}`,
        posisi: i,
        title: null,
        artist: null,
      })),
      likes: Array.from({ length: 100 }, (_, i) => ({
        videoId: `vid-${i}`,
        likedAt: 1000,
        title: null,
        artist: null,
      })),
      history: Array.from({ length: 100 }, (_, i) => ({
        videoId: `vid-${i}`,
        playedAt: 1000 + i,
        secondsPlayed: 10,
        title: null,
        artist: null,
      })),
      deletedPlaylists: Array.from({ length: 100 }, (_, i) => ({
        clientId: `dev-1:hantu-${i}`,
      })),
      deletedPlaylistItems: Array.from({ length: 100 }, (_, i) => ({
        playlistClientId: 'dev-1:0',
        videoId: `vid-hantu-${i}`,
      })),
      deletedLikes: Array.from({ length: 100 }, (_, i) => ({
        videoId: `vid-hantu-${i}`,
      })),
      settings: { settingsJson: '{"version":1}' },
    });
    // 28 push x 712 = 19.936 (di bawah 20.000).
    for (let i = 0; i < 28; i++) {
      const res = await push(env, cookie, maxBody());
      expect(res.status).toBe(200);
    }
    expect(budgetUsed(db, userId)).toBe(19936);
    // Push ke-29 (712) melewati anggaran -> 429 + Retry-After.
    const over = await push(env, cookie, maxBody());
    expect(over.status).toBe(429);
    const retryAfter = Number(over.headers.get('Retry-After'));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86400);
    const overBody = (await over.json()) as {
      error: { code: string; message: string };
    };
    expect(overBody.error.code).toBe('DAILY_WRITE_BUDGET_EXCEEDED');
    expect(overBody.error.message.length).toBeGreaterThan(0);
    // Sisa anggaran (64) masih bisa dipakai push kecil.
    const small = await push(env, cookie, {
      deviceId: 'dev-1',
      likes: [{ videoId: 'vid-0', likedAt: 2000, title: null, artist: null }],
    });
    expect(small.status).toBe(200);
    // Besok (hari UTC baru): anggaran reset, push besar jalan lagi.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    try {
      const nextDay = await push(env, cookie, maxBody());
      expect(nextDay.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it('S9: push pada pengguna penuh (10.000 suka) membaca sedikit, tanpa COUNT', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 10000; i++) {
      db.likes.set(`${userId}|vid-${i}`, {
        user_id: userId,
        video_id: `vid-${i}`,
        liked_at: 1000 + i,
        device_id: 'dev-seed',
        updated_at: 1000,
        deleted_at: null,
        title: null,
        artist: null,
      });
    }
    seedCounter(db, userId, 'likes', '', 10000);
    // Push 1 update entri lama: auth 2 + rate limit 1 + penghitung
    // 1 + probe 1 = 5 baris (kode lama: COUNT 10.000 + fetchKeys
    // 10.000 = 20.000 baris).
    db.resetReadCount();
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      likes: [{ videoId: 'vid-0', likedAt: 9999, title: 'Baru', artist: null }],
    });
    expect(res.status).toBe(200);
    expect(db.countQueries).toBe(0);
    expect(db.rowsRead).toBeLessThanOrEqual(10);
    expect(db.likes.get(`${userId}|vid-0`)?.title).toBe('Baru');
    // Push 100 update: baca ~ jumlah entri (104), bukan ukuran tabel.
    db.resetReadCount();
    const res2 = await push(env, cookie, {
      deviceId: 'dev-1',
      likes: Array.from({ length: 100 }, (_, i) => ({
        videoId: `vid-${i}`,
        likedAt: 9999,
        title: 'U',
        artist: null,
      })),
    });
    expect(res2.status).toBe(200);
    expect(db.countQueries).toBe(0);
    expect(db.rowsRead).toBeLessThanOrEqual(110);
    const body2 = (await res2.json()) as {
      data: { applied: number; skippedOverLimit: { likes: number } };
    };
    expect(body2.data.skippedOverLimit.likes).toBe(0);
    expect(body2.data.applied).toBe(100);
  });

  it('S9: baca tidak tumbuh dengan ukuran tabel (10 suka vs 10.000 suka)', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const a = await seedSession(db, { userId: 'user-a' });
    const b = await seedSession(db, { userId: 'user-b' });
    for (let i = 0; i < 10; i++) {
      db.likes.set(`${a.userId}|vid-${i}`, {
        user_id: a.userId,
        video_id: `vid-${i}`,
        liked_at: 1000,
        device_id: 'dev-seed',
        updated_at: 1000,
        deleted_at: null,
        title: null,
        artist: null,
      });
    }
    seedCounter(db, a.userId, 'likes', '', 10);
    for (let i = 0; i < 10000; i++) {
      db.likes.set(`${b.userId}|vid-${i}`, {
        user_id: b.userId,
        video_id: `vid-${i}`,
        liked_at: 1000,
        device_id: 'dev-seed',
        updated_at: 1000,
        deleted_at: null,
        title: null,
        artist: null,
      });
    }
    seedCounter(db, b.userId, 'likes', '', 10000);
    const oneUpdate = {
      deviceId: 'dev-1',
      likes: [{ videoId: 'vid-0', likedAt: 9999, title: 'U', artist: null }],
    };
    db.resetReadCount();
    await push(env, a.cookie, oneUpdate);
    const readsSmall = db.rowsRead;
    db.resetReadCount();
    await push(env, b.cookie, oneUpdate);
    const readsFull = db.rowsRead;
    expect(readsFull).toBe(readsSmall);
    expect(readsFull).toBeLessThanOrEqual(10);
  });

  it('S9: penghitung benar — 50 masuk dari headroom 50, lalu mentok di 10.000', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 9950; i++) {
      db.likes.set(`${userId}|vid-${i}`, {
        user_id: userId,
        video_id: `vid-${i}`,
        liked_at: 1000 + i,
        device_id: 'dev-seed',
        updated_at: 1000,
        deleted_at: null,
        title: null,
        artist: null,
      });
    }
    seedCounter(db, userId, 'likes', '', 9950);
    const newLikes = (from: number) =>
      Array.from({ length: 100 }, (_, k) => ({
        videoId: `vid-baru-${from + k}`,
        likedAt: 5000,
        title: null,
        artist: null,
      }));
    const res1 = await push(env, cookie, {
      deviceId: 'dev-1',
      likes: newLikes(0),
    });
    const body1 = (await res1.json()) as {
      data: { skippedOverLimit: { likes: number } };
    };
    expect(body1.data.skippedOverLimit.likes).toBe(50);
    expect(db.likes.size).toBe(10000);
    expect(
      db.counts.get(FakeD1.countKey(userId, 'likes', ''))?.n,
    ).toBe(10000);
    const res2 = await push(env, cookie, {
      deviceId: 'dev-1',
      likes: newLikes(100),
    });
    const body2 = (await res2.json()) as {
      data: { skippedOverLimit: { likes: number } };
    };
    expect(body2.data.skippedOverLimit.likes).toBe(100);
    expect(db.likes.size).toBe(10000);
    expect(
      db.counts.get(FakeD1.countKey(userId, 'likes', ''))?.n,
    ).toBe(10000);
  });

  it('S9: penghitung pulih sesudah clear (sentinel -1 -> COUNT ulang)', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    const res1 = await push(env, cookie, {
      deviceId: 'dev-1',
      history: Array.from({ length: 100 }, (_, k) => ({
        videoId: `vid-${k}`,
        playedAt: 1000 + k,
        secondsPlayed: 30,
        title: null,
        artist: null,
      })),
      historyClearedBefore: 9999999999999,
    });
    expect(res1.status).toBe(200);
    expect(db.history.size).toBe(0);
    // Clear menandai penghitung riwayat BASI (-1).
    expect(
      db.counts.get(FakeD1.countKey(userId, 'history', ''))?.n,
    ).toBe(-1);
    // Push berikut menghitung ulang dari data nyata (COUNT 1x),
    // lalu penghitung benar lagi.
    db.resetReadCount();
    const res2 = await push(env, cookie, {
      deviceId: 'dev-1',
      history: Array.from({ length: 50 }, (_, k) => ({
        videoId: `vid-baru-${k}`,
        playedAt: 5000 + k,
        secondsPlayed: 30,
        title: null,
        artist: null,
      })),
    });
    expect(res2.status).toBe(200);
    expect(db.countQueries).toBe(1);
    expect(db.history.size).toBe(50);
    expect(
      db.counts.get(FakeD1.countKey(userId, 'history', ''))?.n,
    ).toBe(50);
  });

  it('S9: penghitung melenceng di atas batas memicu rekonsiliasi', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 100; i++) {
      seedPlaylist(db, userId, `dev-1:${i}`, `Playlist ${i}`);
    }
    // Drift: penghitung 5.000 padahal baris nyata 100.
    seedCounter(db, userId, 'playlists', '', 5000);
    db.resetReadCount();
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:baru', nama: 'Baru', deskripsi: null }],
    });
    expect(res.status).toBe(200);
    // Rekonsiliasi jalan (COUNT 1x), penghitung dikoreksi ke 100,
    // dan cap ditegakkan dari nilai benar (sudah di batas).
    expect(db.countQueries).toBe(1);
    expect(
      db.counts.get(FakeD1.countKey(userId, 'playlists', ''))?.n,
    ).toBe(100);
    const body = (await res.json()) as {
      data: { skippedOverLimit: { playlists: number } };
    };
    expect(body.data.skippedOverLimit.playlists).toBe(1);
    expect(db.playlists.size).toBe(100);
  });

  it('S9 fallback: tanpa tabel penghitung, push tetap jalan via COUNT', async () => {
    const db = new FakeD1();
    db.throwOnCounts = true;
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 100; i++) {
      seedPlaylist(db, userId, `dev-1:${i}`, `Playlist ${i}`);
    }
    // Playlist ke-101 tetap ditolak (lewat COUNT fallback).
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:101', nama: 'Lebih', deskripsi: null }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { applied: number; skippedOverLimit: { playlists: number } };
    };
    expect(body.data.skippedOverLimit.playlists).toBe(1);
    expect(body.data.applied).toBe(0);
    // Update entri lama tetap jalan tanpa penghitung.
    const res2 = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:5', nama: 'Nama Baru', deskripsi: null }],
    });
    const body2 = (await res2.json()) as {
      data: { applied: number };
    };
    expect(body2.data.applied).toBe(1);
    expect(db.playlists.get('dev-1:5')?.nama).toBe('Nama Baru');
  });

  it('R19: insert terjaga diblokir bila penghitung naik di tengah batch', async () => {
    // FakeD1 yang mensimulasikan push bersamaan: saat INSERT
    // terjaga pertama dievaluasi, increment penghitung push lain
    // (+50) mendarat duluan — seolah-olah dua batch tumpang tindih.
    class RacingFakeD1 extends FakeD1 {
      bumped = false;
      override runSql(sql: string, v: unknown[]): void {
        if (
          !this.bumped &&
          sql.startsWith('INSERT INTO sync_playlists') &&
          sql.includes('FROM sync_counts')
        ) {
          this.bumped = true;
          const key = FakeD1.countKey('user-1', 'playlists', '');
          const cur = this.counts.get(key);
          if (cur) cur.n += 50;
        }
        super.runSql(sql, v);
      }
    }
    const db = new RacingFakeD1();
    const env = makeEnv(db);
    const { cookie, userId } = await seedSession(db);
    for (let i = 0; i < 50; i++) {
      seedPlaylist(db, userId, `dev-1:${i}`, `Playlist ${i}`);
    }
    seedCounter(db, userId, 'playlists', '', 50);
    // Headroom 50: 50 entri baru lolos cap. Increment +50 (counter
    // 100), lalu "push lain" +50 (counter 150) sebelum insert
    // dievaluasi — guard (150 - 50 + k >= 100) memblokir semuanya.
    const res = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: Array.from({ length: 100 }, (_, i) => ({
        clientId: `dev-1:baru-${i}`,
        nama: `Baru ${i}`,
        deskripsi: null,
      })),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { skippedOverLimit: { playlists: number } };
    };
    expect(body.data.skippedOverLimit.playlists).toBe(50);
    expect(db.playlists.size).toBe(50);
    expect(
      db.counts.get(FakeD1.countKey(userId, 'playlists', ''))?.n,
    ).toBe(150);
    // Push berikut merekonsiliasi (150 > 100 + 30): penghitung
    // kembali ke 50, dan penambahan jalan lagi.
    const res2 = await push(env, cookie, {
      deviceId: 'dev-1',
      playlists: [{ clientId: 'dev-1:satu', nama: 'Satu', deskripsi: null }],
    });
    expect(res2.status).toBe(200);
    expect(db.playlists.size).toBe(51);
    expect(
      db.counts.get(FakeD1.countKey(userId, 'playlists', ''))?.n,
    ).toBe(51);
  });

  it('I20: item ke playlist orang lain ditolak notOwned tanpa menyentuh cap', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const a = await seedSession(db, { userId: 'user-a' });
    const b = await seedSession(db, { userId: 'user-b' });
    seedPlaylist(db, a.userId, 'dev-a:target', 'Target');
    for (let i = 0; i < 999; i++) {
      db.items.set(`dev-a:target|vid-${i}`, {
        playlist_id: 'dev-a:target',
        video_id: `vid-${i}`,
        posisi: i,
        added_at: 1000,
        device_id: 'dev-seed',
        updated_at: 1000,
        deleted_at: null,
        title: null,
        artist: null,
        user_id: a.userId,
      });
    }
    seedCounter(db, a.userId, 'items', 'dev-a:target', 999);
    // B mendorong 100 item ke playlist A (999 item).
    const res = await push(env, b.cookie, {
      deviceId: 'dev-b',
      playlistItems: Array.from({ length: 100 }, (_, i) => ({
        playlistClientId: 'dev-a:target',
        videoId: `vid-serang-${i}`,
        posisi: i,
        title: null,
        artist: null,
      })),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        applied: number;
        skippedNotOwned: number;
        skippedOverLimit: { playlistItems: number };
      };
    };
    // Semua ditolak sebagai bukan milik pendorong; cap TIDAK
    // dihitung untuk playlist itu (0 — tidak membocorkan bahwa
    // korban punya ~999 item).
    expect(body.data.skippedNotOwned).toBe(100);
    expect(body.data.skippedOverLimit.playlistItems).toBe(0);
    expect(body.data.applied).toBe(0);
    expect(db.items.size).toBe(999);
    // Penghitung B untuk playlist A tidak pernah dibuat/dibaca.
    expect(
      db.counts.has(FakeD1.countKey(b.userId, 'items', 'dev-a:target')),
    ).toBe(false);
  });
});
