import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb } from './db';
import { createPgliteDb } from './pglite';
import { migrate } from './migrate';

describe('Db (PGlite)', () => {
  beforeEach(async () => {
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it('db.query inside a transaction throws; a timer started inside it does not', async () => {
    const db = getDb();
    let timerRan = false;
    let timerPromiseResolve: () => void;
    const timerPromise = new Promise<void>((resolve) => {
      timerPromiseResolve = resolve;
    });

    await db.transaction(async (q) => {
      const qRes = await q.query('SELECT 1 as val');
      expect(qRes.rows[0]).toEqual({ val: 1 });

      await expect(db.query('SELECT 1')).rejects.toThrow('db.query inside a transaction');

      setTimeout(async () => {
        try {
          const res = await db.query('SELECT 2 as val');
          expect(res.rows[0]).toEqual({ val: 2 });
          timerRan = true;
          timerPromiseResolve();
        } catch (err) {
          timerPromiseResolve();
          throw err;
        }
      }, 0);
    });

    await timerPromise;
    expect(timerRan).toBe(true);
  });

  it('transaction retries 40P01 up to 3 times', async () => {
    const db = getDb();

    // 1) Throws 40P01 twice then succeeds -> fn called 3 times, result returned
    let calls1 = 0;
    const res = await db.transaction(async () => {
      calls1++;
      if (calls1 < 3) {
        const err = new Error('deadlock detected') as Error & { code: string };
        err.code = '40P01';
        throw err;
      }
      return 'success';
    });
    expect(res).toBe('success');
    expect(calls1).toBe(3);

    // 2) Throwing 40P01 every time -> rejects after 3 attempts
    let calls2 = 0;
    await expect(
      db.transaction(async () => {
        calls2++;
        const err = new Error('deadlock detected') as Error & { code: string };
        err.code = '40P01';
        throw err;
      })
    ).rejects.toThrow('deadlock detected');
    expect(calls2).toBe(3);

    // 3) Another error code -> not retried
    let calls3 = 0;
    await expect(
      db.transaction(async () => {
        calls3++;
        const err = new Error('other error') as Error & { code: string };
        err.code = '23505';
        throw err;
      })
    ).rejects.toThrow('other error');
    expect(calls3).toBe(1);
  });

  it('transaction rolls back on throw', async () => {
    const db = getDb();
    await db.query('create table if not exists test_rollback (id int primary key)');
    await db.query('delete from test_rollback');

    await expect(
      db.transaction(async (q) => {
        await q.query('insert into test_rollback values (1)');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const res = await db.query('select * from test_rollback where id = 1');
    expect(res.rows).toEqual([]);
  });

  it('numeric/int8/timestamptz map to numbers', async () => {
    const db = getDb();
    const res = await db.query(
      `select 1.5::numeric(10,4) n, 9007199254740991::int8 i, '2026-01-01T00:00:00Z'::timestamptz t, null::numeric as null_n`
    );
    expect(res.rows[0]).toEqual({
      n: 1.5,
      i: 9007199254740991,
      t: Date.UTC(2026, 0, 1),
      null_n: null,
    });
  });

  it('migrate applies 0001 once', async () => {
    const db = getDb();
    const tables = [
      'threads',
      'runs',
      'run_events',
      'artifacts',
      'messages',
      'message_attachments',
      'designs',
      'pending_deletes',
      'schema_migrations',
    ];

    for (const t of tables) {
      const check = await db.query(
        `select table_name from information_schema.tables where table_name = $1`,
        [t]
      );
      expect(check.rows.length, `table ${t} should exist`).toBe(1);
    }

    const second = await migrate(db);
    expect(second).toEqual([]);
  });

  it('migration 0002 applies', async () => {
    const db = getDb();
    // Verify columns from 0002_u1.sql
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

  it('getDb uses memory under VITEST and is cached', async () => {
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
    expect(db1.kind).toBe('pglite');

    await closeDb();
    const db3 = getDb();
    expect(db3).not.toBe(db1);
  });

  it('concurrent first queries wait for migrations', async () => {
    const db = createPgliteDb('memory://');
    try {
      const [res1, res2] = await Promise.all([
        db.query('select count(*) from threads'),
        db.query('select count(*) from runs'),
      ]);
      expect(res1.rows[0]).toBeDefined();
      expect(res2.rows[0]).toBeDefined();
    } finally {
      await db.close();
    }
  });

  it('the transaction guard works across two copies of the db module', async () => {
    vi.resetModules();
    const A = await import('@/lib/db/db');
    vi.resetModules();
    const B = await import('@/lib/db/db');
    expect(A).not.toBe(B);

    expect(() => B.requireTransaction()).toThrow('store method requires a transaction');

    await A.getDb().transaction(async () => {
      expect(() => B.requireTransaction()).not.toThrow();
      expect(() => B.assertNotInTransaction()).toThrow('db.query inside a transaction');
    });
  });
});
