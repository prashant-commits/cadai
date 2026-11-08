import { defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';

const repo = path.resolve(__dirname);
const vitestTmp = path.join(repo, '.cadai/scratch/vitest');
fs.mkdirSync(vitestTmp, { recursive: true });

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Several suites drive the real build123d geometry runner rather than a mock.
    // Under parallel workers they contend for CPU and can blow past vitest's 5s
    // default, producing timeouts that look like product bugs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [
            '**/*.pg.test.ts',
            '**/node_modules/**',
            '**/dist/**',
            '**/.{idea,git,cache,output,temp}/**',
          ],
          env: {
            CADAI_DB: 'pglite',
            TMPDIR: vitestTmp,
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'pg',
          include: ['**/*.pg.test.ts'],
          exclude: ['**/node_modules/**'],
          globalSetup: ['./vitest.pg-setup.ts'],
          fileParallelism: false,
          env: {
            CADAI_DB: 'postgres',
            TMPDIR: vitestTmp,
          },
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
