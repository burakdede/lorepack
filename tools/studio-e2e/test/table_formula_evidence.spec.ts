import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startServing } from '../../../packages/cli/dist/services/serving.js';
import { loadProjectConfig } from '../../../packages/core/dist/index.js';
import {
  formula,
  inlineString,
  makeXlsx,
  number,
  row,
} from '../../test-support/src/office-fixtures.js';
import { expect, test } from './fixture.js';

test('shows retained formula evidence and conversion warnings on desktop and mobile, issue430', async ({
  page,
  browser,
  checkA11y,
}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'lore-studio-formula-'));
  let server: Awaited<ReturnType<typeof startServing>> | undefined;
  try {
    writeFileSync(join(root, 'lore.yaml'), 'version: 1\nname: formulas\nsources: [.]\n');
    writeFileSync(
      join(root, 'rates.xlsx'),
      await makeXlsx({
        sheets: [
          {
            name: 'Rates',
            rows:
              row(1, [
                inlineString('A1', 'quantity'),
                inlineString('B1', 'amount'),
                inlineString('C1', 'computed'),
                inlineString('D1', 'notes'),
                inlineString('E1', 'copy'),
              ]) +
              row(2, [
                number('A2', 2),
                number('B2', 3),
                formula('C2', 'A2+B2', 999),
                inlineString('D2', 'Merged note'),
              ]),
            merges: ['D2:E2'],
          },
        ],
      }),
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
    rmSync(join(root, 'rates.xlsx'));
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const address = reservation.address();
    if (address === null || typeof address === 'string')
      throw new Error('Expected an allocated TCP port.');
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    server = await startServing({
      config: loadProjectConfig({ cwd: root }),
      host: '127.0.0.1',
      port: address.port,
      studio: true,
      warn: () => {},
    });
    await page.goto(`${server.url}/#/tables`);
    const schema = page.getByRole('table', { name: 'Rates schema' });
    await expect(schema.getByRole('row', { name: /computed/ })).toContainText('present');
    await expect(schema.getByRole('row', { name: /amount/ })).toContainText('absent');
    await expect(page.getByText('xlsx-merged-cells')).toBeVisible();
    await expect(page.getByText(/Workbook formulas are never evaluated/)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Rates sample rows' })).toContainText('999');
    await info.attach('Chromium version', { body: browser.version(), contentType: 'text/plain' });
    await checkA11y();
    for (const [name, width, height] of [
      ['desktop', 1280, 900],
      ['mobile', 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const label of [
        'Rates schema scroll area',
        ...(name === 'mobile' ? ['Rates sample rows scroll area'] : []),
      ]) {
        const scroll = page.getByRole('region', { name: label });
        await scroll.evaluate((element) => {
          element.scrollLeft = 0;
        });
        await scroll.focus();
        await expect(scroll).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await expect
          .poll(() => scroll.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0);
        await scroll.evaluate((element) => element.scrollTo({ left: 0, behavior: 'instant' }));
      }
      await checkA11y();
      await page.getByRole('heading', { name: 'Tables', exact: true }).click();

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const screenshot = info.outputPath(`table-formula-${name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await info.attach(`Table formula ${name}`, { path: screenshot, contentType: 'image/png' });
    }
  } finally {
    await test.step('Dispose the owned browser context', () => page.context().close());
    await test.step('Drain the owned serving fixture', async () => {
      await server?.close();
    });
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
