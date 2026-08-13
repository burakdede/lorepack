import { defineConfig } from 'vitest/config';

/**
 * The consolidated security suite is separate from the fast default test run so CI can
 * report it as one explicit gate and its output names each security class.
 */
export default defineConfig({
  test: {
    name: 'security',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
