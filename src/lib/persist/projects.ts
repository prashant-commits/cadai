import { requireTransaction, type Queryable } from '@/lib/db/db';
import {
  StoreError,
  rowToProject,
  runActive,
  type ProjectRow,
  type ProjectSummary,
} from './types';
import { BAD_PROJECT_NAME, DEFAULT_PROJECT_NAME } from './phrases';

export interface ProjectListOptions {
  search?: string;
  limit?: number;
  before?: { updatedAt: number; id: string };
}

function validateProjectName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    throw new StoreError(400, 'bad_request', BAD_PROJECT_NAME);
  }
  return trimmed;
}

function escapeLike(str: string): string {
  return str.replace(/([\\%_])/g, '\\$1');
}

export const ProjectStore = {
  async create(q: Queryable, ownerKey: string, name: string): Promise<ProjectRow> {
    const trimmed = validateProjectName(name);
    const res = await q.query(
      `INSERT INTO projects (owner_key, name)
       VALUES ($1, $2)
       RETURNING id, owner_key, name, created_at, updated_at, archived_at`,
      [ownerKey, trimmed]
    );
    return rowToProject(res.rows[0]);
  },

  async get(q: Queryable, ownerKey: string, id: string): Promise<ProjectRow | null> {
    const res = await q.query(
      `SELECT id, owner_key, name, created_at, updated_at, archived_at
       FROM projects
       WHERE id = $1 AND owner_key = $2 AND archived_at IS NULL`,
      [id, ownerKey]
    );
    if (res.rows.length === 0) return null;
    return rowToProject(res.rows[0]);
  },

  async list(
    q: Queryable,
    ownerKey: string,
    opts?: ProjectListOptions
  ): Promise<ProjectSummary[]> {
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
    const params: unknown[] = [ownerKey];
    let searchClause = '';
    if (opts?.search !== undefined && opts?.search !== null && opts.search.length > 0) {
      params.push(`%${escapeLike(opts.search)}%`);
      searchClause = ` AND p.name ILIKE $${params.length}`;
    }

    let beforeClause = '';
    if (opts?.before !== undefined) {
      params.push(new Date(opts.before.updatedAt).toISOString());
      const dateParam = params.length;
      params.push(opts.before.id);
      const idParam = params.length;
      beforeClause = ` WHERE (updated_at, id) < ($${dateParam}::timestamptz, $${idParam})`;
    }

    params.push(limit);
    const limitParam = params.length;

    const sql = `
      WITH project_base AS (
        SELECT
          p.id,
          p.name,
          GREATEST(p.updated_at, COALESCE(MAX(t.updated_at), p.updated_at)) AS updated_at,
          COUNT(t.id)::int AS thread_count,
          (
            SELECT d.stl_artifact
            FROM threads th
            JOIN designs d ON d.thread_id = th.id
            WHERE th.project_id = p.id
              AND th.archived_at IS NULL
              AND d.stl_artifact IS NOT NULL
            ORDER BY d.created_at DESC
            LIMIT 1
          ) AS thumbnail_artifact_id
        FROM projects p
        LEFT JOIN threads t ON t.project_id = p.id AND t.archived_at IS NULL
        WHERE p.owner_key = $1
          AND p.archived_at IS NULL${searchClause}
        GROUP BY p.id, p.name, p.updated_at
      )
      SELECT id, name, updated_at, thread_count, thumbnail_artifact_id
      FROM project_base${beforeClause}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${limitParam}
    `;

    const res = await q.query(sql, params);
    return res.rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      updatedAt: Number(r.updated_at),
      threadCount: Number(r.thread_count),
      thumbnailArtifactId: (r.thumbnail_artifact_id as string | null) ?? null,
    }));
  },

  async rename(
    q: Queryable,
    ownerKey: string,
    id: string,
    name: string
  ): Promise<boolean> {
    const trimmed = validateProjectName(name);
    const res = await q.query(
      `UPDATE projects
       SET name = $1, updated_at = now()
       WHERE id = $2 AND owner_key = $3 AND archived_at IS NULL`,
      [trimmed, id, ownerKey]
    );
    return res.rowCount > 0;
  },

  async archive(
    q: Queryable,
    ownerKey: string,
    id: string
  ): Promise<boolean> {
    requireTransaction();

    // 1. Lock threads first
    const threadsRes = await q.query(
      `SELECT id, active_run_id
       FROM threads
       WHERE project_id = $1 AND archived_at IS NULL
       FOR UPDATE`,
      [id]
    );

    // 2. Lock project
    const projRes = await q.query(
      `SELECT owner_key, archived_at
       FROM projects
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );
    if (projRes.rows.length === 0) return false;
    const proj = projRes.rows[0];
    if (proj.owner_key !== ownerKey || proj.archived_at !== null) {
      return false;
    }

    // 3. Refuse if active run
    for (const t of threadsRes.rows) {
      if (t.active_run_id) {
        throw runActive(String(t.active_run_id));
      }
    }

    // 4. Archive threads and project
    await q.query(
      `UPDATE threads
       SET archived_at = now(), updated_at = now()
       WHERE project_id = $1 AND archived_at IS NULL`,
      [id]
    );
    await q.query(
      `UPDATE projects
       SET archived_at = now(), updated_at = now()
       WHERE id = $1`,
      [id]
    );
    return true;
  },

  async ensureDefault(
    q: Queryable,
    ownerKey: string
  ): Promise<string | null> {
    requireTransaction();

    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      'cadai:ensureDefault:' + ownerKey,
    ]);

    const defaultProjRes = await q.query(
      `SELECT id
       FROM projects
       WHERE owner_key = $1 AND name = $2 AND archived_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1`,
      [ownerKey, DEFAULT_PROJECT_NAME]
    );
    const existingDefaultId =
      defaultProjRes.rows.length > 0 ? String(defaultProjRes.rows[0].id) : null;

    const nullThreadsRes = await q.query(
      `SELECT id
       FROM threads
       WHERE owner_key = $1 AND project_id IS NULL AND archived_at IS NULL`,
      [ownerKey]
    );

    if (nullThreadsRes.rows.length === 0) {
      return existingDefaultId;
    }

    let defaultId = existingDefaultId;
    if (!defaultId) {
      const createRes = await q.query(
        `INSERT INTO projects (owner_key, name)
         VALUES ($1, $2)
         RETURNING id`,
        [ownerKey, DEFAULT_PROJECT_NAME]
      );
      defaultId = String(createRes.rows[0].id);
    }

    await q.query(
      `UPDATE threads
       SET project_id = $1
       WHERE owner_key = $2 AND project_id IS NULL`,
      [defaultId, ownerKey]
    );

    return defaultId;
  },
};
