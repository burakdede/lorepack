import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { startServing } from '../../../packages/cli/dist/services/serving.js';
import { loadProjectConfig } from '../../../packages/core/dist/index.js';
import { expect, test } from './fixture.js';

const execute = promisify(execFile);
const BINARY = join(import.meta.dirname, '../../../packages/cli/dist/public-entry.js');

async function project(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'lore-studio-history-'));
  let server: Awaited<ReturnType<typeof startServing>> | undefined;
  try {
    writeFileSync(join(root, 'lore.yaml'), 'version: 1\nname: history\nsources: [docs]\n');
    mkdirSync(join(root, 'docs'));
    const cli = async (args: string[]) => {
      const result = await execute(process.execPath, [BINARY, '--cwd', root, '--json', ...args], {
        timeout: 30_000,
      });
      return JSON.parse(result.stdout) as { buildId: string };
    };
    writeFileSync(join(root, 'docs/a.md'), '# First\n\nFIRST_ACTIVE\n');
    const first = (await cli(['build'])).buildId;
    writeFileSync(join(root, 'docs/a.md'), '# Candidate\n\nNEVER_ACTIVE\n');
    const candidate = (await cli(['build', '--no-activate'])).buildId;
    writeFileSync(join(root, 'docs/a.md'), '# Third\n\nTHIRD_ACTIVE\n');
    const third = (await cli(['build'])).buildId;
    expect(new Set([first, candidate, third]).size).toBe(3);
    rmSync(join(root, 'docs'), { recursive: true });
    rmSync(join(root, '.lore/cache'), { recursive: true, force: true });
    if (legacy) {
      const db = new DatabaseSync(join(root, '.lore/state.sqlite'));
      try {
        db.exec(
          "DROP TRIGGER record_activation; DROP TABLE activation_events; DELETE FROM schema_migrations WHERE id = '0003';",
        );
      } finally {
        db.close();
      }
    }
    server = await startServing({
      config: loadProjectConfig({ cwd: root }),
      host: '127.0.0.1',
      port: 43_190,
      studio: true,
      warn: () => {},
    });
    return {
      first,
      candidate,
      third,
      url: server.url,
      close: async () => {
        await server?.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      },
    };
  } catch (cause) {
    await server?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw cause;
  }
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, theme: 'light' },
  { name: 'mobile', width: 390, height: 844, theme: 'dark' },
]) {
  test(`shows actual activation order and rolls back without sources on ${viewport.name}, issue422`, async ({
    page,
    checkA11y,
  }, info) => {
    const fixture = await project();
    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${fixture.url}/#/versions`);
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-theme', theme),
        viewport.theme,
      );
      await expect(page.locator('.rollback-line')).toContainText(fixture.first.slice(0, 17));
      await expect(page.locator('.rollback-line')).not.toContainText(
        fixture.candidate.slice(0, 17),
      );
      await page.getByText('Activation history', { exact: true }).click();
      const events = page.getByRole('region', { name: 'Recorded activations' });
      await expect(events).toContainText(fixture.first.slice(0, 17));
      await expect(events).toContainText(fixture.third.slice(0, 17));
      await expect(events).not.toContainText(fixture.candidate.slice(0, 17));
      await expect(events.getByRole('row')).toHaveCount(3);
      await page.getByRole('button', { name: 'Roll back', exact: true }).click();
      const confirmation = page.getByRole('region', {
        name: `Roll back to ${fixture.first.slice(0, 17)}`,
      });
      await expect(confirmation).toContainText('Nothing is recompiled');
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().endsWith('/v1/builds/rollback') && response.request().method() === 'POST',
      );
      await confirmation.getByRole('button', { name: /^Roll back to lore_/ }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({
        buildId: fixture.first,
        generation: 3,
        changed: true,
      });
      await expect(page.locator('.header-id')).toContainText(fixture.first.slice(0, 17));
      await expect(page.locator('.rollback-line')).toContainText(fixture.third.slice(0, 17));
      await expect(events.getByRole('row')).toHaveCount(4);
      if (viewport.name === 'mobile') {
        await events.focus();
        const before = await events.evaluate((element) => element.scrollLeft);
        await events.press('ArrowRight');
        await expect
          .poll(() => events.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(before);
        await events.evaluate((element) => {
          element.scrollLeft = 0;
        });
      }
      await checkA11y();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await page.evaluate(() => window.scrollTo(0, 0));
      const screenshot = info.outputPath(`activation-history-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await info.attach(`Activation history ${viewport.name}`, {
        path: screenshot,
        contentType: 'image/png',
      });
    } finally {
      await test.step('Dispose the owned browser context', () => page.context().close());
      await test.step('Drain the owned serving fixture', () => fixture.close());
    }
  });
}

test('labels legacy history honestly and enables explicit activation, issue422', async ({
  page,
  checkA11y,
}, info) => {
  const fixture = await project(true);
  try {
    await page.goto(`${fixture.url}/#/versions`);
    await expect(page.getByText(/No previous activation is recorded/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Roll back', exact: true })).toHaveCount(0);
    await page.getByText('Activation history', { exact: true }).click();
    const events = page.getByRole('region', { name: 'Recorded activations' });
    await expect(events.getByText('Baseline observation', { exact: true })).toBeVisible();
    await expect(events.getByText('Unknown', { exact: true })).toBeVisible();
    await expect(events.getByRole('row')).toHaveCount(2);
    await checkA11y();
    const screenshot = info.outputPath('activation-history-baseline.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach('Legacy baseline', { path: screenshot, contentType: 'image/png' });
    await page.getByRole('button', { name: `Activate ${fixture.first.slice(0, 17)}` }).click();
    const confirmation = page.getByRole('region', {
      name: `Activate ${fixture.first.slice(0, 17)}`,
    });
    await confirmation
      .getByRole('button', { name: `Activate ${fixture.first.slice(0, 17)}` })
      .click();
    await expect(page.locator('.header-id')).toContainText(fixture.first.slice(0, 17));
    await expect(page.getByRole('button', { name: 'Roll back', exact: true })).toBeVisible();
    await expect(page.locator('.rollback-line')).toContainText(fixture.third.slice(0, 17));
    await expect(events.getByRole('row')).toHaveCount(3);
  } finally {
    await test.step('Dispose the owned browser context', () => page.context().close());
    await test.step('Drain the owned serving fixture', () => fixture.close());
  }
});
