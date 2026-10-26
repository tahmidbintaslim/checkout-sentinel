import vue from '@vitejs/plugin-vue';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  resolve: { conditions: ['@checkout-sentinel/source', ...defaultClientConditions] },
  test: {
    name: 'web',
    include: ['test/unit/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['test/unit/setup.ts'],
  },
});
