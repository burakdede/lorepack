import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'contract', include: ['test/**/*.test.ts'] } });
