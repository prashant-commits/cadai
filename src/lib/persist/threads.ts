import { requireTransaction, type Queryable } from '@/lib/db/db';
import { rowToThread, type ThreadRow } from './types';
import { DbRunStore } from '@/lib/runs/db-run-store';

export interface ThreadListOptions {
  limit?: number;
  before?: { updatedAt: number; id: string };
}

export const ThreadStore = {
  async get(
    q: Queryable,
    ownerKey: string,
    threadId: string
  ): Promise<ThreadRow | null> {
    const res = await q.query(
      `SELECT id, owner_key, title, active_run_id, created_at, updated_at, archived_at
       FROM threads
       WHERE id = $1 AND owner_key = $2 AND archived_at IS NULL`,
      [threadId, ownerKey]
    );
    if (res.rows.length === 0) return null;
    return rowToThread(res.rows[0]);
  },

  async list(
    q: Queryable,
    ownerKey: string,
    opts?: ThreadListOptions
  ): Promise<ThreadRow[]> {
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
    if (opts?.before !== undefined) {
      const res = await q.query(
        `SELECT id, owner_key, title, active_run_id, created_at, updated_at, archived_at
         FROM threads
         WHERE owner_key = $1 AND archived_at IS NULL AND (updated_at, id) < ($2::timestamptz, $3)
         ORDER BY updated_at DESC, id DESC
         LIMIT $4`,
        [ownerKey, new Date(opts.before.updatedAt).toISOString(), opts.before.id, limit]
      );
      return res.rows.map(rowToThread);
    }

    const res = await q.query(
      `SELECT id, owner_key, title, active_run_id, created_at, updated_at, archived_at
       FROM threads
       WHERE owner_key = $1 AND archived_at IS NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT $2`,
      [ownerKey, limit]
    );
    return res.rows.map(rowToThread);
  },

  async rename(
    q: Queryable,
    ownerKey: string,
    threadId: string,
    title: string
  ): Promise<boolean> {
    const trimmed = title.trim();
    const cleanTitle = trimmed.length === 0 ? null : trimmed.slice(0, 120);

    const res = await q.query(
      `UPDATE threads
       SET title = $1, updated_at = now()
       WHERE id = $2 AND owner_key = $3 AND archived_at IS NULL`,
      [cleanTitle, threadId, ownerKey]
    );
    return res.rowCount > 0;
  },

  async archive(
    q: Queryable,
    ownerKey: string,
    threadId: string
  ): Promise<boolean> {
    requireTransaction();

    const res = await q.query(
      `SELECT owner_key, archived_at, active_run_id
       FROM threads
       WHERE id = $1 FOR UPDATE`,
      [threadId]
    );
    if (res.rows.length === 0) return false;
    const row = res.rows[0];
    if (row.owner_key !== ownerKey || row.archived_at !== null) {
      return false;
    }

    if (row.active_run_id) {
      const activeRunId = String(row.active_run_id);
      const runRes = await q.query(
        `SELECT status FROM runs WHERE id = $1`,
        [activeRunId]
      );
      if (runRes.rows.length > 0 && runRes.rows[0].status === 'running') {
        await DbRunStore.terminate(q, activeRunId, 'cancelled', 'cancelled');
      }
    }

    await q.query(
      `UPDATE threads
       SET archived_at = now(), updated_at = now()
       WHERE id = $1`,
      [threadId]
    );
    return true;
  },
};
