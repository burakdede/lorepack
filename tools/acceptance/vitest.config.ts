import { defineConfig } from 'vitest/config';

/**
 * The acceptance suite is deliberately not part of `pnpm test`.
 *
 * It spawns the real binary dozens of times, builds corpora of thousands of documents, and
 * waits on locks and signals, so it is measured in minutes rather than milliseconds. Mixed
 * into the unit run it would either be trimmed until it proved nothing, or make every
 * commit slow enough that people stop running the fast suite.
 *
 * Scenarios run one at a time. Several of them are about elapsed time (progress repeating,
 * a second command waiting for the lock), and those assertions are meaningless on a machine
 * running sixteen builds at once.
 */
export default defineConfig({
  test: {
    name: 'acceptance',
    include: ['test/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
  },
});
