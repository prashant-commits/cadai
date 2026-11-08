import { describe, it, expect, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { getDb, closeDb } from '@/lib/db/db';
import { DbRunStore } from './db-run-store';
import { ThreadStore } from '@/lib/persist/threads';
import { sweep } from '@/lib/persist/sweep';
import {
  StoreError,
  type StartInput,
  type CommitPlan,
} from '@/lib/persist/types';
import {
  STOPPED,
  RUN_LOST,
  DEADLINE,
} from '@/lib/persist/phrases';

describe('DbRunStore', () => {
  afterAll(async () => {
    await closeDb();
  });

  const makeStartInput = (overrides?: Partial<StartInput>): StartInput => ({
    threadId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    ownerKey: `owner_${crypto.randomUUID()}`,
    text: 'A test prompt',
    viewingVersion: null,
    ...overrides,
  });

  it('start refuses a second active run with 409 and writes nothing', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // Start run A
    const resA = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    expect(resA.replay).toBe(false);
    if (resA.replay) throw new Error('Expected replay=false');
    const runAId = resA.runId;

    // Snapshot counts and thread updated_at
    const beforeThread = (await db.query(`SELECT updated_at FROM threads WHERE id = $1`, [threadId])).rows[0];
    const beforeRuns = (await db.query(`SELECT count(*)::int as c FROM runs`)).rows[0].c;
    const beforeMsgs = (await db.query(`SELECT count(*)::int as c FROM messages`)).rows[0].c;
    const beforeDesigns = (await db.query(`SELECT count(*)::int as c FROM designs`)).rows[0].c;
    const beforeAtts = (await db.query(`SELECT count(*)::int as c FROM message_attachments`)).rows[0].c;

    // Attempt to start run B on same thread with a new clientMessageId
    let caught: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({ threadId, ownerKey, clientMessageId: crypto.randomUUID() }));
      });
    } catch (err) {
      if (err instanceof StoreError) {
        caught = err;
      } else {
        throw err;
      }
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(409);
    expect(caught?.code).toBe('run_active');
    expect(caught?.activeRunId).toBe(runAId);

    // Assert counts and thread updated_at unchanged
    const afterThread = (await db.query(`SELECT updated_at FROM threads WHERE id = $1`, [threadId])).rows[0];
    const afterRuns = (await db.query(`SELECT count(*)::int as c FROM runs`)).rows[0].c;
    const afterMsgs = (await db.query(`SELECT count(*)::int as c FROM messages`)).rows[0].c;
    const afterDesigns = (await db.query(`SELECT count(*)::int as c FROM designs`)).rows[0].c;
    const afterAtts = (await db.query(`SELECT count(*)::int as c FROM message_attachments`)).rows[0].c;

    expect(afterThread.updated_at).toBe(beforeThread.updated_at);
    expect(afterRuns).toBe(beforeRuns);
    expect(afterMsgs).toBe(beforeMsgs);
    expect(afterDesigns).toBe(beforeDesigns);
    expect(afterAtts).toBe(beforeAtts);
  });

  it('start reaps a stale active run', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // Start run A
    const resA = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    if (resA.replay) throw new Error('Expected replay=false');
    const runAId = resA.runId;

    // Set A's heartbeat_at 2 minutes back
    await db.query(
      `UPDATE runs SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1`,
      [runAId]
    );

    // Start B
    const resB = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    expect(resB.replay).toBe(false);
    if (resB.replay) throw new Error('Expected replay=false');
    const runBId = resB.runId;

    // Check A: failed, error.code 'run_lost', has RUN_LOST assistant message and one end event
    const runARow = await DbRunStore.get(db, runAId);
    expect(runARow?.status).toBe('failed');
    expect(runARow?.error).toEqual({ code: 'run_lost' });

    const msgsA = await db.query(
      `SELECT * FROM messages WHERE run_id = $1 AND role = 'assistant'`,
      [runAId]
    );
    expect(msgsA.rows).toHaveLength(1);
    expect(msgsA.rows[0].content).toBe(RUN_LOST);

    const endEventsA = await db.query(
      `SELECT * FROM run_events WHERE run_id = $1 AND type = 'end'`,
      [runAId]
    );
    expect(endEventsA.rows).toHaveLength(1);

    // Thread active_run_id is now B
    const threadRow = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [threadId])).rows[0];
    expect(threadRow.active_run_id).toBe(runBId);

    // Second case: run C fresh heartbeat but deadline_at 61 s in the past
    const threadId2 = crypto.randomUUID();
    const resC = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId: threadId2, ownerKey }));
    });
    if (resC.replay) throw new Error('Expected replay=false');
    const runCId = resC.runId;

    await db.query(
      `UPDATE runs SET heartbeat_at = now(), deadline_at = now() - interval '61 seconds' WHERE id = $1`,
      [runCId]
    );

    // Start D on thread2
    const resD = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId: threadId2, ownerKey }));
    });
    expect(resD.replay).toBe(false);

    const runCRow = await DbRunStore.get(db, runCId);
    expect(runCRow?.status).toBe('failed');
    expect(runCRow?.error).toEqual({ code: 'deadline' });

    const msgsC = await db.query(
      `SELECT * FROM messages WHERE run_id = $1 AND role = 'assistant'`,
      [runCId]
    );
    expect(msgsC.rows).toHaveLength(1);
    expect(msgsC.rows[0].content).toBe(DEADLINE);
  });

  it('a replayed clientMessageId returns the first run', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const clientMessageId = crypto.randomUUID();

    const input = makeStartInput({ threadId, ownerKey, clientMessageId });
    const res1 = await db.transaction(async (q) => DbRunStore.start(q, input));
    expect(res1.replay).toBe(false);
    if (res1.replay) throw new Error('replay=false expected');
    const firstRunId = res1.runId;

    // Snapshot counts
    const countRuns1 = Number((await db.query(`SELECT count(*)::int as c FROM runs`)).rows[0].c);
    const countMsgs1 = Number((await db.query(`SELECT count(*)::int as c FROM messages`)).rows[0].c);

    // Replay while running
    const res2 = await db.transaction(async (q) => DbRunStore.start(q, input));
    expect(res2).toEqual({ replay: true, runId: firstRunId });

    const countRuns2 = Number((await db.query(`SELECT count(*)::int as c FROM runs`)).rows[0].c);
    const countMsgs2 = Number((await db.query(`SELECT count(*)::int as c FROM messages`)).rows[0].c);
    expect(countRuns2).toBe(countRuns1);
    expect(countMsgs2).toBe(countMsgs1);

    // Commit run
    const plan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 100,
      turns: 1,
    };
    await db.transaction(async (q) => DbRunStore.commit(q, firstRunId, plan));

    // Replay again after commit
    const res3 = await db.transaction(async (q) => DbRunStore.start(q, input));
    expect(res3).toEqual({ replay: true, runId: firstRunId });

    const countRuns3 = Number((await db.query(`SELECT count(*)::int as c FROM runs`)).rows[0].c);
    const countMsgs3 = Number((await db.query(`SELECT count(*)::int as c FROM messages`)).rows[0].c);
    expect(countRuns3).toBe(countRuns1);
    expect(countMsgs3).toBe(countMsgs1 + 1); // +1 assistant reply from commit
  });

  it('missing viewingVersion on a thread with a design → STALE_CLIENT', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // Seed thread and a design v1
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, flags)
       VALUES ($1, 1, null, 'designer', 'box', '[]', 'box = 1', 'v1', 'box', '[]')`,
      [threadId]
    );

    const beforeRuns = (await db.query(`SELECT count(*)::int as c FROM runs`)).rows[0].c;

    let caught: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({ threadId, ownerKey, viewingVersion: null }));
      });
    } catch (err) {
      if (err instanceof StoreError) caught = err;
      else throw err;
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(400);
    expect(caught?.code).toBe('stale_client');

    const afterRuns = (await db.query(`SELECT count(*)::int as c FROM runs`)).rows[0].c;
    expect(afterRuns).toBe(beforeRuns);
  });

  it('a foreign viewingVersion → 404', async () => {
    const db = getDb();
    const threadId1 = crypto.randomUUID();
    const threadId2 = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId1, ownerKey]);
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId2, ownerKey]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, flags)
       VALUES ($1, 1, null, 'designer', 'box', '[]', 'box = 1', 'v1', 'box', '[]')`,
      [threadId1]
    );
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, flags)
       VALUES ($1, 2, null, 'designer', 'box2', '[]', 'box = 2', 'v1', 'box2', '[]')`,
      [threadId2]
    );

    // Case 1: version 99 absent from thread1
    let err1: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({ threadId: threadId1, ownerKey, viewingVersion: 99 }));
      });
    } catch (e) {
      if (e instanceof StoreError) err1 = e;
    }
    expect(err1?.status).toBe(404);

    // Case 2: version 2 exists in threadId2, but not in threadId1
    let err2: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({ threadId: threadId1, ownerKey, viewingVersion: 2 }));
      });
    } catch (e) {
      if (e instanceof StoreError) err2 = e;
    }
    expect(err2?.status).toBe(404);
  });

  it('pins: unknown name or 1e21 → BAD_PIN, nothing written', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const foreignOwner = `owner_foreign_${crypto.randomUUID()}`;

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, flags)
       VALUES ($1, 1, null, 'designer', 'box', '[]', 'length = 50  # [10:100] Length', 'v1', 'box', '[]')`,
      [threadId]
    );

    const countRunsBefore = (await db.query(`SELECT count(*)::int as c FROM runs`)).rows[0].c;

    // Unknown param name
    let err1: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({
          threadId,
          ownerKey,
          viewingVersion: 1,
          pinnedParams: { nonexistent: 20 },
        }));
      });
    } catch (e) {
      if (e instanceof StoreError) err1 = e;
    }
    expect(err1?.status).toBe(400);
    expect(err1?.code).toBe('bad_pin');

    // 1e21 (out of range |v| <= 1e6)
    let err2: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({
          threadId,
          ownerKey,
          viewingVersion: 1,
          pinnedParams: { length: 1e21 },
        }));
      });
    } catch (e) {
      if (e instanceof StoreError) err2 = e;
    }
    expect(err2?.status).toBe(400);
    expect(err2?.code).toBe('bad_pin');

    const countRunsAfter = (await db.query(`SELECT count(*)::int as c FROM runs`)).rows[0].c;
    expect(countRunsAfter).toBe(countRunsBefore);

    // Another owner's thread with bad pins → 404 (owner check first)
    let err3: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({
          threadId,
          ownerKey: foreignOwner,
          viewingVersion: 1,
          pinnedParams: { nonexistent: 20 },
        }));
      });
    } catch (e) {
      if (e instanceof StoreError) err3 = e;
    }
    expect(err3?.status).toBe(404);
  });

  it('an attachment of another owner → 404', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const foreignOwner = `owner_foreign_${crypto.randomUUID()}`;

    const foreignArtId = `art_${crypto.randomUUID()}`;
    const ownStlArtId = `art_${crypto.randomUUID()}`;
    const ownImageArtId = `art_${crypto.randomUUID()}`;

    // Seed artifacts
    await db.query(
      `INSERT INTO artifacts(id, owner_key, kind, bytes, object_key) VALUES
       ($1, $2, 'image', 100, 'obj1'),
       ($3, $4, 'stl', 100, 'obj2'),
       ($5, $6, 'image', 100, 'obj3')`,
      [foreignArtId, foreignOwner, ownStlArtId, ownerKey, ownImageArtId, ownerKey]
    );

    // Foreign image attachment -> 404
    let err1: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({
          threadId,
          ownerKey,
          attachmentIds: [foreignArtId],
        }));
      });
    } catch (e) {
      if (e instanceof StoreError) err1 = e;
    }
    expect(err1?.status).toBe(404);

    // Own stl attachment -> 404 (must be kind='image')
    let err2: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({
          threadId,
          ownerKey,
          attachmentIds: [ownStlArtId],
        }));
      });
    } catch (e) {
      if (e instanceof StoreError) err2 = e;
    }
    expect(err2?.status).toBe(404);

    // Own image attachment -> attached
    const res = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        attachmentIds: [ownImageArtId],
      }));
    });
    expect(res.replay).toBe(false);
    if (res.replay) throw new Error('Expected replay=false');

    const attRows = await db.query(
      `SELECT * FROM message_attachments WHERE artifact_id = $1`,
      [ownImageArtId]
    );
    expect(attRows.rows).toHaveLength(1);
    expect(attRows.rows[0].message_id).toBe(res.userMessageId);
  });

  it('user_edit fields', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags)
       VALUES ($1, 1, null, 'designer', 'make a box', '["taller"]'::jsonb, 'w = 40  # [0:100] W\nh = 10', 'p1', 'box v1', '{"fact": 1}'::jsonb, '[]'::jsonb)`,
      [threadId]
    );

    // Case 1: editedBody + pins -> v2
    const editedBody = 'w = 40  # [0:100] W\nh = 20';
    const res1 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        viewingVersion: 1,
        editedBody,
        pinnedParams: { w: 60 },
      }));
    });
    expect(res1.replay).toBe(false);
    if (res1.replay) throw new Error('Expected replay=false');
    expect(res1.baseVersion).toBe(2);

    const v2 = (await db.query(`SELECT * FROM designs WHERE thread_id = $1 AND version = 2`, [threadId])).rows[0];
    expect(v2.parent_version).toBe(1);
    expect(v2.origin).toBe('user_edit');
    expect(v2.run_id).toBeNull();
    expect(v2.base_request).toBe('make a box');
    expect(v2.edits).toEqual(['taller']);
    expect(v2.prelude_version).toBe('p1');
    expect(v2.facts).toBeNull();
    expect(v2.flags).toEqual([]);
    expect(v2.summary).toBe('Your edit (code and sliders)');
    expect(v2.stl_artifact).toBeNull();
    expect(v2.step_artifact).toBeNull();
    expect(v2.body).toBe('w = 60  # [0:100] W\nh = 20');

    const run1 = await DbRunStore.get(db, res1.runId);
    expect(run1?.baseVersion).toBe(2);

    // Commit run1 so thread is idle
    await db.transaction(async (q) => {
      await DbRunStore.commit(q, res1.runId, {
        replyKind: 'result',
        replyMarkdown: 'Done 1',
        userKind: 'request',
        costUsd: 0,
        wallMs: 0,
        turns: 1,
      });
    });

    // Case 2: sliders-only edit
    const res2 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        viewingVersion: 2,
        pinnedParams: { w: 80 },
      }));
    });
    if (res2.replay) throw new Error('Expected replay=false');
    expect(res2.baseVersion).toBe(3);
    const v3 = (await db.query(`SELECT * FROM designs WHERE thread_id = $1 AND version = 3`, [threadId])).rows[0];
    expect(v3.summary).toBe('Your edit (sliders)');
    expect(v3.body).toBe('w = 80  # [0:100] W\nh = 20');

    await db.transaction(async (q) => {
      await DbRunStore.commit(q, res2.runId, {
        replyKind: 'result',
        replyMarkdown: 'Done 2',
        userKind: 'request',
        costUsd: 0,
        wallMs: 0,
        turns: 1,
      });
    });

    // Case 3: code-only edit
    const res3 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        viewingVersion: 3,
        editedBody: 'w = 80  # [0:100] W\nh = 30',
      }));
    });
    if (res3.replay) throw new Error('Expected replay=false');
    expect(res3.baseVersion).toBe(4);
    const v4 = (await db.query(`SELECT * FROM designs WHERE thread_id = $1 AND version = 4`, [threadId])).rows[0];
    expect(v4.summary).toBe('Your edit (code)');

    await db.transaction(async (q) => {
      await DbRunStore.commit(q, res3.runId, {
        replyKind: 'result',
        replyMarkdown: 'Done 3',
        userKind: 'request',
        costUsd: 0,
        wallMs: 0,
        turns: 1,
      });
    });

    // Case 4: editedBody equal to base body -> no version, base stays 4
    const res4 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        viewingVersion: 4,
        editedBody: String(v4.body),
      }));
    });
    if (res4.replay) throw new Error('Expected replay=false');
    expect(res4.baseVersion).toBe(4);
    const countDesigns = (await db.query(`SELECT count(*)::int as c FROM designs WHERE thread_id = $1`, [threadId])).rows[0].c;
    expect(countDesigns).toBe(4);
  });

  it('start sets the title once', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // First message with multi-line text
    const res1 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        text: 'Make a bracket\nwith holes',
      }));
    });
    if (res1.replay) throw new Error('Expected replay=false');

    const thread1 = (await db.query(`SELECT title FROM threads WHERE id = $1`, [threadId])).rows[0];
    expect(thread1.title).toBe('Make a bracket');

    // Commit run1
    await db.transaction(async (q) => {
      await DbRunStore.commit(q, res1.runId, {
        replyKind: 'result',
        replyMarkdown: 'Done',
        userKind: 'request',
        costUsd: 0,
        wallMs: 0,
        turns: 1,
      });
    });

    // Second message does not overwrite title
    await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        text: 'Add chamfer',
      }));
    });
    const thread2 = (await db.query(`SELECT title FROM threads WHERE id = $1`, [threadId])).rows[0];
    expect(thread2.title).toBe('Make a bracket');

    // Test 120-char first line truncated to 80 chars
    const threadId2 = crypto.randomUUID();
    const longLine = 'a'.repeat(120);
    await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId: threadId2,
        ownerKey,
        text: `${longLine}\nsecond line`,
      }));
    });
    const thread3 = (await db.query(`SELECT title FROM threads WHERE id = $1`, [threadId2])).rows[0];
    expect(thread3.title).toBe('a'.repeat(80));

    // Test a renamed title is kept
    const threadId4 = crypto.randomUUID();
    await db.query(`INSERT INTO threads(id, owner_key, title) VALUES ($1, $2, $3)`, [threadId4, ownerKey, 'Renamed Title']);
    await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId: threadId4,
        ownerKey,
        text: 'Brand new text',
      }));
    });
    const thread4 = (await db.query(`SELECT title FROM threads WHERE id = $1`, [threadId4])).rows[0];
    expect(thread4.title).toBe('Renamed Title');
  });

  it('commit: nextVersion, then the run, then the design', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // Seed v1, v2
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, body, prelude_version, summary)
       VALUES ($1, 1, null, 'designer', 'v1', 'b1', 'p1', 's1'),
              ($1, 2, 1, 'designer', 'v2', 'b2', 'p1', 's2')`,
      [threadId]
    );

    const startRes = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey, viewingVersion: 2 }));
    });
    if (startRes.replay) throw new Error('Expected replay=false');
    const runId = startRes.runId;

    // Commit with design
    const commitPlan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Design complete',
      userKind: 'edit',
      costUsd: 0.0543,
      wallMs: 1234,
      turns: 2,
      design: {
        parentVersion: 2,
        origin: 'designer',
        baseRequest: 'make wider',
        edits: ['wider'],
        body: 'b3',
        preludeVersion: 'p1',
        summary: 'Wider box',
        facts: { width: 100 },
        flags: ['failed_checks'],
      },
    };

    const commitRes = await db.transaction(async (q) => {
      return DbRunStore.commit(q, runId, commitPlan);
    });

    expect(commitRes.committed).toBe(true);
    if (!commitRes.committed) throw new Error('Expected committed=true');

    // Design v3 created
    const d3 = (await db.query(`SELECT * FROM designs WHERE thread_id = $1 AND version = 3`, [threadId])).rows[0];
    expect(d3.origin).toBe('designer');
    expect(d3.run_id).toBe(runId);
    expect(d3.parent_version).toBe(2);
    expect(d3.summary).toBe('Wider box');

    // Run done
    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
    expect(run?.designVersion).toBe(3);
    expect(run?.costUsd).toBe(0.0543);
    expect(run?.wallMs).toBe(1234);
    expect(run?.turns).toBe(2);
    expect(run?.endedAt).not.toBeNull();

    // Assistant message
    const msgs = await db.query(`SELECT * FROM messages WHERE run_id = $1 ORDER BY seq ASC`, [runId]);
    expect(msgs.rows).toHaveLength(2);
    const userMsg = msgs.rows.find((m) => m.role === 'user');
    const asstMsg = msgs.rows.find((m) => m.role === 'assistant');
    expect(userMsg).toBeDefined();
    expect(asstMsg).toBeDefined();
    expect(userMsg!.kind).toBe('edit');
    expect(asstMsg!.kind).toBe('result');
    expect(asstMsg!.content).toBe('Design complete');
    expect(asstMsg!.design_version).toBe(3);

    // End event
    expect(commitRes.end).toEqual({
      t: 'end',
      seq: run?.lastSeq,
      status: 'done',
      reply: {
        messageId: asstMsg!.id,
        kind: 'result',
        markdown: 'Design complete',
      },
      designVersion: 3,
    });

    // Active run cleared
    const thread = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [threadId])).rows[0];
    expect(thread.active_run_id).toBeNull();

    // Without a design
    const startRes2 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey, viewingVersion: 3 }));
    });
    if (startRes2.replay) throw new Error('Expected replay=false');

    const commitRes2 = await db.transaction(async (q) => {
      return DbRunStore.commit(q, startRes2.runId, {
        replyKind: 'answer',
        replyMarkdown: 'An answer',
        userKind: 'question',
        costUsd: 0.01,
        wallMs: 50,
        turns: 1,
      });
    });
    expect(commitRes2.committed).toBe(true);
    if (!commitRes2.committed) throw new Error('Expected committed=true');
    expect(commitRes2.end.designVersion).toBeUndefined();

    const run2 = await DbRunStore.get(db, startRes2.runId);
    expect(run2?.designVersion).toBeNull();
  });

  it('commit is atomic and refused after terminate', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    if (startRes.replay) throw new Error('Expected replay=false');
    const runId = startRes.runId;

    // (a) plan referencing nonexistent stlArtifact
    const invalidPlan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 100,
      turns: 1,
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'make box',
        edits: [],
        body: 'b = 1',
        preludeVersion: 'p1',
        summary: 'box',
        facts: null,
        flags: [],
        stlArtifact: 'nonexistent_art_id',
      },
    };

    let thrown = false;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.commit(q, runId, invalidPlan);
      });
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);

    // Assert NOTHING changed: run still running, active_run_id still set, no designs, no assistant message
    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('running');
    const thread = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [threadId])).rows[0];
    expect(thread.active_run_id).toBe(runId);
    const designs = (await db.query(`SELECT count(*)::int as c FROM designs WHERE thread_id = $1`, [threadId])).rows[0].c;
    expect(designs).toBe(0);
    const asstMsgs = (await db.query(`SELECT count(*)::int as c FROM messages WHERE run_id = $1 AND role = 'assistant'`, [runId])).rows[0].c;
    expect(asstMsgs).toBe(0);

    // (b) terminate, then commit
    const termRes = await db.transaction(async (q) => {
      return DbRunStore.terminate(q, runId, 'cancelled', 'cancelled');
    });
    expect(termRes.ended).toBe(true);

    const validPlan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 100,
      turns: 1,
    };
    const commitAfterTerm = await db.transaction(async (q) => {
      return DbRunStore.commit(q, runId, validPlan);
    });
    expect(commitAfterTerm).toEqual({ committed: false });

    // Assert no design, one end event, one assistant message
    const designsAfter = (await db.query(`SELECT count(*)::int as c FROM designs WHERE thread_id = $1`, [threadId])).rows[0].c;
    expect(designsAfter).toBe(0);
    const endEvents = (await db.query(`SELECT count(*)::int as c FROM run_events WHERE run_id = $1 AND type = 'end'`, [runId])).rows[0].c;
    expect(endEvents).toBe(1);
    const asstMsgsAfter = (await db.query(`SELECT count(*)::int as c FROM messages WHERE run_id = $1 AND role = 'assistant'`, [runId])).rows[0].c;
    expect(asstMsgsAfter).toBe(1);
  });

  it('terminate does nothing after commit', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    if (startRes.replay) throw new Error('Expected replay=false');
    const runId = startRes.runId;

    await db.transaction(async (q) => {
      return DbRunStore.commit(q, runId, {
        replyKind: 'result',
        replyMarkdown: 'Done',
        userKind: 'request',
        costUsd: 0.01,
        wallMs: 100,
        turns: 1,
      });
    });

    const termRes = await db.transaction(async (q) => {
      return DbRunStore.terminate(q, runId, 'cancelled', 'cancelled');
    });
    expect(termRes).toEqual({ ended: false });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
    const endEvents = (await db.query(`SELECT count(*)::int as c FROM run_events WHERE run_id = $1 AND type = 'end'`, [runId])).rows[0].c;
    expect(endEvents).toBe(1);
  });

  it('terminate records cost', async () => {
    const db = getDb();
    const threadId1 = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes1 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId: threadId1, ownerKey }));
    });
    if (startRes1.replay) throw new Error('Expected replay=false');
    const run1Id = startRes1.runId;

    await db.transaction(async (q) => {
      return DbRunStore.terminate(q, run1Id, 'cancelled', 'cancelled', 0.1234);
    });
    const run1 = await DbRunStore.get(db, run1Id);
    expect(run1?.costUsd).toBe(0.1234);

    // Heartbeat then terminate without cost keeps 0.05
    const threadId2 = crypto.randomUUID();
    const startRes2 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId: threadId2, ownerKey }));
    });
    if (startRes2.replay) throw new Error('Expected replay=false');
    const run2Id = startRes2.runId;

    await DbRunStore.heartbeat(db, run2Id, 0.05);

    await db.transaction(async (q) => {
      return DbRunStore.terminate(q, run2Id, 'failed', 'graph');
    });
    const run2 = await DbRunStore.get(db, run2Id);
    expect(run2?.costUsd).toBe(0.05);
  });

  it('exactly one end event per run', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // Test commit path + repeated commit
    const t1 = crypto.randomUUID();
    const r1 = (await db.transaction(async (q) => DbRunStore.start(q, makeStartInput({ threadId: t1, ownerKey })))).runId!;
    await DbRunStore.append(db, r1, { type: 'chunk', payload: { delta: 'a' } });
    await db.transaction(async (q) => DbRunStore.commit(q, r1, { replyKind: 'result', replyMarkdown: 'M', userKind: 'request', costUsd: 0, wallMs: 0, turns: 1 }));
    // Try commit again
    await db.transaction(async (q) => DbRunStore.commit(q, r1, { replyKind: 'result', replyMarkdown: 'M', userKind: 'request', costUsd: 0, wallMs: 0, turns: 1 }));

    // Append after end returns 0
    const seqAfterEnd = await DbRunStore.append(db, r1, { type: 'chunk', payload: { delta: 'b' } });
    expect(seqAfterEnd).toBe(0);

    const events1 = await DbRunStore.eventsSince(db, r1, 0);
    const endEvents1 = events1.filter((e) => e.type === 'end');
    expect(endEvents1).toHaveLength(1);
    const runRow1 = await DbRunStore.get(db, r1);
    expect(endEvents1[0].seq).toBe(runRow1?.lastSeq);
    expect(events1[events1.length - 1].type).toBe('end');

    // Test terminate path + repeated terminate
    const t2 = crypto.randomUUID();
    const r2 = (await db.transaction(async (q) => DbRunStore.start(q, makeStartInput({ threadId: t2, ownerKey })))).runId!;
    await db.transaction(async (q) => DbRunStore.terminate(q, r2, 'cancelled', 'cancelled'));
    await db.transaction(async (q) => DbRunStore.terminate(q, r2, 'cancelled', 'cancelled'));
    const events2 = await DbRunStore.eventsSince(db, r2, 0);
    const endEvents2 = events2.filter((e) => e.type === 'end');
    expect(endEvents2).toHaveLength(1);

    // Test reap path + repeated reap
    const t3 = crypto.randomUUID();
    const r3 = (await db.transaction(async (q) => DbRunStore.start(q, makeStartInput({ threadId: t3, ownerKey })))).runId!;
    await db.query(`UPDATE runs SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1`, [r3]);
    const reaped1 = await db.transaction(async (q) => DbRunStore.reap(q, r3));
    expect(reaped1).toBe(true);
    const reaped2 = await db.transaction(async (q) => DbRunStore.reap(q, r3));
    expect(reaped2).toBe(false);
    const events3 = await DbRunStore.eventsSince(db, r3, 0);
    expect(events3.filter((e) => e.type === 'end')).toHaveLength(1);

    // Test archive path
    const t4 = crypto.randomUUID();
    const r4 = (await db.transaction(async (q) => DbRunStore.start(q, makeStartInput({ threadId: t4, ownerKey })))).runId!;
    await db.transaction(async (q) => ThreadStore.archive(q, ownerKey, t4));
    const events4 = await DbRunStore.eventsSince(db, r4, 0);
    expect(events4.filter((e) => e.type === 'end')).toHaveLength(1);
  });

  it('archive in one transaction terminates the running run', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const foreignOwner = `owner_foreign_${crypto.randomUUID()}`;

    const startRes = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    if (startRes.replay) throw new Error('Expected replay=false');
    const runId = startRes.runId;

    // Archive by another owner -> false and nothing changes
    const archiveForeign = await db.transaction(async (q) => {
      return ThreadStore.archive(q, foreignOwner, threadId);
    });
    expect(archiveForeign).toBe(false);

    const runStillRunning = await DbRunStore.get(db, runId);
    expect(runStillRunning?.status).toBe('running');

    // Archive by owner -> true
    const archiveSuccess = await db.transaction(async (q) => {
      return ThreadStore.archive(q, ownerKey, threadId);
    });
    expect(archiveSuccess).toBe(true);

    // A cancelled with STOPPED reply and one end event
    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.error).toEqual({ code: 'cancelled' });

    const msgs = await db.query(`SELECT * FROM messages WHERE run_id = $1 AND role = 'assistant'`, [runId]);
    expect(msgs.rows).toHaveLength(1);
    expect(msgs.rows[0].content).toBe(STOPPED);

    const endEvents = await db.query(`SELECT * FROM run_events WHERE run_id = $1 AND type = 'end'`, [runId]);
    expect(endEvents.rows).toHaveLength(1);

    // Thread archived_at set, ThreadStore.get -> null
    const thread = await ThreadStore.get(db, ownerKey, threadId);
    expect(thread).toBeNull();

    // A new start on archived thread -> 404
    let errStart: StoreError | null = null;
    try {
      await db.transaction(async (q) => {
        await DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
      });
    } catch (e) {
      if (e instanceof StoreError) errStart = e;
    }
    expect(errStart?.status).toBe(404);
  });

  it('the reaper terminates stale runs with a reply', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    if (startRes.replay) throw new Error('Expected replay=false');
    const runId = startRes.runId;

    // Fresh run: reap -> false, nothing changes
    const freshReaped = await db.transaction(async (q) => DbRunStore.reap(q, runId));
    expect(freshReaped).toBe(false);

    const runFresh = await DbRunStore.get(db, runId);
    expect(runFresh?.status).toBe('running');

    // Make stale: heartbeat 2 min back
    await db.query(`UPDATE runs SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1`, [runId]);

    // listStale lists it
    const staleList1 = await DbRunStore.listStale(db);
    expect(staleList1).toContain(runId);

    // Reap -> true, failed / run_lost, RUN_LOST message, end event, active_run_id null
    const staleReaped = await db.transaction(async (q) => DbRunStore.reap(q, runId));
    expect(staleReaped).toBe(true);

    const runReaped = await DbRunStore.get(db, runId);
    expect(runReaped?.status).toBe('failed');
    expect(runReaped?.error).toEqual({ code: 'run_lost' });

    const msgs = await db.query(`SELECT * FROM messages WHERE run_id = $1 AND role = 'assistant'`, [runId]);
    expect(msgs.rows[0].content).toBe(RUN_LOST);

    const endEvents = await db.query(`SELECT * FROM run_events WHERE run_id = $1 AND type = 'end'`, [runId]);
    expect(endEvents.rows).toHaveLength(1);

    const thread = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [threadId])).rows[0];
    expect(thread.active_run_id).toBeNull();

    // listStale no longer includes it
    const staleList2 = await DbRunStore.listStale(db);
    expect(staleList2).not.toContain(runId);
  });

  it('sweep keeps referenced artifacts, queues object keys, skips locked rows', async () => {
    const db = getDb();
    const now = 1700000000000; // epoch ms
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);

    const artOldUnreferenced = `art_${crypto.randomUUID()}`;
    const artOldDesignStl = `art_${crypto.randomUUID()}`;
    const artOldDesignStep = `art_${crypto.randomUUID()}`;
    const artOldMsgAttachment = `art_${crypto.randomUUID()}`;
    const artYoung23h = `art_${crypto.randomUUID()}`;

    // Seed artifacts with controlled created_at
    // now - 25 hours
    const ts25hAgo = new Date(now - 25 * 3600 * 1000).toISOString();
    // now - 23 hours
    const ts23hAgo = new Date(now - 23 * 3600 * 1000).toISOString();

    await db.query(
      `INSERT INTO artifacts(id, owner_key, kind, bytes, object_key, created_at) VALUES
       ($1, $2, 'stl', 10, 'key_old_unref', $3),
       ($4, $2, 'stl', 10, 'key_old_stl', $3),
       ($5, $2, 'step', 10, 'key_old_step', $3),
       ($6, $2, 'image', 10, 'key_old_att', $3),
       ($7, $2, 'image', 10, 'key_young', $8)`,
      [artOldUnreferenced, ownerKey, ts25hAgo, artOldDesignStl, artOldDesignStep, artOldMsgAttachment, artYoung23h, ts23hAgo]
    );

    // Reference stl and step in design
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, body, prelude_version, summary, stl_artifact, step_artifact)
       VALUES ($1, 1, null, 'designer', 'req', 'body', 'p1', 'sum', $2, $3)`,
      [threadId, artOldDesignStl, artOldDesignStep]
    );

    // Reference image in message_attachments
    const msgId = crypto.randomUUID();
    await db.query(
      `INSERT INTO messages(id, thread_id, seq, role, kind, content) VALUES ($1, $2, 1, 'user', 'req', 'msg')`,
      [msgId, threadId]
    );
    await db.query(
      `INSERT INTO message_attachments(message_id, artifact_id) VALUES ($1, $2)`,
      [msgId, artOldMsgAttachment]
    );

    // Seed runs and run_events:
    // Run 1: ended 11 min before now -> events deleted
    const r1 = crypto.randomUUID();
    const ts11minAgo = new Date(now - 11 * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at, ended_at) VALUES ($1, $2, 'done', now(), $3)`,
      [r1, threadId, ts11minAgo]
    );
    await db.query(`INSERT INTO run_events(run_id, seq, type, payload) VALUES ($1, 1, 'msg', '{"a":1}')`, [r1]);

    // Run 2: ended 5 min before now -> events kept
    const r2 = crypto.randomUUID();
    const ts5minAgo = new Date(now - 5 * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at, ended_at) VALUES ($1, $2, 'done', now(), $3)`,
      [r2, threadId, ts5minAgo]
    );
    await db.query(`INSERT INTO run_events(run_id, seq, type, payload) VALUES ($1, 1, 'msg', '{"a":2}')`, [r2]);

    // Run 3: running -> events kept
    const r3 = crypto.randomUUID();
    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '10 minutes')`,
      [r3, threadId]
    );
    await db.query(`INSERT INTO run_events(run_id, seq, type, payload) VALUES ($1, 1, 'msg', '{"a":3}')`, [r3]);

    // Run sweep
    const sweepRes = await db.transaction(async (q) => sweep(q, now));

    expect(sweepRes.eventsDeleted).toBe(1);
    expect(sweepRes.objectKeys).toEqual(['key_old_unref']);

    // Check pending_deletes
    const pDeletes = await db.query(`SELECT object_key FROM pending_deletes WHERE object_key = 'key_old_unref'`);
    expect(pDeletes.rows).toHaveLength(1);

    // Check artifacts kept/deleted
    const arts = await db.query(`SELECT id FROM artifacts WHERE id IN ($1, $2, $3, $4, $5)`, [
      artOldUnreferenced,
      artOldDesignStl,
      artOldDesignStep,
      artOldMsgAttachment,
      artYoung23h,
    ]);
    const remainingArtIds = arts.rows.map((r) => r.id);
    expect(remainingArtIds).not.toContain(artOldUnreferenced);
    expect(remainingArtIds).toContain(artOldDesignStl);
    expect(remainingArtIds).toContain(artOldDesignStep);
    expect(remainingArtIds).toContain(artOldMsgAttachment);
    expect(remainingArtIds).toContain(artYoung23h);

    // Check run_events
    const ev1 = await db.query(`SELECT * FROM run_events WHERE run_id = $1`, [r1]);
    expect(ev1.rows).toHaveLength(0);
    const ev2 = await db.query(`SELECT * FROM run_events WHERE run_id = $1`, [r2]);
    expect(ev2.rows).toHaveLength(1);
    const ev3 = await db.query(`SELECT * FROM run_events WHERE run_id = $1`, [r3]);
    expect(ev3.rows).toHaveLength(1);
  });

  it('commit and terminate clear active_run_id only when it points at the run', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes1 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    const run1Id = startRes1.runId!;

    // Set threads.active_run_id to another id
    const otherRunId = crypto.randomUUID();
    await db.query(`UPDATE threads SET active_run_id = $1 WHERE id = $2`, [otherRunId, threadId]);

    // Commit run1
    await db.transaction(async (q) => {
      return DbRunStore.commit(q, run1Id, {
        replyKind: 'result',
        replyMarkdown: 'Done',
        userKind: 'request',
        costUsd: 0,
        wallMs: 0,
        turns: 1,
      });
    });

    const threadAfterCommit = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [threadId])).rows[0];
    expect(threadAfterCommit.active_run_id).toBe(otherRunId);

    // Test terminate
    const startRes2 = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId: crypto.randomUUID(), ownerKey }));
    });
    if (startRes2.replay) throw new Error('Expected replay=false');
    const run2Id = startRes2.runId;
    const thread2Id = startRes2.threadId;

    await db.query(`UPDATE threads SET active_run_id = $1 WHERE id = $2`, [otherRunId, thread2Id]);

    await db.transaction(async (q) => {
      return DbRunStore.terminate(q, run2Id, 'cancelled', 'cancelled');
    });

    const threadAfterTerm = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [thread2Id])).rows[0];
    expect(threadAfterTerm.active_run_id).toBe(otherRunId);
  });

  it('heartbeat returns rows updated', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    const runId = startRes.runId!;

    const updated1 = await DbRunStore.heartbeat(db, runId, 0.042);
    expect(updated1).toBe(1);

    const run = await DbRunStore.get(db, runId);
    expect(run?.costUsd).toBe(0.042);

    // End run
    await db.transaction(async (q) => {
      return DbRunStore.terminate(q, runId, 'cancelled', 'cancelled');
    });

    const updated2 = await DbRunStore.heartbeat(db, runId, 0.05);
    expect(updated2).toBe(0);
  });

  it('append numbers events and eventsSince pages them', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({ threadId, ownerKey }));
    });
    const runId = startRes.runId!;

    const s1 = await DbRunStore.append(db, runId, { type: 'chunk', payload: { i: 1 } });
    const s2 = await DbRunStore.append(db, runId, { type: 'chunk', payload: { i: 2 } });
    const s3 = await DbRunStore.append(db, runId, { type: 'chunk', payload: { i: 3 } });

    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(s3).toBe(3);

    // eventsSince(q, id, 1, 1) -> only seq 2
    const paged = await DbRunStore.eventsSince(db, runId, 1, 1);
    expect(paged).toHaveLength(1);
    expect(paged[0].seq).toBe(2);
    expect(paged[0].payload).toEqual({ i: 2 });
  });

  it('store methods require a transaction', async () => {
    const db = getDb();
    const input = makeStartInput();

    await expect(DbRunStore.start(db, input)).rejects.toThrow(
      'store method requires a transaction'
    );
  });
});
