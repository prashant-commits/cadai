import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import { assertRunDirWritable, runStoreDir } from '@/lib/runs/config';
import { createPgliteDb } from './pglite';
import { createPgDb } from './pg';

export type Row = Record<string, unknown>;

export interface QueryResult<T = Row> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  readonly kind: 'pglite' | 'pg';
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface TxStore {
  open: boolean;
}

declare global {
  var __cadaiDb: Db | undefined;
  var __cadaiTxStorage: AsyncLocalStorage<TxStore> | undefined;
}

const txStorage: AsyncLocalStorage<TxStore> =
  (globalThis.__cadaiTxStorage ??= new AsyncLocalStorage<TxStore>());

export function assertNotInTransaction(): void {
  const store = txStorage.getStore();
  if (store && store.open) {
    throw new Error('db.query inside a transaction');
  }
}

export function requireTransaction(): void {
  const store = txStorage.getStore();
  if (!store || !store.open) {
    throw new Error('store method requires a transaction');
  }
}

export async function runInTxGuard<T>(fn: () => Promise<T>): Promise<T> {
  const store: TxStore = { open: true };
  return txStorage.run(store, async () => {
    try {
      return await fn();
    } finally {
      store.open = false;
    }
  });
}

export async function withTxRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '40P01' && attempt < MAX_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

export function getDb(): Db {
  if (globalThis.__cadaiDb) {
    return globalThis.__cadaiDb;
  }

  const rawKind = (process.env.CADAI_DB ?? 'pglite').trim().toLowerCase();
  if (rawKind !== 'pglite' && rawKind !== 'postgres') {
    throw new Error(`Unsupported CADAI_DB "${rawKind}". Expected "pglite" or "postgres".`);
  }

  let db: Db;
  if (rawKind === 'postgres') {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) {
      throw new Error('DATABASE_URL is required when CADAI_DB is "postgres".');
    }
    db = createPgDb(url);
  } else {
    let pgliteDir: string;
    const customDir = process.env.CADAI_PGLITE_DIR?.trim();
    if (customDir) {
      pgliteDir = customDir;
    } else if (process.env.VITEST) {
      pgliteDir = 'memory://';
    } else {
      assertRunDirWritable();
      pgliteDir = path.join(runStoreDir(), 'pglite');
    }
    db = createPgliteDb(pgliteDir);
  }

  globalThis.__cadaiDb = db;
  return db;
}

export async function closeDb(): Promise<void> {
  const db = globalThis.__cadaiDb;
  globalThis.__cadaiDb = undefined;
  if (db) {
    await db.close();
  }
}
