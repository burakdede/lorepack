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

    // And the half that gets buried, in both of the shapes it comes in: a file the walk read
    // and could not parse, and a file a rule removed before anything was read (#202).
    await page.getByRole('button', { name: /excluded \d/ }).click();
    await expect(page.getByText('docs/diagram.bin')).toBeVisible();
    await expect(page.getByText(/no supported parser/)).toBeVisible();
    await expect(page.getByText('drafts/', { exact: true })).toBeVisible();
    // The rule is `drafts/`, which prunes the directory (#209), so the row names the
    // directory and not the files inside it. Listing them would show paths discovery never
    // walked, and on a dependency tree it would be a listing of somebody's node_modules.
    await expect(page.getByRole('cell', { name: 'drafts/', exact: true })).toBeVisible();

    await checkA11y();
  });

  /**
   * The count against the list, against a real build.
   *
   * The component test asserts the same equality against a fixture, and a fixture agrees with
   * whoever wrote the component: this one is fed by a real `.loreignore` and a real walk.
   */
  test('counts every kind of exclusion it lists', async ({ page, session }) => {
    await page.goto(`${session.url}/#/sources`);

    const reported = (await (await fetch(`${session.url}/v1/warnings`)).json()) as {
      groups: { warnings: unknown[] }[];
      excludedByRule: number | null;
      exclusions: { pattern: string }[] | null;
    };

    // A build that recorded nothing would make the assertion below vacuous.
    expect(reported.exclusions?.some((one) => one.pattern === 'drafts/')).toBe(true);
    const total =
      (reported.excludedByRule ?? 0) + reported.groups.flatMap((group) => group.warnings).length;

    // Polled rather than read once. The page fetches this itself, and the supervisor is
    // watching the same project, so reading the control at one instant and the API at another
    // compares two moments rather than two representations. What is under test is that they
    // agree, not how quickly the page got there.
    await expect
      .poll(async () =>
        Number(
          /excluded (\d+)/.exec(
            (await page.getByRole('button', { name: /excluded \d+/ }).textContent()) ?? '',
          )?.[1],
        ),
      )
      .toBe(total);
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

  /**
   * The page against the bundle, from the server, with nothing mocked.
   *
   * The component test asserts the same equality against a fixture, and a fixture is written
   * by whoever writes the component: #199 shipped with an `overview` of `[]` in the fixture
   * and an `overview` the route never read. Only the real assembler produces a bundle nobody
   * chose the shape of.
   */
  test('shows every passage the assembled bundle cites', async ({ page, session }) => {
    await page.goto(`${session.url}/#/playground`);

    const task = 'how do I roll back a release';
    await page.getByLabel('Task').fill(task);
    await page.getByRole('button', { name: 'Assemble' }).click();
    await expect(page.locator('.item')).not.toHaveCount(0);

    const bundle = (await (
      await fetch(`${session.url}/v1/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
      })
    ).json()) as { citations: { relativePath: string }[]; overview: unknown[] };

    // The reserve is what was missing, so a bundle without one would make this pass by
    // asserting nothing, exactly as the old fixture did.
    expect(bundle.overview.length).toBeGreaterThan(0);

    const body = await page.locator('main').innerText();
    for (const citation of new Set(bundle.citations.map((one) => one.relativePath))) {
      expect(body, `${citation} is cited in the bundle and must be on the page`).toContain(
        citation,
      );
    }
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
  /**
   * #210. The buttons this route exists for were outside the table's visible area at every
   * window width, because `.main` is capped and the table is wider than the cap.
   *
   * Every other test here finds them with `getByRole`, and Playwright scrolls an element into
   * view before acting on it, so a control nobody could see was still perfectly clickable.
   * That is why this assertion is about **geometry, before anything scrolls**: it is the only
   * shape of assertion that could have caught it.
   */
  for (const width of [1280, 1512]) {
    test(`keeps every action on a build row visible at ${width}`, async ({ page, session }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${session.url}/#/versions`);
      await expect(page.locator('.build-row').first()).toBeVisible();

      // Against the scroll box, not against the viewport. That distinction is the defect:
      // `.main` is capped at 1100px, so the buttons were inside the window and outside the
      // container clipping them. A viewport-relative assertion passes on the broken layout,
      // which is worth stating because the first version of this test did exactly that.
      const scroller = page.locator('.table-scroll').first();
      const frame = await scroller.boundingBox();
      expect(frame, 'the history should be laid out').not.toBeNull();
      const right = (frame?.x ?? 0) + (frame?.width ?? 0);

      const visible = async (locator: import('@playwright/test').Locator, what: string) => {
        const box = await locator.boundingBox();
        expect(box, `${what} should be laid out`).not.toBeNull();
        expect(
          (box?.x ?? 0) + (box?.width ?? 0),
          `${what} is clipped by the right edge of the history at ${width}`,
        ).toBeLessThanOrEqual(right);
        expect(box?.x ?? -1, `${what} is clipped by the left edge`).toBeGreaterThanOrEqual(
          frame?.x ?? 0,
        );
      };

      for (const name of [/^Activate lore_/, /^Pack lore_/, /^Compare lore_/]) {
        await visible(page.getByRole('button', { name }).first(), String(name));
      }

      // The other end must not have been traded away for it: the build a row is about has to
      // stay readable next to the buttons that act on it.
      await visible(page.locator('.build-id').first(), 'the build id');

      // And the page still does not scroll sideways, which is the guarantee the scroll box
      // exists to keep.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

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
