import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'tools/*'],
    coverage: { provider: 'v8', reporter: ['text', 'json'], reportsDirectory: 'coverage' },
  },
});
