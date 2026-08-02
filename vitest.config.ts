import { defineConfig } from 'vitest/config';

/**
 * The default run is the fast one.
 *
 * `tools/acceptance` is absent on purpose: it spawns the binary dozens of times and builds
 * corpora of thousands of documents, so it belongs to `pnpm acceptance` and its own CI job.
 * Folding it in would make every commit slow enough that people stop running the fast
 * suite, which costs more than it buys.
 *
 * The list is explicit rather than `tools/*` so that adding a slow suite to the default run
 * is a decision visible in a diff, not a side effect of creating a directory.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'tools/arch',
      'tools/contract',
      'tools/phase-gate',
      'tools/test-support',
    ],
    coverage: { provider: 'v8', reporter: ['text', 'json'], reportsDirectory: 'coverage' },
  },
});
