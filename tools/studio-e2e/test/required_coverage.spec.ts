import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startServing } from '../../../packages/cli/dist/services/serving.js';
import { loadProjectConfig } from '../../../packages/core/dist/index.js';
import { makePdf } from '../../test-support/src/pdf-fixtures.js';
import { expect, test } from './fixture.js';

test('shows required coverage and exact missing PDF pages from the retained build', async ({
  page,
  browser,
  checkA11y,
}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'lore-studio-coverage-'));
  let server: Awaited<ReturnType<typeof startServing>> | undefined;
  try {
    mkdirSync(join(root, 'docs'));
    writeFileSync(
      join(root, 'lore.yaml'),
      [
        'version: 1',
        'name: required-context',
        'sources: [docs]',
        'build:',
        '  profile: permissive',
        '  required: [{path: docs/contract.pdf}]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'docs/contract.pdf'),
      makePdf([{ lines: ['Available contract text.'] }, { lines: [], image: true }]),
    );
    await promisify(execFile)(
      process.execPath,
      [
        join(import.meta.dirname, '../../../packages/cli/dist/public-entry.js'),
        '--cwd',
        root,
        '--json',
        'build',
      ],
      { timeout: 30_000 },
    );
    rmSync(join(root, 'docs/contract.pdf'));
    server = await startServing({
      config: loadProjectConfig({ cwd: root }),
      host: '127.0.0.1',
      port: 49_413,
      studio: true,
      warn: () => {},
    });
    await page.goto(`${server.url}/#/`);
    await expect(
      page.getByText('Required source docs/contract.pdf has incomplete coverage:', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(page.getByText('Pages: 2.', { exact: false }).first()).toBeVisible();
    await expect(page.locator('.warning-list')).toContainText('docs/contract.pdf Required source');
    await info.attach('Chromium version', { body: browser.version(), contentType: 'text/plain' });
    await checkA11y();
    for (const [name, width, height] of [
      ['desktop', 1280, 720],
      ['mobile', 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const screenshot = info.outputPath(`required-coverage-${name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await info.attach(`Required coverage ${name}`, {
        path: screenshot,
        contentType: 'image/png',
      });
    }
  } finally {
    await test.step('Dispose the owned browser context', () => page.context().close());
    await test.step('Drain the owned serving fixture', async () => {
      await server?.close();
    });
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
