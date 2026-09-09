import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'deploy-cloudflare',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { groupOrder: 3 },
  },
});
