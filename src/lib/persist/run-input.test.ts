import { describe, it, expect, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { getDb, closeDb } from '@/lib/db/db';
import { loadRunInput } from './run-input';
import { LocalObjectStore } from '@/lib/storage/object-store';
import { newArtifactId } from '@/lib/runs/owner-artifacts';

describe('run-input', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('loadRunInput: history from messages only, the base body from designs', async () => {
    const db = getDb();
    const ownerA = `owner_a_${crypto.randomUUID()}`;
    const ownerB = `owner_b_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();
    const otherThreadId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    // 1. Thread for owner A
    await db.query(
      `insert into threads(id, owner_key, title) values ($1, $2, $3)`,
      [threadId, ownerA, 'Test Thread']
    );

    // Unrelated thread for owner A
    await db.query(
      `insert into threads(id, owner_key, title) values ($1, $2, $3)`,
      [otherThreadId, ownerA, 'Other Thread']
    );

    // 2. Messages for threadId (seq 1 and seq 2)
    const msgId1 = crypto.randomUUID();
    const msgId2 = crypto.randomUUID();
    await db.query(
      `insert into messages(id, thread_id, seq, role, kind, content, client_message_id) values
       ($1, $2, 1, 'user', 'request', 'First message', $3),
       ($4, $2, 2, 'assistant', 'result', 'Second message', null)`,
      [msgId1, threadId, crypto.randomUUID(), msgId2]
    );

    // Unrelated message in otherThreadId
    await db.query(
      `insert into messages(id, thread_id, seq, role, kind, content, client_message_id) values
       ($1, $2, 1, 'user', 'request', 'Unrelated thread message', $3)`,
      [crypto.randomUUID(), otherThreadId, crypto.randomUUID()]
    );

    // Run and run_events row (should NOT be in history)
    await db.query(
      `insert into runs(id, thread_id, status, base_version, deadline_at) values ($1, $2, 'running', null, now() + interval '1 hour')`,
      [runId, threadId]
    );
    await db.query(
      `insert into run_events(run_id, seq, type, payload) values ($1, 1, 'delta', '{"text":"event data"}')`,
      [runId]
    );

    // 3. Two designs for threadId
    await db.query(
      `insert into designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags) values
       ($1, 1, null, 'designer', 'first base request', '["v1 edit"]', 'body v1', 'v1', 'summary 1', null, '[]'),
       ($1, 2, 1, 'designer', 'second base request', '["v2 edit 1", "v2 edit 2"]', 'body v2', 'v1', 'summary 2', null, '[]')`,
      [threadId]
    );

    // 4. ObjectStore and attachment for owner A
    const scratchDir = process.env.TMPDIR || '/home/claude/work/cadai/.cadai/scratch/pa/a68/tmp';
    const storeDir = `${scratchDir}/run-input-store-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const objectStore = new LocalObjectStore(storeDir);

    const artIdA = newArtifactId();
    const imageBytes = Buffer.from('fake-png-image-content-bytes');
    const objectKeyA = `image/${artIdA}`;
    await objectStore.put(objectKeyA, imageBytes);
    await db.query(
      `insert into artifacts(id, owner_key, thread_id, run_id, kind, bytes, object_key) values ($1, $2, $3, $4, 'image', $5, $6)`,
      [artIdA, ownerA, threadId, runId, imageBytes.byteLength, objectKeyA]
    );

    // Attachment for owner B
    const artIdB = newArtifactId();
    const objectKeyB = `image/${artIdB}`;
    await objectStore.put(objectKeyB, imageBytes);
    await db.query(
      `insert into artifacts(id, owner_key, thread_id, run_id, kind, bytes, object_key) values ($1, $2, $3, $4, 'image', $5, $6)`,
      [artIdB, ownerB, null, null, imageBytes.byteLength, objectKeyB]
    );

    // 5. Test loadRunInput with baseVersion = 2 and attachment
    const loaded = await loadRunInput(
      db,
      ownerA,
      threadId,
      2,
      [artIdA],
      { objectStore }
    );

    // Verify messages: history from messages table ONLY for this thread, ordered by seq
    expect(loaded.messages).toEqual([
      { role: 'user', kind: 'request', content: 'First message' },
      { role: 'assistant', kind: 'result', content: 'Second message' },
    ]);

    // Verify base body, request, and edits come from baseVersion 2
    expect(loaded.baseVersion).toBe(2);
    expect(loaded.baseBody).toBe('body v2');
    expect(loaded.baseRequest).toBe('second base request');
    expect(loaded.baseEdits).toEqual(['v2 edit 1', 'v2 edit 2']);

    // Verify loadRunInput with baseVersion = 1 returns v1's body, request and edits when v2 exists
    const loadedV1 = await loadRunInput(
      db,
      ownerA,
      threadId,
      1,
      [],
      { objectStore }
    );
    expect(loadedV1.baseVersion).toBe(1);
    expect(loadedV1.baseBody).toBe('body v1');
    expect(loadedV1.baseRequest).toBe('first base request');
    expect(loadedV1.baseEdits).toEqual(['v1 edit']);

    // Verify attachment round-tripped bytes in order
    expect(loaded.attachments).toEqual([
      {
        mediaType: 'image/png',
        base64: imageBytes.toString('base64'),
        kind: 'reference',
      },
    ]);

    // Another owner's attachment id throws
    await expect(
      loadRunInput(db, ownerA, threadId, 2, [artIdB], { objectStore })
    ).rejects.toThrow();

    // baseVersion === null -> all null (baseEdits: [])
    const loadedNullBase = await loadRunInput(
      db,
      ownerA,
      threadId,
      null,
      [],
      { objectStore }
    );
    expect(loadedNullBase.baseVersion).toBeNull();
    expect(loadedNullBase.baseBody).toBeNull();
    expect(loadedNullBase.baseRequest).toBeNull();
    expect(loadedNullBase.baseEdits).toEqual([]);

    // Thread belonging to another owner throws 'thread not found'
    await expect(
      loadRunInput(db, ownerB, threadId, null, [], { objectStore })
    ).rejects.toThrow('thread not found');

    // Archived thread throws 'thread not found'
    const archivedThreadId = crypto.randomUUID();
    await db.query(
      `insert into threads(id, owner_key, title, archived_at) values ($1, $2, $3, now())`,
      [archivedThreadId, ownerA, 'Archived Thread']
    );
    await expect(
      loadRunInput(db, ownerA, archivedThreadId, null, [], { objectStore })
    ).rejects.toThrow('thread not found');
  });

  it("loadRunInput keeps each attachment's kind", async () => {
    const db = getDb();
    const owner = `owner_kinds_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();

    await db.query(
      `insert into threads(id, owner_key, title) values ($1, $2, $3)`,
      [threadId, owner, 'Kind Test Thread']
    );

    const msgId = crypto.randomUUID();
    await db.query(
      `insert into messages(id, thread_id, seq, role, kind, content, client_message_id) values
       ($1, $2, 1, 'user', 'request', 'Attachments message', $3)`,
      [msgId, threadId, crypto.randomUUID()]
    );

    const scratchDir = process.env.TMPDIR || '/home/claude/work/cadai/.cadai/scratch/pa/u1/tmp';
    const storeDir = `${scratchDir}/run-input-kinds-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const objectStore = new LocalObjectStore(storeDir);

    const imageBytes = Buffer.from('test-image-content');

    // 1. Explicit object attachments: one markup, one reference
    const artMarkup = newArtifactId();
    const keyMarkup = `image/${artMarkup}`;
    await objectStore.put(keyMarkup, imageBytes);
    await db.query(
      `insert into artifacts(id, owner_key, thread_id, run_id, kind, bytes, object_key) values ($1, $2, $3, null, 'image', $4, $5)`,
      [artMarkup, owner, threadId, imageBytes.byteLength, keyMarkup]
    );

    const artRef = newArtifactId();
    const keyRef = `image/${artRef}`;
    await objectStore.put(keyRef, imageBytes);
    await db.query(
      `insert into artifacts(id, owner_key, thread_id, run_id, kind, bytes, object_key) values ($1, $2, $3, null, 'image', $4, $5)`,
      [artRef, owner, threadId, imageBytes.byteLength, keyRef]
    );

    const loadedObj = await loadRunInput(
      db,
      owner,
      threadId,
      null,
      [
        { id: artMarkup, kind: 'markup' },
        { id: artRef, kind: 'reference' },
      ],
      { objectStore }
    );
    expect(loadedObj.attachments).toHaveLength(2);
    expect(loadedObj.attachments[0].kind).toBe('markup');
    expect(loadedObj.attachments[1].kind).toBe('reference');

    // 2. Bare-id attachment reading kind from message_attachments
    const artBareMarkup = newArtifactId();
    const keyBareMarkup = `image/${artBareMarkup}`;
    await objectStore.put(keyBareMarkup, imageBytes);
    await db.query(
      `insert into artifacts(id, owner_key, thread_id, run_id, kind, bytes, object_key) values ($1, $2, $3, null, 'image', $4, $5)`,
      [artBareMarkup, owner, threadId, imageBytes.byteLength, keyBareMarkup]
    );
    await db.query(
      `insert into message_attachments(message_id, artifact_id, kind) values ($1, $2, 'markup')`,
      [msgId, artBareMarkup]
    );

    const loadedBare = await loadRunInput(
      db,
      owner,
      threadId,
      null,
      [artBareMarkup],
      { objectStore }
    );
    expect(loadedBare.attachments).toHaveLength(1);
    expect(loadedBare.attachments[0].kind).toBe('markup');
  });

  it('run-input includes tool_edit lines in history', async () => {
    const db = getDb();
    const owner = `owner_te_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();

    await db.query(
      `insert into threads(id, owner_key, title) values ($1, $2, 'Tool Edit Thread')`,
      [threadId, owner]
    );

    await db.query(
      `insert into messages(id, thread_id, seq, role, kind, content, client_message_id) values
       ($1, $2, 1, 'user', 'request', 'Make a box', $3),
       ($4, $2, 2, 'assistant', 'result', 'Here is the box', null),
       ($5, $2, 3, 'user', 'tool_edit', 'You added Hole M5 · v2', $6)`,
      [
        crypto.randomUUID(),
        threadId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]
    );

    const loaded = await loadRunInput(db, owner, threadId, null, []);
    expect(loaded.messages).toHaveLength(3);
    expect(loaded.messages[2]).toEqual({
      role: 'user',
      kind: 'tool_edit',
      content: 'You added Hole M5 · v2',
    });
  });
});
