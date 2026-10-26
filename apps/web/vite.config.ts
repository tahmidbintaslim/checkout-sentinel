import { cp, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

/** Where `pnpm --filter @checkout-sentinel/web dev` sends /api requests. */
const apiTarget = process.env.CHECKOUT_SENTINEL_API_URL ?? 'http://127.0.0.1:3000';
const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * The read-only demo (vite build --mode demo; the app checks import.meta.env.MODE) ships the sample
 * data from demo/data/ next to the app, and a 404.html copy of the app so static hosts that
 * serve it for unknown paths (GitHub Pages) open deep links such as /runs/<id>.
 */
function demoData(outDir: string): Plugin {
  return {
    name: 'checkout-sentinel-demo-data',
    apply: 'build',
    async closeBundle() {
      await cp(path.join(root, 'demo/data'), path.join(outDir, 'demo-data'), { recursive: true });
      await copyFile(path.join(outDir, 'index.html'), path.join(outDir, '404.html'));
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  const outDir = path.join(root, demo ? 'dist-demo' : 'dist');
  return {
    plugins: [vue(), ...(demo ? [demoData(outDir)] : [])],
    resolve: {
      // Bundle @checkout-sentinel/core from its TypeScript source, so the dashboard builds (and
      // its e2e test runs) without building the other packages first.
      conditions: ['@checkout-sentinel/source', ...defaultClientConditions],
    },
    server: {
      port: 5173,
      proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    },
    build: {
      outDir,
      emptyOutDir: true,
      // The API serves the build under a strict CSP (no inline scripts or styles).
      assetsInlineLimit: 0,
    },
  };
});
