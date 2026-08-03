import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Studio is built into the CLI package and served by the same Hono app on the same port
 * (architecture 15.1, 15.3). One process, one port, no CDN, no external request at runtime.
 */
export default defineConfig({
  plugins: [react()],
  // Relative, because the assets are served from the dev server root and must not assume a
  // deployment path.
  base: './',
  build: {
    outDir: '../../packages/cli/studio-dist',
    emptyOutDir: true,
    // The bundle has a budget, asserted in CI. Studio is an inspector, not an application.
    chunkSizeWarningLimit: 400,
    // Fonts are inlined only if tiny; these are not, so they stay as separate cacheable
    // files served from the same origin.
    assetsInlineLimit: 2048,
  },
  server: {
    // `pnpm --filter @lorepack/studio dev` proxies to a running `lore dev`, so the app can be
    // developed with hot reload against a real server rather than mocks.
    proxy: {
      '/v1': 'http://127.0.0.1:43110',
      '/health': 'http://127.0.0.1:43110',
    },
  },
});
