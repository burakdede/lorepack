import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'studio',
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    environment: 'jsdom',
    // Testing Library only unmounts between tests when globals are on. Without it, every
    // render stacks and queries start finding two of everything.
    globals: true,
    setupFiles: ['./test/setup.ts'],
    css: false,
  },
});
