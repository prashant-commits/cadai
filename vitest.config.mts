import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Several suites drive the real OpenSCAD wasm compiler rather than a mock.
    // A single compile is fast, but a dozen of them running across parallel
    // workers contend for CPU and routinely blow past vitest's 5s default -
    // producing timeouts that look like product bugs and pass on a re-run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
