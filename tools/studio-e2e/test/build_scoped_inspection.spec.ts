import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from './fixture.js';

const execute = promisify(execFile);
const BINARY = join(import.meta.dirname, '../../../packages/cli/dist/public-entry.js');

test('Stored text follows an external build activation, issue609', async ({
  page,
  session,
}, info) => {
  await page.goto(`${session.url}/#/sources`);
  await page.getByRole('button', { name: 'docs/runbook.md' }).click();
  const reader = page.getByRole('region', { name: 'Stored text of docs/runbook.md' });
  await expect(reader).toContainText('No deployments during a change freeze.');

  writeFileSync(
    join(session.projectRoot, 'docs', 'runbook.md'),
    '# Release runbook\n\nREVISED CONTENT FOR ACTIVE BUILD\n',
  );
  const { stdout } = await execute(
    process.execPath,
    [BINARY, '--cwd', session.projectRoot, '--json', 'build'],
    { timeout: 30_000 },
  );
  const { buildId } = JSON.parse(stdout) as { buildId: string };
  await expect(page.locator('.header-id')).toHaveAttribute('title', buildId);
  const inventory = (await (
    await fetch(`${session.url}/v1/sources?buildId=${encodeURIComponent(buildId)}`)
  ).json()) as { artifacts: { artifactId: string; relativePath: string }[] };
  const artifactId = inventory.artifacts.find(
    (artifact) => artifact.relativePath === 'docs/runbook.md',
  )?.artifactId;
  expect(artifactId).toBeDefined();
  const expected = (await (
    await fetch(
      `${session.url}/v1/sources/${encodeURIComponent(artifactId as string)}?buildId=${encodeURIComponent(buildId)}`,
    )
  ).json()) as {
    text: string;
  };
  await expect(reader).toContainText('REVISED CONTENT FOR ACTIVE BUILD');
  const stored = await reader
    .locator('.reader-line')
    .evaluateAll((lines) => lines.map((line) => line.lastChild?.textContent ?? '').join(''));
  expect(stored.trim()).toBe(expected.text.trim());
  const screenshot = info.outputPath('source-after-external-build.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('Stored text after external build', {
    path: screenshot,
    contentType: 'image/png',
  });
});

test('Copy as export follows the assembled bundle, issue609', async ({ page, session }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${session.url}/#/playground`);
  await page.getByRole('textbox', { name: 'Task' }).fill('pipeline input output');
  const assembled = page.waitForResponse(
    (response) => response.url().endsWith('/v1/context') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Assemble' }).click();
  await expect(page.getByRole('button', { name: 'Copy as export' })).toBeVisible();
  const { buildId: assembledBuildId } = (await (await assembled).json()) as { buildId: string };

  await page.getByRole('textbox', { name: 'Task' }).fill('percent named file');
  await page.getByRole('textbox', { name: 'Budget' }).fill('9000');
  writeFileSync(
    join(session.projectRoot, 'docs', 'onboarding.md'),
    '# Onboarding\n\nA revised onboarding procedure.\n',
  );
  const { stdout } = await execute(
    process.execPath,
    [BINARY, '--cwd', session.projectRoot, '--json', 'build'],
    { timeout: 30_000 },
  );
  const { buildId: activeBuildId } = JSON.parse(stdout) as { buildId: string };
  expect(activeBuildId).not.toBe(assembledBuildId);
  await expect(page.locator('.header-id')).toHaveAttribute('title', activeBuildId);
  const exportRequest = page.waitForRequest(
    (request) => request.url().endsWith('/v1/export') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Copy as export' }).click();
  const body = (await exportRequest).postDataJSON() as {
    task: string;
    budget?: number;
    buildId?: string;
  };
  expect(body.task).toBe('pipeline input output');
  expect(body.budget).toBeUndefined();
  expect(body.buildId).toBe(assembledBuildId);
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('# Context for: pipeline input output');
  expect(clipboard).toContain(`build \`${assembledBuildId}\``);
  expect(clipboard).not.toContain('# Context for: percent named file');
});
