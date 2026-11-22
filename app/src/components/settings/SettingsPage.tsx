/**
 * Halaman Pengaturan (P6): pembaruan config, kondisi layanan,
 * laporkan kerusakan (kode diagnostik LRS1 + snapshot pemutar),
 * tentang app. P7 menambah Akun (masuk + sinkronisasi opsional)
 * dan Lirik (saklar tampilkan lirik). P8 menambah Salinan data
 * (ekspor/impor backup, impor Spotify, hapus semua data).
 *
 * Rute /settings, lazy-load (tidak masuk bundle awal). Copy
 * Bahasa Indonesia sehari-hari, tanpa jargon, tanpa em dash.
 * Kode diagnostik + snapshot TIDAK memuat URL stream, token,
 * judul lagu, atau data pribadi apa pun (PRD B9.9).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from '@phosphor-icons/react';
import { APP_VERSION } from '../../core/version';
import {
  buildDiagnosticCode,
  getMemorySnapshot,
  loadPersistedSnapshot,
  type FailureSnapshot,
} from '../../resilience/diagnostics';
import { getConfigLoader } from '../../resilience/configStore';
import {
  getPlayerLog,
  loadPersistedPlayerLog,
} from '../../resilience/playerLog';
import { useResilienceStore } from '../../resilience/store';
import { strings } from '../../strings/id';
import AppLink from '../AppLink';
import { getLyricsService } from '../../lyrics/lyricsService';
import { loginUrl } from '../../sync/auth';
import { useSyncStore } from '../../sync/syncStore';
import ConfirmDialog from '../library/ConfirmDialog';
import BackupSection from './BackupSection';

function formatTime(ms: number | null): string {
  if (ms === null) return strings.settingsConfigNever;
  return new Date(ms).toLocaleString('id-ID', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format tanggal buka kunci cooldown daftar ulang (Blue 7, S13):
 * `until` ISO YYYY-MM-DD (UTC, dari redirect worker) menjadi
 * tanggal Indonesia ("25 November 2026"). Dibangun sebagai
 * tanggal lokal (bukan UTC tengah malam) supaya tidak bergeser
 * sehari di zona waktu barat UTC. Null bila format tidak valid
 * (pemanggil memakai pesan "besok" lama).
 */
function formatUnlockDate(until: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} data-testid={testId} className="mt-8">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/5 py-2 last:border-b-0">
      <span className="shrink-0 text-sm text-zinc-400">{label}</span>
      <span
        data-testid={testId}
        className="min-w-0 break-words text-right font-mono text-sm text-zinc-100"
      >
        {value}
      </span>
    </div>
  );
}

/** Seksi Akun (P7): masuk opsional + sinkronisasi. */
function AccountSection() {
  const status = useSyncStore((s) => s.status);
  const displayName = useSyncStore((s) => s.displayName);
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);
  const syncing = useSyncStore((s) => s.syncing);
  const error = useSyncStore((s) => s.error);
  const refreshAuth = useSyncStore((s) => s.refreshAuth);
  const syncNow = useSyncStore((s) => s.syncNow);
  const signOut = useSyncStore((s) => s.signOut);
  const signOutEverywhere = useSyncStore((s) => s.signOutEverywhere);
  const deleteAccount = useSyncStore((s) => s.deleteAccount);

  const [authError, setAuthError] = useState(false);
  // Blue 6 (S10c): daftar ulang ditolak karena akun baru saja
  // dihapus (cooldown 24 jam) — pesan khusus, bukan galat umum.
  // Blue 7 (S13): cooldown sebanding ukuran akun — redirect
  // membawa tanggal buka kunci (until) untuk cooldown panjang.
  const [authDeletedRecently, setAuthDeletedRecently] = useState(false);
  const [authDeletedUntil, setAuthDeletedUntil] = useState<string | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSignOutEverywhere, setConfirmSignOutEverywhere] =
    useState(false);
  const [deleteDone, setDeleteDone] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const handledQuery = useRef(false);

  // Periksa sesi saat halaman dibuka + tangani hasil redirect
  // OAuth (?auth=ok / ?auth=error). Query dibersihkan dari URL
  // supaya refresh halaman tidak mengulanginya.
  useEffect(() => {
    if (handledQuery.current) return;
    handledQuery.current = true;
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    const reason = params.get('reason');
    const until = params.get('until');
    if (auth === 'ok' || auth === 'error') {
      params.delete('auth');
      params.delete('reason');
      params.delete('until');
      const next = params.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${next ? `?${next}` : ''}`,
      );
    }
    if (auth === 'error') {
      if (reason === 'deleted-recently') {
        setAuthDeletedRecently(true);
        // Tanggal buka kunci (bila ada + valid): pesan menyebut
        // tanggal itu; bila tidak ada, pesan "besok" lama.
        if (until) {
          const formatted = formatUnlockDate(until);
          if (formatted) setAuthDeletedUntil(formatted);
        }
      }
      setAuthError(true);
      void refreshAuth();
      return;
    }
    void refreshAuth().then(() => {
      // Sesudah masuk lewat redirect, langsung sinkron sekali.
      if (auth === 'ok') void syncNow();
    });
  }, [refreshAuth, syncNow]);

  const handleDelete = useCallback(() => {
    setDeleteFailed(false);
    void deleteAccount()
      .then(() => {
        setConfirmDelete(false);
        setDeleteDone(true);
      })
      .catch(() => {
        setConfirmDelete(false);
        setDeleteFailed(true);
      });
  }, [deleteAccount]);

  const errorText =
    error === 'syncErrorRateLimited'
      ? strings.settingsAccountRateLimited
      : error === 'syncErrorPullIncomplete'
        ? strings.settingsAccountPullIncomplete
        : error === 'syncErrorNetwork' || error === 'syncErrorServer'
          ? strings.settingsAccountSyncError
          : null;

  return (
    <Section title={strings.settingsAccountSection} testId="settings-account">
      {status === 'unknown' ? (
        error ? (
          <div>
            <p
              data-testid="settings-account-error"
              className="text-sm text-red-300"
            >
              {strings.settingsAccountUnavailable}
            </p>
            <button
              type="button"
              onClick={() => void refreshAuth()}
              data-testid="settings-account-retry"
              className="mt-4 h-11 rounded-full border border-white/15 px-6 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
            >
              {strings.retry}
            </button>
          </div>
        ) : (
          <p data-testid="settings-account-loading" className="text-sm text-zinc-400">
            {strings.loadingLabel}
          </p>
        )
      ) : status === 'signed-out' ? (
        <div>
          <p className="text-sm leading-relaxed text-zinc-400">
            {strings.settingsAccountBody}
          </p>
          {authError || deleteFailed ? (
            <p
              data-testid="settings-account-error"
              className="mt-3 text-sm text-red-300"
            >
              {authDeletedRecently
                ? authDeletedUntil
                  ? strings.settingsAccountDeletedRecentlyUntil(
                      authDeletedUntil,
                    )
                  : strings.settingsAccountDeletedRecently
                : strings.settingsAccountUnavailable}
            </p>
          ) : null}
          {deleteDone ? (
            <p
              data-testid="settings-account-delete-done"
              className="mt-3 text-sm text-zinc-300"
            >
              {strings.settingsAccountDeleteDone}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href={loginUrl('google')}
              data-testid="settings-signin-google"
              className="flex h-11 items-center rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95"
            >
              {strings.settingsAccountSignInGoogle}
            </a>
            <a
              href={loginUrl('github')}
              data-testid="settings-signin-github"
              className="flex h-11 items-center rounded-full border border-white/15 px-6 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
            >
              {strings.settingsAccountSignInGithub}
            </a>
          </div>
        </div>
      ) : (
        <div>
          <p data-testid="settings-account-name" className="text-sm text-zinc-100">
            {strings.settingsAccountSignedInAs(displayName ?? '')}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">
            {strings.settingsAccountFilesNote}
          </p>
          {errorText ? (
            <p
              data-testid="settings-account-error"
              className="mt-3 text-sm text-red-300"
            >
              {errorText}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void syncNow()}
              disabled={syncing}
              data-testid="settings-sync-now"
              className="h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95 disabled:opacity-50"
            >
              {syncing
                ? strings.settingsAccountSyncing
                : strings.settingsAccountSyncNow}
            </button>
            <button
              type="button"
              onClick={() => void signOut()}
              data-testid="settings-sign-out"
              className="h-11 rounded-full border border-white/15 px-6 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
            >
              {strings.settingsAccountSignOut}
            </button>
            <button
              type="button"
              onClick={() => setConfirmSignOutEverywhere(true)}
              data-testid="settings-sign-out-everywhere"
              className="h-11 rounded-full border border-white/15 px-6 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
            >
              {strings.settingsAccountSignOutEverywhere}
            </button>
          </div>
          {confirmSignOutEverywhere ? (
            <ConfirmDialog
              title={strings.settingsAccountSignOutEverywhereTitle}
              body={strings.settingsAccountSignOutEverywhereBody}
              confirmLabel={strings.settingsAccountSignOut}
              onConfirm={() => {
                setConfirmSignOutEverywhere(false);
                void signOutEverywhere();
              }}
              onCancel={() => setConfirmSignOutEverywhere(false)}
              testId="settings-sign-out-everywhere-dialog"
            />
          ) : null}
          <div className="mt-4">
            <Row
              label={strings.settingsAccountLastSync}
              value={
                lastSyncAt === null
                  ? strings.settingsAccountNeverSynced
                  : formatTime(lastSyncAt)
              }
              testId="settings-last-sync"
            />
          </div>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            data-testid="settings-delete-account"
            className="mt-4 h-11 rounded-full px-3 text-sm font-medium text-red-300 transition-colors hover:bg-white/5 active:scale-95"
          >
            {strings.settingsAccountDelete}
          </button>
          {confirmDelete ? (
            <ConfirmDialog
              title={strings.settingsAccountDeleteTitle}
              body={strings.settingsAccountDeleteBody}
              confirmLabel={strings.delete}
              onConfirm={handleDelete}
              onCancel={() => setConfirmDelete(false)}
              testId="settings-delete-dialog"
            />
          ) : null}
        </div>
      )}
    </Section>
  );
}

/** Seksi Lirik (P7): saklar tampilkan lirik di pemutar. */
function LyricsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getLyricsService().then((service) =>
      service.isEnabled().then((value) => {
        if (!cancelled) setEnabled(value);
      }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(() => {
    if (enabled === null) return;
    const next = !enabled;
    setEnabled(next);
    void getLyricsService().then((service) =>
      service.setEnabled(next).catch(() => setEnabled(enabled)),
    );
  }, [enabled]);

  return (
    <Section title={strings.settingsLyricsSection} testId="settings-lyrics">
      <p className="text-sm leading-relaxed text-zinc-400">
        {strings.settingsLyricsBody}
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={enabled === true}
        onClick={toggle}
        disabled={enabled === null}
        data-testid="settings-lyrics-toggle"
        className="mt-4 flex h-11 items-center gap-3 rounded-full border border-white/15 px-5 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95 disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={`inline-block h-5 w-9 rounded-full p-0.5 transition-colors ${
            enabled ? 'bg-white' : 'bg-zinc-700'
          }`}
        >
          <span
            className={`block h-4 w-4 rounded-full transition-transform ${
              enabled ? 'translate-x-4 bg-black' : 'translate-x-0 bg-zinc-300'
            }`}
          />
        </span>
        {enabled === null
          ? strings.loadingLabel
          : enabled
            ? strings.settingsLyricsOn
            : strings.settingsLyricsOff}
      </button>
    </Section>
  );
}

export default function SettingsPage({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const canary = useResilienceStore((s) => s.canary);
  const configSource = useResilienceStore((s) => s.configSource);
  const configStale = useResilienceStore((s) => s.configStale);
  const configFetchedAt = useResilienceStore((s) => s.configFetchedAt);
  const updateStatus = useResilienceStore((s) => s.updateStatus);
  const updateMessage = useResilienceStore((s) => s.updateMessage);
  const runUpdateCheck = useResilienceStore((s) => s.runUpdateCheck);
  const refresh = useResilienceStore((s) => s.refresh);

  const [snapshot, setSnapshot] = useState<FailureSnapshot | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    void refresh();
    const memory = getMemorySnapshot();
    if (memory) {
      setSnapshot(memory);
    } else {
      void loadPersistedSnapshot().then(setSnapshot);
    }
    // Log memori utama; sesudah reload halaman, memori kosong
    // dan log yang tersimpan dipakai (sama seperti snapshot).
    const memoryLog = getPlayerLog();
    if (memoryLog.length > 0) {
      setLogLines(memoryLog);
    } else {
      void loadPersistedPlayerLog().then(setLogLines);
    }
  }, [refresh]);

  const diagnosticCode = useMemo(() => {
    const loaded = getConfigLoader().lastLoaded();
    return buildDiagnosticCode({
      kind: snapshot?.kind,
      cause: snapshot?.cause,
      failedAt: snapshot?.failedAt,
      clientsTried: snapshot?.clientsTried ?? [],
      configVersion: loaded?.primaryClientVersion ?? null,
      // configSource dari store (reaktif): kode dihitung ulang
      // sesudah Periksa pembaruan mengubah sumber config.
      configIsRemote: configSource !== null && configSource !== 'builtin',
      serviceStatus: canary?.status ?? null,
    });
  }, [snapshot, canary, configSource]);

  const handleCopy = useCallback(async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(diagnosticCode);
      setCopied(true);
      return;
    } catch {
      // Fallback untuk browser tanpa izin clipboard (pola SpikePage).
    }
    try {
      const area = document.createElement('textarea');
      area.value = diagnosticCode;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  }, [diagnosticCode]);

  const checking = updateStatus === 'checking';
  const serviceText =
    canary?.status === 'ok'
      ? strings.settingsServiceOk
      : canary?.status === 'degraded'
        ? strings.settingsServiceDegraded
        : canary?.status === 'broken'
          ? strings.settingsServiceBroken
          : strings.settingsServiceUnknown;
  const configSourceText =
    configSource === 'remote'
      ? strings.settingsConfigRemote
      : configSource === 'cached'
        ? strings.settingsConfigCached
        : configSource === 'builtin'
          ? strings.settingsConfigBuiltin
          : strings.settingsConfigBuiltin;

  return (
    <div data-testid="settings-page" className="pt-2">
      <AppLink
        to="/"
        onNavigate={onNavigate}
        testId="settings-back"
        className="flex h-11 items-center gap-2 rounded-full px-3 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
      >
        <ArrowLeft size={18} aria-hidden="true" />
        {strings.backToHome}
      </AppLink>
      <h1 className="mt-2 text-xl font-bold tracking-tight">
        {strings.settingsTitle}
      </h1>

      <AccountSection />
      <LyricsSection />
      <BackupSection />

      <Section title={strings.settingsUpdateSection} testId="settings-update">
        <p className="text-sm leading-relaxed text-zinc-400">
          {strings.settingsUpdateBody}
        </p>
        <button
          type="button"
          onClick={() => void runUpdateCheck()}
          disabled={checking}
          data-testid="check-update"
          className="mt-4 h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95 disabled:opacity-50"
        >
          {checking ? strings.checkingUpdate : strings.checkUpdate}
        </button>
        {updateMessage ? (
          <p
            data-testid="check-update-result"
            className="mt-3 text-sm text-zinc-300"
          >
            {updateMessage}
          </p>
        ) : null}
        <div className="mt-4">
          <Row
            label={strings.settingsConfigSource}
            value={configSourceText}
            testId="settings-config-source"
          />
          <Row
            label={strings.settingsConfigFetchedAt}
            value={formatTime(configFetchedAt)}
            testId="settings-config-fetched-at"
          />
          {configStale ? (
            <p
              data-testid="settings-config-stale"
              className="mt-2 text-sm text-amber-200"
            >
              {strings.settingsConfigStale}
            </p>
          ) : null}
        </div>
      </Section>

      <Section title={strings.settingsServiceSection} testId="settings-service">
        <Row
          label={strings.settingsServiceSection}
          value={serviceText}
          testId="settings-service-status"
        />
        <Row
          label={strings.settingsServiceCheckedAt}
          value={formatTime(canary?.checkedAt ?? null)}
          testId="settings-service-checked-at"
        />
      </Section>

      <Section title={strings.settingsReportSection} testId="settings-report">
        <p className="text-sm leading-relaxed text-zinc-400">
          {strings.settingsReportBody}
        </p>
        <div className="mt-4 rounded-xl border border-white/10 bg-zinc-900 px-4 py-3">
          <p className="text-xs text-zinc-400">
            {strings.settingsDiagnosticCode}
          </p>
          <p
            data-testid="diagnostic-code"
            className="mt-1 break-all font-mono text-base font-semibold text-zinc-100"
          >
            {diagnosticCode}
          </p>
          <button
            type="button"
            onClick={() => void handleCopy()}
            data-testid="copy-diagnostic-code"
            className="mt-3 h-11 rounded-full border border-white/15 px-5 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
          >
            {copied ? strings.codeCopied : strings.copyCode}
          </button>
          {copyFailed ? (
            <p
              data-testid="diagnostic-copy-failed"
              className="mt-2 text-sm text-zinc-400"
            >
              {strings.copyFailedBody}
            </p>
          ) : null}
        </div>
        {snapshot ? (
          <div className="mt-4" data-testid="diagnostic-snapshot">
            <h3 className="text-sm font-semibold">
              {strings.settingsSnapshotSection}
            </h3>
            <div className="mt-2">
              <Row
                label={strings.settingsSnapshotLayer}
                value={
                  snapshot.layer === 'engine'
                    ? strings.settingsSnapshotLayerEngine
                    : strings.settingsSnapshotLayerResolve
                }
                testId="snapshot-layer"
              />
              <Row
                label={strings.settingsSnapshotTime}
                value={formatTime(snapshot.failedAt)}
                testId="snapshot-time"
              />
              <Row
                label={strings.settingsSnapshotClient}
                value={snapshot.lastClient ?? '-'}
                testId="snapshot-client"
              />
              <Row
                label={strings.settingsSnapshotPlayability}
                value={snapshot.lastPlayability ?? '-'}
                testId="snapshot-playability"
              />
              <Row
                label={strings.settingsSnapshotHash}
                value={snapshot.playerHash ?? '-'}
                testId="snapshot-hash"
              />
              <Row
                label={strings.settingsSnapshotConfig}
                value={
                  getConfigLoader().lastLoaded()?.primaryClientVersion ??
                  '-'
                }
                testId="snapshot-config"
              />
            </div>
          </div>
        ) : (
          <p
            data-testid="diagnostic-no-failure"
            className="mt-4 text-sm text-zinc-400"
          >
            {strings.settingsNoFailure}
          </p>
        )}
        <div className="mt-4" data-testid="diagnostic-log">
          <h3 className="text-sm font-semibold">
            {strings.settingsSnapshotLog}
          </h3>
          {logLines.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-400">
              {strings.settingsSnapshotLogEmpty}
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {logLines.map((line, index) => (
                <li
                  key={`${index}-${line}`}
                  className="break-words font-mono text-xs leading-relaxed text-zinc-400"
                >
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section title={strings.settingsAboutSection} testId="settings-about">
        <Row
          label={strings.settingsAppVersion}
          value={APP_VERSION}
          testId="settings-app-version"
        />
      </Section>
    </div>
  );
}
