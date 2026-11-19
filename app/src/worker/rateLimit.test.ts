/**
 * Tes Vitest rate limit D1 proxy (Red 1 S3).
 *
 * Modul worker (`workers/proxy/src/rateLimit.js`) diimpor langsung
 * dengan D1 palsu in-memory yang meniru tiga pernyataan SQL yang
 * dipakai modul itu (upsert, select hitungan, sapu). Ini menguji
 * logika jendela + hitungan tanpa Cloudflare; perilaku D1 aslinya
 * (UPSERT/RETURNING, binding) diverifikasi koordinator saat
 * redeploy proxy (lihat docs/blue1-red1-fixes.md S3).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isRateLimited,
  sweepExpiredWindows,
  windowStartFor,
  type D1DatabaseLike,
  type D1Statement,
} from '../../../workers/proxy/src/rateLimit';

/** D1 palsu in-memory: cukup untuk tiga pernyataan rateLimit.js. */
class FakeD1 implements D1DatabaseLike {
  /** key: `${key}|${windowStart}` -> count */
  rows = new Map<string, number>();

  prepare(query: string): D1Statement {
    const sql = query;
    const rows = this.rows;
    let values: unknown[] = [];
    const stmt: D1Statement = {
      bind(...v: unknown[]): D1Statement {
        values = v;
        return stmt;
      },
      async run(): Promise<unknown> {
        if (sql.startsWith('INSERT INTO rate_limits')) {
          const k = `${String(values[0])}|${Number(values[1])}`;
          rows.set(k, (rows.get(k) ?? 0) + 1);
          return { success: true };
        }
        if (sql.startsWith('DELETE FROM rate_limits')) {
          const cutoff = Number(values[0]);
          for (const [k] of [...rows]) {
            const w = Number(k.split('|')[1]);
            if (w < cutoff) rows.delete(k);
          }
          return { success: true };
        }
        throw new Error(`pernyataan tak dikenal: ${sql}`);
      },
      async first<T>(): Promise<T | null> {
        if (sql.startsWith('SELECT count')) {
          const count = rows.get(
            `${String(values[0])}|${Number(values[1])}`,
          );
          if (count === undefined) return null;
          return { count } as T;
        }
        throw new Error(`pernyataan tak dikenal: ${sql}`);
      },
    };
    return stmt;
  }
}

describe('windowStartFor', () => {
  it('membulatkan ke awal menit', () => {
    // 2026-11-18 02:00:00 UTC = 1794784800000; +45 detik masih
    // jendela yang sama.
    expect(windowStartFor(1794784800000)).toBe(1794784800000);
    expect(windowStartFor(1794784800000 + 45000)).toBe(1794784800000);
    expect(windowStartFor(1794784800000 + 60000)).toBe(1794784800000 + 60000);
  });

  // Blue 6 (S10a): jendela per jam untuk rate limit hapus akun.
  // 1794783600000 = 2026-11-18 02:00:00 UTC (batas jam persis;
  // 1794784800000 yang dipakai tes menit adalah 02:20:00).
  it('membulatkan ke awal jam bila windowMs = 1 jam', () => {
    const hour = 3600000;
    const base = 1794783600000;
    expect(windowStartFor(base, hour)).toBe(base);
    expect(windowStartFor(base + 3599000, hour)).toBe(base);
    expect(windowStartFor(base + 3600000, hour)).toBe(base + 3600000);
  });
});

describe('isRateLimited (D1)', () => {
  it('mengizinkan sampai batas, menolak sesudahnya', async () => {
    const db = new FakeD1();
    const now = 1794784800000;
    for (let i = 1; i <= 60; i++) {
      expect(await isRateLimited(db, 'innertube:203.0.113.7', 60, now)).toBe(
        false,
      );
    }
    expect(await isRateLimited(db, 'innertube:203.0.113.7', 60, now)).toBe(
      true,
    );
  });

  it('kunci berbeda punya hitungan terpisah', async () => {
    const db = new FakeD1();
    const now = 1794784800000;
    for (let i = 0; i < 10; i++) {
      await isRateLimited(db, 'media:203.0.113.7', 10, now);
    }
    expect(await isRateLimited(db, 'media:203.0.113.7', 10, now)).toBe(true);
    // IP lain belum tersentuh; bucket innertube juga terpisah.
    expect(await isRateLimited(db, 'media:198.51.100.9', 10, now)).toBe(false);
    expect(await isRateLimited(db, 'innertube:203.0.113.7', 60, now)).toBe(
      false,
    );
  });

  it('hitungan reset di jendela menit berikutnya', async () => {
    const db = new FakeD1();
    const now = 1794784800000;
    for (let i = 0; i < 60; i++) {
      await isRateLimited(db, 'innertube:203.0.113.7', 60, now);
    }
    expect(await isRateLimited(db, 'innertube:203.0.113.7', 60, now)).toBe(
      true,
    );
    expect(
      await isRateLimited(db, 'innertube:203.0.113.7', 60, now + 60000),
    ).toBe(false);
  });

  it('melempar bila D1 gagal (pemanggil yang fail-open)', async () => {
    const failing = {
      prepare(): never {
        throw new Error('D1 mati');
      },
    } as unknown as D1DatabaseLike;
    await expect(
      isRateLimited(failing, 'innertube:203.0.113.7', 60),
    ).rejects.toThrow('D1 mati');
  });

  // Blue 6 (S12b): request yang SUDAH dibatasi tidak menulis
  // baris lagi — 70 percobaan dengan batas 60 berhenti di
  // hitungan 61 (bukan 70). Sebelumnya tiap percobaan menulis
  // (43.200 baris/hari/akun di luar anggaran).
  it('S12b: request yang sudah dibatasi tidak menulis baris lagi', async () => {
    const db = new FakeD1();
    const now = 1794784800000;
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      if (await isRateLimited(db, 'sync:user-1', 60, now)) limited++;
    }
    expect(limited).toBe(10);
    expect(db.rows.get(`sync:user-1|${windowStartFor(now)}`)).toBe(61);
  });

  // Blue 6 (S10a): jendela per jam — batas 1/jam untuk hapus
  // akun per akun; percobaan ke-2 dalam jam yang sama ditolak
  // tanpa menulis, jam berikutnya diizinkan lagi.
  it('S10a: jendela per jam (batas 1) menolak percobaan ke-2 tanpa menulis', async () => {
    const db = new FakeD1();
    const now = 1794784800000;
    const hour = 3600000;
    expect(
      await isRateLimited(db, 'delete-acct:user-1', 1, now, hour),
    ).toBe(false);
    expect(
      await isRateLimited(db, 'delete-acct:user-1', 1, now + 1000, hour),
    ).toBe(true);
    expect(
      await isRateLimited(db, 'delete-acct:user-1', 1, now + 2000, hour),
    ).toBe(true);
    expect(db.rows.get(`delete-acct:user-1|${windowStartFor(now, hour)}`)).toBe(
      2,
    );
    expect(
      await isRateLimited(db, 'delete-acct:user-1', 1, now + hour, hour),
    ).toBe(false);
  });
});

describe('sweepExpiredWindows', () => {
  it('menghapus jendela lama, mempertahankan jendela berjalan', async () => {
    const db = new FakeD1();
    const now = 1794784800000;
    // I15: matikan sapu probabilistik (1%) selama penyiapan —
    // sapu acak yang menyala di dalam isRateLimited kedua bisa
    // menghapus baris lama sebelum asersi (flaky 1%).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      // Blue 6 (S12b): retensi sapu kini 1 jam (jendela
      // terpanjang di sistem — hapus akun per jam), jadi baris
      // "lama" harus berumur 2 jam (bukan 2 menit).
      await isRateLimited(db, 'innertube:203.0.113.7', 60, now - 2 * 3600000);
      await isRateLimited(db, 'innertube:203.0.113.7', 60, now);
    } finally {
      randomSpy.mockRestore();
    }
    expect(db.rows.size).toBe(2);
    await sweepExpiredWindows(db, now);
    expect(db.rows.size).toBe(1);
    expect([...db.rows.keys()][0]).toBe(
      `innertube:203.0.113.7|${windowStartFor(now)}`,
    );
  });

  // Blue 6 (S12b): baris berumur 2 menit DITAHAN (retensi 1 jam)
  // — sapu proxy tidak boleh menghapus baris jendela per jam
  // (hapus akun) yang masih berjalan.
  it('menahan baris berumur 2 menit (retensi 1 jam)', async () => {
    const db = new FakeD1();
    const now = 1794784800000;
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      await isRateLimited(db, 'delete-acct:user-1', 1, now - 120000, 3600000);
      await isRateLimited(db, 'innertube:203.0.113.7', 60, now);
    } finally {
      randomSpy.mockRestore();
    }
    expect(db.rows.size).toBe(2);
    await sweepExpiredWindows(db, now);
    expect(db.rows.size).toBe(2);
  });

  it('sapu gagal tidak mengubah vonis rate limit', async () => {
    const db = new FakeD1();
    // Paksa sapu jalan (probabilitas 1%) dengan stub Math.random.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    // Rusakkan DELETE saja: SELECT/INSERT tetap jalan.
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((query: string) => {
      if (query.startsWith('DELETE')) {
        const stmt: D1Statement = {
          bind: () => stmt,
          run: async () => {
            throw new Error('sapu gagal');
          },
          first: async () => null,
        };
        return stmt;
      }
      return originalPrepare(query);
    }) as FakeD1['prepare'];
    await expect(
      isRateLimited(db, 'innertube:203.0.113.7', 60, 1794784800000),
    ).resolves.toBe(false);
    randomSpy.mockRestore();
  });
});
