import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalStateStore,
  stateMigrationsDirectory,
} from '../../../packages/backend-local/dist/index.js';
import { importArchive } from '../../../packages/cli/dist/services/importing.js';
import { startServing } from '../../../packages/cli/dist/services/serving.js';
import { assertBuildId, loadProjectConfig } from '../../../packages/core/dist/index.js';
import { expect, test } from './fixture.js';

test('reads the selected artifact when its ID is another source path, issue752', async ({
  page,
  checkA11y,
}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'lore-studio-selector-'));
  let server: Awaited<ReturnType<typeof startServing>> | undefined;
  try {
    writeFileSync(join(root, 'lore.yaml'), 'version: 1\nname: demo\nsources: [.]\n');
    const imported = await importArchive(
      root,
      join(import.meta.dirname, '../../../fixtures/builds/source_selector.lorepack'),
    );
    const state = LocalStateStore.open(join(root, '.lore'), stateMigrationsDirectory());
    try {
      state.activate(assertBuildId(imported.buildId));
    } finally {
      state.close();
    }
    server = await startServing({
      config: loadProjectConfig({ cwd: root }),
      host: '127.0.0.1',
      port: 43_190,
      studio: true,
      warn: () => {},
    });
    await page.goto(`${server.url}/#/sources`);
    for (const [path, artifactId, marker, other] of [
      ['omega/z.md', 'omega:z.md', 'ID_TARGET_BODY', 'PATH_TARGET_BODY'],
      ['alpha/omega:z.md', 'alpha:omega:z.md', 'PATH_TARGET_BODY', 'ID_TARGET_BODY'],
    ] as const) {
      const responsePromise = page.waitForResponse((response) =>
        response.url().includes(`/v1/sources/${encodeURIComponent(artifactId)}`),
      );
      await page.getByRole('button', { name: path, exact: true }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({
        buildId: imported.buildId,
        locator: { artifactId },
      });
      const reader = page.getByRole('region', { name: `Stored text of ${path}` });
      await expect(reader).toContainText(marker);
      await expect(reader).not.toContainText(other);
    }
    await checkA11y();
    const screenshot = info.outputPath('source-selector.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach('source selector', { path: screenshot, contentType: 'image/png' });
  } finally {
    await test.step('Dispose the owned browser context', () => page.context().close());
    await test.step('Drain the owned serving fixture', async () => {
      await server?.close();
    });
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
