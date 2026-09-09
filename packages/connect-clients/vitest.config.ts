import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'connect-clients',
    include: ['test/**/*.test.ts'],
    // Verification spawns the real binary, which costs seconds rather than milliseconds.
    testTimeout: 120_000,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { groupOrder: 2 },
  },
});
