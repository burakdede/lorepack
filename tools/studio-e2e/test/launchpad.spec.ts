import { expect, test } from './fixture.js';

/**
 * Studio as the place a developer starts from: what it offers to copy has to work when
 * pasted, so these run the copied forms against the same real server.
 *
 * A rendering can look right and be wrong in exactly the ways a unit test cannot see: a
 * field the server does not accept, a path it does not serve, an MCP call it rejects.
 */

/** The JSON body of a curl line, as a shell would pass it. */
function curlBody(http: string): unknown {
  const match = /-d ('(?:[^']|'\\'')*'|\S+)$/.exec(http);
  if (match === null) throw new Error(`no body in ${http}`);
  const word = match[1] ?? '';
  const unquoted = word.startsWith("'") ? word.slice(1, -1).replaceAll("'\\''", "'") : word;
  return JSON.parse(unquoted);
}

test.describe('Use it anywhere', () => {
  test('the HTTP and MCP forms of a context run make the same request', async ({
    page,
    session,
    checkA11y,
  }) => {
    await page.goto(`${session.url}/#/playground`);
    await page.getByLabel('Task').fill("how do I roll back a release that's live");
    await page.getByRole('button', { name: 'Assemble' }).click();
    await expect(page.locator('.item')).not.toHaveCount(0);

    const shown = Number(
      ((await page.locator('.tape-used').textContent()) ?? '').replace(/,/g, ''),
    );
    const panel = page.getByRole('region', { name: 'Use it anywhere' });

    await panel.getByRole('tab', { name: 'HTTP' }).click();
    const http = (await panel.locator('.equivalents-code').textContent()) ?? '';
    expect(http).toContain(`${session.url}/v1/context`);
    const viaHttp = await page.request.post(`${session.url}/v1/context`, {
      data: curlBody(http),
    });
    expect(viaHttp.ok()).toBe(true);
    // The same request against an immutable build: the same bundle, so the same accounting.
    expect((await viaHttp.json()).estimatedTokens).toBe(shown);

    await panel.getByRole('tab', { name: 'MCP' }).click();
    const call = JSON.parse((await panel.locator('.equivalents-code').textContent()) ?? '{}');
    expect(call.name).toBe('lore_context_for_task');
    const viaMcp = await page.request.post(`${session.url}/mcp`, {
      headers: { accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: call },
    });
    expect(viaMcp.ok()).toBe(true);
    const reply = await viaMcp.text();
    expect(reply).toContain('"result"');
    expect(reply).not.toContain('"isError":true');

    await checkA11y();
  });

  test('the SQL console hands over a query the API accepts', async ({ page, session }) => {
    await page.goto(`${session.url}/#/tables`);
    await page.getByRole('button', { name: 'Run query' }).click();
    await expect(page.getByRole('table', { name: 'Query result' })).toBeVisible();

    const panel = page.getByRole('region', { name: 'Use it anywhere' });
    await expect(panel.getByRole('tab', { name: 'CLI' })).toHaveCount(0);
    const http = (await panel.locator('.equivalents-code').textContent()) ?? '';
    const url = /curl -s -X POST (\S+)/.exec(http)?.[1] ?? '';
    const reply = await page.request.post(url, { data: curlBody(http) });
    expect(reply.ok()).toBe(true);
    expect((await reply.json()).rows.length).toBeGreaterThan(0);
  });
});

test.describe('Following provenance', () => {
  test('a citation opens the stored text with its lines marked', async ({
    page,
    session,
    checkA11y,
  }) => {
    await page.goto(`${session.url}/#/playground`);
    await page.getByLabel('Task').fill('how do I roll back a release');
    await page.getByRole('button', { name: 'Assemble' }).click();

    const link = page.locator('.item .citation-link').first();
    const path = (await link.textContent()) ?? '';
    await link.click();

    await expect(page).toHaveURL(/#\/sources\?artifact=.+&lines=\d+-\d+/);
    const reader = page.getByRole('region', { name: `Stored text of ${path}` });
    await expect(reader).toBeVisible();
    await expect(reader.locator('.reader-line-marked').first()).toBeVisible();

    await checkA11y();
  });
});

test.describe('Connecting a client', () => {
  test('Overview names the endpoints this process serves', async ({ page, session }) => {
    await page.goto(`${session.url}/#/`);
    const connect = page.locator('#connect');
    await expect(connect).toContainText(`${session.url}/mcp`);
    await expect(connect).toContainText('lorepack mcp');

    await page.getByRole('button', { name: 'Show how to connect' }).click();
    await expect(connect).toBeFocused();
  });
});
