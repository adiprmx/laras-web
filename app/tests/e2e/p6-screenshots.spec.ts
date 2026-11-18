/**
 * Screenshot P6 untuk docs/p6/ (bukan tes asersi): banner status
 * 3 tingkat di beranda + halaman Pengaturan (tombol Periksa
 * pembaruan + kode diagnostik) — masing-masing 360px + 1440px.
 *
 * Dijalankan lawan server dev + mock (pola resilience.spec.ts).
 * Hanya proyek chromium (pola P2/P5): screenshot di mobile diskip.
 * File ditulis ke <repo>/docs/p6/*.png — butuh sandbox TERBUKA
 * (tulis exec diblokir saat TERBATAS; lihat p5-log.md).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PROXY_BASE_URL } from './p4-helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', '..', '..', 'docs', 'p6');

/** Mock minimal: beranda rapi tanpa jaringan live (browse kosong). */
async function mockBrowseEmpty(context: BrowserContext): Promise<void> {
  await context.route(`${PROXY_BASE_URL}/api/innertube/search`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    }),
  );
  await context.route(`${PROXY_BASE_URL}/api/innertube/browse`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"contents":{}}',
    }),
  );
}

async function gotoCommit(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'commit' });
}

async function seed(page: Page, testId: string, doneText: string): Promise<void> {
  await gotoCommit(page, '/p6-test');
  await page.getByTestId('p6-test-page').waitFor({ timeout: 120000 });
  await page.getByTestId(testId).click();
  await expect(page.getByTestId('p6-test-status')).toHaveText(doneText, {
    timeout: 30000,
  });
}

test.describe('Screenshot P6', () => {
  // Skip per tes (pola P5): test.skip di tingkat describe
  // dengan callback menerima HANYA fixtures — testInfo di
  // argumen kedua undefined dan keempat tes gagal TypeError
  // (jalan 18 Nov 2026 18:29 UTC). Di dalam badan tes,
  // testInfo tersedia sebagai argumen kedua.

  // Satu tes per tingkat: tiga siklus seed + muat halaman dalam
  // satu tes 60 detik tidak muat saat VM sibuk (gagal timeout
  // di jalan pertama 18 Nov 2026 16:33 UTC). Satu siklus per tes
  // memberi ruang bagi transform dev yang lambat.
  const levels = [
    {
      seedId: 'p6-test-seed-canary-broken',
      done: 'Kanari broken tersimpan.',
      file: 'banner-outage',
      name: 'banner gangguan di beranda (360 + 1440)',
    },
    {
      seedId: 'p6-test-seed-canary-degraded',
      done: 'Kanari degraded tersimpan.',
      file: 'banner-warning',
      name: 'banner peringatan di beranda (360 + 1440)',
    },
    {
      seedId: 'p6-test-seed-stale-config',
      done: 'Config basi tersimpan.',
      file: 'banner-info',
      name: 'banner info di beranda (360 + 1440)',
    },
  ] as const;
  for (const level of levels) {
    test(level.name, async ({ page, context }, testInfo) => {
      test.skip(
        testInfo.project.name !== 'chromium',
        'Screenshot hanya di proyek chromium.',
      );
      await mockBrowseEmpty(context);
      await seed(page, level.seedId, level.done);
      await gotoCommit(page, '/');
      await page.getByTestId('status-banner').waitFor({ timeout: 30000 });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: path.join(SHOTS, `${level.file}-360.png`),
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: path.join(SHOTS, `${level.file}-1440.png`),
      });
    });
  }

  test('Pengaturan: Periksa pembaruan + kode diagnostik (360 + 1440)', async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium.',
    );
    await mockBrowseEmpty(context);
    await seed(
      page,
      'p6-test-seed-snapshot-engine',
      'Snapshot engine tersimpan.',
    );
    await gotoCommit(page, '/settings');
    await page.getByTestId('settings-page').waitFor({ timeout: 60000 });
    await page.getByTestId('diagnostic-code').waitFor({ timeout: 30000 });
    // Viewport TINGGI + screenshot viewport (bukan fullPage):
    // fullPage menempel bilah bawah (position:fixed) di tengah
    // jahitan dan menutupi teks "Laporkan kerusakan" di 360px
    // (ditemukan saat pemeriksaan visual 20:28 UTC). Halaman
    // setinggi ~1616px (360) / ~1461px (1440); viewport diberi
    // margin supaya seluruh halaman muat dalam satu tangkapan.
    await page.setViewportSize({ width: 360, height: 1700 });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(SHOTS, 'settings-360.png'),
    });
    await page.setViewportSize({ width: 1440, height: 1550 });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(SHOTS, 'settings-1440.png'),
    });
  });
});
