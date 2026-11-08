import fs from 'fs';
import { PGlite } from '@electric-sql/pglite';
import { pgliteParsers } from './map';
import { acquireLock } from './lockfile';
import { migrate, type InternalScriptDb, type ScriptQueryable } from './migrate';
import {
  assertNotInTransaction,
  runInTxGuard,
  withTxRetry,
  type Db,
  type Queryable,
  type QueryResult,
  type Row,
} from './db';

export const PGLITE_PROD_ERROR =
  'PGlite is not permitted in production without CADAI_DB_SINGLE_PROCESS=1';

const activeCloses = new Set<() => Promise<void>>();
let sigRegistered = false;

function registerSigHandler(closeFn: () => Promise<void>) {
  activeCloses.add(closeFn);
  if (!sigRegistered) {
    sigRegistered = true;
    const onSignal = async () => {
      for (const close of Array.from(activeCloses)) {
        try {
          await close();
        } catch {
          // ignore
        }
      }
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
}

export function createPgliteDb(dir: string): Db {
  if (process.env.NODE_ENV === 'production' && process.env.CADAI_DB_SINGLE_PROCESS !== '1') {
    throw new Error(PGLITE_PROD_ERROR);
  }

  let pgliteInstance: PGlite | null = null;
  let initPromise: Promise<PGlite> | null = null;
  let releaseLock: (() => void) | null = null;
  let closed = false;

  const closeFn = async (): Promise<void> => {
    activeCloses.delete(closeFn);
    closed = true;
    if (pgliteInstance) {
      const p = pgliteInstance;
      pgliteInstance = null;
      await p.close();
    }
    if (releaseLock) {
      const r = releaseLock;
      releaseLock = null;
      r();
    }
    initPromise = null;
  };

  function runScriptOnInstance<T>(
    inst: PGlite,
    fn: (sq: ScriptQueryable) => Promise<T>
  ): Promise<T> {
    return withTxRetry(async () => {
      return runInTxGuard(async () => {
        return await inst.transaction(async (tx) => {
          const sq: ScriptQueryable = {
            async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
              const res = await tx.query(sql, params as Parameters<typeof tx.query>[1]);
              return {
                rows: res.rows as R[],
                rowCount: res.rowCount ?? res.rows.length,
              };
            },
            async exec(sql: string): Promise<void> {
              await tx.exec(sql);
            },
          };
          return await fn(sq);
        });
      });
    });
  }

  async function init(): Promise<PGlite> {
    if (closed) throw new Error('Database is closed');
    if (dir !== 'memory://') {
      fs.mkdirSync(dir, { recursive: true });
      releaseLock = acquireLock(dir);
      registerSigHandler(closeFn);
    }
    const inst = new PGlite(dir, { parsers: pgliteParsers });
    await inst.waitReady;

    const initDb: InternalScriptDb = {
      ...db,
      transactionScript: (fn) => runScriptOnInstance(inst, fn),
    };
    await migrate(initDb);

    pgliteInstance = inst;
    return inst;
  }

  async function getReadyPglite(): Promise<PGlite> {
    if (closed) throw new Error('Database is closed');
    if (pgliteInstance) return pgliteInstance;
    if (!initPromise) {
      initPromise = init();
    }
    return await initPromise;
  }

  const db: InternalScriptDb = {
    kind: 'pglite',

    async query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      assertNotInTransaction();
      const pglite = await getReadyPglite();
      const res = await pglite.query(sql, params as Parameters<typeof pglite.query>[1]);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length,
      };
    },

    async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const pglite = await getReadyPglite();
      return withTxRetry(async () => {
        return runInTxGuard(async () => {
          return await pglite.transaction(async (tx) => {
            const q: Queryable = {
              async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
                const res = await tx.query(sql, params as Parameters<typeof tx.query>[1]);
                return {
                  rows: res.rows as R[],
                  rowCount: res.rowCount ?? res.rows.length,
                };
              },
            };
            return await fn(q);
          });
        });
      });
    },

    async transactionScript<T>(fn: (sq: ScriptQueryable) => Promise<T>): Promise<T> {
      const pglite = await getReadyPglite();
      return runScriptOnInstance(pglite, fn);
    },

    close: closeFn,
  };

  return db;
}
