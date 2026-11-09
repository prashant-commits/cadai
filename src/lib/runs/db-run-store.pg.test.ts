import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { createPgDb } from '@/lib/db/pg';
import { migrate } from '@/lib/db/migrate';
import { pgTestUrl } from '@/lib/db/test-pg';
import { DbRunStore } from './db-run-store';
import { ThreadStore } from '@/lib/persist/threads';
import { sweep } from '@/lib/persist/sweep';
import {
  StoreError,
  type StartInput,
  type CommitPlan,
} from '@/lib/persist/types';
import { STOPPED, BUSY } from '@/lib/persist/phrases';
import { txRetryState, type Db } from '@/lib/db/db';
import type { Pool } from 'pg';

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function isPending(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  let settled = false;
  promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

describe('DbRunStore (Postgres concurrency)', () => {
  let db: Db & { pool: Pool };

  beforeAll(async () => {
    db = createPgDb(pgTestUrl(), { max: 4 });
    await migrate(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("UPDATE runs SET status = 'done' WHERE status = 'running'");
  });

  afterEach(() => {
    txRetryState.retryCount = 0;
    txRetryState.maxAttempts = 3;
  });

  const makeStartInput = (overrides?: Partial<StartInput>): StartInput => ({
    threadId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    ownerKey: `owner_${crypto.randomUUID()}`,
    text: 'A test prompt',
    viewingVersion: null,
    ...overrides,
  });

  it('two starts on two connections: one run, one 409', async () => {
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // Committed thread with no run
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);

    const reached1 = latch();
    const gate = latch();

    const t1 = db.transaction(async (q) => {
      const r = await DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        clientMessageId: crypto.randomUUID(),
        text: 'Message A',
      }));
      reached1.open();
      await gate.promise;
      return r;
    });

    await reached1.promise;

    const t2 = db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        clientMessageId: crypto.randomUUID(),
        text: 'Message B',
      }))
    );

    expect(await isPending(t2, 300)).toBe(true);

    gate.open();

    const [r1, r2] = await Promise.allSettled([t1, t2]);

    expect(r1.status).toBe('fulfilled');
    if (r1.status !== 'fulfilled') throw new Error('Expected t1 to be fulfilled');
    expect(r1.value.replay).toBe(false);
    if (r1.value.replay) throw new Error('Expected replay=false');
    const winningRunId = r1.value.runId;

    expect(r2.status).toBe('rejected');
    if (r2.status !== 'rejected') throw new Error('Expected t2 to be rejected');
    expect(r2.reason).toBeInstanceOf(StoreError);
    const storeErr = r2.reason as StoreError;
    expect(storeErr.status).toBe(409);
    expect(storeErr.code).toBe('run_active');
    expect(storeErr.activeRunId).toBe(winningRunId);

    // Final database state
    const runsRes = await db.query(`SELECT id, status FROM runs WHERE thread_id = $1`, [threadId]);
    expect(runsRes.rows).toHaveLength(1);
    expect(runsRes.rows[0].id).toBe(winningRunId);
    expect(runsRes.rows[0].status).toBe('running');

    const msgsRes = await db.query(`SELECT content FROM messages WHERE thread_id = $1 AND role = 'user'`, [threadId]);
    expect(msgsRes.rows).toHaveLength(1);
    expect(msgsRes.rows[0].content).toBe('Message A');

    const threadRes = await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [threadId]);
    expect(threadRes.rows[0].active_run_id).toBe(winningRunId);
  });

  it('commit vs terminate on two connections: no deadlock, one winner', async () => {
    const planWithDesign: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Design complete',
      userKind: 'request',
      costUsd: 0.05,
      wallMs: 200,
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
      },
    };

    // --- Order 1: commit holds, terminate waits ---
    const thread1 = crypto.randomUUID();
    const owner1 = `owner_${crypto.randomUUID()}`;
    const start1 = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId: thread1, ownerKey: owner1 }))
    );
    if (start1.replay) throw new Error('replay=false expected');
    const run1Id = start1.runId;

    const reached1 = latch();
    const gate1 = latch();

    const t1Order1 = db.transaction(async (q) => {
      const r = await DbRunStore.commit(q, run1Id, planWithDesign);
      reached1.open();
      await gate1.promise;
      return r;
    });

    await reached1.promise;

    const t2Order1 = db.transaction((q) =>
      DbRunStore.terminate(q, run1Id, 'cancelled', 'cancelled')
    );

    expect(await isPending(t2Order1, 300)).toBe(true);
    gate1.open();

    const [res1Commit, res1Term] = await Promise.allSettled([t1Order1, t2Order1]);
    expect(res1Commit.status).toBe('fulfilled');
    if (res1Commit.status !== 'fulfilled') throw new Error('t1Order1 failed');
    expect(res1Commit.value.committed).toBe(true);

    expect(res1Term.status).toBe('fulfilled');
    if (res1Term.status !== 'fulfilled') throw new Error('t2Order1 failed');
    expect(res1Term.value).toEqual({ ended: false });

    // Assert final DB state for Order 1: done, one design, one assistant message, one end, active_run_id null
    const run1 = await DbRunStore.get(db, run1Id);
    expect(run1?.status).toBe('done');
    expect(run1?.designVersion).toBe(1);

    const designs1 = await db.query(`SELECT * FROM designs WHERE thread_id = $1`, [thread1]);
    expect(designs1.rows).toHaveLength(1);

    const msgs1 = await db.query(`SELECT * FROM messages WHERE run_id = $1 AND role = 'assistant'`, [run1Id]);
    expect(msgs1.rows).toHaveLength(1);

    const endEvents1 = await db.query(`SELECT * FROM run_events WHERE run_id = $1 AND type = 'end'`, [run1Id]);
    expect(endEvents1.rows).toHaveLength(1);

    const threadRow1 = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [thread1])).rows[0];
    expect(threadRow1.active_run_id).toBeNull();

    // --- Order 2: terminate holds, commit waits ---
    const thread2 = crypto.randomUUID();
    const owner2 = `owner_${crypto.randomUUID()}`;
    const start2 = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId: thread2, ownerKey: owner2 }))
    );
    if (start2.replay) throw new Error('replay=false expected');
    const run2Id = start2.runId;

    const reached2 = latch();
    const gate2 = latch();

    const t1Order2 = db.transaction(async (q) => {
      const r = await DbRunStore.terminate(q, run2Id, 'cancelled', 'cancelled');
      reached2.open();
      await gate2.promise;
      return r;
    });

    await reached2.promise;

    const t2Order2 = db.transaction((q) =>
      DbRunStore.commit(q, run2Id, planWithDesign)
    );

    expect(await isPending(t2Order2, 300)).toBe(true);
    gate2.open();

    const [res2Term, res2Commit] = await Promise.allSettled([t1Order2, t2Order2]);
    expect(res2Term.status).toBe('fulfilled');
    if (res2Term.status !== 'fulfilled') throw new Error('t1Order2 failed');
    expect(res2Term.value.ended).toBe(true);

    expect(res2Commit.status).toBe('fulfilled');
    if (res2Commit.status !== 'fulfilled') throw new Error('t2Order2 failed');
    expect(res2Commit.value).toEqual({ committed: false });

    // Assert final DB state for Order 2: cancelled, no design, one assistant message (STOPPED), one end
    const run2 = await DbRunStore.get(db, run2Id);
    expect(run2?.status).toBe('cancelled');

    const designs2 = await db.query(`SELECT * FROM designs WHERE thread_id = $1`, [thread2]);
    expect(designs2.rows).toHaveLength(0);

    const msgs2 = await db.query(`SELECT * FROM messages WHERE run_id = $1 AND role = 'assistant'`, [run2Id]);
    expect(msgs2.rows).toHaveLength(1);
    expect(msgs2.rows[0].content).toBe(STOPPED);

    const endEvents2 = await db.query(`SELECT * FROM run_events WHERE run_id = $1 AND type = 'end'`, [run2Id]);
    expect(endEvents2.rows).toHaveLength(1);

    const threadRow2 = (await db.query(`SELECT active_run_id FROM threads WHERE id = $1`, [thread2])).rows[0];
    expect(threadRow2.active_run_id).toBeNull();
  });

  it('reaper vs commit on two connections', async () => {
    const plan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 50,
      turns: 1,
    };

    // --- Order 1: commit holds, reap waits ---
    const thread1 = crypto.randomUUID();
    const owner1 = `owner_${crypto.randomUUID()}`;
    const start1 = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId: thread1, ownerKey: owner1 }))
    );
    if (start1.replay) throw new Error('replay=false expected');
    const run1Id = start1.runId;

    // Make stale: heartbeat 2 min back
    await db.query(`UPDATE runs SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1`, [run1Id]);

    const reached1 = latch();
    const gate1 = latch();

    const t1Order1 = db.transaction(async (q) => {
      const r = await DbRunStore.commit(q, run1Id, plan);
      reached1.open();
      await gate1.promise;
      return r;
    });

    await reached1.promise;

    const t2Order1 = db.transaction((q) => DbRunStore.reap(q, run1Id));
    expect(await isPending(t2Order1, 300)).toBe(true);
    gate1.open();

    const [res1Commit, res1Reap] = await Promise.allSettled([t1Order1, t2Order1]);
    expect(res1Commit.status).toBe('fulfilled');
    expect((res1Commit as PromiseFulfilledResult<{ committed: boolean }>).value.committed).toBe(true);

    expect(res1Reap.status).toBe('fulfilled');
    expect((res1Reap as PromiseFulfilledResult<boolean>).value).toBe(false);

    const run1 = await DbRunStore.get(db, run1Id);
    expect(run1?.status).toBe('done');
    const endEvents1 = await db.query(`SELECT * FROM run_events WHERE run_id = $1 AND type = 'end'`, [run1Id]);
    expect(endEvents1.rows).toHaveLength(1);

    // --- Order 2: reap holds, commit waits ---
    const thread2 = crypto.randomUUID();
    const owner2 = `owner_${crypto.randomUUID()}`;
    const start2 = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId: thread2, ownerKey: owner2 }))
    );
    if (start2.replay) throw new Error('replay=false expected');
    const run2Id = start2.runId;

    await db.query(`UPDATE runs SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1`, [run2Id]);

    const reached2 = latch();
    const gate2 = latch();

    const t1Order2 = db.transaction(async (q) => {
      const r = await DbRunStore.reap(q, run2Id);
      reached2.open();
      await gate2.promise;
      return r;
    });

    await reached2.promise;

    const t2Order2 = db.transaction((q) => DbRunStore.commit(q, run2Id, plan));
    expect(await isPending(t2Order2, 300)).toBe(true);
    gate2.open();

    const [res2Reap, res2Commit] = await Promise.allSettled([t1Order2, t2Order2]);
    expect(res2Reap.status).toBe('fulfilled');
    expect((res2Reap as PromiseFulfilledResult<boolean>).value).toBe(true);

    expect(res2Commit.status).toBe('fulfilled');
    expect((res2Commit as PromiseFulfilledResult<{ committed: boolean }>).value).toEqual({ committed: false });

    const run2 = await DbRunStore.get(db, run2Id);
    expect(run2?.status).toBe('failed');
    expect(run2?.error).toEqual({ code: 'run_lost' });

    const designs2 = await db.query(`SELECT * FROM designs WHERE thread_id = $1`, [thread2]);
    expect(designs2.rows).toHaveLength(0);

    const endEvents2 = await db.query(`SELECT * FROM run_events WHERE run_id = $1 AND type = 'end'`, [run2Id]);
    expect(endEvents2.rows).toHaveLength(1);
  });

  it('archive vs start on two connections', async () => {
    // --- Order 1: ThreadStore.archive holds on thread with no run; start -> 404 ---
    const thread1 = crypto.randomUUID();
    const owner1 = `owner_${crypto.randomUUID()}`;
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [thread1, owner1]);

    const reached1 = latch();
    const gate1 = latch();

    const t1Order1 = db.transaction(async (q) => {
      const r = await ThreadStore.archive(q, owner1, thread1);
      reached1.open();
      await gate1.promise;
      return r;
    });

    await reached1.promise;

    const t2Order1 = db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId: thread1, ownerKey: owner1 }))
    );

    expect(await isPending(t2Order1, 300)).toBe(true);
    gate1.open();

    const [res1Archive, res1Start] = await Promise.allSettled([t1Order1, t2Order1]);
    expect(res1Archive.status).toBe('fulfilled');
    expect((res1Archive as PromiseFulfilledResult<boolean>).value).toBe(true);

    expect(res1Start.status).toBe('rejected');
    const err1 = (res1Start as PromiseRejectedResult).reason;
    expect(err1).toBeInstanceOf(StoreError);
    expect(err1.status).toBe(404);

    const runs1 = await db.query(`SELECT * FROM runs WHERE thread_id = $1`, [thread1]);
    expect(runs1.rows).toHaveLength(0);
    const msgs1 = await db.query(`SELECT * FROM messages WHERE thread_id = $1`, [thread1]);
    expect(msgs1.rows).toHaveLength(0);

    // --- Order 2: start holds (run created); archive -> true and terminates run ---
    const thread2 = crypto.randomUUID();
    const owner2 = `owner_${crypto.randomUUID()}`;
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [thread2, owner2]);

    const reached2 = latch();
    const gate2 = latch();

    const t1Order2 = db.transaction(async (q) => {
      const r = await DbRunStore.start(q, makeStartInput({ threadId: thread2, ownerKey: owner2 }));
      reached2.open();
      await gate2.promise;
      return r;
    });

    await reached2.promise;

    const t2Order2 = db.transaction((q) =>
      ThreadStore.archive(q, owner2, thread2)
    );

    expect(await isPending(t2Order2, 300)).toBe(true);
    gate2.open();

    const [res2Start, res2Archive] = await Promise.allSettled([t1Order2, t2Order2]);
    expect(res2Start.status).toBe('fulfilled');
    const start2Val = (res2Start as PromiseFulfilledResult<{ replay: false; runId: string }>).value;
    expect(start2Val.replay).toBe(false);
    const run2Id = start2Val.runId;

    expect(res2Archive.status).toBe('fulfilled');
    expect((res2Archive as PromiseFulfilledResult<boolean>).value).toBe(true);

    const run2 = await DbRunStore.get(db, run2Id);
    expect(run2?.status).toBe('cancelled');
    expect(run2?.error).toEqual({ code: 'cancelled' });

    const msgs2 = await db.query(`SELECT * FROM messages WHERE run_id = $1 AND role = 'assistant'`, [run2Id]);
    expect(msgs2.rows).toHaveLength(1);
    expect(msgs2.rows[0].content).toBe(STOPPED);

    const endEvents2 = await db.query(`SELECT * FROM run_events WHERE run_id = $1 AND type = 'end'`, [run2Id]);
    expect(endEvents2.rows).toHaveLength(1);

    const threadRow2 = (await db.query(`SELECT archived_at, active_run_id FROM threads WHERE id = $1`, [thread2])).rows[0];
    expect(threadRow2.archived_at).not.toBeNull();

    const runningRuns = await db.query(`SELECT * FROM runs WHERE thread_id = $1 AND status = 'running'`, [thread2]);
    expect(runningRuns.rows).toHaveLength(0);
  });

  it('reaper vs heartbeat on two connections: a fresh heartbeat wins', async () => {
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId, ownerKey }))
    );
    if (startRes.replay) throw new Error('replay=false expected');
    const runId = startRes.runId;

    // Stale run: heartbeat 2 min back
    await db.query(`UPDATE runs SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1`, [runId]);

    const reached1 = latch();
    const gate = latch();

    const t1 = db.transaction(async (q) => {
      const r = await DbRunStore.heartbeat(q, runId, 0.2);
      reached1.open();
      await gate.promise;
      return r;
    });

    await reached1.promise;

    const t2 = db.transaction((q) => DbRunStore.reap(q, runId));

    expect(await isPending(t2, 300)).toBe(true);

    gate.open();

    const [r1, r2] = await Promise.allSettled([t1, t2]);
    expect(r1.status).toBe('fulfilled');
    expect((r1 as PromiseFulfilledResult<number>).value).toBe(1);

    expect(r2.status).toBe('fulfilled');
    expect((r2 as PromiseFulfilledResult<boolean>).value).toBe(false);

    // Final database state
    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('running');
    expect(run?.costUsd).toBe(0.2);

    const endEvents = await db.query(`SELECT * FROM run_events WHERE run_id = $1 AND type = 'end'`, [runId]);
    expect(endEvents.rows).toHaveLength(0);

    const asstMsgs = await db.query(`SELECT * FROM messages WHERE run_id = $1 AND role = 'assistant'`, [runId]);
    expect(asstMsgs.rows).toHaveLength(0);
  });

  it('concurrent message seq', async () => {
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startRes = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId, ownerKey, text: 'First user message' }))
    );
    if (startRes.replay) throw new Error('replay=false expected');
    const runId = startRes.runId;

    const reached1 = latch();
    const gate = latch();

    const t1 = db.transaction(async (q) => {
      const r = await DbRunStore.commit(q, runId, {
        replyKind: 'result',
        replyMarkdown: 'Assistant reply',
        userKind: 'request',
        costUsd: 0.01,
        wallMs: 100,
        turns: 1,
      });
      reached1.open();
      await gate.promise;
      return r;
    });

    await reached1.promise;

    const t2 = db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId, ownerKey, text: 'Second user message', viewingVersion: null }))
    );

    expect(await isPending(t2, 300)).toBe(true);

    gate.open();

    const [r1, r2] = await Promise.allSettled([t1, t2]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');

    const msgs = await db.query<{ seq: number; role: string; content: string }>(
      `SELECT seq, role, content FROM messages WHERE thread_id = $1 ORDER BY seq ASC`,
      [threadId]
    );

    expect(msgs.rows).toHaveLength(3);
    expect(msgs.rows.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(msgs.rows.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs.rows[0].content).toBe('First user message');
    expect(msgs.rows[1].content).toBe('Assistant reply');
    expect(msgs.rows[2].content).toBe('Second user message');
  });

  it('the unique index rejects a second running run when the lock is skipped', async () => {
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);

    const run1Id = crypto.randomUUID();
    const run2Id = crypto.randomUUID();

    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '10 minutes')`,
      [run1Id, threadId]
    );

    let caughtErr: Record<string, unknown> | null = null;
    try {
      await db.query(
        `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '10 minutes')`,
        [run2Id, threadId]
      );
    } catch (err: unknown) {
      caughtErr = err as Record<string, unknown>;
    }

    expect(caughtErr).not.toBeNull();
    expect(caughtErr?.code).toBe('23505');
    const msg = String(caughtErr?.constraint ?? caughtErr?.message ?? '');
    expect(msg).toContain('runs_one_active');
  });

  it('sweep skips locked rows', async () => {
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const artX = `art_${crypto.randomUUID()}`;
    const artY = `art_${crypto.randomUUID()}`;
    const now = Date.now();
    const ts25hAgo = new Date(now - 25 * 3600 * 1000).toISOString();

    await db.query(
      `INSERT INTO artifacts(id, owner_key, kind, bytes, object_key, created_at) VALUES
       ($1, $2, 'image', 100, 'key_x', $3),
       ($4, $5, 'image', 100, 'key_y', $6)`,
      [artX, ownerKey, ts25hAgo, artY, ownerKey, ts25hAgo]
    );

    const reached1 = latch();
    const gate = latch();

    const t1 = db.transaction(async (q) => {
      await q.query(`SELECT * FROM artifacts WHERE id = $1 FOR UPDATE`, [artX]);
      reached1.open();
      await gate.promise;
    });

    await reached1.promise;

    // sweep on connection 2 is NOT blocked (resolves while tx1 is open)
    const sweepPromise = db.transaction((q) => sweep(q, now));
    expect(await isPending(sweepPromise, 300)).toBe(false);
    const sweepRes = await sweepPromise;

    expect(sweepRes.objectKeys).toEqual(['key_y']);

    gate.open();
    await t1;

    // After release: X still exists, Y deleted
    const remArts = await db.query(`SELECT id FROM artifacts WHERE id IN ($1, $2)`, [artX, artY]);
    expect(remArts.rows).toHaveLength(1);
    expect(remArts.rows[0].id).toBe(artX);

    const pDeletes = await db.query(
      `SELECT object_key FROM pending_deletes WHERE object_key IN ('key_x', 'key_y')`
    );
    expect(pDeletes.rows.map((r) => r.object_key)).toEqual(['key_y']);
  });

  it('start, commit and terminate never deadlock across two threads', async () => {
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // --- Order A: tx1 commit run 1, tx2 terminate run 2 ---
    const thread1 = crypto.randomUUID();
    const thread2 = crypto.randomUUID();

    const start1 = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId: thread1, ownerKey }))
    );
    const start2 = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId: thread2, ownerKey }))
    );
    const run1Id = start1.runId!;
    const run2Id = start2.runId!;

    const reached1 = latch();
    const reached2 = latch();
    const gateA = latch();

    const t1OrderA = db.transaction(async (q) => {
      reached1.open();
      await reached2.promise;
      const r = await DbRunStore.commit(q, run1Id, {
        replyKind: 'result',
        replyMarkdown: 'Done 1',
        userKind: 'request',
        costUsd: 0,
        wallMs: 0,
        turns: 1,
      });
      await gateA.promise;
      return r;
    });

    const t2OrderA = db.transaction(async (q) => {
      reached2.open();
      await reached1.promise;
      const r = await DbRunStore.terminate(q, run2Id, 'cancelled', 'cancelled');
      await gateA.promise;
      return r;
    });

    await Promise.all([reached1.promise, reached2.promise]);
    gateA.open();

    const [res1A, res2A] = await Promise.all([t1OrderA, t2OrderA]);
    expect(res1A.committed).toBe(true);
    expect(res2A.ended).toBe(true);

    // --- Order B: tx1 terminate run 3, tx2 commit run 4 ---
    const thread3 = crypto.randomUUID();
    const thread4 = crypto.randomUUID();

    const start3 = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId: thread3, ownerKey }))
    );
    const start4 = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId: thread4, ownerKey }))
    );
    const run3Id = start3.runId!;
    const run4Id = start4.runId!;

    const reached3 = latch();
    const reached4 = latch();
    const gateB = latch();

    const t1OrderB = db.transaction(async (q) => {
      reached3.open();
      await reached4.promise;
      const r = await DbRunStore.terminate(q, run3Id, 'cancelled', 'cancelled');
      await gateB.promise;
      return r;
    });

    const t2OrderB = db.transaction(async (q) => {
      reached4.open();
      await reached3.promise;
      const r = await DbRunStore.commit(q, run4Id, {
        replyKind: 'result',
        replyMarkdown: 'Done 4',
        userKind: 'request',
        costUsd: 0,
        wallMs: 0,
        turns: 1,
      });
      await gateB.promise;
      return r;
    });

    await Promise.all([reached3.promise, reached4.promise]);
    gateB.open();

    const [res1B, res2B] = await Promise.all([t1OrderB, t2OrderB]);
    expect(res1B.ended).toBe(true);
    expect(res2B.committed).toBe(true);
  });

  it('start waits behind a thread that is only locked (in-flight commit)', async () => {
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const startA = await db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({ threadId, ownerKey, text: 'Msg 1' }))
    );
    if (startA.replay) throw new Error('Expected replay=false');

    await db.transaction((q) =>
      DbRunStore.terminate(q, startA.runId, 'cancelled', 'cancelled')
    );

    const reached1 = latch();
    const gate = latch();

    const t1 = db.transaction(async (q) => {
      await q.query(`SELECT id FROM threads WHERE id = $1 FOR UPDATE`, [threadId]);
      await q.query(
        `INSERT INTO messages(id, thread_id, seq, role, kind, content)
         VALUES (gen_random_uuid(), $1, (SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE thread_id = $1), 'assistant', 'answer', 'x')`,
        [threadId]
      );
      reached1.open();
      await gate.promise;
    });

    await reached1.promise;

    const t2 = db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        clientMessageId: crypto.randomUUID(),
        text: 'Msg 4',
        viewingVersion: null,
      }))
    );

    expect(await isPending(t2, 300)).toBe(true);

    gate.open();

    const [r1, r2] = await Promise.allSettled([t1, t2]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');

    const msgs = await db.query<{ seq: number; role: string; content: string }>(
      `SELECT seq, role, content FROM messages WHERE thread_id = $1 ORDER BY seq ASC`,
      [threadId]
    );

    expect(msgs.rows).toHaveLength(4);
    expect(msgs.rows.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(msgs.rows[3].role).toBe('user');
    expect(msgs.rows[3].content).toBe('Msg 4');
  });

  it('start re-reads the thread after an in-flight archive', async () => {
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // Committed thread T of owner O, no run
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);

    const reached1 = latch();
    const gate = latch();

    // tx1: SELECT id FROM threads WHERE id=$1 FOR UPDATE; open reached1; await the gate;
    // THEN UPDATE threads SET archived_at=now(), updated_at=now() WHERE id=$1
    const t1 = db.transaction(async (q) => {
      await q.query(`SELECT id FROM threads WHERE id = $1 FOR UPDATE`, [threadId]);
      reached1.open();
      await gate.promise;
      await q.query(`UPDATE threads SET archived_at = now(), updated_at = now() WHERE id = $1`, [threadId]);
    });

    await reached1.promise;

    // tx2: DbRunStore.start on T (owner O, viewingVersion: null)
    const t2 = db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        clientMessageId: crypto.randomUUID(),
        text: 'Msg while archiving',
        viewingVersion: null,
      }))
    );

    expect(await isPending(t2, 300)).toBe(true);

    gate.open();

    const [r1, r2] = await Promise.allSettled([t1, t2]);
    expect(r1.status).toBe('fulfilled');

    expect(r2.status).toBe('rejected');
    const err = (r2 as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(StoreError);
    expect(err.status).toBe(404);

    // T has no runs and no messages
    const runsRes = await db.query(`SELECT * FROM runs WHERE thread_id = $1`, [threadId]);
    expect(runsRes.rows).toHaveLength(0);

    const msgsRes = await db.query(`SELECT * FROM messages WHERE thread_id = $1`, [threadId]);
    expect(msgsRes.rows).toHaveLength(0);
  });

  it('start re-reads the designs after an in-flight commit', async () => {
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    // Committed thread T of owner O, no run, no design
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);

    const reached1 = latch();
    const gate = latch();

    // tx1: thread FOR UPDATE; open reached1; await the gate;
    // THEN insert design v1 for T by SQL (origin 'designer', run_id null, any body)
    const t1 = db.transaction(async (q) => {
      await q.query(`SELECT id FROM threads WHERE id = $1 FOR UPDATE`, [threadId]);
      reached1.open();
      await gate.promise;
      await q.query(
        `INSERT INTO designs(thread_id, version, parent_version, origin, run_id, base_request, body, prelude_version, summary)
         VALUES ($1, 1, null, 'designer', null, 'base req', 'box = 1', 'p1', 'summary')`,
        [threadId]
      );
    });

    await reached1.promise;

    // tx2: DbRunStore.start on T with viewingVersion: null; pending as above
    const t2 = db.transaction((q) =>
      DbRunStore.start(q, makeStartInput({
        threadId,
        ownerKey,
        clientMessageId: crypto.randomUUID(),
        text: 'Msg while committing',
        viewingVersion: null,
      }))
    );

    expect(await isPending(t2, 300)).toBe(true);

    gate.open();

    const [r1, r2] = await Promise.allSettled([t1, t2]);
    expect(r1.status).toBe('fulfilled');

    // Open the gate. tx2 rejects with StoreError status 400, code stale_client. T has no runs.
    expect(r2.status).toBe('rejected');
    const err = (r2 as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(StoreError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('stale_client');

    const runsRes = await db.query(`SELECT * FROM runs WHERE thread_id = $1`, [threadId]);
    expect(runsRes.rows).toHaveLength(0);
  });

  it('lock-order probe: commit locks threads before runs', async () => {
    txRetryState.maxAttempts = 1;
    txRetryState.retryCount = 0;

    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const runId = `run_${crypto.randomUUID()}`;

    await db.query(`INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, $3)`, [threadId, ownerKey, runId]);
    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '15 minutes')`,
      [runId, threadId]
    );

    // 1. tx1 holds SELECT ... FROM threads WHERE id=$t FOR UPDATE
    const client1 = await db.pool.connect();
    await client1.query('BEGIN');
    await client1.query(`SELECT id FROM threads WHERE id = $1 FOR UPDATE`, [threadId]);

    // 2. Start commit on tx2. It must block.
    const commitPlan: CommitPlan = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 10,
      turns: 1,
    };
    const tx2 = db.transaction((q) => DbRunStore.commit(q, runId, commitPlan));
    expect(await isPending(tx2, 200)).toBe(true);

    // 3. While tx2 is blocked, tx3 runs SELECT ... FROM runs WHERE id=$r FOR UPDATE NOWAIT.
    // It must succeed, proving commit took no runs lock before blocking on the thread.
    const client3 = await db.pool.connect();
    try {
      await client3.query('BEGIN');
      const r3 = await client3.query(`SELECT id FROM runs WHERE id = $1 FOR UPDATE NOWAIT`, [runId]);
      expect(r3.rows).toHaveLength(1);
      await client3.query('COMMIT');
    } finally {
      client3.release();
    }

    // Release tx1 so tx2 can finish
    await client1.query('ROLLBACK');
    client1.release();

    const res = await tx2;
    expect(res.committed).toBe(true);
    expect(txRetryState.retryCount).toBe(0);
  });

  it('lock-order probe: terminate locks threads before runs', async () => {
    txRetryState.maxAttempts = 1;
    txRetryState.retryCount = 0;

    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const runId = `run_${crypto.randomUUID()}`;

    await db.query(`INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, $3)`, [threadId, ownerKey, runId]);
    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '15 minutes')`,
      [runId, threadId]
    );

    // 1. tx1 holds SELECT ... FROM threads WHERE id=$t FOR UPDATE
    const client1 = await db.pool.connect();
    await client1.query('BEGIN');
    await client1.query(`SELECT id FROM threads WHERE id = $1 FOR UPDATE`, [threadId]);

    // 2. Start terminate on tx2. It must block.
    const tx2 = db.transaction((q) => DbRunStore.terminate(q, runId, 'cancelled', 'cancelled'));
    expect(await isPending(tx2, 200)).toBe(true);

    // 3. While tx2 is blocked, tx3 runs SELECT ... FROM runs WHERE id=$r FOR UPDATE NOWAIT.
    const client3 = await db.pool.connect();
    try {
      await client3.query('BEGIN');
      const r3 = await client3.query(`SELECT id FROM runs WHERE id = $1 FOR UPDATE NOWAIT`, [runId]);
      expect(r3.rows).toHaveLength(1);
      await client3.query('COMMIT');
    } finally {
      client3.release();
    }

    await client1.query('ROLLBACK');
    client1.release();

    const res = await tx2;
    expect(res.ended).toBe(true);
    expect(txRetryState.retryCount).toBe(0);
  });

  it('lock-order probe: reap locks threads before runs', async () => {
    txRetryState.maxAttempts = 1;
    txRetryState.retryCount = 0;

    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const runId = `run_${crypto.randomUUID()}`;

    await db.query(`INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, $3)`, [threadId, ownerKey, runId]);
    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at, heartbeat_at)
       VALUES ($1, $2, 'running', now() + interval '15 minutes', now() - interval '200 seconds')`,
      [runId, threadId]
    );

    // 1. tx1 holds SELECT ... FROM threads WHERE id=$t FOR UPDATE
    const client1 = await db.pool.connect();
    await client1.query('BEGIN');
    await client1.query(`SELECT id FROM threads WHERE id = $1 FOR UPDATE`, [threadId]);

    // 2. Start reap on tx2. It must block.
    const tx2 = db.transaction((q) => DbRunStore.reap(q, runId));
    expect(await isPending(tx2, 200)).toBe(true);

    // 3. While tx2 is blocked, tx3 runs SELECT ... FROM runs WHERE id=$r FOR UPDATE NOWAIT.
    const client3 = await db.pool.connect();
    try {
      await client3.query('BEGIN');
      const r3 = await client3.query(`SELECT id FROM runs WHERE id = $1 FOR UPDATE NOWAIT`, [runId]);
      expect(r3.rows).toHaveLength(1);
      await client3.query('COMMIT');
    } finally {
      client3.release();
    }

    await client1.query('ROLLBACK');
    client1.release();

    const res = await tx2;
    expect(res).toBe(true);
    expect(txRetryState.retryCount).toBe(0);
  });

  it('two starts at the cap on two connections', async () => {
    const origMaxRunning = process.env.CADAI_MAX_RUNNING;
    process.env.CADAI_MAX_RUNNING = '1';

    try {
      const thread1 = crypto.randomUUID();
      const thread2 = crypto.randomUUID();
      const owner = `owner_${crypto.randomUUID()}`;

      const holdTx1 = latch();
      const tx2Started = latch();

      const p1 = db.transaction(async (q) => {
        const res = await DbRunStore.start(
          q,
          makeStartInput({ threadId: thread1, ownerKey: owner })
        );
        await holdTx1.promise;
        return res;
      });

      await new Promise((r) => setTimeout(r, 100));

      const p2 = db.transaction(async (q) => {
        tx2Started.open();
        return DbRunStore.start(
          q,
          makeStartInput({ threadId: thread2, ownerKey: owner })
        );
      });

      await tx2Started.promise;
      expect(await isPending(p2, 200)).toBe(true);

      holdTx1.open();

      const [res1, res2] = await Promise.allSettled([p1, p2]);

      expect(res1.status).toBe('fulfilled');
      expect(res2.status).toBe('rejected');
      if (res2.status === 'rejected') {
        const err = res2.reason;
        expect(err).toBeInstanceOf(StoreError);
        expect((err as StoreError).status).toBe(429);
        expect((err as StoreError).code).toBe('busy');
        expect((err as StoreError).message).toBe(BUSY);
      }
    } finally {
      if (origMaxRunning === undefined) {
        delete process.env.CADAI_MAX_RUNNING;
      } else {
        process.env.CADAI_MAX_RUNNING = origMaxRunning;
      }
    }
  });

  it('DP1: a user_edit version copies a base design\'s non-empty edits as jsonb', async () => {
    const threadId = crypto.randomUUID();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary)
       VALUES ($1, 1, null, 'designer', 'make a box', '["taller"]'::jsonb, 'w = 40  # [0:100] W', 'p1', 'box')`,
      [threadId]
    );
    const res = await db.transaction((q) =>
      DbRunStore.start(
        q,
        makeStartInput({ threadId, ownerKey, viewingVersion: 1, pinnedParams: { w: 60 } })
      )
    );
    if (res.replay) throw new Error('Expected replay=false');
    expect(res.baseVersion).toBe(2);
    const v2 = (await db.query(`SELECT origin, edits, body FROM designs WHERE thread_id = $1 AND version = 2`, [threadId])).rows[0];
    expect(v2.origin).toBe('user_edit');
    expect(v2.edits).toEqual(['taller']);
    expect(v2.body).toBe('w = 60  # [0:100] W');
  });
});
