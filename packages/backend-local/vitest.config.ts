import { defineConfig } from 'vitest/config';

/**
 * Real SQLite and a real filesystem, so these are integration tests wearing a unit test's
 * clothes. Vitest's 5 s default is sized for pure logic, and the Phase 0 exit criterion,
 * which drives a whole lifecycle, exceeded it on a loaded Windows runner while taking under
 * a second locally.
 *
 * The timeout is raised rather than the test trimmed: what makes it evidence is that it
 * uses the real storage layer, and a suite that only passes on the fastest platform is not
 * evidence at all.
 */
export default defineConfig({
  test: {
    name: 'backend-local',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
