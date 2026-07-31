import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'backend-local', include: ['test/**/*.test.ts'] } });
