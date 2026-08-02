import { defineConfig } from 'vitest/config';

/**
 * 120 seconds, not the 5 second default. These tests spawn the built binary, which builds
 * a project before it answers anything, and process spawn on Windows costs several times
 * what it does on Linux. A suite that passes locally and times out on the platform the
 * guarantee is for is worse than no suite (learned in Phase 1).
 */
export default defineConfig({
  test: { name: 'contract', include: ['test/**/*.test.ts'], testTimeout: 120_000 },
});
