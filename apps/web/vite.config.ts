import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig } from 'vite';

/** Where `pnpm --filter @checkout-sentinel/web dev` sends /api requests. */
const apiTarget = process.env.CHECKOUT_SENTINEL_API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // Bundle @checkout-sentinel/core from its TypeScript source, so the dashboard builds (and its
    // e2e test runs) without building the other packages first.
    conditions: ['@checkout-sentinel/source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The API serves the build under a strict CSP (no inline scripts or styles).
    assetsInlineLimit: 0,
  },
});
