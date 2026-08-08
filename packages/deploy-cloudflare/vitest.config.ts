import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'deploy-cloudflare', include: ['test/**/*.test.ts'] },
});
