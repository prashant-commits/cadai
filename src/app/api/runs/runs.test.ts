import { describe, it, expect, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type Db } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { CADAI_OWNER_COOKIE } from '@/lib/owner';
import { streamRun } from '@/lib/runs/stream-run';
import { STOPPED } from '@/lib/persist/phrases';
import type { RunOutcome } from '@/lib/persist/types';
import { GET as getRun } from './[runId]/route';
import { GET as getEvents } from './[runId]/events/route';
import { POST as cancelRun } from './[runId]/cancel/route';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const cookie = `${CADAI_OWNER_COOKIE}=${uuid}`;
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, cookie, key };
}

async function createTestRun(db: Db, ownerKey: string) {
  const threadId = crypto.randomUUID();
  const runId = `run_${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, $3)`,
    [threadId, ownerKey, runId]
  );
  await db.query(
    `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '15 minutes')`,
    [runId, threadId]
  );
  return { threadId, runId };
}

const reqGet = (runId: string, cookie?: string) =>
  getRun(
    new NextRequest(`http://localhost/api/runs/${runId}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ runId }) }
  );

const reqEvents = (runId: string, query = '', cookie?: string) =>
  getEvents(
    new NextRequest(`http://localhost/api/runs/${runId}/events${query}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ runId }) }
  );

const reqCancel = (runId: string, cookie?: string) =>
  cancelRun(
    new NextRequest(`http://localhost/api/runs/${runId}/cancel`, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ runId }) }
  );

describe('Runs API routes', () => {
  afterAll(async () => {
    await closeDb();
  });

  it("another owner's run is 404 on status, events and cancel", async () => {
    const db = getDb();
    const owner1 = makeOwner();
    const owner2 = makeOwner();
    const { runId } = await createTestRun(db, owner1.key);

    // No owner -> 401
    expect((await reqGet(runId)).status).toBe(401);
    expect((await reqEvents(runId)).status).toBe(401);
    expect((await reqCancel(runId)).status).toBe(401);

    // Another owner -> 404
    const resGet = await reqGet(runId, owner2.cookie);
    expect(resGet.status).toBe(404);
    const bodyGet = await resGet.json();
    expect(bodyGet.error.code).toBe('not_found');

    const resEvents = await reqEvents(runId, '', owner2.cookie);
    expect(resEvents.status).toBe(404);

    const resCancel = await reqCancel(runId, owner2.cookie);
    expect(resCancel.status).toBe(404);
  });

  it('GET /api/runs/:runId returns the run shape', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);

    const res = await reqGet(runId, owner.cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: runId,
      threadId,
      status: 'running',
      lastSeq: 0,
      designVersion: null,
      error: null,
    });
  });

  it('GET /api/runs/:runId/events rejects invalid after with 400', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { runId } = await createTestRun(db, owner.key);

    const res = await reqEvents(runId, '?after=-1', owner.cookie);
    expect(res.status).toBe(400);

    const res2 = await reqEvents(runId, '?after=abc', owner.cookie);
    expect(res2.status).toBe(400);
  });

  it('Stop on a run not in this process terminates it at once', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { runId } = await createTestRun(db, owner.key);

    // Run is not registered in this process
    const res = await reqCancel(runId, owner.cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: runId, status: 'cancelled' });

    // Stored in db
    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('cancelled');

    // End event stored
    const events = await DbRunStore.eventsSince(db, runId, 0, 100);
    const end = events.find((e) => e.type === 'end');
    expect(end).toBeDefined();
    expect((end?.payload as { reply?: { markdown?: string } })?.reply?.markdown).toBe(STOPPED);
  });

  it('Stop before the outcome → cancelled with STOPPED', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);

    // Start streaming in this process
    const streamPromise = (async () => {
      const sseRes = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        invoke: async (signal) =>
          (async function* () {
            yield ['custom', { t: 'delta', text: 'working...' }];
            // Wait until cancelled
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve());
            });
          })(),
      });
      return sseRes.text();
    })();

    // Give it a moment to register
    await new Promise((r) => setTimeout(r, 40));

    // Cancel while running in this process
    const cancelRes = await reqCancel(runId, owner.cookie);
    expect(cancelRes.status).toBe(202);
    expect(await cancelRes.json()).toEqual({ status: 'running' });

    // The stream completes
    const rawText = await streamPromise;
    const events = rawText
      .split('\n\n')
      .filter((l) => l.trim().startsWith('data: '))
      .map((l) => JSON.parse(l.trim().slice(6)));

    const endEvent = events.find((e) => e.t === 'end');
    expect(endEvent).toMatchObject({
      t: 'end',
      status: 'cancelled',
      reply: { kind: 'cancelled', markdown: STOPPED },
    });
  });

  it('the events tail never ends before the end event', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Done Box',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 100,
      turns: 1,
    };

    // Run starts
    const streamPromise = (async () => {
      const sseRes = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        invoke: async () =>
          (async function* () {
            yield ['custom', { t: 'delta', text: 'building...' }];
            await new Promise((r) => setTimeout(r, 60));
            yield ['values', { outcome }];
          })(),
      });
      return sseRes.text();
    })();

    // Wait until run is running and has emitted run event
    await new Promise((r) => setTimeout(r, 30));

    // Connect events tail while run is running
    const tailRes = await reqEvents(runId, '?after=0', owner.cookie);
    expect(tailRes.status).toBe(200);

    const tailTextPromise = tailRes.text();

    await Promise.all([streamPromise, tailTextPromise]);
    const tailText = await tailTextPromise;

    const tailEvents = tailText
      .split('\n\n')
      .filter((l) => l.trim().startsWith('data: '))
      .map((l) => JSON.parse(l.trim().slice(6)));

    expect(tailEvents.length).toBeGreaterThanOrEqual(2);
    expect(tailEvents.at(-1)?.t).toBe('end');
    expect(tailEvents.at(-1)?.status).toBe('done');
  });
});
