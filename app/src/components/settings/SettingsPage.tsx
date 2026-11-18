/**
 * Halaman Pengaturan (P6): pembaruan config, kondisi layanan,
 * laporkan kerusakan (kode diagnostik LRS1 + snapshot pemutar),
 * tentang app.
 *
 * Rute /settings, lazy-load (tidak masuk bundle awal). Copy
 * Bahasa Indonesia sehari-hari, tanpa jargon, tanpa em dash.
 * Kode diagnostik + snapshot TIDAK memuat URL stream, token,
 * judul lagu, atau data pribadi apa pun (PRD B9.9).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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

function formatTime(ms: number | null): string {
  if (ms === null) return strings.settingsConfigNever;
  return new Date(ms).toLocaleString('id-ID', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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
      <button
        type="button"
        onClick={() => onNavigate('/')}
        data-testid="settings-back"
        className="flex h-11 items-center gap-2 rounded-full px-3 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
      >
        <ArrowLeft size={18} aria-hidden="true" />
        {strings.backToHome}
      </button>
      <h1 className="mt-2 text-xl font-bold tracking-tight">
        {strings.settingsTitle}
      </h1>

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
