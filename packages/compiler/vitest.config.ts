import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'compiler', include: ['test/**/*.test.ts'] } });
