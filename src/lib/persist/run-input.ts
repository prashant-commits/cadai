import type { Queryable } from '@/lib/db/db';
import { getObjectStore, type ObjectStore } from '@/lib/storage/object-store';
import { get as getArtifact } from '@/lib/runs/owner-artifacts';
import { DesignStore } from './designs';
import type { GraphInput } from './types';

export async function loadRunInput(
  q: Queryable,
  ownerKey: string,
  threadId: string,
  baseVersion: number | null,
  attachmentIds: Array<string | { id: string; kind?: 'markup' | 'reference' }>,
  deps?: { objectStore?: ObjectStore }
): Promise<GraphInput & { baseEdits: string[]; layer: { id: string; name: string } | null }> {
  // 1. Thread must belong to ownerKey and not be archived, else throw
  const threadRes = await q.query(
    `SELECT id FROM threads WHERE id = $1 AND owner_key = $2 AND archived_at IS NULL`,
    [threadId, ownerKey]
  );
  if (threadRes.rows.length === 0) {
    throw new Error('thread not found');
  }

  // 2. messages: history from messages table ONLY for this thread, ordered by seq
  const messagesRes = await q.query(
    `SELECT role, kind, content, layer FROM messages WHERE thread_id = $1 ORDER BY seq ASC`,
    [threadId]
  );
  const messages: GraphInput['messages'] = messagesRes.rows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    kind: String(row.kind),
    content: String(row.content),
  }));

  let layer: { id: string; name: string } | null = null;
  for (let i = messagesRes.rows.length - 1; i >= 0; i--) {
    if (messagesRes.rows[i].role === 'user') {
      const rawLayer = messagesRes.rows[i].layer;
      if (rawLayer) {
        const parsed = typeof rawLayer === 'string' ? JSON.parse(rawLayer) : rawLayer;
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof parsed.id === 'string' &&
          typeof parsed.name === 'string'
        ) {
          layer = { id: parsed.id, name: parsed.name };
        }
      }
      break;
    }
  }

  // 3. baseBody, baseRequest, baseEdits from designs at (threadId, baseVersion)
  let baseBody: string | null = null;
  let baseRequest: string | null = null;
  let baseEdits: string[] = [];

  if (baseVersion !== null) {
    const design = await DesignStore.get(q, ownerKey, threadId, baseVersion);
    if (!design) {
      throw new Error(`design version ${baseVersion} not found`);
    }
    baseBody = design.body;
    baseRequest = design.baseRequest;
    baseEdits = (design.edits as string[]) ?? [];
  }

  // 4. attachments: for each id, owner-artifacts.get(q, ownerKey, id) must return kind 'image'
  const objectStore = deps?.objectStore ?? getObjectStore();
  const attachments: GraphInput['attachments'] = [];

  for (const item of attachmentIds) {
    const id = typeof item === 'string' ? item : item.id;
    let kind: 'markup' | 'reference' =
      typeof item === 'object' && item.kind ? item.kind : 'reference';

    if (typeof item === 'string' || !item.kind) {
      const maRes = await q.query(
        `SELECT kind FROM message_attachments WHERE artifact_id = $1 LIMIT 1`,
        [id]
      );
      if (
        maRes.rows.length > 0 &&
        (maRes.rows[0].kind === 'markup' || maRes.rows[0].kind === 'reference')
      ) {
        kind = maRes.rows[0].kind as 'markup' | 'reference';
      }
    }

    const row = await getArtifact(q, ownerKey, id);
    if (!row || row.kind !== 'image') {
      throw new Error(`attachment ${id} not found or not an image`);
    }
    const stream = await objectStore.openStream(row.objectKey);
    if (!stream) {
      throw new Error(`artifact object not found: ${row.objectKey}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    attachments.push({
      mediaType: 'image/png',
      base64: buf.toString('base64'),
      kind,
    });
  }

  return {
    messages,
    baseVersion,
    baseBody,
    baseRequest,
    baseEdits,
    attachments,
    layer,
  };
}
