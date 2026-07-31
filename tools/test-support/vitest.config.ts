import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'test-support', include: ['test/**/*.test.ts'] } });
