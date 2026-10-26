import { defineConfig } from 'vitest/config';

// Workspace packages export a "@checkout-sentinel/source" condition that points at src/,
// so tests run against TypeScript sources without a build step.
const resolve = { conditions: ['@checkout-sentinel/source'] };

export default defineConfig({
  resolve,
  ssr: { resolve: { conditions: ['@checkout-sentinel/source'] } },
  test: {
    projects: [
      {
        resolve,
        ssr: { resolve: { conditions: ['@checkout-sentinel/source'] } },
        test: {
          name: 'unit',
          include: ['packages/*/test/unit/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
          // The dashboard's unit tests need Vue and a DOM; they are the "web" project below.
          exclude: ['apps/web/**'],
          environment: 'node',
        },
      },
      {
        resolve,
        ssr: { resolve: { conditions: ['@checkout-sentinel/source'] } },
        test: {
          name: 'integration',
          include: [
            'packages/*/test/integration/**/*.test.ts',
            'apps/*/test/integration/**/*.test.ts',
          ],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve,
        ssr: { resolve: { conditions: ['@checkout-sentinel/source'] } },
        test: {
          name: 'e2e',
          include: ['apps/*/test/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 90_000,
          hookTimeout: 90_000,
          fileParallelism: false,
        },
      },
      'apps/web/vitest.config.ts',
    ],
  },
});
