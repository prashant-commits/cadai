import type { Queryable } from '@/lib/db/db';
import { rowToDesign, type DesignRow } from './types';

const SELECT_DESIGN_FIELDS = `
  d.thread_id, d.version, d.parent_version, d.origin, d.run_id,
  d.base_request, d.edits, d.body, d.prelude_version, d.summary,
  d.facts, d.flags, d.stl_artifact, d.step_artifact, d.created_at
`;

export const DesignStore = {
  async get(
    q: Queryable,
    ownerKey: string,
    threadId: string,
    version: number
  ): Promise<DesignRow | null> {
    const res = await q.query(
      `SELECT ${SELECT_DESIGN_FIELDS}
       FROM designs d
       JOIN threads t ON d.thread_id = t.id
       WHERE t.id = $1 AND t.owner_key = $2 AND t.archived_at IS NULL AND d.version = $3`,
      [threadId, ownerKey, version]
    );
    if (res.rows.length === 0) return null;
    return rowToDesign(res.rows[0]);
  },

  async latest(
    q: Queryable,
    ownerKey: string,
    threadId: string
  ): Promise<DesignRow | null> {
    const res = await q.query(
      `SELECT ${SELECT_DESIGN_FIELDS}
       FROM designs d
       JOIN threads t ON d.thread_id = t.id
       WHERE t.id = $1 AND t.owner_key = $2 AND t.archived_at IS NULL
       ORDER BY d.version DESC
       LIMIT 1`,
      [threadId, ownerKey]
    );
    if (res.rows.length === 0) return null;
    return rowToDesign(res.rows[0]);
  },

  async list(
    q: Queryable,
    ownerKey: string,
    threadId: string
  ): Promise<DesignRow[]> {
    const res = await q.query(
      `SELECT ${SELECT_DESIGN_FIELDS}
       FROM designs d
       JOIN threads t ON d.thread_id = t.id
       WHERE t.id = $1 AND t.owner_key = $2 AND t.archived_at IS NULL
       ORDER BY d.version ASC`,
      [threadId, ownerKey]
    );
    return res.rows.map(rowToDesign);
  },
};
