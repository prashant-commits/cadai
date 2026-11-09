import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { getDb, closeDb, type Queryable } from '@/lib/db/db';
import { DbRunStore } from './db-run-store';
import { ThreadStore } from '@/lib/persist/threads';
import { ProjectStore } from '@/lib/persist/projects';
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
  BUSY,
  BUDGET_USED,
} from '@/lib/persist/phrases';

describe('DbRunStore', () => {
  const origEnv = { ...process.env };

  beforeEach(async () => {
    const db = getDb();
    await db.query("UPDATE runs SET status = 'done' WHERE status = 'running'");
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

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

  async function startNew(q: Queryable, input: StartInput) {
    const proj = await ProjectStore.create(q, input.ownerKey, 'Test Project');
    return DbRunStore.start(q, { ...input, projectId: proj.id });
  }

  it('start refuses a second active run with 409 and writes nothing', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // Start run A
    const resA = await db.transaction(async (q) => {
      return startNew(q, makeStartInput({ threadId, ownerKey }));
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
      return startNew(q, makeStartInput({ threadId, ownerKey }));
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
      return startNew(q, makeStartInput({ threadId: threadId2, ownerKey }));
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
    const res1 = await db.transaction(async (q) => startNew(q, input));
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
        await startNew(q, makeStartInput({
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
        await startNew(q, makeStartInput({
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
      return startNew(q, makeStartInput({
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
    expect(v4.body).toBe('w = 80  # [0:100] W\nh = 30');

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

  it('thread with v1..v3: start with viewingVersion 1 uses v1 not latest', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary)
       VALUES ($1, 1, null, 'designer', 'make box 1', '[]'::jsonb, 'w = 10  # [0:100] W\nh = 10', 'p1', 'v1'),
              ($1, 2, 1,    'designer', 'make box 2', '[]'::jsonb, 'w = 20  # [0:100] W\nh = 20', 'p1', 'v2'),
              ($1, 3, 2,    'designer', 'make box 3', '[]'::jsonb, 'w = 30  # [0:100] W\nh = 30', 'p1', 'v3')`,
      [threadId]
    );

    // Case A: start without pins gives run.base_version === 1
    const resA = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        viewingVersion: 1,
      }));
    });
    expect(resA.replay).toBe(false);
    if (resA.replay) throw new Error('Expected replay=false');
    expect(resA.baseVersion).toBe(1);

    const runA = await DbRunStore.get(db, resA.runId);
    expect(runA?.baseVersion).toBe(1);

    // Commit runA to free active_run_id
    await db.transaction(async (q) => {
      await DbRunStore.commit(q, resA.runId, {
        replyKind: 'result',
        replyMarkdown: 'Done A',
        userKind: 'request',
        costUsd: 0,
        wallMs: 0,
        turns: 1,
      });
    });

    // Case B: with pins, user_edit version has parent_version === 1 and body derived from v1
    const resB = await db.transaction(async (q) => {
      return DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        viewingVersion: 1,
        pinnedParams: { w: 15 },
      }));
    });
    expect(resB.replay).toBe(false);
    if (resB.replay) throw new Error('Expected replay=false');
    expect(resB.baseVersion).toBe(4);

    const v4 = (await db.query(`SELECT * FROM designs WHERE thread_id = $1 AND version = 4`, [threadId])).rows[0];
    expect(Number(v4.parent_version)).toBe(1);
    expect(v4.body).toBe('w = 15  # [0:100] W\nh = 10');
  });

  it('start sets the title once', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // First message with multi-line text
    const res1 = await db.transaction(async (q) => {
      return startNew(q, makeStartInput({
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
      return startNew(q, makeStartInput({
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
    expect(d3.edits).toEqual(['wider']);
    expect(d3.flags).toEqual(['failed_checks']);

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
      return startNew(q, makeStartInput({ threadId, ownerKey }));
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
      return startNew(q, makeStartInput({ threadId, ownerKey }));
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
      return startNew(q, makeStartInput({ threadId: threadId1, ownerKey }));
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
      return startNew(q, makeStartInput({ threadId: threadId2, ownerKey }));
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
    const r1 = (await db.transaction(async (q) => startNew(q, makeStartInput({ threadId: t1, ownerKey })))).runId!;
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
    const r2 = (await db.transaction(async (q) => startNew(q, makeStartInput({ threadId: t2, ownerKey })))).runId!;
    await db.transaction(async (q) => DbRunStore.terminate(q, r2, 'cancelled', 'cancelled'));
    await db.transaction(async (q) => DbRunStore.terminate(q, r2, 'cancelled', 'cancelled'));
    const events2 = await DbRunStore.eventsSince(db, r2, 0);
    const endEvents2 = events2.filter((e) => e.type === 'end');
    expect(endEvents2).toHaveLength(1);

    // Test reap path + repeated reap
    const t3 = crypto.randomUUID();
    const r3 = (await db.transaction(async (q) => startNew(q, makeStartInput({ threadId: t3, ownerKey })))).runId!;
    await db.query(`UPDATE runs SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1`, [r3]);
    const reaped1 = await db.transaction(async (q) => DbRunStore.reap(q, r3));
    expect(reaped1).toBe(true);
    const reaped2 = await db.transaction(async (q) => DbRunStore.reap(q, r3));
    expect(reaped2).toBe(false);
    const events3 = await DbRunStore.eventsSince(db, r3, 0);
    expect(events3.filter((e) => e.type === 'end')).toHaveLength(1);

    // Test archive path
    const t4 = crypto.randomUUID();
    const r4 = (await db.transaction(async (q) => startNew(q, makeStartInput({ threadId: t4, ownerKey })))).runId!;
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
      return startNew(q, makeStartInput({ threadId, ownerKey }));
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
      return startNew(q, makeStartInput({ threadId, ownerKey }));
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

  it('the reaper waits deadline_at + 60 s', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes = await db.transaction(async (q) => {
      return startNew(q, makeStartInput({ threadId, ownerKey }));
    });
    if (startRes.replay) throw new Error('Expected replay=false');
    const runId = startRes.runId;

    // Fresh heartbeat, deadline_at is now() - 30 s:
    await db.query(
      `UPDATE runs SET heartbeat_at = now(), deadline_at = now() - interval '30 seconds' WHERE id = $1`,
      [runId]
    );

    // reap returns false and the run stays running
    const reap1 = await db.transaction(async (q) => DbRunStore.reap(q, runId));
    expect(reap1).toBe(false);

    const runFresh = await DbRunStore.get(db, runId);
    expect(runFresh?.status).toBe('running');

    // set deadline_at = now() - 61 s:
    await db.query(
      `UPDATE runs SET heartbeat_at = now(), deadline_at = now() - interval '61 seconds' WHERE id = $1`,
      [runId]
    );

    // reap ends it with error.code 'deadline' and the DEADLINE reply
    const reap2 = await db.transaction(async (q) => DbRunStore.reap(q, runId));
    expect(reap2).toBe(true);

    const runReaped = await DbRunStore.get(db, runId);
    expect(runReaped?.status).toBe('failed');
    expect(runReaped?.error).toEqual({ code: 'deadline' });

    const msgs = await db.query(
      `SELECT * FROM messages WHERE run_id = $1 AND role = 'assistant'`,
      [runId]
    );
    expect(msgs.rows[0].content).toBe(DEADLINE);
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
      return startNew(q, makeStartInput({ threadId, ownerKey }));
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
      return startNew(q, makeStartInput({ threadId: crypto.randomUUID(), ownerKey }));
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
      return startNew(q, makeStartInput({ threadId, ownerKey }));
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
      return startNew(q, makeStartInput({ threadId, ownerKey }));
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

    // commit, reap and terminate refuse to run outside a transaction too, and write nothing
    const started = await db.transaction(async (q) =>
      startNew(q, makeStartInput({ threadId: crypto.randomUUID() }))
    );
    if (started.replay) throw new Error('Expected replay=false');
    const plan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0,
      wallMs: 0,
      turns: 1,
    };
    await expect(DbRunStore.commit(db, started.runId, plan)).rejects.toThrow(
      'store method requires a transaction'
    );
    await expect(DbRunStore.reap(db, started.runId)).rejects.toThrow(
      'store method requires a transaction'
    );
    await expect(
      DbRunStore.terminate(db, started.runId, 'cancelled', 'cancelled')
    ).rejects.toThrow('store method requires a transaction');
    expect((await DbRunStore.get(db, started.runId))?.status).toBe('running');
    const asst = await db.query(
      `SELECT count(*)::int AS c FROM messages WHERE run_id = $1 AND role = 'assistant'`,
      [started.runId]
    );
    expect(asst.rows[0].c).toBe(0);
  });

  describe('start/commit edge cases', () => {
    const plan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0,
      wallMs: 0,
      turns: 1,
    };

    const startError = async (input: StartInput): Promise<StoreError> => {
      const db = getDb();
      try {
        await db.transaction(async (q) => {
          await startNew(q, input);
        });
      } catch (e) {
        if (e instanceof StoreError) return e;
        throw e;
      }
      throw new Error('Expected start to throw a StoreError');
    };

    const seedDesign = async (threadId: string, ownerKey: string, body: string, edits = '[]') => {
      const db = getDb();
      await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
      await db.query(
        `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, flags)
         VALUES ($1, 1, null, 'designer', 'box', $2::jsonb, $3, 'v1', 'box', '[]')`,
        [threadId, edits, body]
      );
    };

    it('DT1: terminate, reap and commit of an unknown run report nothing happened', async () => {
      const db = getDb();
      await db.transaction(async (q) => {
        expect(await DbRunStore.terminate(q, 'run_missing', 'cancelled', 'cancelled')).toEqual({ ended: false });
        expect(await DbRunStore.reap(q, 'run_missing')).toBe(false);
        expect(await DbRunStore.commit(q, 'run_missing', plan)).toEqual({ committed: false });
      });
    });

    it('DT2: a dangling or finished active_run_id does not block start', async () => {
      const db = getDb();
      const ownerKey = `owner_${crypto.randomUUID()}`;

      // (i) pointer to a run row that does not exist
      const ghostThread = crypto.randomUUID();
      await db.query(`INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, 'run_ghost')`, [ghostThread, ownerKey]);
      const res1 = await db.transaction(async (q) =>
        DbRunStore.start(q, makeStartInput({ threadId: ghostThread, ownerKey }))
      );
      if (res1.replay) throw new Error('Expected replay=false');
      const t1 = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [ghostThread])).rows[0];
      expect(t1.active_run_id).toBe(res1.runId);

      // (ii) pointer to a run that is already done
      const doneThread = crypto.randomUUID();
      const doneRun = `run_${crypto.randomUUID()}`;
      await db.query(`INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, $3)`, [doneThread, ownerKey, doneRun]);
      await db.query(
        `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'done', now() + interval '15 minutes')`,
        [doneRun, doneThread]
      );
      const res2 = await db.transaction(async (q) =>
        DbRunStore.start(q, makeStartInput({ threadId: doneThread, ownerKey }))
      );
      if (res2.replay) throw new Error('Expected replay=false');
      const t2 = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [doneThread])).rows[0];
      expect(t2.active_run_id).toBe(res2.runId);
      expect((await DbRunStore.get(db, doneRun))?.status).toBe('done');
    });

    it('DT3: a viewingVersion on a thread with no design is 404; an omitted one is fine', async () => {
      const ownerKey = `owner_${crypto.randomUUID()}`;
      const err = await startError(makeStartInput({ ownerKey, viewingVersion: 1 }));
      expect(err.status).toBe(404);
      expect(err.code).toBe('not_found');

      const db = getDb();
      const res = await db.transaction(async (q) =>
        startNew(q, makeStartInput({ ownerKey, viewingVersion: undefined as never }))
      );
      expect(res.replay).toBe(false);
      if (res.replay) throw new Error('Expected replay=false');
      expect(res.baseVersion).toBeNull();
    });

    it('DT4: empty pinnedParams on a new thread are not pins', async () => {
      const db = getDb();
      const res = await db.transaction(async (q) =>
        startNew(q, makeStartInput({ pinnedParams: {} }))
      );
      expect(res.replay).toBe(false);
    });

    it('DT5: pins on a thread with nothing to pin are BAD_PIN', async () => {
      const err = await startError(makeStartInput({ pinnedParams: { w: 1 } }));
      expect(err.status).toBe(400);
      expect(err.code).toBe('bad_pin');
    });

    it('DT6: an edited body on a thread with no design is STALE_CLIENT, nothing written', async () => {
      const db = getDb();
      const threadId = crypto.randomUUID();
      const ownerKey = `owner_${crypto.randomUUID()}`;
      const err = await startError(makeStartInput({ threadId, ownerKey, editedBody: 'w = 1' }));
      expect(err.status).toBe(400);
      expect(err.code).toBe('stale_client');
      const runs = await db.query(`SELECT count(*)::int AS c FROM runs WHERE thread_id = $1`, [threadId]);
      expect(runs.rows[0].c).toBe(0);
      const msgs = await db.query(`SELECT count(*)::int AS c FROM messages WHERE thread_id = $1`, [threadId]);
      expect(msgs.rows[0].c).toBe(0);
    });

    it('DT7: a pin equal to the current value creates no version', async () => {
      const db = getDb();
      const threadId = crypto.randomUUID();
      const ownerKey = `owner_${crypto.randomUUID()}`;
      await seedDesign(threadId, ownerKey, 'w = 40  # [0:100] W\nh = 10');
      const res = await db.transaction(async (q) =>
        DbRunStore.start(q, makeStartInput({ threadId, ownerKey, viewingVersion: 1, pinnedParams: { w: 40 } }))
      );
      if (res.replay) throw new Error('Expected replay=false');
      expect(res.baseVersion).toBe(1);
      const n = await db.query(`SELECT count(*)::int AS c FROM designs WHERE thread_id = $1`, [threadId]);
      expect(n.rows[0].c).toBe(1);
    });

    it('DT9: start records the model, or NULL', async () => {
      const db = getDb();
      const res1 = await db.transaction(async (q) =>
        startNew(q, makeStartInput({ model: 'm1' }))
      );
      if (res1.replay) throw new Error('Expected replay=false');
      expect((await db.query(`SELECT model FROM runs WHERE id = $1`, [res1.runId])).rows[0].model).toBe('m1');
      const res2 = await db.transaction(async (q) => startNew(q, makeStartInput()));
      if (res2.replay) throw new Error('Expected replay=false');
      expect((await db.query(`SELECT model FROM runs WHERE id = $1`, [res2.runId])).rows[0].model).toBeNull();
    });

    it('DT10: the title is the trimmed first line; a blank first line leaves it unset', async () => {
      const db = getDb();
      const titleOf = async (text: string) => {
        const threadId = crypto.randomUUID();
        await db.transaction(async (q) => startNew(q, makeStartInput({ threadId, text })));
        return (await db.query(`SELECT title FROM threads WHERE id = $1`, [threadId])).rows[0].title;
      };
      expect(await titleOf('  Padded  \nrest')).toBe('Padded');
      expect(await titleOf('   \nreal')).toBeNull();
      expect(await titleOf('')).toBeNull();
    });

    it('DT12: commit stores a design\'s edits and flags, defaulting both to []', async () => {
      const db = getDb();
      const run = async (design: Record<string, unknown>) => {
        const threadId = crypto.randomUUID();
        const started = await db.transaction(async (q) => startNew(q, makeStartInput({ threadId })));
        if (started.replay) throw new Error('Expected replay=false');
        await db.transaction(async (q) =>
          DbRunStore.commit(q, started.runId, { ...plan, design: design as unknown as CommitPlan['design'] })
        );
        return (await db.query(`SELECT edits, flags FROM designs WHERE thread_id = $1`, [threadId])).rows[0];
      };
      const base = {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'box',
        body: 'b = 1',
        preludeVersion: 'p1',
        summary: 's',
        facts: null,
      };
      const full = await run({ ...base, edits: ['a', 'b'], flags: ['failed_checks'] });
      expect(full.edits).toEqual(['a', 'b']);
      expect(full.flags).toEqual(['failed_checks']);
      const bare = await run({ ...base });
      expect(bare.edits).toEqual([]);
      expect(bare.flags).toEqual([]);
    });

    it('DT13: get of an unknown run is null', async () => {
      expect(await DbRunStore.get(getDb(), 'run_missing')).toBeNull();
    });
  });

  it('start over CADAI_MAX_RUNNING → 429 BUSY', async () => {
    process.env.CADAI_MAX_RUNNING = '2';
    const db = getDb();
    await db.query(`UPDATE runs SET status = 'done' WHERE status = 'running'`);

    const thread1 = crypto.randomUUID();
    const thread2 = crypto.randomUUID();
    const thread3 = crypto.randomUUID();
    const owner = `owner_${crypto.randomUUID()}`;

    const r1 = await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId: thread1, ownerKey: owner }))
    );
    expect(r1.replay).toBe(false);

    const r2 = await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId: thread2, ownerKey: owner }))
    );
    expect(r2.replay).toBe(false);

    // 3rd start exceeds cap 2 -> 429 BUSY
    let err: StoreError | null = null;
    try {
      await db.transaction((q) =>
        startNew(q, makeStartInput({ threadId: thread3, ownerKey: owner }))
      );
    } catch (e) {
      if (e instanceof StoreError) err = e;
    }
    expect(err).not.toBeNull();
    expect(err?.status).toBe(429);
    expect(err?.code).toBe('busy');
    expect(err?.message).toBe(BUSY);

    // After one commits, start succeeds
    const plan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 100,
      turns: 1,
    };
    await db.transaction((q) => DbRunStore.commit(q, r1.runId!, plan));

    const r3 = await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId: thread3, ownerKey: owner }))
    );
    expect(r3.replay).toBe(false);
  });

  it('stale running runs do not count toward the cap', async () => {
    process.env.CADAI_MAX_RUNNING = '2';
    process.env.CADAI_STALE_MS = '100';
    const db = getDb();
    await db.query(`UPDATE runs SET status = 'done' WHERE status = 'running'`);

    const thread1 = crypto.randomUUID();
    const thread2 = crypto.randomUUID();
    const thread3 = crypto.randomUUID();
    const owner = `owner_${crypto.randomUUID()}`;

    const r1 = await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId: thread1, ownerKey: owner }))
    );
    await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId: thread2, ownerKey: owner }))
    );

    // Make run 1 stale
    await db.query(`UPDATE runs SET heartbeat_at = now() - interval '200 milliseconds' WHERE id = $1`, [
      r1.runId,
    ]);

    // Now start on thread3 succeeds because r1 is stale
    const r3 = await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId: thread3, ownerKey: owner }))
    );
    expect(r3.replay).toBe(false);
  });

  it('CADAI_MAX_RUNNING=0 turns the cap off', async () => {
    process.env.CADAI_MAX_RUNNING = '0';
    const db = getDb();
    const owner = `owner_${crypto.randomUUID()}`;

    for (let i = 0; i < 5; i++) {
      const res = await db.transaction((q) =>
        startNew(q, makeStartInput({ threadId: crypto.randomUUID(), ownerKey: owner }))
      );
      expect(res.replay).toBe(false);
    }
  });

  it('daily cost ceiling → 429 BUDGET_USED', async () => {
    process.env.CADAI_DAILY_COST_USD = '10';
    process.env.CADAI_MAX_RUNNING = '4';
    const db = getDb();
    await db.query(`UPDATE runs SET status = 'done', cost_usd = 0, ended_at = now() - interval '2 days'`);
    const owner = `owner_${crypto.randomUUID()}`;

    // Insert a past run that ended yesterday UTC with a large cost -> must not count
    const oldThread = crypto.randomUUID();
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [oldThread, owner]);
    await db.query(
      `INSERT INTO runs(id, thread_id, status, cost_usd, ended_at, created_at, updated_at, heartbeat_at, deadline_at)
       VALUES ($1, $2, 'done', 50.0, now() - interval '2 days', now(), now(), now(), now())`,
      [`run_old_${crypto.randomUUID()}`, oldThread]
    );

    // With CADAI_DAILY_COST_USD=10, CADAI_MAX_RUNNING=4, MAX_COST_USD=1.5:
    // maxRunningForBudget * MAX_COST_USD = 4 * 1.5 = 6.
    // spent threshold = 10 - 6 = 4.
    // Committed run today with cost_usd = 4 -> threshold reached
    const threadToday = crypto.randomUUID();
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadToday, owner]);
    await db.query(
      `INSERT INTO runs(id, thread_id, status, cost_usd, ended_at, created_at, updated_at, heartbeat_at, deadline_at)
       VALUES ($1, $2, 'done', 4.0, now(), now(), now(), now(), now())`,
      [`run_today_${crypto.randomUUID()}`, threadToday]
    );

    let err: StoreError | null = null;
    try {
      await db.transaction((q) =>
        startNew(q, makeStartInput({ threadId: crypto.randomUUID(), ownerKey: owner }))
      );
    } catch (e) {
      if (e instanceof StoreError) err = e;
    }
    expect(err).not.toBeNull();
    expect(err?.status).toBe(429);
    expect(err?.code).toBe('budget');
    expect(err?.message).toBe(BUDGET_USED);

    // Update today's run cost to 3.99 -> allowed!
    await db.query(
      `UPDATE runs SET cost_usd = 3.99 WHERE thread_id = $1`,
      [threadToday]
    );

    const allowedRes = await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId: crypto.randomUUID(), ownerKey: owner }))
    );
    expect(allowedRes.replay).toBe(false);
  });

  it('the cap and the ceiling come after the owner check', async () => {
    process.env.CADAI_MAX_RUNNING = '1';
    const db = getDb();
    await db.query(`UPDATE runs SET status = 'done' WHERE status = 'running'`);
    const owner1 = `owner1_${crypto.randomUUID()}`;
    const owner2 = `owner2_${crypto.randomUUID()}`;

    // Fill the cap with owner1
    await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId: crypto.randomUUID(), ownerKey: owner1 }))
    );

    // Create a thread belonging to owner1
    const threadOwner1 = crypto.randomUUID();
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadOwner1, owner1]);

    // Attempt start on owner1's thread with owner2 credentials -> throws notFound (404), NOT 429
    await expect(
      db.transaction((q) =>
        DbRunStore.start(q, makeStartInput({ threadId: threadOwner1, ownerKey: owner2 }))
      )
    ).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it("commit stores the run's steps on the reply", async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const started = await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId, ownerKey }))
    );
    expect(started.replay).toBe(false);
    if (started.replay) return;
    const runId = started.runId;

    // Append some section and delta events
    await DbRunStore.append(db, runId, {
      type: 'section',
      payload: { t: 'section', id: 'planner', label: 'Planner', state: 'open' },
    });
    await DbRunStore.append(db, runId, {
      type: 'delta',
      payload: { t: 'delta', text: 'Step 1' },
    });
    await DbRunStore.append(db, runId, {
      type: 'delta',
      payload: { t: 'delta', text: 'Step 2' },
    });
    await DbRunStore.append(db, runId, {
      type: 'section',
      payload: { t: 'section', id: 'planner', state: 'close', status: 'ok', summary: 'Done' },
    });

    const commitPlan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done model',
      userKind: 'request',
      costUsd: 0.05,
      wallMs: 1200,
      turns: 2,
    };

    const res = await db.transaction((q) => DbRunStore.commit(q, runId, commitPlan));
    expect(res.committed).toBe(true);

    const msgRow = await db.query(
      `SELECT steps FROM messages WHERE run_id = $1 AND role = 'assistant'`,
      [runId]
    );
    expect(msgRow.rows.length).toBe(1);
    const steps = typeof msgRow.rows[0].steps === 'string'
      ? JSON.parse(msgRow.rows[0].steps)
      : msgRow.rows[0].steps;
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      kind: 'section',
      id: 'planner',
      label: 'Planner',
      status: 'ok',
      body: 'Step 1Step 2\n\nDone',
    });
  });

  it("terminate stores the run's steps on the reply", async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const started = await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId, ownerKey }))
    );
    expect(started.replay).toBe(false);
    if (started.replay) return;
    const runId = started.runId;

    await DbRunStore.append(db, runId, {
      type: 'section',
      payload: { t: 'section', id: 'designer', label: 'Designer', state: 'open' },
    });
    await DbRunStore.append(db, runId, {
      type: 'delta',
      payload: { t: 'delta', text: 'Writing CAD code...' },
    });
    await DbRunStore.append(db, runId, {
      type: 'delta',
      payload: { t: 'delta', text: 'Still writing...' },
    });
    await DbRunStore.append(db, runId, {
      type: 'section',
      payload: { t: 'section', id: 'designer', state: 'close', status: 'error', summary: 'Crashed' },
    });

    const termRes = await db.transaction((q) =>
      DbRunStore.terminate(q, runId, 'failed', 'graph')
    );
    expect(termRes.ended).toBe(true);

    const msgRow = await db.query(
      `SELECT steps FROM messages WHERE run_id = $1 AND role = 'assistant'`,
      [runId]
    );
    expect(msgRow.rows.length).toBe(1);
    const steps = typeof msgRow.rows[0].steps === 'string'
      ? JSON.parse(msgRow.rows[0].steps)
      : msgRow.rows[0].steps;
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      kind: 'section',
      id: 'designer',
      label: 'Designer',
      status: 'error',
      body: 'Writing CAD code...Still writing...\n\nCrashed',
    });
  });

  it('steps keep only the last 200 events', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const started = await db.transaction((q) =>
      startNew(q, makeStartInput({ threadId, ownerKey }))
    );
    expect(started.replay).toBe(false);
    if (started.replay) return;
    const runId = started.runId;

    // Append 250 delta events
    for (let i = 1; i <= 250; i++) {
      await DbRunStore.append(db, runId, {
        type: 'delta',
        payload: { t: 'delta', text: `d${i},` },
      });
    }

    const commitPlan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 500,
      turns: 1,
    };
    await db.transaction((q) => DbRunStore.commit(q, runId, commitPlan));

    const msgRow = await db.query(
      `SELECT steps FROM messages WHERE run_id = $1 AND role = 'assistant'`,
      [runId]
    );
    const steps = typeof msgRow.rows[0].steps === 'string'
      ? JSON.parse(msgRow.rows[0].steps)
      : msgRow.rows[0].steps;

    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe('agent');
    // First 50 deltas (d1 to d50) should be dropped; only d51..d250 present
    expect(steps[0].body).not.toContain('d1,');
    expect(steps[0].body).not.toContain('d50,');
    expect(steps[0].body).toContain('d51,');
    expect(steps[0].body).toContain('d250,');
  });

  it('start persists attachment kinds and links the artifact rows', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const artId1 = `art_${crypto.randomUUID()}`;
    const artId2 = `art_${crypto.randomUUID()}`;

    // Insert artifacts first
    await db.query(
      `INSERT INTO artifacts (id, owner_key, kind, bytes, object_key)
       VALUES ($1, $2, 'image', 100, 'obj1'), ($3, $4, 'image', 200, 'obj2')`,
      [artId1, ownerKey, artId2, ownerKey]
    );

    const started = await db.transaction((q) =>
      startNew(q, {
        ...makeStartInput({ threadId, ownerKey }),
        attachments: [
          { id: artId1, kind: 'markup' },
          { id: artId2, kind: 'reference' },
        ],
      })
    );
    expect(started.replay).toBe(false);
    if (started.replay) return;
    const runId = started.runId;

    // Check message_attachments has kind
    const attRows = await db.query(
      `SELECT artifact_id, kind FROM message_attachments WHERE message_id = $1 ORDER BY artifact_id`,
      [started.userMessageId]
    );
    const expected = [
      { artifact_id: artId1, kind: 'markup' },
      { artifact_id: artId2, kind: 'reference' },
    ].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
    expect(attRows.rows).toEqual(expected);

    // Check artifacts linked to thread_id and run_id
    const updatedArts = await db.query(
      `SELECT id, thread_id, run_id FROM artifacts WHERE id IN ($1, $2) ORDER BY id`,
      [artId1, artId2]
    );
    const expectedArts = [
      { id: artId1, thread_id: threadId, run_id: runId },
      { id: artId2, thread_id: threadId, run_id: runId },
    ].sort((a, b) => a.id.localeCompare(b.id));
    expect(updatedArts.rows).toEqual(expectedArts);
  });

  it('kind is persisted with the message attachment', async () => {
    const db = getDb();
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const artId = `art_${crypto.randomUUID()}`;

    await db.query(
      `INSERT INTO artifacts (id, owner_key, kind, bytes, object_key)
       VALUES ($1, $2, 'image', 100, 'obj')`,
      [artId, ownerKey]
    );

    const started = await db.transaction((q) =>
      startNew(q, {
        ...makeStartInput({ threadId, ownerKey }),
        attachments: [{ id: artId, kind: 'markup' }],
      })
    );
    expect(started.replay).toBe(false);
    if (started.replay) return;

    const attRows = await db.query(
      `SELECT artifact_id, kind FROM message_attachments WHERE message_id = $1`,
      [started.userMessageId]
    );
    expect(attRows.rows).toEqual([{ artifact_id: artId, kind: 'markup' }]);
  });

  it('the sweep keeps a linked image and sweeps an old unlinked one', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const linkedArtId = `art_linked_${crypto.randomUUID()}`;
    const unlinkedArtId = `art_unlinked_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();

    // Insert unlinked artifact older than 25 hours
    const now = Date.now();
    const oldTime = new Date(now - 25 * 3600 * 1000);
    await db.query(
      `INSERT INTO artifacts (id, owner_key, kind, bytes, object_key, created_at)
       VALUES ($1, $2, 'image', 100, 'unlinked_key', $3)`,
      [unlinkedArtId, ownerKey, oldTime]
    );

    // Insert linked artifact older than 25 hours
    await db.query(
      `INSERT INTO artifacts (id, owner_key, kind, bytes, object_key, created_at)
       VALUES ($1, $2, 'image', 100, 'linked_key', $3)`,
      [linkedArtId, ownerKey, oldTime]
    );

    // Create thread and message with message_attachments for linkedArtId
    await db.query(`INSERT INTO threads (id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
    const msgRes = await db.query(
      `INSERT INTO messages (thread_id, seq, role, kind, content)
       VALUES ($1, 1, 'user', 'request', 'hi') RETURNING id`,
      [threadId]
    );
    const msgId = msgRes.rows[0].id;
    await db.query(
      `INSERT INTO message_attachments (message_id, artifact_id, kind) VALUES ($1, $2, 'reference')`,
      [msgId, linkedArtId]
    );

    const sweepRes = await db.transaction((q) => sweep(q, now));
    expect(sweepRes.objectKeys).toContain('unlinked_key');
    expect(sweepRes.objectKeys).not.toContain('linked_key');

    const remaining = await db.query(`SELECT id FROM artifacts WHERE id IN ($1, $2)`, [
      unlinkedArtId,
      linkedArtId,
    ]);
    expect(remaining.rows).toEqual([{ id: linkedArtId }]);
  });

  it('sweep keeps a topo artifact referenced by a design', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const referencedTopoId = `art_topo_ref_${crypto.randomUUID()}`;
    const unreferencedTopoId = `art_topo_unref_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();

    const now = Date.now();
    const oldTime = new Date(now - 25 * 3600 * 1000);

    // Insert unreferenced topo artifact older than 25 hours
    await db.query(
      `INSERT INTO artifacts (id, owner_key, kind, bytes, object_key, created_at)
       VALUES ($1, $2, 'topo', 200, 'unref_topo_key', $3)`,
      [unreferencedTopoId, ownerKey, oldTime]
    );

    // Insert referenced topo artifact older than 25 hours
    await db.query(
      `INSERT INTO artifacts (id, owner_key, kind, bytes, object_key, created_at)
       VALUES ($1, $2, 'topo', 200, 'ref_topo_key', $3)`,
      [referencedTopoId, ownerKey, oldTime]
    );

    // Create thread and design referencing referencedTopoId in topo_artifact
    await db.query(`INSERT INTO threads (id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
    await db.query(
      `INSERT INTO designs (
        thread_id, version, parent_version, origin, base_request, edits,
        body, prelude_version, summary, topo_artifact
      ) VALUES (
        $1, 1, null, 'designer', 'test', '[]'::jsonb,
        'result = Box(1,1,1)', 'v1', 'summary', $2
      )`,
      [threadId, referencedTopoId]
    );

    const sweepRes = await db.transaction((q) => sweep(q, now));
    expect(sweepRes.objectKeys).toContain('unref_topo_key');
    expect(sweepRes.objectKeys).not.toContain('ref_topo_key');

    const remaining = await db.query(`SELECT id FROM artifacts WHERE id IN ($1, $2)`, [
      unreferencedTopoId,
      referencedTopoId,
    ]);
    expect(remaining.rows).toEqual([{ id: referencedTopoId }]);
  });
});
