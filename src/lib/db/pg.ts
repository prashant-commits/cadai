import pg from 'pg';
import { createPgTypes } from './map';
import type { InternalScriptDb, ScriptQueryable } from './migrate';
import {
  assertNotInTransaction,
  runInTxGuard,
  withTxRetry,
  type Db,
  type Queryable,
  type QueryResult,
  type Row,
} from './db';

export interface CreatePgDbOptions {
  max?: number;
}

export function createPgDb(
  url: string,
  opts?: CreatePgDbOptions
): Db & { pool: pg.Pool } {
  const maxPool =
    opts?.max ??
    (process.env.PG_POOL_MAX && !Number.isNaN(Number(process.env.PG_POOL_MAX))
      ? Number(process.env.PG_POOL_MAX)
      : 10);

  const pool = new pg.Pool({
    connectionString: url,
    max: maxPool,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
    lock_timeout: 15000,
    types: createPgTypes(),
  });

  const db: Db & { pool: pg.Pool } & InternalScriptDb = {
    kind: 'pg',
    pool,

    async query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      assertNotInTransaction();
      const res = await pool.query(sql, params);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length,
      };
    },

    async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      return withTxRetry(async () => {
        return runInTxGuard(async () => {
          const client = await pool.connect();
          let releaseErr: Error | undefined;
          try {
            await client.query('BEGIN');
            const q: Queryable = {
              async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
                const res = await client.query(sql, params);
                return {
                  rows: res.rows as R[],
                  rowCount: res.rowCount ?? res.rows.length,
                };
              },
            };
            const result = await fn(q);
            await client.query('COMMIT');
            return result;
          } catch (err) {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackErr) {
              releaseErr = rollbackErr as Error;
            }
            throw err;
          } finally {
            client.release(releaseErr);
          }
        });
      });
    },

    async transactionScript<T>(fn: (sq: ScriptQueryable) => Promise<T>): Promise<T> {
      return withTxRetry(async () => {
        return runInTxGuard(async () => {
          const client = await pool.connect();
          let releaseErr: Error | undefined;
          try {
            await client.query('BEGIN');
            const sq: ScriptQueryable = {
              async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
                const res = await client.query(sql, params);
                return {
                  rows: res.rows as R[],
                  rowCount: res.rowCount ?? res.rows.length,
                };
              },
              async exec(sql: string): Promise<void> {
                await client.query(sql);
              },
            };
            const result = await fn(sq);
            await client.query('COMMIT');
            return result;
          } catch (err) {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackErr) {
              releaseErr = rollbackErr as Error;
            }
            throw err;
          } finally {
            client.release(releaseErr);
          }
        });
      });
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };

  return db;
}
