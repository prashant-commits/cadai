import { describe, it, expect, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { getDb, closeDb } from '@/lib/db/db';
import { ThreadStore } from './threads';
import { DesignStore } from './designs';
import { MessageStore } from './messages';
import { ArtifactRows } from './artifact-rows';

describe('stores', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('stores hide other owners', async () => {
    const db = getDb();
    const ownerA = `owner_a_${crypto.randomUUID()}`;
    const ownerB = `owner_b_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();
    const artifactId = `art_${crypto.randomUUID()}`;
    const msgId1 = crypto.randomUUID();
    const msgId2 = crypto.randomUUID();

    // Seed thread T for owner A
    await db.query(
      `insert into threads(id, owner_key, title) values ($1, $2, $3)`,
      [threadId, ownerA, 'Original Title']
    );

    // Seed artifact for owner A
    await ArtifactRows.insert(db, {
      id: artifactId,
      ownerKey: ownerA,
      threadId,
      runId: null,
      kind: 'image',
      bytes: 1024,
      objectKey: 'artifacts/test.png',
    });

    // Seed two messages (one with attachment)
    await db.query(
      `insert into messages(id, thread_id, seq, role, kind, content, client_message_id) values
       ($1, $2, 1, 'user', 'request', 'Hello', $3),
       ($4, $2, 2, 'assistant', 'result', 'World', null)`,
      [msgId1, threadId, crypto.randomUUID(), msgId2]
    );
    await db.query(
      `insert into message_attachments(message_id, artifact_id) values ($1, $2)`,
      [msgId1, artifactId]
    );

    // Seed one design
    await db.query(
      `insert into designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags)
       values ($1, 1, null, 'designer', 'make box', '[]', 'box = 1', 'v1', 'box summary', null, '[]')`,
      [threadId]
    );

    // Owner B checks
    expect(await ThreadStore.get(db, ownerB, threadId)).toBeNull();
    const listB = await ThreadStore.list(db, ownerB);
    expect(listB.find((t) => t.id === threadId)).toBeUndefined();

    const renamedB = await ThreadStore.rename(db, ownerB, threadId, 'New Title');
    expect(renamedB).toBe(false);
    const unchangedA = await ThreadStore.get(db, ownerA, threadId);
    expect(unchangedA?.title).toBe('Original Title');

    expect(await DesignStore.get(db, ownerB, threadId, 1)).toBeNull();
    expect(await DesignStore.latest(db, ownerB, threadId)).toBeNull();
    expect(await DesignStore.list(db, ownerB, threadId)).toEqual([]);

    expect(await MessageStore.list(db, ownerB, threadId)).toEqual([]);
    expect(await ArtifactRows.get(db, ownerB, artifactId)).toBeNull();

    // Owner A checks
    const threadA = await ThreadStore.get(db, ownerA, threadId);
    expect(threadA).not.toBeNull();
    expect(threadA?.id).toBe(threadId);

    const listA = await ThreadStore.list(db, ownerA);
    expect(listA.find((t) => t.id === threadId)).toBeDefined();

    const designA = await DesignStore.get(db, ownerA, threadId, 1);
    expect(designA?.version).toBe(1);
    const latestA = await DesignStore.latest(db, ownerA, threadId);
    expect(latestA?.version).toBe(1);
    const designsA = await DesignStore.list(db, ownerA, threadId);
    expect(designsA).toHaveLength(1);

    const messagesA = await MessageStore.list(db, ownerA, threadId);
    expect(messagesA).toHaveLength(2);
    expect(messagesA[0].attachmentIds).toEqual([artifactId]);
    expect(messagesA[1].attachmentIds).toEqual([]);

    const artA = await ArtifactRows.get(db, ownerA, artifactId);
    expect(artA?.id).toBe(artifactId);
  });

  it('archived threads are hidden', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();

    await db.query(
      `insert into threads(id, owner_key, title) values ($1, $2, $3)`,
      [threadId, ownerKey, 'Archived Thread']
    );

    const before = await ThreadStore.get(db, ownerKey, threadId);
    expect(before).not.toBeNull();

    await db.query(`update threads set archived_at = now() where id = $1`, [threadId]);

    expect(await ThreadStore.get(db, ownerKey, threadId)).toBeNull();
    const list = await ThreadStore.list(db, ownerKey);
    expect(list.find((t) => t.id === threadId)).toBeUndefined();
  });

  it('rename trims, caps at 80 and bumps updated_at', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();

    await db.query(
      `insert into threads(id, owner_key, title, created_at, updated_at) values ($1, $2, $3, now() - interval '1 hour', now() - interval '1 hour')`,
      [threadId, ownerKey, 'Initial']
    );

    const initial = await ThreadStore.get(db, ownerKey, threadId);
    const initialUpdatedAt = initial!.updatedAt;

    // Trims whitespace
    await ThreadStore.rename(db, ownerKey, threadId, '   Padded Title   ');
    const padded = await ThreadStore.get(db, ownerKey, threadId);
    expect(padded?.title).toBe('Padded Title');
    expect(padded!.updatedAt).toBeGreaterThan(initialUpdatedAt);

    // Empty string becomes null
    await ThreadStore.rename(db, ownerKey, threadId, '   ');
    const empty = await ThreadStore.get(db, ownerKey, threadId);
    expect(empty?.title).toBeNull();

    // Caps at 80 chars
    const longTitle = 'a'.repeat(100);
    await ThreadStore.rename(db, ownerKey, threadId, longTitle);
    const capped = await ThreadStore.get(db, ownerKey, threadId);
    expect(capped?.title).toBe('a'.repeat(80));
    expect(capped?.title?.length).toBe(80);
  });

  it('rows map timestamps to epoch ms and numerics to numbers', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();

    await db.query(
      `insert into threads(id, owner_key, title) values ($1, $2, 'T')`,
      [threadId, ownerKey]
    );

    await db.query(
      `insert into designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags)
       values ($1, 1, null, 'designer', 'req', '[{"type":"edit"}]', 'body', 'v1', 'sum', '{"mass":12}', '["failed_checks"]')`,
      [threadId]
    );

    const d = await DesignStore.get(db, ownerKey, threadId, 1);
    expect(typeof d?.createdAt).toBe('number');
    expect(d?.createdAt).toBeGreaterThan(0);
    expect(Array.isArray(d?.edits)).toBe(true);
    expect(d?.edits).toEqual([{ type: 'edit' }]);
    expect(Array.isArray(d?.flags)).toBe(true);
    expect(d?.flags).toEqual(['failed_checks']);
    expect(d?.facts).toEqual({ mass: 12 });
  });
});
