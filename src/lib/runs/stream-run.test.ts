import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { getDb, closeDb, type Db } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { abortRun } from '@/lib/runs/run-control';
import { streamRun } from './stream-run';
import { reapOnce } from '@/lib/persist/loop';
import { BUILD_FAILED, SAVE_FAILED, STOPPED } from '@/lib/persist/phrases';
import type { RunOutcome } from '@/lib/persist/types';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, key };
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
    const { threadId, runId } = await createTestRun(db, owner.key);

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
    const { threadId, runId } = await createTestRun(db, owner.key);

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

  it('a silent designer call outlives the stale threshold', async () => {
    process.env.CADAI_HEARTBEAT_MS = '50';
    process.env.CADAI_STALE_MS = '300';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);

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

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);

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
      deps: { store: fakeStore as typeof DbRunStore },
      invoke: async () =>
        (async function* () {
          yield ['values', { outcome }];
        })(),
    });

    await readAllEvents(res);
    const countAtClose = heartbeatCount;

    // Wait 200ms and verify heartbeat is no longer called
    await new Promise((r) => setTimeout(r, 200));
    expect(heartbeatCount).toBe(countAtClose);
  });

  it('commit throws, then succeeds on retry', async () => {
    process.env.CADAI_COMMIT_RETRY_MS = '2000';

    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);

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
    const { threadId, runId } = await createTestRun(db, owner.key);

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
    const { threadId, runId } = await createTestRun(db, owner.key);

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
    const { threadId, runId } = await createTestRun(db, owner.key);

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
    const { threadId, runId } = await createTestRun(db, owner.key);

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
    const { threadId, runId } = await createTestRun(db, owner.key);

    let signalAborted = false;
    let terminatedAt = 0;
    let abortAt = 0;

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
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
    const { threadId, runId } = await createTestRun(db, owner.key);

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
    const { threadId, runId } = await createTestRun(db, owner.key);

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
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
    const { threadId, runId } = await createTestRun(db, owner.key);

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
    const { threadId, runId } = await createTestRun(db, owner.key);

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
});
