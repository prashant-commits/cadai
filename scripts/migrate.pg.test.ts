import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { runMigrateCli } from './migrate';
import { createPgDb } from '@/lib/db/pg';
import { freshPgDatabase } from '@/lib/db/test-pg';

describe('migrate CLI', () => {
  it('migrate.ts applies pending files once', async () => {
    const fresh = await freshPgDatabase();
    try {
      const logSpy = vi.fn();
      const applied = await runMigrateCli({ DATABASE_URL_MIGRATE: fresh.url }, logSpy);

      const migrationsDir = path.resolve(process.cwd(), 'db/migrations');
      const expectedFiles = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      expect(expectedFiles.length).toBeGreaterThan(0);
      expect(applied).toEqual(expectedFiles);

      for (const file of expectedFiles) {
        expect(logSpy).toHaveBeenCalledWith(`applied ${file}`);
      }

      const db = createPgDb(fresh.url);
      let rowCountBefore: number;
      try {
        const res = await db.query<{ name: string }>(
          'select name from schema_migrations order by name'
        );
        expect(res.rows.map((r) => r.name)).toEqual(expectedFiles);
        rowCountBefore = res.rowCount;
      } finally {
        await db.close();
      }

      const logSpy2 = vi.fn();
      const secondApplied = await runMigrateCli({ DATABASE_URL_MIGRATE: fresh.url }, logSpy2);
      expect(secondApplied).toEqual([]);
      expect(logSpy2).toHaveBeenCalledWith('no pending migrations');

      const checkDb = createPgDb(fresh.url);
      try {
        const res = await checkDb.query<{ name: string }>(
          'select name from schema_migrations order by name'
        );
        expect(res.rowCount).toBe(rowCountBefore);
        expect(res.rows.map((r) => r.name)).toEqual(expectedFiles);
      } finally {
        await checkDb.close();
      }
    } finally {
      await fresh.drop();
    }
  });

  it('migrate.ts fails without DATABASE_URL_MIGRATE', async () => {
    await expect(runMigrateCli({})).rejects.toThrow('DATABASE_URL_MIGRATE is not set.');
    await expect(runMigrateCli({ DATABASE_URL_MIGRATE: '' })).rejects.toThrow(
      'DATABASE_URL_MIGRATE is not set.'
    );
    await expect(runMigrateCli({ DATABASE_URL_MIGRATE: '   ' })).rejects.toThrow(
      'DATABASE_URL_MIGRATE is not set.'
    );
  });
});
