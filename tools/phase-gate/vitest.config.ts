import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'phase-gate', include: ['test/**/*.test.ts'] } });
