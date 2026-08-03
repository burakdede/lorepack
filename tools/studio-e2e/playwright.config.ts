import { defineConfig, devices } from '@playwright/test';

/**
 * Studio in a real browser, against a real `lore dev`.
 *
 * A separate suite from the unit run, for the reason the acceptance suite is separate: it
 * builds a project, spawns a server and drives a browser, so it is minutes rather than
 * seconds, and when it fails the useful question is "which flow" rather than "which test".
 *
 * Chromium only, deliberately. This suite exists to prove that the assembled application
 * works against the real API, that every route is operable by keyboard, and that the page
 * reads at the documented viewport. None of those are questions about browser engines, and a
 * three-engine matrix would triple the runtime to answer a question nobody asked.
 */
export default defineConfig({
  testDir: './test',
  // The fixture builds a project and starts a server per worker, so each file gets its own.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    // The viewport section 15.6 names. Everything here must read at this size without a
    // horizontal scrollbar, which is asserted rather than assumed.
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
