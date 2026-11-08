import type { Queryable } from '@/lib/db/db';
import { rowToArtifact, type ArtifactRow } from './types';

export const ArtifactRows = {
  async insert(
    q: Queryable,
    row: Omit<ArtifactRow, 'createdAt'>
  ): Promise<void> {
    await q.query(
      `INSERT INTO artifacts(id, owner_key, thread_id, run_id, kind, bytes, object_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.ownerKey,
        row.threadId,
        row.runId,
        row.kind,
        row.bytes,
        row.objectKey,
      ]
    );
  },

  async get(
    q: Queryable,
    ownerKey: string,
    id: string
  ): Promise<ArtifactRow | null> {
    const res = await q.query(
      `SELECT id, owner_key, thread_id, run_id, kind, bytes, object_key, created_at
       FROM artifacts
       WHERE id = $1 AND owner_key = $2`,
      [id, ownerKey]
    );
    if (res.rows.length === 0) return null;
    return rowToArtifact(res.rows[0]);
  },
};
