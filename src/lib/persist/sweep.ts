import { requireTransaction, type Queryable } from '@/lib/db/db';

export async function sweep(
  q: Queryable,
  now: number
): Promise<{ eventsDeleted: number; objectKeys: string[] }> {
  requireTransaction();

  // 1. Delete run_events of runs with status <> 'running' and ended_at < $now - 10 minutes (600,000 ms)
  const eventsRes = await q.query(
    `DELETE FROM run_events
     WHERE run_id IN (
       SELECT id FROM runs
       WHERE status <> 'running'
         AND ended_at < to_timestamp(($1::bigint - 600000) / 1000.0)
     )`,
    [now]
  );
  const eventsDeleted = eventsRes.rowCount;

  // 2. Delete unreferenced artifacts older than 24 hours (86,400,000 ms)
  const artRes = await q.query<{ object_key: string }>(
    `DELETE FROM artifacts
     WHERE id IN (
       SELECT a.id
       FROM artifacts a
       WHERE a.created_at < to_timestamp(($1::bigint - 86400000) / 1000.0)
         AND NOT EXISTS (
           SELECT 1 FROM designs d
           WHERE d.stl_artifact = a.id OR d.step_artifact = a.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM message_attachments ma
           WHERE ma.artifact_id = a.id
         )
       FOR UPDATE SKIP LOCKED
     )
     RETURNING object_key`,
    [now]
  );
  const objectKeys = artRes.rows.map((r) => String(r.object_key));

  // 3. Insert object keys into pending_deletes
  for (const k of objectKeys) {
    await q.query(
      `INSERT INTO pending_deletes (object_key) VALUES ($1) ON CONFLICT DO NOTHING`,
      [k]
    );
  }

  return { eventsDeleted, objectKeys };
}
