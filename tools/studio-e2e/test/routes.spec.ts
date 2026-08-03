import { expect, test } from './fixture.js';

/**
 * The workflows Studio exists for, driven end to end.
 *
 * Each of these is a thing a person came to do: find out what the build contains, find out
 * why a document is missing, see what a task would send a model, compare two builds, and
 * find out why something is stuck. They run against a real server, so the assertions are
 * about the assembled product rather than about a component's props.
 */

test.describe('Overview', () => {
  test('answers what this build contains and whether the sources moved', async ({
    page,
    session,
    checkA11y,
  }) => {
    await page.goto(`${session.url}/#/`);

    // The build id is in the header on every route, because everything on screen is relative
    // to one immutable build (architecture 4.10).
    await expect(page.locator('.header-id')).toContainText(/^lore_[0-9a-f]{12}/);
    await expect(page.getByRole('heading', { name: 'build', exact: true })).toBeVisible();
    // The one thing on this route that moves under the reader, and the reason it is given
    // the weight rather than the counts.
    await expect(page.locator('.state-banner')).toContainText(/match|moved on|unknown/i);

    await checkA11y();
  });

  test('reads at 1280 by 720 without scrolling sideways', async ({ page, session }) => {
    await page.goto(`${session.url}/#/`);
    await expect(page.locator('.header-id')).toBeVisible();

    // Section 15.6 names the laptop viewport. A page that scrolls horizontally at it has a
    // table or a path that was never given anywhere to wrap.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('Sources', () => {
  test('lists what was parsed, and what was not, with the reason', async ({
    page,
    session,
    checkA11y,
  }) => {
    await page.goto(`${session.url}/#/sources`);

    await expect(page.getByRole('button', { name: 'docs/runbook.md' })).toBeVisible();
    await checkA11y();

    // The document detail, which is where provenance is shown.
    await page.getByRole('button', { name: 'docs/runbook.md' }).click();
    const detail = page.getByRole('complementary', { name: /docs\/runbook\.md/ });
    await expect(detail).toContainText('markdown');
    await expect(detail).toContainText('Release runbook');

    // And the half that gets buried: the file with no parser, and why it was skipped.
    await page.getByRole('button', { name: /excluded \d/ }).click();
    await expect(page.getByText('docs/diagram.bin')).toBeVisible();
    await expect(page.getByText(/no supported parser/)).toBeVisible();

    await checkA11y();
  });
});

test.describe('Playground', () => {
  test('assembles a bundle with provenance on every item', async ({ page, session, checkA11y }) => {
    await page.goto(`${session.url}/#/playground`);

    await page.getByLabel('Task').fill('how do I roll back a release');
    await page.getByRole('button', { name: 'Assemble' }).click();

    // A real bundle from the real assembler, so this fails if the route and the API disagree
    // about a field name, which no mocked component test can catch.
    await expect(page.locator('.item')).not.toHaveCount(0);
    // Invariant 5: every selected passage carries where it came from.
    await expect(page.locator('.item .citation').first()).toContainText('docs/runbook.md');
    await expect(
      page.getByText('Every figure is a conservative estimate, not an exact token count.'),
    ).toBeVisible();

    await checkA11y();
  });

  test('searches and shows the score as a ranking heuristic', async ({ page, session }) => {
    await page.goto(`${session.url}/#/playground`);

    await page.getByRole('tab', { name: 'search' }).click();
    await page.getByLabel('Query').fill('rollback');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.locator('.item .citation').first()).toContainText('docs/runbook.md');
    // Invariant 6: never presented as a measure of truth.
    await expect(page.getByText(/ranking heuristic/)).toBeVisible();
  });
});

test.describe('Versions', () => {
  test('compares two builds, activates one, and rolls back', async ({
    page,
    session,
    checkA11y,
  }) => {
    await page.goto(`${session.url}/#/versions`);

    // Two builds, one of them live.
    await expect(page.locator('.build-row')).toHaveCount(2);
    await expect(page.locator('.active-marker')).toHaveCount(1);
    await checkA11y();

    // The comparison, which reads the way `lore diff` reads.
    await expect(page.locator('.diff-section')).toHaveCount(5);
    await expect(page.locator('.diff-list .diff-marker').first()).toBeVisible();

    // Activate: the plan is shown first and names the target, and nothing moves until it is
    // confirmed.
    const activate = page.getByRole('button', { name: /^Activate lore_/ });
    const target = ((await activate.getAttribute('aria-label')) ?? '').replace('Activate ', '');
    await activate.click();

    const confirmation = page.getByRole('region', { name: `Activate ${target}` });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('Nothing is recompiled');
    await checkA11y();

    await confirmation.getByRole('button', { name: `Activate ${target}` }).click();
    await expect(page.locator('.outcome')).toContainText(`Activated ${target}`);

    // The header follows, because the whole interface is relative to the active build.
    await expect(page.locator('.header-id')).toContainText(target.slice(0, 17));

    // And back again, with the same treatment.
    await page.getByRole('button', { name: 'Roll back' }).click();
    const rollback = page.getByRole('region', { name: /^Roll back to lore_/ });
    await expect(rollback).toBeVisible();
    await rollback.getByRole('button', { name: /^Roll back to lore_/ }).click();
    await expect(page.locator('.outcome')).toContainText('Rolled back to lore_');
  });

  test('packs a build and reports where the archive went', async ({ page, session }) => {
    await page.goto(`${session.url}/#/versions`);

    const pack = page.getByRole('button', { name: /^Pack lore_/ }).first();
    const target = ((await pack.getAttribute('aria-label')) ?? '').replace('Pack ', '');
    await pack.click();

    await page
      .getByRole('region', { name: `Pack ${target}` })
      .getByRole('button', { name: `Pack ${target}` })
      .click();

    await expect(page.locator('.outcome')).toContainText('.lorepack');
    await expect(page.locator('.outcome')).toContainText('members including the checksum index');
  });
});

test.describe('Diagnostics', () => {
  test('renders the doctor checks and the live session', async ({ page, session, checkA11y }) => {
    await page.goto(`${session.url}/#/diagnostics`);

    await expect(page.getByText('Node version')).toBeVisible();
    await expect(page.getByText('SQLite FTS5')).toBeVisible();
    // The live half, which is why this route is more than `lore doctor` in a browser.
    await expect(page.getByRole('heading', { name: 'Session' })).toBeVisible();
    await expect(page.locator('.facts').first()).toContainText('127.0.0.1:');

    await checkA11y();
  });

  test('re-runs the checks when asked', async ({ page, session }) => {
    await page.goto(`${session.url}/#/diagnostics`);
    await page.getByRole('button', { name: 'Re-run checks' }).click();
    await expect(page.getByText('Node version')).toBeVisible();
  });
});
