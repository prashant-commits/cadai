import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPgDb } from './pg';
import { createPgliteDb } from './pglite';
import { migrate } from './migrate';
import { pgTestUrl, freshPgDatabase } from './test-pg';
import type { Db } from './db';
import type { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

/** Every migration file, in order; the test asserts all of them apply exactly once. */
const ALL_MIGRATIONS = fs
  .readdirSync(path.resolve(process.cwd(), 'db/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('Db (Postgres)', () => {
  let db: Db & { pool: Pool };

  beforeAll(async () => {
    db = createPgDb(pgTestUrl());
    await migrate(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('pool timeouts are set', async () => {
    const client = await db.pool.connect();
    try {
      const res1 = await client.query('show statement_timeout');
      const res2 = await client.query('show idle_in_transaction_session_timeout');
      const res3 = await client.query('show lock_timeout');

      expect(res1.rows[0].statement_timeout).toBe('15s');
      expect(res2.rows[0].idle_in_transaction_session_timeout).toBe('15s');
      expect(res3.rows[0].lock_timeout).toBe('15s');
    } finally {
      client.release();
    }

    expect(db.pool.options.connectionTimeoutMillis).toBe(5000);
    expect(db.pool.options.max).toBe(10);
  });

  it('numeric/int8/timestamptz map the same as on PGlite', async () => {
    const pgliteDb = createPgliteDb('memory://');
    const sql = `select 1.5::numeric(10,4) n, 9007199254740991::int8 i, '2026-01-01T00:00:00Z'::timestamptz t, null::numeric as null_n`;

    const pgliteRes = await pgliteDb.query(sql);
    const pgRes = await db.query(sql);

    expect(pgRes.rows[0]).toEqual(pgliteRes.rows[0]);
    expect(pgRes.rows[0]).toEqual({
      n: 1.5,
      i: 9007199254740991,
      t: Date.UTC(2026, 0, 1),
      null_n: null,
    });

    await pgliteDb.close();
  });

  it('migrate twice concurrently', async () => {
    const fresh = await freshPgDatabase();
    const db1 = createPgDb(fresh.url);
    const db2 = createPgDb(fresh.url);
    try {
      const [res1, res2] = await Promise.all([migrate(db1), migrate(db2)]);

      const appliedCounts = [res1.length, res2.length].sort();
      expect(ALL_MIGRATIONS.slice(0, 4)).toEqual([
        '0001_init.sql',
        '0002_u1.sql',
        '0003_projects.sql',
        '0004_topology.sql',
      ]);
      const n = ALL_MIGRATIONS.length;
      expect(appliedCounts).toEqual([0, n]);

      const winningRes = res1.length === n ? res1 : res2;
      const losingRes = res1.length === 0 ? res1 : res2;
      expect(winningRes).toEqual(ALL_MIGRATIONS);
      expect(losingRes).toEqual([]);

      const migrations = await db1.query('select name from schema_migrations');
      expect(migrations.rows.length).toBe(n);
      expect(migrations.rows.map((r) => (r as { name: string }).name).sort()).toEqual(ALL_MIGRATIONS);
    } finally {
      await Promise.allSettled([db1.close(), db2.close()]);
      await fresh.drop();
    }
  });

  it('db.query inside a transaction throws on pg too', async () => {
    await db.transaction(async (q) => {
      const qRes = await q.query('SELECT 1 as val');
      expect(qRes.rows[0]).toEqual({ val: 1 });

      await expect(db.query('SELECT 1')).rejects.toThrow('db.query inside a transaction');
    });
  });

  it('migration 0002 applies', async () => {
    const stepsCheck = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'messages' AND column_name = 'steps'`
    );
    expect(stepsCheck.rows).toHaveLength(1);
    expect(stepsCheck.rows[0].column_name).toBe('steps');

    const kindCheck = await db.query(
      `SELECT column_name, data_type, column_default FROM information_schema.columns
       WHERE table_name = 'message_attachments' AND column_name = 'kind'`
    );
    expect(kindCheck.rows).toHaveLength(1);
    expect(kindCheck.rows[0].column_name).toBe('kind');
  });
});
