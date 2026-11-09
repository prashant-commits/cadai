import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type Db } from '@/lib/db/db';
import { CADAI_OWNER_COOKIE } from '@/lib/owner';
import { streamRun, SSE_HEADERS, SSE_KEEPALIVE_MS, KEEPALIVE } from './stream-run';
import { GET as getEvents } from '@/app/api/runs/[runId]/events/route';
import type { RunOutcome } from '@/lib/persist/types';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const cookie = `${CADAI_OWNER_COOKIE}=${uuid}`;
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, cookie, key };
}

async function createTestRun(db: Db, ownerKey: string) {
  const threadId = crypto.randomUUID();
  const runId = `run_${crypto.randomUUID()}`;
  const deadlineAt = Date.now() + 900_000;
  await db.query(
    `INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, $3)`,
    [threadId, ownerKey, runId]
  );
  await db.query(
    `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '15 minutes')`,
    [runId, threadId]
  );
  return { threadId, runId, deadlineAt };
}

const reqEvents = (runId: string, cookie?: string) =>
  getEvents(
    new NextRequest(`http://localhost/api/runs/${runId}/events`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ runId }) }
  );

describe('SSE keep-alive and headers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('SSE headers disable proxy buffering', async () => {
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
    expect(SSE_HEADERS['Cache-Control']).toContain('no-transform');
    expect(SSE_KEEPALIVE_MS).toBe(15_000);

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const streamRes = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async () => (async function* () {})(),
    });

    expect(streamRes.headers.get('X-Accel-Buffering')).toBe('no');
    expect(streamRes.headers.get('Cache-Control')).toContain('no-transform');
    expect(streamRes.headers.get('Cache-Control')).toContain('no-cache');

    const eventsRes = await reqEvents(runId, owner.cookie);
    expect(eventsRes.headers.get('X-Accel-Buffering')).toBe('no');
    expect(eventsRes.headers.get('Cache-Control')).toContain('no-transform');
    expect(eventsRes.headers.get('Cache-Control')).toContain('no-cache');
  });

  it('chat stream emits a keep-alive every 15 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let resolveInvoke!: () => void;
    const pendingInvoke = new Promise<void>((resolve) => {
      resolveInvoke = resolve;
    });

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 10,
      turns: 1,
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async () =>
        (async function* () {
          await pendingInvoke;
          yield ['values', { outcome }];
        })(),
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';

    // Read the initial run event
    const first = await reader.read();
    text += decoder.decode(first.value, { stream: true });
    expect(text).not.toContain(KEEPALIVE);

    // Advance 10s: still no keep-alive
    vi.advanceTimersByTime(10_000);
    expect(text).not.toContain(KEEPALIVE);

    // Advance another 5s (total 15s): keep-alive is enqueued
    vi.advanceTimersByTime(5_000);
    const second = await reader.read();
    text += decoder.decode(second.value, { stream: true });
    expect(text).toContain(KEEPALIVE);

    // Release the graph and let it finish
    resolveInvoke();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });

  it('events tail emits a keep-alive every 15 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const db = getDb();
    const owner = makeOwner();
    const { runId } = await createTestRun(db, owner.key);

    const res = await reqEvents(runId, owner.cookie);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';

    // Wait a brief moment, advance 10s: no keep-alive
    vi.advanceTimersByTime(10_000);
    expect(text).not.toContain(KEEPALIVE);

    // Advance 5s (total 15s): keep-alive enqueued
    vi.advanceTimersByTime(5_000);
    const chunk = await reader.read();
    text += decoder.decode(chunk.value, { stream: true });
    expect(text).toContain(KEEPALIVE);

    await reader.cancel();
  });

  it('keep-alive stops after the client disconnects', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let resolveInvoke!: () => void;
    const pendingInvoke = new Promise<void>((resolve) => {
      resolveInvoke = resolve;
    });

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async () =>
        (async function* () {
          await pendingInvoke;
          yield [
            'values',
            {
              outcome: {
                replyKind: 'result',
                replyMarkdown: 'Done',
                userKind: 'request',
                costUsd: 0,
                wallMs: 0,
                turns: 1,
              },
            },
          ];
        })(),
    });

    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(() => {
      vi.advanceTimersByTime(15_000);
      vi.advanceTimersByTime(30_000);
    }).not.toThrow();

    resolveInvoke();
  });
});
