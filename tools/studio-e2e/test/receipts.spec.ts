import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from './fixture.js';

for (const viewport of [
  { name: 'desktop', width: 1280, height: 1000, captureRequest: false, theme: 'light' },
  { name: 'mobile', width: 390, height: 844, captureRequest: true, theme: 'dark' },
]) {
  test(`saves exact receipt and context on ${viewport.name}, issue434`, async ({
    page,
    session,
    checkA11y,
  }, info) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${session.url}/#/playground`);
    await page.evaluate(
      (theme) => document.documentElement.setAttribute('data-theme', theme),
      viewport.theme,
    );
    await expect(page.getByRole('checkbox', { name: 'Keep a receipt' })).not.toBeChecked();
    await page.getByLabel('Task', { exact: true }).fill('rollback');
    await page.getByRole('checkbox', { name: 'Keep a receipt' }).check();
    if (viewport.captureRequest)
      await page.getByRole('checkbox', { name: 'Include task and filters in receipt' }).check();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/context') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const emitted = await response.text();
    await expect(page.getByRole('button', { name: 'Save exact context' })).toBeVisible();
    await page.getByLabel('Task', { exact: true }).fill('changed form, not the saved request');
    const payloadDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save exact context' }).click();
    const payloadPath = info.outputPath('context.json');
    await (await payloadDownload).saveAs(payloadPath);
    expect(readFileSync(payloadPath, 'utf8')).toBe(emitted);
    const receiptDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save receipt' }).click();
    const receiptPath = info.outputPath('receipt.json');
    await (await receiptDownload).saveAs(receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.payloadDigest).toBe(
      createHash('sha256').update(readFileSync(payloadPath)).digest('hex'),
    );
    expect(receipt.payloadBytes).toBe(readFileSync(payloadPath).byteLength);
    expect(receipt.requestRetained).toBe(viewport.captureRequest);
    if (viewport.captureRequest) expect(receipt.request.task).toBe('rollback');
    else expect(receipt.request).toBeUndefined();
    expect(receipt.buildId).toBe(JSON.parse(emitted).buildId);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    await checkA11y();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: info.outputPath(`receipt-${viewport.name}.png`),
      fullPage: true,
    });
  });
}
