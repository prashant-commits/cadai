import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { getDb, closeDb } from '@/lib/db/db';
import { getObjectStore, type ObjectStore } from '@/lib/storage/object-store';
import { register } from '@/instrumentation';
import { RUN_LOST } from '@/lib/persist/phrases';
import {
  loop,
  reapOnce,
  sweepOnce,
  shouldStartLoop,
  stopLoop,
} from './loop';

describe('Reaper and sweep loop', () => {
  beforeEach(() => {
    stopLoop();
    delete globalThis.__cadaiBootSweepCount;
  });

  afterAll(async () => {
    stopLoop();
    await closeDb();
  });

  it('the loop starts once across two register() calls, and not in build or vitest', async () => {
    // 1. shouldStartLoop conditions
    expect(shouldStartLoop({ NEXT_PHASE: 'phase-production-build' })).toBe(false);
    expect(shouldStartLoop({ VITEST: 'true' })).toBe(false);
    expect(shouldStartLoop({ VITEST: '1' })).toBe(false);
    expect(shouldStartLoop({ CADAI_EVAL_RUNNER: '1' })).toBe(false);
    expect(shouldStartLoop({ CADAI_EVAL_RUNNER: '1', CADAI_EVAL_REAPER: '1' })).toBe(true);
    expect(shouldStartLoop({})).toBe(true);

    // 2. Call register() twice with NEXT_RUNTIME=nodejs and VITEST unset
    const origRuntime = process.env.NEXT_RUNTIME;
    const origVitest = process.env.VITEST;
    const bootSweepSpy = vi.spyOn(loop, 'bootSweep');

    try {
      process.env.NEXT_RUNTIME = 'nodejs';
      delete process.env.VITEST;

      await register();
      await register();

      // Assert one loop and one boot sweep
      expect(bootSweepSpy).toHaveBeenCalledTimes(1);
      expect(globalThis.__cadaiBootSweepCount).toBe(1);
      expect(globalThis.__cadaiReaper).toBeDefined();
    } finally {
      stopLoop();
      bootSweepSpy.mockRestore();
      if (origRuntime !== undefined) {
        process.env.NEXT_RUNTIME = origRuntime;
      } else {
        delete process.env.NEXT_RUNTIME;
      }
      if (origVitest !== undefined) {
        process.env.VITEST = origVitest;
      } else {
        delete process.env.VITEST;
      }
    }
  });

  it('the PGlite boot sweep, awaited in register(), ends only runs created before the process started', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const threadOldId = crypto.randomUUID();
    const threadNewId = crypto.randomUUID();
    const runOldId = `run_old_${crypto.randomUUID()}`;
    const runNewId = `run_new_${crypto.randomUUID()}`;

    // Seed two threads (each thread can have at most one running run)
    await db.query(
      `INSERT INTO threads (id, owner_key, title, active_run_id, created_at, updated_at)
       VALUES ($1, $2, 'Boot Thread Old', $3, now(), now())`,
      [threadOldId, ownerKey, runOldId]
    );
    await db.query(
      `INSERT INTO threads (id, owner_key, title, active_run_id, created_at, updated_at)
       VALUES ($1, $2, 'Boot Thread New', $3, now(), now())`,
      [threadNewId, ownerKey, runNewId]
    );

    const processStartedAt = Date.now();

    // 1. Run created before process started
    await db.query(
      `INSERT INTO runs (id, thread_id, status, last_seq, deadline_at, heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, 'running', 1, now() + interval '15 minutes', now(), $3::timestamptz, now())`,
      [runOldId, threadOldId, new Date(processStartedAt - 60000).toISOString()]
    );

    // 2. Run created after process started (with fresh heartbeat)
    await db.query(
      `INSERT INTO runs (id, thread_id, status, last_seq, deadline_at, heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, 'running', 1, now() + interval '15 minutes', now(), $3::timestamptz, now())`,
      [runNewId, threadNewId, new Date(processStartedAt + 60000).toISOString()]
    );

    // Configure processStartedAt for the register() call
    globalThis.__cadaiProcessStartedAt = processStartedAt;

    const origRuntime = process.env.NEXT_RUNTIME;
    const origVitest = process.env.VITEST;

    try {
      process.env.NEXT_RUNTIME = 'nodejs';
      delete process.env.VITEST;

      await register();

      // Check run created before process started: ended failed/run_lost with RUN_LOST reply
      const oldCheck = await db.query(`SELECT status, error FROM runs WHERE id = $1`, [runOldId]);
      expect(oldCheck.rows[0].status).toBe('failed');
      const errObj = typeof oldCheck.rows[0].error === 'string'
        ? JSON.parse(oldCheck.rows[0].error)
        : oldCheck.rows[0].error;
      expect(errObj?.code).toBe('run_lost');

      const msgCheck = await db.query(
        `SELECT role, kind, content FROM messages WHERE run_id = $1`,
        [runOldId]
      );
      expect(msgCheck.rows).toHaveLength(1);
      expect(msgCheck.rows[0].content).toBe(RUN_LOST);

      // Check run created after process started: stays running
      const newCheck = await db.query(`SELECT status FROM runs WHERE id = $1`, [runNewId]);
      expect(newCheck.rows[0].status).toBe('running');
    } finally {
      stopLoop();
      delete globalThis.__cadaiProcessStartedAt;
      if (origRuntime !== undefined) {
        process.env.NEXT_RUNTIME = origRuntime;
      } else {
        delete process.env.NEXT_RUNTIME;
      }
      if (origVitest !== undefined) {
        process.env.VITEST = origVitest;
      } else {
        delete process.env.VITEST;
      }
    }
  });

  it('the loop reaps and sweeps', async () => {
    const db = getDb();
    const store = getObjectStore();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const threadStaleId = crypto.randomUUID();
    const threadLiveId = crypto.randomUUID();
    const threadSweepId = crypto.randomUUID();

    await db.query(
      `INSERT INTO threads (id, owner_key, title, created_at, updated_at)
       VALUES ($1, $2, 'Stale Thread', now(), now()),
              ($3, $2, 'Live Thread', now(), now()),
              ($4, $2, 'Sweep Thread', now(), now())`,
      [threadStaleId, ownerKey, threadLiveId, threadSweepId]
    );

    // --- Part 1: Reaper check ---
    const runStaleId = `run_stale_${crypto.randomUUID()}`;
    const runLiveId = `run_live_${crypto.randomUUID()}`;

    // Stale run: heartbeat 200 s ago
    await db.query(
      `INSERT INTO runs (id, thread_id, status, last_seq, deadline_at, heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, 'running', 1, now() + interval '15 minutes', now() - interval '200 seconds', now(), now())`,
      [runStaleId, threadStaleId]
    );

    // Live run: fresh heartbeat
    await db.query(
      `INSERT INTO runs (id, thread_id, status, last_seq, deadline_at, heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, 'running', 1, now() + interval '15 minutes', now(), now(), now())`,
      [runLiveId, threadLiveId]
    );

    const reapedIds = await reapOnce(db);
    expect(reapedIds).toContain(runStaleId);
    expect(reapedIds).not.toContain(runLiveId);

    const staleRunRow = await db.query(`SELECT status FROM runs WHERE id = $1`, [runStaleId]);
    expect(staleRunRow.rows[0].status).toBe('failed');

    const liveRunRow = await db.query(`SELECT status FROM runs WHERE id = $1`, [runLiveId]);
    expect(liveRunRow.rows[0].status).toBe('running');

    // --- Part 2: Sweep check ---
    const runOldEnded = `run_old_ended_${crypto.randomUUID()}`;
    const runRecentEnded = `run_rec_ended_${crypto.randomUUID()}`;

    // Run ended 15 min ago (events should be deleted)
    await db.query(
      `INSERT INTO runs (id, thread_id, status, last_seq, deadline_at, heartbeat_at, ended_at, created_at, updated_at)
       VALUES ($1, $2, 'done', 1, now(), now() - interval '15 minutes', now() - interval '15 minutes', now(), now())`,
      [runOldEnded, threadSweepId]
    );
    await db.query(
      `INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1, 1, 'info', '{"msg":"old"}'::jsonb)`,
      [runOldEnded]
    );

    // Run ended 2 min ago (events should stay)
    await db.query(
      `INSERT INTO runs (id, thread_id, status, last_seq, deadline_at, heartbeat_at, ended_at, created_at, updated_at)
       VALUES ($1, $2, 'done', 1, now(), now() - interval '2 minutes', now() - interval '2 minutes', now(), now())`,
      [runRecentEnded, threadSweepId]
    );
    await db.query(
      `INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1, 1, 'info', '{"msg":"recent"}'::jsonb)`,
      [runRecentEnded]
    );

    // Unreferenced artifact older than 24 h
    const unrefArtId = crypto.randomBytes(16).toString('base64url');
    const unrefObjKey = `artifacts/${crypto.randomBytes(16).toString('base64url')}`;
    await store.put(unrefObjKey, new Uint8Array([1, 2, 3]));

    await db.query(
      `INSERT INTO artifacts (id, owner_key, thread_id, kind, bytes, object_key, created_at)
       VALUES ($1, $2, $3, 'image', 3, $4, now() - interval '25 hours')`,
      [unrefArtId, ownerKey, threadSweepId, unrefObjKey]
    );

    // Referenced artifact older than 24 h (referenced by a design)
    const refArtId = crypto.randomBytes(16).toString('base64url');
    const refObjKey = `artifacts/${crypto.randomBytes(16).toString('base64url')}`;
    await store.put(refObjKey, new Uint8Array([4, 5, 6]));

    await db.query(
      `INSERT INTO artifacts (id, owner_key, thread_id, kind, bytes, object_key, created_at)
       VALUES ($1, $2, $3, 'stl', 3, $4, now() - interval '25 hours')`,
      [refArtId, ownerKey, threadSweepId, refObjKey]
    );
    await db.query(
      `INSERT INTO designs (thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, stl_artifact, created_at)
       VALUES ($1, 1, null, 'designer', 'make box', '[]', 'box = 1', 'v1', 'box', $2, now())`,
      [threadSweepId, refArtId]
    );

    // Run sweepOnce
    await sweepOnce(db, store, Date.now());

    // Assert: old run's events deleted
    const oldEvents = await db.query(`SELECT seq FROM run_events WHERE run_id = $1`, [runOldEnded]);
    expect(oldEvents.rows).toHaveLength(0);

    // Assert: recent run's events kept
    const recEvents = await db.query(`SELECT seq FROM run_events WHERE run_id = $1`, [runRecentEnded]);
    expect(recEvents.rows).toHaveLength(1);

    // Assert: unreferenced artifact row deleted from DB and object deleted from store
    const unrefRow = await db.query(`SELECT id FROM artifacts WHERE id = $1`, [unrefArtId]);
    expect(unrefRow.rows).toHaveLength(0);
    const unrefStream = await store.openStream(unrefObjKey);
    expect(unrefStream).toBeNull();

    // Assert: referenced artifact kept in DB and store
    const refRow = await db.query(`SELECT id FROM artifacts WHERE id = $1`, [refArtId]);
    expect(refRow.rows).toHaveLength(1);
    const refStream = await store.openStream(refObjKey);
    expect(refStream).not.toBeNull();
    refStream?.destroy();
  });

  it('pending_deletes are retried until the object is gone', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();

    await db.query(
      `INSERT INTO threads (id, owner_key, title, created_at, updated_at)
       VALUES ($1, $2, 'Pending Retry Thread', now(), now())`,
      [threadId, ownerKey]
    );

    const artId = crypto.randomBytes(16).toString('base64url');
    const objKey = `artifacts/${crypto.randomBytes(16).toString('base64url')}`;

    await db.query(
      `INSERT INTO artifacts (id, owner_key, thread_id, kind, bytes, object_key, created_at)
       VALUES ($1, $2, $3, 'image', 10, $4, now() - interval '25 hours')`,
      [artId, ownerKey, threadId, objKey]
    );

    let failDelete = true;
    const deletedKeys: string[] = [];
    const mockStore: ObjectStore = {
      put: vi.fn(),
      openStream: vi.fn(),
      delete: vi.fn(async (key: string) => {
        if (failDelete) {
          throw new Error('Simulated network error deleting object');
        }
        deletedKeys.push(key);
      }),
    };

    // First sweep: delete fails
    await sweepOnce(db, mockStore, Date.now());

    // After first sweep, row is still in pending_deletes
    const pending1 = await db.query(
      `SELECT object_key FROM pending_deletes WHERE object_key = $1`,
      [objKey]
    );
    expect(pending1.rows).toHaveLength(1);
    expect(pending1.rows[0].object_key).toBe(objKey);
    expect(deletedKeys).not.toContain(objKey);

    // Second sweep: delete succeeds
    failDelete = false;
    await sweepOnce(db, mockStore, Date.now());

    // After second sweep, row is gone and object was deleted
    const pending2 = await db.query(
      `SELECT object_key FROM pending_deletes WHERE object_key = $1`,
      [objKey]
    );
    expect(pending2.rows).toHaveLength(0);
    expect(deletedKeys).toContain(objKey);
  });
});
