import type { Queryable } from '@/lib/db/db';
import { rowToMessage, type MessageRow } from './types';

export const MessageStore = {
  async list(
    q: Queryable,
    ownerKey: string,
    threadId: string
  ): Promise<MessageRow[]> {
    const res = await q.query(
      `SELECT m.id, m.thread_id, m.seq, m.role, m.kind, m.content, m.run_id,
              m.design_version, m.client_message_id, m.created_at, m.steps,
              COALESCE(
                (SELECT json_agg(json_build_object('id', ma.artifact_id, 'kind', ma.kind) ORDER BY ma.artifact_id)
                 FROM message_attachments ma
                 WHERE ma.message_id = m.id),
                '[]'::json
              ) AS attachments
       FROM messages m
       JOIN threads t ON m.thread_id = t.id
       WHERE t.id = $1 AND t.owner_key = $2 AND t.archived_at IS NULL
       ORDER BY m.seq ASC`,
      [threadId, ownerKey]
    );
    return res.rows.map((row) => rowToMessage(row));
  },
};
