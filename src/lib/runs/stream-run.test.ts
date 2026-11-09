import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { getDb, closeDb, type Db } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { abortRun } from '@/lib/runs/run-control';
import { streamRun } from './stream-run';
import { reapOnce } from '@/lib/persist/loop';
import { BUILD_FAILED, DEADLINE, SAVE_FAILED, STOPPED } from '@/lib/persist/phrases';
import type { RunOutcome } from '@/lib/persist/types';
import { put as realPut } from '@/lib/runs/owner-artifacts';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, key };
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

async function readAllEvents(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((line) => line.trim().startsWith('data: '))
    .map((line) => JSON.parse(line.trim().slice(6)));
}

describe('streamRun', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('every event is stored before the end event; exactly one end event', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

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
          yield ['custom', { t: 'section', id: 'designerNode', label: 'Designer', state: 'open' }];
          yield ['custom', { t: 'delta', text: 'hello' }];
          yield ['custom', { t: 'section', id: 'designerNode', state: 'close', status: 'ok' }];
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    const endEvents = events.filter((e) => e.t === 'end');
    expect(endEvents).toHaveLength(1);
    expect(events.at(-1)?.t).toBe('end');
    expect(endEvents[0]).toMatchObject({
      t: 'end',
      status: 'done',
      reply: { kind: 'result', markdown: 'Done' },
    });

    // S9: the first stored event is the run event
    expect(events[0]).toMatchObject({
      t: 'run',
      seq: 1,
      runId,
      threadId,
      status: 'running',
      resumed: false,
    });
    // S16: a finished run is no longer registered for local abort
    expect(abortRun(runId)).toBe(false);

    // Check database has all events stored before the end event
    const stored = await DbRunStore.eventsSince(db, runId, 0, 100);
    expect(stored.at(-1)?.type).toBe('end');
    expect(stored.length).toBe(events.length);
    for (let i = 0; i < stored.length; i++) {
      expect(stored[i].seq).toBe(i + 1);
      expect(events[i].seq).toBe(i + 1);
    }
  });

  it('completed wins over a late local abort', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Completed successfully',
      userKind: 'request',
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'box',
        edits: [],
        body: 'box = Box(10, 10, 10)',
        preludeVersion: '1',
        summary: 'Box',
        facts: null,
        flags: [],
      },
      costUsd: 0.05,
      wallMs: 100,
      turns: 1,
    };

    let signalAborted = false;

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async (signal) => {
        return (async function* () {
          yield ['values', { outcome }];
          expect(abortRun(runId)).toBe(true);
          await new Promise((r) => setTimeout(r, 10));
          signalAborted = signal.aborted;
        })();
      },
    });

    const events = await readAllEvents(res);
    expect(signalAborted).toBe(true);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'done',
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
    expect(run?.designVersion).toBe(1);
  });

  it('completed wins: generator yields values with outcome, calls abortRun, then throws AbortError', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Completed successfully',
      userKind: 'request',
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'box',
        edits: [],
        body: 'box = Box(10, 10, 10)',
        preludeVersion: '1',
        summary: 'Box',
        facts: null,
        flags: [],
      },
      costUsd: 0.05,
      wallMs: 100,
      turns: 1,
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async (signal) =>
        (async function* () {
          yield ['values', { outcome }];
          expect(abortRun(runId)).toBe(true);
          expect(signal.aborted).toBe(true);
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        })(),
    });

    const events = await readAllEvents(res);
    const endEvent = events.at(-1) as { t: string; status: string; designVersion?: number };
    expect(endEvent).toMatchObject({
      t: 'end',
      status: 'done',
    });
    expect(endEvent.designVersion).toBe(1);

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
    expect(run?.designVersion).toBe(1);
  });

  it('completed wins: generator yields values with outcome, then throws a non-abort error', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Completed successfully',
      userKind: 'request',
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'box',
        edits: [],
        body: 'box = Box(10, 10, 10)',
        preludeVersion: '1',
        summary: 'Box',
        facts: null,
        flags: [],
      },
      costUsd: 0.05,
      wallMs: 100,
      turns: 1,
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async () =>
        (async function* () {
          yield ['values', { outcome }];
          throw new Error('Graph non-abort crash');
        })(),
    });

    const events = await readAllEvents(res);
    const endEvent = events.at(-1) as { t: string; status: string; designVersion?: number };
    expect(endEvent).toMatchObject({
      t: 'end',
      status: 'done',
    });
    expect(endEvent.designVersion).toBe(1);

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
    expect(run?.designVersion).toBe(1);
  });

  it('a silent designer call outlives the stale threshold', async () => {
    process.env.CADAI_HEARTBEAT_MS = '50';
    process.env.CADAI_STALE_MS = '300';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Done after silence',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 1000,
      turns: 1,
    };

    // Reaper runs every 100ms
    const reapInterval = setInterval(() => {
      void reapOnce(db).catch(() => undefined);
    }, 100);

    try {
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        invoke: async () =>
          (async function* () {
            // Yield nothing for ~1s
            await new Promise((r) => setTimeout(r, 1000));
            yield ['values', { outcome }];
          })(),
      });

      const events = await readAllEvents(res);
      expect(events.at(-1)).toMatchObject({
        t: 'end',
        status: 'done',
      });

      const run = await DbRunStore.get(db, runId);
      expect(run?.status).toBe('done');
    } finally {
      clearInterval(reapInterval);
    }
  });

  it('the heartbeat stops when streamRun exits after a thrown commit', async () => {
    process.env.CADAI_COMMIT_RETRY_MS = '100';
    process.env.CADAI_HEARTBEAT_MS = '20';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let heartbeatCount = 0;
    const fakeStore = {
      ...DbRunStore,
      heartbeat: async (...args: Parameters<typeof DbRunStore.heartbeat>) => {
        heartbeatCount++;
        return DbRunStore.heartbeat(...args);
      },
      commit: async () => {
        throw new Error('Forced commit failure');
      },
    };

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
      deps: { store: fakeStore as typeof DbRunStore },
      invoke: async () =>
        (async function* () {
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    const countAtClose = heartbeatCount;
    expect(countAtClose).toBeGreaterThan(0);

    // Wait 100ms and verify heartbeat is no longer called
    await new Promise((r) => setTimeout(r, 100));
    expect(heartbeatCount).toBe(countAtClose);

    const last = events.at(-1) as { t: string; status: string; reply: { markdown: string } };
    expect(last).toMatchObject({
      t: 'end',
      status: 'failed',
      reply: { markdown: SAVE_FAILED },
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('failed');
    expect(run?.error).toEqual({ code: 'internal' });
  });

  it('commit retries exhausted terminates with internal and gives SAVE_FAILED', async () => {
    process.env.CADAI_COMMIT_RETRY_MS = '50';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const fakeStore = {
      ...DbRunStore,
      commit: async () => {
        throw new Error('Permanent commit failure');
      },
    };

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Outcome',
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
      deps: { store: fakeStore as typeof DbRunStore },
      invoke: async () =>
        (async function* () {
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    const last = events.at(-1) as { t: string; status: string; reply: { markdown: string } };
    expect(last).toMatchObject({
      t: 'end',
      status: 'failed',
      reply: { markdown: SAVE_FAILED },
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('failed');
    expect(run?.error).toEqual({ code: 'internal' });
  });

  it('commit and terminate both throw, and eventsSince throws too → unstored SAVE_FAILED fallback', async () => {
    process.env.CADAI_COMMIT_RETRY_MS = '50';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const fakeStore = {
      ...DbRunStore,
      commit: async () => {
        throw new Error('Forced commit failure');
      },
      terminate: async () => {
        throw new Error('Forced terminate failure');
      },
      eventsSince: async () => {
        throw new Error('Forced eventsSince failure');
      },
    };

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Outcome',
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
      deps: { store: fakeStore as typeof DbRunStore },
      invoke: async () =>
        (async function* () {
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    const endEvents = events.filter((e) => e.t === 'end');
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]).toMatchObject({
      t: 'end',
      status: 'failed',
      reply: { markdown: SAVE_FAILED },
    });
    // S8: the unstored fallback continues the sequence and carries the empty message id
    const prevSeq = (events.at(-2) as { seq: number }).seq;
    expect(endEvents[0]).toMatchObject({
      seq: prevSeq + 1,
      reply: { messageId: '', kind: 'error', markdown: SAVE_FAILED },
    });
  });

  it('heartbeat errors never end the run', async () => {
    process.env.CADAI_HEARTBEAT_MS = '20';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const fakeStore = {
      ...DbRunStore,
      heartbeat: async () => {
        throw new Error('Transient heartbeat failure');
      },
    };

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Completed successfully',
      userKind: 'request',
      costUsd: 0.01,
      wallMs: 150,
      turns: 1,
    };

    let signalAborted = false;

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      deps: { store: fakeStore as typeof DbRunStore },
      invoke: async (signal) =>
        (async function* () {
          await new Promise((r) => setTimeout(r, 150));
          signalAborted = signal.aborted;
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    expect(signalAborted).toBe(false);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'done',
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
  });

  it('append returning 0 aborts the graph within one tick and replays winners end', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let signalAborted = false;

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async (signal) =>
        (async function* () {
          // Wait for first event (run) to be processed
          await new Promise((r) => setTimeout(r, 30));

          // Terminate the run from outside
          await db.transaction((q) =>
            DbRunStore.terminate(q, runId, 'cancelled', 'cancelled')
          );

          // Yield a delta so append is called and returns 0
          yield ['custom', { t: 'delta', text: 'hello' }];

          // Wait a tick for append to process and abort
          await new Promise((r) => setTimeout(r, 30));
          signalAborted = signal.aborted;
        })(),
    });

    const events = await readAllEvents(res);
    expect(signalAborted).toBe(true);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'cancelled',
      reply: { kind: 'cancelled', markdown: STOPPED },
    });
  });

  it('heartbeat writes accumulated running cost total to database', async () => {
    process.env.CADAI_HEARTBEAT_MS = '20';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Finished',
      userKind: 'request',
      costUsd: 0.042,
      wallMs: 100,
      turns: 1,
    };

    let observedCostUsd: number | null = null;
    let observedStatus: string | null = null;

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async () =>
        (async function* () {
          // Emit cost event
          yield ['custom', { t: 'cost', usd: 0.042 }];

          // Wait for two heartbeats (~50ms)
          await new Promise((r) => setTimeout(r, 60));

          // Read while run is still running
          const row = (await db.query(`SELECT status, cost_usd FROM runs WHERE id = $1`, [runId])).rows[0];
          observedStatus = String(row.status);
          observedCostUsd = Number(row.cost_usd);

          yield ['values', { outcome }];
        })(),
    });

    await readAllEvents(res);
    expect(observedStatus).toBe('running');
    expect(observedCostUsd).toBeCloseTo(0.042, 3);
  });

  it('commit throws, then succeeds on retry', async () => {
    process.env.CADAI_COMMIT_RETRY_MS = '2000';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let commitCalls = 0;
    const fakeStore = {
      ...DbRunStore,
      commit: async (...args: Parameters<typeof DbRunStore.commit>) => {
        commitCalls++;
        if (commitCalls === 1) {
          throw new Error('Temporary commit error');
        }
        return DbRunStore.commit(...args);
      },
    };

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Done on retry',
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
      deps: { store: fakeStore as typeof DbRunStore },
      invoke: async () =>
        (async function* () {
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    expect(commitCalls).toBe(2);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'done',
    });
  });

  it('commit committed:false replays the winner\'s end', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'My outcome',
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
          // Terminate the run from outside before returning outcome
          await db.transaction((q) =>
            DbRunStore.terminate(q, runId, 'cancelled', 'cancelled')
          );
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'cancelled',
      reply: { kind: 'cancelled', markdown: STOPPED },
    });
  });

  it('append down for under 30 s loses nothing', async () => {
    process.env.CADAI_APPEND_WINDOW_MS = '2000';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let appendFails = 2;
    const fakeStore = {
      ...DbRunStore,
      append: async (...args: Parameters<typeof DbRunStore.append>) => {
        if (appendFails > 0) {
          appendFails--;
          throw new Error('Temporary append failure');
        }
        return DbRunStore.append(...args);
      },
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      deps: { store: fakeStore as typeof DbRunStore },
      invoke: async () =>
        (async function* () {
          yield ['custom', { t: 'delta', text: 'part1' }];
          yield ['custom', { t: 'delta', text: 'part2' }];
          yield ['values', { outcome: { replyKind: 'result', replyMarkdown: 'Done', userKind: 'request', costUsd: 0, wallMs: 0, turns: 1 } }];
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.some((e) => e.t === 'delta' && (e as { text: string }).text === 'part1')).toBe(true);
    expect(events.some((e) => e.t === 'delta' && (e as { text: string }).text === 'part2')).toBe(true);
    expect(events.at(-1)?.t).toBe('end');
  });

  it('append down for over 30 s with an outcome → the design still commits', async () => {
    process.env.CADAI_APPEND_WINDOW_MS = '100';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let appendCalls = 0;
    const fakeStore = {
      ...DbRunStore,
      append: async (...args: Parameters<typeof DbRunStore.append>) => {
        appendCalls++;
        // Allow the initial 'run' event, then fail
        if (appendCalls > 1) {
          throw new Error('Persistent append outage');
        }
        return DbRunStore.append(...args);
      },
    };

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Done despite outage',
      userKind: 'request',
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'box',
        edits: [],
        body: 'box = Box(10, 10, 10)',
        preludeVersion: '1',
        summary: 'Outage box',
        facts: null,
        flags: [],
      },
      costUsd: 0.02,
      wallMs: 50,
      turns: 1,
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      deps: { store: fakeStore as typeof DbRunStore },
      invoke: async () =>
        (async function* () {
          yield ['custom', { t: 'delta', text: 'will fail append' }];
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'done',
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
    expect(run?.designVersion).toBe(1);
  });

  it('append down for over 30 s without an outcome → SAVE_FAILED', async () => {
    process.env.CADAI_APPEND_WINDOW_MS = '100';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let appendCalls = 0;
    const fakeStore = {
      ...DbRunStore,
      append: async (...args: Parameters<typeof DbRunStore.append>) => {
        appendCalls++;
        if (appendCalls > 1) {
          throw new Error('Persistent append outage');
        }
        return DbRunStore.append(...args);
      },
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      deps: { store: fakeStore as typeof DbRunStore },
      invoke: async () =>
        (async function* () {
          yield ['custom', { t: 'delta', text: 'failing' }];
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'failed',
      reply: { kind: 'error', markdown: SAVE_FAILED },
    });
  });

  it('a remote terminate aborts the owner within one heartbeat', async () => {
    process.env.CADAI_HEARTBEAT_MS = '50';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let signalAborted = false;
    let terminatedAt = 0;
    let abortAt = 0;

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async (signal) => {
        signal.addEventListener('abort', () => {
          abortAt = Date.now();
          signalAborted = true;
        });
        return (async function* () {
          // Terminate externally after 20ms
          setTimeout(async () => {
            await db.transaction((q) =>
              DbRunStore.terminate(q, runId, 'cancelled', 'cancelled')
            );
            terminatedAt = Date.now();
          }, 20);

          // Wait until aborted
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve());
          });
        })();
      },
    });

    const events = await readAllEvents(res);
    expect(signalAborted).toBe(true);
    expect(abortAt - terminatedAt).toBeLessThan(150);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'cancelled',
      reply: { kind: 'cancelled', markdown: STOPPED },
    });
  });

  it('a client disconnect does not abort the run', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    let abortedLocally = false;

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Committed after disconnect',
      userKind: 'request',
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'box',
        edits: [],
        body: 'box = Box(10, 10, 10)',
        preludeVersion: '1',
        summary: 'Box',
        facts: null,
        flags: [],
      },
      costUsd: 0.01,
      wallMs: 50,
      turns: 1,
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async (signal) => {
        signal.addEventListener('abort', () => {
          abortedLocally = true;
        });
        return (async function* () {
          yield ['custom', { t: 'delta', text: 'part1' }];
          await new Promise((r) => setTimeout(r, 60));
          yield ['values', { outcome }];
        })();
      },
    });

    // Cancel reader mid-run
    const reader = res.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    // Give run time to finish
    await new Promise((r) => setTimeout(r, 150));

    expect(abortedLocally).toBe(false);
    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
  });

  it('a graph throw → BUILD_FAILED', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async () =>
        (async function* () {
          throw new Error('Graph execution exploded');
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'failed',
      reply: { kind: 'error', markdown: BUILD_FAILED },
    });
  });

  it('a mesh upload failure → SAVE_FAILED, no version', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'box',
        edits: [],
        body: 'box = Box(10, 10, 10)',
        preludeVersion: '1',
        summary: 'Box',
        facts: null,
        flags: [],
        stl: 'solid box ...',
      },
      costUsd: 0.01,
      wallMs: 10,
      turns: 1,
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      deps: {
        putArtifact: async () => {
          throw new Error('Upload to S3 failed');
        },
      },
      invoke: async () =>
        (async function* () {
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'failed',
      reply: { kind: 'error', markdown: SAVE_FAILED },
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('failed');
    expect(run?.designVersion).toBeNull();
  });

  it('outcome never reaches the client', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);

    const SECRET_BODY = 'secret_cad_script_body_xyz';
    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Clean summary',
      userKind: 'request',
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'box',
        edits: [],
        body: SECRET_BODY,
        preludeVersion: '1',
        summary: 'Clean summary',
        facts: null,
        flags: [],
      },
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
          yield ['values', { outcome }];
        })(),
    });

    const rawText = await res.text();
    expect(rawText).not.toContain(SECRET_BODY);
    expect(rawText).not.toContain('"outcome"');
    expect(rawText).not.toContain('"replyMarkdown"');
    expect(rawText).toContain('Clean summary');
  });

  it('deadline → the owner aborts and terminates with DEADLINE', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);
    const deadlineAt = Date.now() + 100;

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async (signal) =>
        (async function* () {
          if (!signal.aborted) {
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          }
        })(),
    });

    const events = await readAllEvents(res);
    const endEvent = events.at(-1);
    expect(endEvent).toMatchObject({
      t: 'end',
      status: 'failed',
      reply: { kind: 'error', markdown: DEADLINE },
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('failed');
    expect(run?.error?.code).toBe('deadline');
  });

  it('Stop before the deadline still ends cancelled', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);
    const deadlineAt = Date.now() + 100;

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt,
      invoke: async () =>
        (async function* () {
          abortRun(runId);
          await new Promise((r) => setTimeout(r, 120));
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'cancelled',
      reply: { kind: 'cancelled', markdown: STOPPED },
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.error?.code).toBe('cancelled');
  });

  it('an outcome at the deadline still commits', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);
    const deadlineAt = Date.now() + 50;

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Finished in time',
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
          yield ['values', { outcome }];
          await new Promise((r) => setTimeout(r, 80));
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'done',
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
  });

  it('a cancelled run records its cost', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt: Date.now() + 900_000,
      invoke: async (signal) =>
        (async function* () {
          yield ['custom', { t: 'cost', usd: 0.0123 }];
          yield ['custom', { t: 'cost', usd: 0.0200 }];
          abortRun(runId);
          if (!signal.aborted) {
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          }
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'cancelled',
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('cancelled');
    expect(Number(run?.costUsd?.toFixed(4))).toBe(0.0323);
  });

  it('commit records the streamed cost total', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0.99,
      wallMs: 10,
      turns: 1,
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt: Date.now() + 900_000,
      invoke: async () =>
        (async function* () {
          yield ['custom', { t: 'cost', usd: 0.02 }];
          yield ['custom', { t: 'cost', usd: 0.03 }];
          yield ['values', { outcome }];
        })(),
    });

    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({
      t: 'end',
      status: 'done',
    });

    const run = await DbRunStore.get(db, runId);
    expect(run?.status).toBe('done');
    expect(Number(run?.costUsd?.toFixed(2))).toBe(0.05);
  });

  describe('streamRun edge cases (T2)', () => {
    const OUTCOME: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      costUsd: 0,
      wallMs: 1,
      turns: 1,
    };
    const DESIGN = {
      parentVersion: null,
      origin: 'designer' as const,
      baseRequest: 'box',
      edits: [],
      body: 'box = Box(10, 10, 10)',
      preludeVersion: '1',
      summary: 'Box',
      facts: null,
      flags: [],
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const waitForRunEvent = (db: Db, runId: string) =>
      vi.waitFor(async () => {
        expect((await DbRunStore.eventsSince(db, runId, 0, 10)).length).toBeGreaterThan(0);
      });
    const aborted = (signal: AbortSignal) =>
      new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));
    const waitForStatus = (db: Db, runId: string, status: string) =>
      vi.waitFor(async () => {
        expect((await DbRunStore.get(db, runId))?.status).toBe(status);
      }, { timeout: 10_000 });

    const fakeDb = (): Db =>
      ({
        kind: 'pglite',
        query: async () => ({ rows: [], rowCount: 0 }),
        transaction: async (fn: (q: unknown) => unknown) =>
          fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
        close: async () => undefined,
      }) as unknown as Db;
    const endRow = {
      t: 'end' as const,
      seq: 99,
      status: 'failed' as const,
      reply: { messageId: 'm', kind: 'error' as const, markdown: SAVE_FAILED },
    };

    it('S1: the response carries the SSE headers', async () => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        invoke: async () =>
          (async function* () {
            yield ['values', { outcome: OUTCOME }];
          })(),
      });
      expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(res.headers.get('connection')).toBe('keep-alive');
      await res.text();
    });

    it.each([[undefined], ['0'], ['-5'], ['abc'], ['Infinity']])(
      'S2: CADAI_HEARTBEAT_MS=%s falls back to the 15 s default',
      async (value) => {
        if (value !== undefined) process.env.CADAI_HEARTBEAT_MS = value;
        else delete process.env.CADAI_HEARTBEAT_MS;
        const db = getDb();
        const owner = makeOwner();
        const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
        let beats = 0;
        const fakeStore = {
          ...DbRunStore,
          heartbeat: async (...args: Parameters<typeof DbRunStore.heartbeat>) => {
            beats++;
            return DbRunStore.heartbeat(...args);
          },
        };
        const res = streamRun({
          runId,
          threadId,
          ownerKey: owner.key,
          deadlineAt,
          deps: { store: fakeStore as typeof DbRunStore },
          invoke: async () =>
            (async function* () {
              await sleep(150);
              yield ['values', { outcome: OUTCOME }];
            })(),
        });
        await res.text();
        expect(beats).toBe(0);
      }
    );

    const BIG = 'x'.repeat(10_000);
    const runWithDeltas = async (count: number) => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        invoke: async () =>
          (async function* () {
            for (let i = 0; i < count; i++) yield ['custom', { t: 'delta', text: BIG }];
            yield ['values', { outcome: OUTCOME }];
          })(),
      });
      // nobody reads the body until the run has finished
      await waitForStatus(db, runId, 'done');
      return res;
    };

    it('S3a: with the default backlog a slow client still gets everything', async () => {
      const res = await runWithDeltas(20);
      const text = await res.text();
      expect(text).toContain('"t":"end"');
    });

    it('S3b: a client under the high-water mark is never cut off', async () => {
      process.env.CADAI_CLIENT_BACKLOG_BYTES = '1000';
      const res = await runWithDeltas(3);
      const text = await res.text();
      expect(text).toContain('"t":"end"');
    });

    it('S3c: a client far behind is errored with the reconnect message; the run still commits', async () => {
      process.env.CADAI_CLIENT_BACKLOG_BYTES = '1000';
      const res = await runWithDeltas(20);
      await expect(res.text()).rejects.toThrow(/fell too far behind/);
    });

    it('S18: a client queued exactly at the backlog threshold is not cut off', async () => {
      // Calibrate: with the default backlog, read every frame and measure the bytes queued
      // before the end event (frame sizes are identical between runs: same ids, same payloads).
      const calib = await (await runWithDeltas(7)).text();
      const frames = calib.split('\n\n').filter((f) => f.startsWith('data: '));
      expect(JSON.parse(frames.at(-1)!.slice(6)).t).toBe('end');
      const queuedBeforeEnd = frames
        .slice(0, -1)
        .reduce((n, f) => n + Buffer.byteLength(`${f}\n\n`), 0);
      const HWM = 64 * 1024;
      const backlog = queuedBeforeEnd - HWM;
      expect(backlog).toBeGreaterThan(0);

      // desiredSize = HWM - queued = -backlog exactly when the end event is written: `<` keeps the client.
      process.env.CADAI_CLIENT_BACKLOG_BYTES = String(backlog);
      const atThreshold = await (await runWithDeltas(7)).text();
      expect(atThreshold).toContain('"t":"end"');

      // one byte less and the same client is cut off (proves the equality is exact)
      process.env.CADAI_CLIENT_BACKLOG_BYTES = String(backlog - 1);
      await expect((await runWithDeltas(7)).text()).rejects.toThrow(/fell too far behind/);
    });

    it('S4: commit retries follow 50/100/200/400 ms backoff clamped to the window', async () => {
      process.env.CADAI_COMMIT_RETRY_MS = '1000';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      try {
        const times: number[] = [];
        let seq = 0;
        const fakeStore = {
          ...DbRunStore,
          append: async () => ++seq,
          heartbeat: async () => 1,
          commit: async () => {
            times.push(Date.now());
            if (times.length < 8) throw new Error('commit down');
            return { committed: true as const, end: { ...endRow, status: 'done' as const } };
          },
          terminate: async () => ({ ended: true as const, end: endRow }),
        };
        const res = streamRun({
          runId: 'run_fake',
          threadId: crypto.randomUUID(),
          ownerKey: 'owner',
          deadlineAt: Date.now() + 900_000,
          deps: { db: fakeDb(), store: fakeStore as unknown as typeof DbRunStore },
          invoke: async () =>
            (async function* () {
              yield ['values', { outcome: OUTCOME }];
            })(),
        });
        const text = res.text();
        await vi.advanceTimersByTimeAsync(1500);
        await text;
        expect(times.map((t) => t - times[0])).toEqual([0, 50, 150, 350, 750, 1000]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('S5: append retries follow the same backoff, then the graph is aborted', async () => {
      process.env.CADAI_APPEND_WINDOW_MS = '1000';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      try {
        const times: number[] = [];
        let calls = 0;
        let signal: AbortSignal | undefined;
        const fakeStore = {
          ...DbRunStore,
          append: async () => {
            calls++;
            if (calls === 1) return 1;
            times.push(Date.now());
            if (times.length < 8) throw new Error('append down');
            return calls;
          },
          heartbeat: async () => 1,
          terminate: async () => ({ ended: true as const, end: endRow }),
        };
        const res = streamRun({
          runId: 'run_fake',
          threadId: crypto.randomUUID(),
          ownerKey: 'owner',
          deadlineAt: Date.now() + 900_000,
          deps: { db: fakeDb(), store: fakeStore as unknown as typeof DbRunStore },
          invoke: async (sig) => {
            signal = sig;
            return (async function* () {
              yield ['custom', { t: 'delta', text: 'x' }];
            })();
          },
        });
        const text = res.text();
        await vi.advanceTimersByTimeAsync(1500);
        await text;
        expect(times.map((t) => t - times[0])).toEqual([0, 50, 150, 350, 750, 1000]);
        expect(signal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    const stlOutcome = (): RunOutcome => ({
      replyKind: 'result',
      replyMarkdown: 'Done',
      userKind: 'request',
      design: { ...DESIGN, stl: 'solid x' },
      costUsd: 0,
      wallMs: 1,
      turns: 1,
    });

    it('S7: a run that ended elsewhere (append returns 0) uploads and commits nothing', async () => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      const putArtifact = vi.fn(realPut);
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        deps: { putArtifact },
        invoke: async (signal) =>
          (async function* () {
            await waitForRunEvent(db, runId);
            await db.transaction((q) => DbRunStore.terminate(q, runId, 'cancelled', 'cancelled'));
            yield ['custom', { t: 'delta', text: 'x' }];
            await aborted(signal);
            yield ['values', { outcome: stlOutcome() }];
          })(),
      });
      const events = await readAllEvents(res);
      expect(putArtifact).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ t: 'end', status: 'cancelled', reply: { markdown: STOPPED } });
      const n = await db.query(`SELECT count(*)::int AS c FROM designs WHERE thread_id = $1`, [threadId]);
      expect(n.rows[0].c).toBe(0);
    });

    it('S7b: a run that ended elsewhere (heartbeat finds 0 rows) uploads and commits nothing', async () => {
      process.env.CADAI_HEARTBEAT_MS = '20';
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      const putArtifact = vi.fn(realPut);
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        deps: { putArtifact },
        invoke: async (signal) =>
          (async function* () {
            await waitForRunEvent(db, runId);
            await db.transaction((q) => DbRunStore.terminate(q, runId, 'cancelled', 'cancelled'));
            await aborted(signal);
            yield ['values', { outcome: stlOutcome() }];
          })(),
      });
      const events = await readAllEvents(res);
      expect(putArtifact).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ t: 'end', status: 'cancelled', reply: { markdown: STOPPED } });
      const n = await db.query(`SELECT count(*)::int AS c FROM designs WHERE thread_id = $1`, [threadId]);
      expect(n.rows[0].c).toBe(0);
    });

    it('S10: a graph throw after a remote Stop replays the Stop, not BUILD_FAILED', async () => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        invoke: async () =>
          (async function* () {
            await waitForRunEvent(db, runId);
            await db.transaction((q) => DbRunStore.terminate(q, runId, 'cancelled', 'cancelled'));
            throw new Error('boom');
          })(),
      });
      const events = await readAllEvents(res);
      const ends = events.filter((e) => e.t === 'end');
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ status: 'cancelled', reply: { kind: 'cancelled', markdown: STOPPED } });
    });

    it('S11: the STL and STEP are uploaded for the owner with the run ids and the injected db', async () => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      const putArtifact = vi.fn(realPut);
      const stepB64 = Buffer.from('STEP-DATA').toString('base64');
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        deps: { db, putArtifact },
        invoke: async () =>
          (async function* () {
            yield [
              'values',
              { outcome: { ...stlOutcome(), design: { ...DESIGN, stl: 'solid x', step: stepB64 } } },
            ];
          })(),
      });
      const events = await readAllEvents(res);
      expect(events.at(-1)).toMatchObject({ t: 'end', status: 'done' });
      expect(putArtifact).toHaveBeenCalledTimes(2);
      expect(putArtifact).toHaveBeenNthCalledWith(
        1,
        owner.key,
        'stl',
        Buffer.from('solid x', 'utf8'),
        { threadId, runId },
        { db }
      );
      expect(putArtifact).toHaveBeenNthCalledWith(
        2,
        owner.key,
        'step',
        Buffer.from('STEP-DATA'),
        { threadId, runId },
        { db }
      );
      const stlId = await putArtifact.mock.results[0].value;
      const stepId = await putArtifact.mock.results[1].value;
      const row = (
        await db.query(`SELECT stl_artifact, step_artifact FROM designs WHERE thread_id = $1`, [threadId])
      ).rows[0];
      expect(row.stl_artifact).toBe(stlId);
      expect(row.step_artifact).toBe(stepId);
    });

    it('S12: a STEP upload failure fails the run with SAVE_FAILED and no version', async () => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      const putArtifact = vi.fn(async (...args: Parameters<typeof realPut>) => {
        if (args[1] === 'step') throw new Error('step upload failed');
        return realPut(...args);
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        deps: { putArtifact },
        invoke: async () =>
          (async function* () {
            yield [
              'values',
              {
                outcome: {
                  ...stlOutcome(),
                  design: { ...DESIGN, stl: 'solid x', step: Buffer.from('S').toString('base64') },
                },
              },
            ];
          })(),
      });
      const events = await readAllEvents(res);
      expect(events.at(-1)).toMatchObject({
        t: 'end',
        status: 'failed',
        reply: { kind: 'error', markdown: SAVE_FAILED },
      });
      expect(putArtifact).toHaveBeenCalledTimes(2);
      const run = await DbRunStore.get(db, runId);
      expect(run?.status).toBe('failed');
      expect(run?.designVersion).toBeNull();
      const n = await db.query(`SELECT count(*)::int AS c FROM designs WHERE thread_id = $1`, [threadId]);
      expect(n.rows[0].c).toBe(0);
    });

    it('S12b: topology is uploaded and saved as topoArtifact when present', async () => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      const putArtifact = vi.fn(realPut);
      const stepB64 = Buffer.from('STEP-DATA').toString('base64');
      const topoObj = { mesh: { positions: [], indices: [], faceIds: [] }, faces: [], edges: [], parts: [] };
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        deps: { db, putArtifact },
        invoke: async () =>
          (async function* () {
            yield [
              'values',
              { outcome: { ...stlOutcome(), design: { ...DESIGN, stl: 'solid x', step: stepB64, topology: topoObj } } },
            ];
          })(),
      });
      const events = await readAllEvents(res);
      expect(events.at(-1)).toMatchObject({ t: 'end', status: 'done' });
      expect(putArtifact).toHaveBeenCalledTimes(3);
      expect(putArtifact).toHaveBeenNthCalledWith(
        3,
        owner.key,
        'topo',
        expect.any(Buffer),
        { threadId, runId },
        { db }
      );
      const topoId = await putArtifact.mock.results[2].value;
      const row = (
        await db.query(`SELECT topo_artifact FROM designs WHERE thread_id = $1`, [threadId])
      ).rows[0];
      expect(row.topo_artifact).toBe(topoId);
    });

    it('S12c: a topology upload failure is non-fatal; commits without topoArtifact', async () => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      const putArtifact = vi.fn(async (...args: Parameters<typeof realPut>) => {
        if (args[1] === 'topo') throw new Error('topo upload failed');
        return realPut(...args);
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        deps: { db, putArtifact },
        invoke: async () =>
          (async function* () {
            yield [
              'values',
              {
                outcome: {
                  ...stlOutcome(),
                  design: {
                    ...DESIGN,
                    stl: 'solid x',
                    step: Buffer.from('S').toString('base64'),
                    topology: { mesh: { positions: [], indices: [], faceIds: [] }, faces: [], edges: [], parts: [] },
                  },
                },
              },
            ];
          })(),
      });
      const events = await readAllEvents(res);
      expect(events.at(-1)).toMatchObject({ t: 'end', status: 'done' });
      const row = (
        await db.query(`SELECT topo_artifact, stl_artifact FROM designs WHERE thread_id = $1`, [threadId])
      ).rows[0];
      expect(row.topo_artifact).toBeNull();
      expect(row.stl_artifact).toBeTruthy();
    });

    it('S13: a graph that ends without an outcome fails with BUILD_FAILED', async () => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = streamRun({
        runId,
        threadId,
        ownerKey: owner.key,
        deadlineAt,
        invoke: async () =>
          (async function* () {
            yield ['custom', { t: 'delta', text: 'thinking' }];
          })(),
      });
      const events = await readAllEvents(res);
      expect(events.at(-1)).toMatchObject({
        t: 'end',
        status: 'failed',
        reply: { kind: 'error', markdown: BUILD_FAILED },
      });
      const run = await DbRunStore.get(db, runId);
      expect(run?.status).toBe('failed');
      expect(run?.error).toEqual({ code: 'graph' });
    });

    it('S15: the deadline timer is cleared when the run finishes', async () => {
      const db = getDb();
      const owner = makeOwner();
      const { threadId, runId } = await createTestRun(db, owner.key);
      const timers: { handle: unknown; delay: number | undefined }[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        fn: () => void,
        delay?: number,
        ...rest: unknown[]
      ) => {
        const handle = (realSetTimeout as unknown as (...a: unknown[]) => unknown)(fn, delay, ...rest);
        timers.push({ handle, delay });
        return handle;
      }) as unknown as typeof setTimeout);
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      try {
        let signal: AbortSignal | undefined;
        const res = streamRun({
          runId,
          threadId,
          ownerKey: owner.key,
          deadlineAt: Date.now() + 60_000,
          invoke: async (sig) => {
            signal = sig;
            return (async function* () {
              yield ['values', { outcome: OUTCOME }];
            })();
          },
        });
        const events = await readAllEvents(res);
        expect(events.at(-1)).toMatchObject({ t: 'end', status: 'done' });
        // the deadline timer is the one armed for ~60 s (backoffs and sleeps are far shorter)
        const deadline = timers.filter((t) => (t.delay ?? 0) > 50_000);
        expect(deadline).toHaveLength(1);
        expect(clearSpy).toHaveBeenCalledWith(deadline[0].handle);
        expect(signal?.aborted).toBe(false);
      } finally {
        clearSpy.mockRestore();
        setSpy.mockRestore();
      }
    });

    it('S17: onFinally runs once, and a throwing one does not stop the stream closing', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      for (const failing of [false, true]) {
        const db = getDb();
        const owner = makeOwner();
        const { threadId, runId, deadlineAt } = await createTestRun(db, owner.key);
        const onFinally = vi.fn(async () => {
          if (failing) throw new Error('flush failed');
        });
        const res = streamRun({
          runId,
          threadId,
          ownerKey: owner.key,
          deadlineAt,
          onFinally,
          invoke: async () =>
            (async function* () {
              yield ['values', { outcome: OUTCOME }];
            })(),
        });
        const events = await readAllEvents(res);
        expect(events.at(-1)).toMatchObject({ t: 'end', status: 'done' });
        expect(onFinally).toHaveBeenCalledTimes(1);
      }
    });
  });
});
