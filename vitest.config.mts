import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Several suites drive the real build123d geometry runner rather than a mock.
    // Under parallel workers they contend for CPU and can blow past vitest's 5s
    // default, producing timeouts that look like product bugs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
