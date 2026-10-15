import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixture.js';

test('browses a source beyond the first inventory page', async ({ page, session, checkA11y }) => {
  for (let index = 0; index < 51; index += 1) {
    writeFileSync(
      join(session.projectRoot, 'docs', `page-${String(index).padStart(2, '0')}.md`),
      `# Inventory page ${index}\n\nA retained source document.\n`,
    );
  }
  await expect
    .poll(async () => {
      const response = await page.request.get(`${session.url}/v1/build`);
      return ((await response.json()) as { counts: { artifacts: number } }).counts.artifacts;
    })
    .toBeGreaterThan(50);
  const firstResponse = await page.request.get(`${session.url}/v1/sources`);
  const first = (await firstResponse.json()) as {
    buildId: string;
    nextOffset: number;
    artifacts: { relativePath: string }[];
  };
  expect(first.artifacts).toHaveLength(50);
  expect(first.nextOffset).toBe(50);
  expect(first.artifacts.map((artifact) => artifact.relativePath)).not.toContain('docs/runbook.md');
  const continuations: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/v1/sources' && url.searchParams.has('offset')) continuations.push(url);
  });
  await page.goto(`${session.url}/#/sources`);
  await page.getByPlaceholder('Filter by path or status').fill('runbook');
  await page.getByRole('button', { name: 'docs/runbook.md', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Stored text of docs/runbook.md' })).toContainText(
    'Run lorepack rollback to point at the previous build.',
  );
  expect(continuations.length).toBeGreaterThan(0);
  for (const url of continuations) {
    expect(url.searchParams.get('buildId')).toBe(first.buildId);
    expect(url.searchParams.get('offset')).toBe('50');
  }
  await checkA11y();
  await page.screenshot({
    path: join(import.meta.dirname, '../../../docs/images/studio_source_inventory.png'),
  });
});
