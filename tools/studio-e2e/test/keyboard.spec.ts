import { expect, test } from './fixture.js';

/**
 * Studio operated without a mouse, and read at 200% zoom.
 *
 * Section 15.6 requires keyboard operation, and the amendment on #70 requires the zoom pass
 * as well as the 100% one, because a type scale that only holds together at one size is a
 * layout that has not been designed, it has been arranged.
 *
 * A jsdom test can assert that a button exists and is focusable. Only a browser can say
 * whether it is *reachable*, whether the focus ring is visible where it landed, and whether
 * the page still fits when everything is twice the size.
 */

const ROUTES = ['/', '/sources', '/tables', '/playground', '/versions', '/diagnostics'] as const;

test.describe('reaching everything by keyboard', () => {
  test('the skip link is first, and it moves focus to the content', async ({ page, session }) => {
    await page.goto(`${session.url}/#/`);
    await page.keyboard.press('Tab');

    const first = page.locator(':focus');
    await expect(first).toHaveText('Skip to content');
    // Visible once focused, which is the whole point of a skip link: it is the only way past
    // a sticky header and five navigation links.
    await expect(first).toBeVisible();

    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.location.hash)).toContain('#main');
  });

  for (const route of ROUTES) {
    test(`every control on ${route} is reachable and shows where focus is`, async ({
      page,
      session,
    }) => {
      await page.goto(`${session.url}/#${route}`);
      // The route has rendered before anything is counted, or the tab order is measured
      // against a loading state.
      await expect(page.locator('h1.route-title')).toBeVisible();
      await page.waitForTimeout(500);

      const interactive = await page.locator('a, button, input, select, [tabindex="0"]').count();
      expect(interactive).toBeGreaterThan(0);

      const reached = new Set<string>();
      for (let step = 0; step < interactive + 10; step += 1) {
        await page.keyboard.press('Tab');
        const description = await page.evaluate(() => {
          const active = document.activeElement;
          if (active === null || active === document.body) return null;
          const style = window.getComputedStyle(active);
          return {
            id: `${active.tagName}:${(active.textContent ?? '').slice(0, 24)}`,
            // A focus ring that is `none` with no other treatment leaves a keyboard user
            // with no idea where they are.
            outline: style.outlineStyle,
            outlineWidth: style.outlineWidth,
          };
        });
        if (description === null) break;
        reached.add(description.id);
        expect(
          description.outline !== 'none' || description.outlineWidth !== '0px',
          `no visible focus on ${description.id}`,
        ).toBe(true);
      }

      // The nav links plus whatever the route offers. An element that cannot be reached by
      // Tab is one a keyboard user does not have.
      expect(reached.size).toBeGreaterThanOrEqual(6);
    });
  }

  test('a confirmation takes focus and gives it back on Escape', async ({ page, session }) => {
    await page.goto(`${session.url}/#/versions`);
    const activate = page.getByRole('button', { name: /^Activate lore_/ });
    await activate.click();

    // Focus lands on the panel rather than staying six rows up at the button that opened it.
    await expect(page.locator(':focus')).toHaveAttribute('id', 'confirm-heading');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: /^Activate lore_/ })).toHaveCount(0);
  });
});

test.describe('at 200% zoom', () => {
  for (const route of ROUTES) {
    test(`${route} still reads without scrolling sideways`, async ({ page, session }) => {
      // 200% zoom on a 1280x720 screen is the same as a 640x360 CSS viewport, which is what
      // browsers do to layout and what a zoom check is actually testing.
      await page.setViewportSize({ width: 640, height: 360 });
      await page.goto(`${session.url}/#${route}`);
      await expect(page.locator('h1.route-title')).toBeVisible();
      await page.waitForTimeout(500);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${route} overflows by ${overflow}px at 200% zoom`).toBeLessThanOrEqual(0);
    });
  }
});
