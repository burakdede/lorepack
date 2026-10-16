import { expect, test } from './fixture.js';

for (const viewport of [
  { name: 'desktop', width: 1280, height: 1000, theme: 'light' },
  { name: 'mobile', width: 390, height: 844, theme: 'dark' },
]) {
  test(`shows cited table schema context on ${viewport.name}, issue429`, async ({
    page,
    session,
    checkA11y,
    browser,
  }, info) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${session.url}/#/playground`);
    await page.evaluate(
      (theme) => document.documentElement.setAttribute('data-theme', theme),
      viewport.theme,
    );
    await page.getByLabel('Task', { exact: true }).fill('list_price');
    const pending = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/context') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const bundle = await response.json();
    expect(bundle.tables).toHaveLength(1);
    expect(bundle.tables[0].schemaReference.buildId).toBe(bundle.buildId);
    expect(bundle.tables[0].locator.relativePath).toBe('docs/pricing.csv');
    expect([...bundle.overview, ...bundle.selected]).toEqual([]);
    await expect(page.getByRole('heading', { name: 'tables', exact: true })).toBeVisible();
    await expect(page.getByText('Matching table references are listed below.')).toBeVisible();
    await expect(
      page.getByText('Nothing fit. Every candidate is in the omissions below.'),
    ).toHaveCount(0);
    const table = page.locator('li.item').filter({ has: page.locator('.table-name') });
    await expect(table).toHaveCount(1);
    await expect(table.getByText('docs/pricing.csv', { exact: true })).toBeVisible();
    await expect(table.getByText(bundle.buildId, { exact: true })).toBeVisible();
    await expect(table.getByText('A-1', { exact: false })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await checkA11y();
    await info.attach('Chromium version', { body: browser.version(), contentType: 'text/plain' });
    await page.screenshot({
      path: info.outputPath(`table-context-${viewport.name}.png`),
      fullPage: true,
    });
  });
}
