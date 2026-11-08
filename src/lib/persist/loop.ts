import { type Db } from '@/lib/db/db';
import { getDb } from '@/lib/db/db';
import { type ObjectStore, getObjectStore } from '@/lib/storage/object-store';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { sweep } from './sweep';

export interface ReaperHandle {
  reapTimer?: NodeJS.Timeout;
  sweepTimer?: NodeJS.Timeout;
}

declare global {
  var __cadaiReaper: ReaperHandle | undefined;
  var __cadaiReaperPromise: Promise<ReaperHandle> | undefined;
  var __cadaiProcessStartedAt: number | undefined;
  var __cadaiBootSweepCount: number | undefined;
}

export async function bootSweep(
  db: Db,
  processStartedAt: number
): Promise<string[]> {
  globalThis.__cadaiBootSweepCount = (globalThis.__cadaiBootSweepCount ?? 0) + 1;
  const res = await db.query<{ id: string }>(
    `SELECT id FROM runs
     WHERE status = 'running'
       AND created_at < $1::timestamptz`,
    [new Date(processStartedAt).toISOString()]
  );
  const endedIds: string[] = [];
  for (const row of res.rows) {
    const id = String(row.id);
    try {
      const termRes = await db.transaction(async (q) => {
        return DbRunStore.terminate(q, id, 'failed', 'run_lost');
      });
      if (termRes.ended) {
        endedIds.push(id);
      }
    } catch (err) {
      console.error(`bootSweep failed to terminate run ${id}:`, err);
    }
  }
  return endedIds;
}

export async function reapOnce(db: Db): Promise<string[]> {
  const staleIds = await DbRunStore.listStale(db);
  const reapedIds: string[] = [];
  for (const id of staleIds) {
    try {
      const reaped = await db.transaction(async (q) => {
        return DbRunStore.reap(q, id);
      });
      if (reaped) {
        reapedIds.push(id);
      }
    } catch (err) {
      console.error(`reapOnce failed for run ${id}:`, err);
    }
  }
  return reapedIds;
}

export async function sweepOnce(
  db: Db,
  store: ObjectStore,
  now = Date.now()
): Promise<void> {
  await db.transaction(async (q) => {
    await sweep(q, now);
  });

  const pending = await db.query<{ object_key: string }>(
    `SELECT object_key FROM pending_deletes`
  );

  for (const row of pending.rows) {
    const key = String(row.object_key);
    try {
      await store.delete(key);
      await db.query(`DELETE FROM pending_deletes WHERE object_key = $1`, [key]);
    } catch (err) {
      console.error(`sweepOnce failed to delete object ${key}:`, err);
    }
  }
}

export function shouldStartLoop(
  env: Record<string, string | undefined> = process.env
): boolean {
  if (env.NEXT_PHASE === 'phase-production-build') {
    return false;
  }
  if (env.VITEST !== undefined && env.VITEST !== '') {
    return false;
  }
  if (env.CADAI_EVAL_RUNNER === '1' && env.CADAI_EVAL_REAPER !== '1') {
    return false;
  }
  return true;
}

export async function startLoop(opts?: {
  db?: Db;
  store?: ObjectStore;
  processStartedAt?: number;
}): Promise<ReaperHandle> {
  if (globalThis.__cadaiReaper) {
    return globalThis.__cadaiReaper;
  }
  if (globalThis.__cadaiReaperPromise) {
    return globalThis.__cadaiReaperPromise;
  }

  const promise = (async () => {
    const db = opts?.db ?? getDb();
    const store = opts?.store ?? getObjectStore();
    const processStartedAt =
      opts?.processStartedAt ??
      (typeof globalThis.__cadaiProcessStartedAt === 'number'
        ? globalThis.__cadaiProcessStartedAt
        : (process.env.CADAI_PROCESS_STARTED_AT
            ? Number(process.env.CADAI_PROCESS_STARTED_AT)
            : Math.floor(performance.timeOrigin || Date.now())));

    const isPglite = (process.env.CADAI_DB ?? 'pglite') === 'pglite';
    if (isPglite) {
      await loop.bootSweep(db, processStartedAt);
    }

    const reapTimer = setInterval(() => {
      loop.reapOnce(db).catch((err) => {
        console.error('reapOnce error:', err);
      });
    }, 60_000);
    reapTimer.unref();

    const sweepTimer = setInterval(() => {
      loop.sweepOnce(db, store).catch((err) => {
        console.error('sweepOnce error:', err);
      });
    }, 10 * 60_000);
    sweepTimer.unref();

    const handle: ReaperHandle = {
      reapTimer,
      sweepTimer,
    };
    globalThis.__cadaiReaper = handle;
    globalThis.__cadaiReaperPromise = undefined;
    return handle;
  })();

  globalThis.__cadaiReaperPromise = promise;
  try {
    return await promise;
  } catch (err) {
    globalThis.__cadaiReaperPromise = undefined;
    throw err;
  }
}

export function stopLoop(): void {
  if (globalThis.__cadaiReaper) {
    if (globalThis.__cadaiReaper.reapTimer) {
      clearInterval(globalThis.__cadaiReaper.reapTimer);
    }
    if (globalThis.__cadaiReaper.sweepTimer) {
      clearInterval(globalThis.__cadaiReaper.sweepTimer);
    }
    globalThis.__cadaiReaper = undefined;
  }
  globalThis.__cadaiReaperPromise = undefined;
}

export const loop = {
  bootSweep,
  reapOnce,
  sweepOnce,
  shouldStartLoop,
  startLoop,
  stopLoop,
};
