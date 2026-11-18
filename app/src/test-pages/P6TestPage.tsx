/**
 * Halaman uji ketahanan P6 TERSEMBUNYI (rute /p6-test): seed
 * kondisi banner status + snapshot diagnostik untuk tes E2E
 * dan screenshot docs/p6/. Tidak ditautkan dari mana pun;
 * DEV-only (Red 1 H1), hilang total dari build produksi.
 *
 * Tombol:
 * - "Seed kanari rusak/degraded/normal": tulis rekaman kanari
 *   ke app_meta lalu refresh store (banner di beranda berubah).
 * - "Seed config basi": tulis cache config dengan fetchedAt
 *   7 jam lalu (banner info di beranda).
 * - "Seed snapshot resolve/engine": tulis snapshot kegagalan
 *   + baris log pemutar (layar kode diagnostik di Pengaturan).
 * - "Bersihkan": hapus semua seed P6 dari app_meta.
 *
 * Data seed jelas berlabel dan hanya masuk lewat tombol di
 * halaman ini, tidak pernah otomatis.
 */
import { useState } from 'react';
import { openDatabase } from '../data/database';
import {
  CONFIG_CACHE_KEY,
  CONFIG_TTL_MS,
} from '../resilience/configStore';
import {
  CANARY_RECORD_KEY,
  type CanaryRecord,
} from '../resilience/canary';
import {
  DIAGNOSTIC_SNAPSHOT_KEY,
  recordFailureSnapshot,
  type FailureSnapshot,
} from '../resilience/diagnostics';
import {
  clearPlayerLog,
  logPlayer,
  persistPlayerLog,
  PLAYER_LOG_KEY,
} from '../resilience/playerLog';
import { useResilienceStore } from '../resilience/store';

const CONFIG_TEXT = JSON.stringify({
  clients: [
    { clientId: '67', name: 'WEB_REMIX', version: '1.20261110.04.00' },
    {
      clientId: '14',
      name: 'ANDROID_VR',
      requiresScript: false,
      version: '1.65.10',
    },
  ],
  playerHashes: { b559f50c: { signatureTimestamp: 20770 } },
  version: 1,
});

async function putMeta(key: string, value: string): Promise<void> {
  const db = await openDatabase();
  await db.app_meta.put({ key, value });
}

function canaryRecord(
  status: CanaryRecord['status'],
  failed: number,
): CanaryRecord {
  return {
    checkedAt: Date.now(),
    succeeded: 5 - failed,
    failed,
    networkFailures: 0,
    dominantCause: failed > 0 ? 'refused' : null,
    status,
    streak: failed > 0 ? 1 : 0,
    streakCause: failed > 0 ? 'refused' : null,
  };
}

const SNAPSHOT_RESOLVE: FailureSnapshot = {
  layer: 'resolve',
  kind: 'unplayable',
  cause: 'login-required',
  failedAt: Date.now(),
  clientsTried: ['WEB_REMIX', 'MWEB', 'ANDROID_VR'],
  lastClient: 'ANDROID_VR',
  lastPlayability: 'LOGIN_REQUIRED',
  playerHash: 'b559f50c',
};

const SNAPSHOT_ENGINE: FailureSnapshot = {
  layer: 'engine',
  kind: 'engine',
  cause: 'http-forbidden',
  failedAt: Date.now(),
  clientsTried: ['WEB_REMIX'],
  lastClient: 'WEB_REMIX',
  lastPlayability: 'OK',
  playerHash: 'b559f50c',
};

export default function P6TestPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Siap.');

  const run = (
    label: string,
    done: string,
    fn: () => Promise<void>,
  ): void => {
    setBusy(true);
    setStatus(label);
    fn()
      .then(async () => {
        await useResilienceStore.getState().refresh();
        setStatus(done);
      })
      .catch(() => setStatus('Gagal.'))
      .finally(() => setBusy(false));
  };

  const seedCanary = (level: 'broken' | 'degraded' | 'ok'): void => {
    const failed = level === 'broken' ? 5 : level === 'degraded' ? 1 : 0;
    run(
      `Seed kanari ${level}.`,
      `Kanari ${level} tersimpan.`,
      async () => {
        await putMeta(
          CANARY_RECORD_KEY,
          JSON.stringify(canaryRecord(level, failed)),
        );
      },
    );
  };

  const seedStaleConfig = (): void => {
    run('Seed config basi.', 'Config basi tersimpan.', async () => {
      await putMeta(
        CONFIG_CACHE_KEY,
        JSON.stringify({
          text: CONFIG_TEXT,
          fetchedAt: Date.now() - CONFIG_TTL_MS - 60 * 60 * 1000,
        }),
      );
      // Kanari normal supaya banner info yang tampil (bukan
      // warning/outage yang menutupinya).
      await putMeta(
        CANARY_RECORD_KEY,
        JSON.stringify(canaryRecord('ok', 0)),
      );
    });
  };

  const seedSnapshot = (layer: 'resolve' | 'engine'): void => {
    run(
      `Seed snapshot ${layer}.`,
      `Snapshot ${layer} tersimpan.`,
      async () => {
        const snapshot =
          layer === 'engine' ? SNAPSHOT_ENGINE : SNAPSHOT_RESOLVE;
        recordFailureSnapshot(snapshot);
        await putMeta(
          DIAGNOSTIC_SNAPSHOT_KEY,
          JSON.stringify(snapshot),
        );
        logPlayer('mencari jalur lain (putaran 2)');
        logPlayer(
          'gagal cari lagu: WEB_REMIX=LOGIN_REQUIRED, MWEB=LOGIN_REQUIRED, ANDROID_VR=LOGIN_REQUIRED',
        );
        if (layer === 'engine') {
          logPlayer('pemutar gagal kode 4 di 0:42');
        }
        // Flush log ke storage SEBELUM status "tersimpan" tampil:
        // tes lalu pindah halaman (reload) dan log memori hilang.
        await persistPlayerLog();
      },
    );
  };

  const clearAll = (): void => {
    run('Membersihkan seed.', 'Seed dibersihkan.', async () => {
      const db = await openDatabase();
      await db.app_meta.bulkDelete([
        CANARY_RECORD_KEY,
        CONFIG_CACHE_KEY,
        DIAGNOSTIC_SNAPSHOT_KEY,
        PLAYER_LOG_KEY,
      ]);
      clearPlayerLog();
    });
  };

  return (
    <div data-testid="p6-test-page" className="px-4 py-8">
      <h1 className="text-xl font-bold">Uji ketahanan P6</h1>
      <p data-testid="p6-test-status" className="mt-2 text-sm text-zinc-400">
        {status}
      </p>
      <div className="mt-6 flex flex-col items-start gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => seedCanary('broken')}
          data-testid="p6-test-seed-canary-broken"
          className="h-11 rounded-full bg-white px-5 text-sm font-medium text-black disabled:opacity-50"
        >
          Seed kanari rusak
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => seedCanary('degraded')}
          data-testid="p6-test-seed-canary-degraded"
          className="h-11 rounded-full bg-white px-5 text-sm font-medium text-black disabled:opacity-50"
        >
          Seed kanari terganggu
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => seedCanary('ok')}
          data-testid="p6-test-seed-canary-ok"
          className="h-11 rounded-full bg-white px-5 text-sm font-medium text-black disabled:opacity-50"
        >
          Seed kanari normal
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={seedStaleConfig}
          data-testid="p6-test-seed-stale-config"
          className="h-11 rounded-full bg-white px-5 text-sm font-medium text-black disabled:opacity-50"
        >
          Seed config basi
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => seedSnapshot('resolve')}
          data-testid="p6-test-seed-snapshot-resolve"
          className="h-11 rounded-full bg-white px-5 text-sm font-medium text-black disabled:opacity-50"
        >
          Seed snapshot resolve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => seedSnapshot('engine')}
          data-testid="p6-test-seed-snapshot-engine"
          className="h-11 rounded-full bg-white px-5 text-sm font-medium text-black disabled:opacity-50"
        >
          Seed snapshot engine
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={clearAll}
          data-testid="p6-test-clear"
          className="h-11 rounded-full border border-white/15 px-5 text-sm font-medium disabled:opacity-50"
        >
          Bersihkan seed
        </button>
      </div>
    </div>
  );
}
