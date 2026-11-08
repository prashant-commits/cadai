import type { Db } from '@/lib/db/db';
import { getDb } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { put as defaultPutArtifact } from '@/lib/runs/owner-artifacts';
import { registerRun, unregisterRun } from '@/lib/runs/run-control';
import { bridgeGraphStream } from '@/lib/agent/stream-bridge';
import type { StreamEvent } from '@/lib/agent/stream-events';
import type { AgentStateType } from '@/lib/agent/designer/state';
import type { CommitPlan, EndEvent } from '@/lib/persist/types';
import type { TerminateCode } from '@/lib/persist/phrases';
import { SAVE_FAILED } from '@/lib/persist/phrases';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

export function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function toWire(row: { seq: number; type: string; payload: unknown; ts: number }): Record<string, unknown> {
  const p = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;
  return { ...p, t: row.type, seq: row.seq, ts: row.ts };
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const heartbeatMs = () => envMs('CADAI_HEARTBEAT_MS', 15_000);
const appendWindowMs = () => envMs('CADAI_APPEND_WINDOW_MS', 30_000);
const commitRetryMs = () => envMs('CADAI_COMMIT_RETRY_MS', 30_000);
const clientBacklogBytes = () => envMs('CADAI_CLIENT_BACKLOG_BYTES', 64 * 1024 * 1024);

export interface StreamRunOptions {
  runId: string;
  threadId: string;
  ownerKey: string;
  /** Starts the graph stream with modes including 'values'; must pass `signal`. Yields [mode, chunk] tuples. */
  invoke: (signal: AbortSignal) => Promise<AsyncIterable<unknown>>;
  onFinally?: () => Promise<void>;
  deps?: {
    db?: Db;
    store?: typeof DbRunStore;
    putArtifact?: typeof defaultPutArtifact;
  };
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxWindowMs: number,
  baseMs = 50,
  maxBackoffMs = 1000
): Promise<T> {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const elapsed = Date.now() - start;
      if (elapsed >= maxWindowMs) {
        throw err;
      }
      const backoff = Math.min(baseMs * Math.pow(2, attempt), maxBackoffMs);
      const delay = Math.min(backoff, maxWindowMs - elapsed);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
}

export function streamRun(o: StreamRunOptions): Response {
  const db = o.deps?.db ?? getDb();
  const store = o.deps?.store ?? DbRunStore;
  const putArtifact = o.deps?.putArtifact ?? defaultPutArtifact;

  const encoder = new TextEncoder();
  let client!: ReadableStreamDefaultController<Uint8Array>;
  let clientGone = false;

  const readable = new ReadableStream<Uint8Array>(
    {
      start(c) {
        client = c;
      },
      cancel() {
        clientGone = true;
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 })
  );

  const controller = registerRun(o.runId);

  const writeClient = (payload: Record<string, unknown>) => {
    if (clientGone) return;
    try {
      if ((client.desiredSize ?? 0) < -clientBacklogBytes()) {
        clientGone = true;
        client.error(new Error('Client fell too far behind; reconnect with GET /api/runs/:runId/events.'));
        return;
      }
      client.enqueue(encoder.encode(sse(payload)));
    } catch {
      clientGone = true;
    }
  };

  let costTotal = 0;
  let lastSeq = 0;
  let endedElsewhere = false;
  let storeOutage = false;
  let outageSince = 0;

  const pendingEvents: StreamEvent[] = [];
  let appendChain: Promise<void> = Promise.resolve();

  const processPendingAppends = async () => {
    while (pendingEvents.length > 0 && !storeOutage && !endedElsewhere) {
      const ev = pendingEvents[0];
      let attempt = 0;
      let appendSuccess = false;

      while (!appendSuccess && !storeOutage && !endedElsewhere) {
        try {
          const seq = await store.append(db, o.runId, { type: ev.t, payload: ev });
          if (seq === 0) {
            endedElsewhere = true;
            controller.abort();
            pendingEvents.length = 0;
            return;
          }
          outageSince = 0;
          lastSeq = seq;
          writeClient(toWire({ seq, type: ev.t, payload: ev, ts: Date.now() }));
          pendingEvents.shift();
          appendSuccess = true;
        } catch (err) {
          if (!outageSince) {
            outageSince = Date.now();
            console.error('Run store append failed; retrying:', err);
          }
          const elapsed = Date.now() - outageSince;
          if (elapsed >= appendWindowMs()) {
            storeOutage = true;
            controller.abort();
            pendingEvents.length = 0;
            return;
          }
          const backoff = Math.min(50 * Math.pow(2, attempt), 1000);
          const delay = Math.min(backoff, appendWindowMs() - elapsed);
          await new Promise((r) => setTimeout(r, delay));
          attempt++;
        }
      }
    }
  };

  const emitEvent = (ev: StreamEvent) => {
    if (ev.t === 'cost') {
      costTotal += (ev as { usd: number }).usd ?? 0;
      return;
    }
    if (storeOutage || endedElsewhere) return;
    pendingEvents.push(ev);
    appendChain = appendChain.then(processPendingAppends);
  };

  const replayAndClose = async (fromSeq: number): Promise<void> => {
    try {
      const events = await store.eventsSince(db, o.runId, fromSeq, 1000);
      for (const row of events) {
        lastSeq = Math.max(lastSeq, row.seq);
        writeClient(toWire(row));
      }
    } catch (err) {
      console.error('eventsSince replay failed:', err);
      writeClient(
        toWire({
          seq: lastSeq + 1,
          type: 'end',
          payload: {
            t: 'end',
            seq: lastSeq + 1,
            status: 'failed',
            reply: { messageId: '', kind: 'error', markdown: SAVE_FAILED },
          },
          ts: Date.now(),
        })
      );
    }
  };

  (async () => {
    // Heartbeat starts before the graph
    const beatTimer = setInterval(async () => {
      try {
        const rows = await store.heartbeat(db, o.runId, costTotal);
        if (rows === 0) {
          endedElsewhere = true;
          controller.abort();
        }
      } catch (err) {
        console.error('Heartbeat error:', err);
      }
    }, heartbeatMs());

    let lastValues: AgentStateType | null = null;
    let graphThrew: unknown = null;

    try {
      // First stored event
      emitEvent({
        t: 'run',
        runId: o.runId,
        threadId: o.threadId,
        status: 'running',
        resumed: false,
      });

      const chunks = await o.invoke(controller.signal);

      async function* filterValues(source: AsyncIterable<unknown>) {
        for await (const chunk of source) {
          if (Array.isArray(chunk) && chunk[0] === 'values') {
            lastValues = chunk[1] as AgentStateType;
            continue;
          }
          yield chunk;
        }
      }

      await bridgeGraphStream(filterValues(chunks), o.runId, (event) => {
        emitEvent(event);
      });
    } catch (err) {
      graphThrew = err;
    }

    async function terminateAndFinish(status: 'cancelled' | 'failed', code: TerminateCode): Promise<void> {
      let termRes: { ended: true; end: EndEvent } | { ended: false } | null = null;
      try {
        termRes = await withRetry(
          () => db.transaction((q) => store.terminate(q, o.runId, status, code, costTotal)),
          commitRetryMs()
        );
      } catch (termErr) {
        console.error('Terminate failed after retries:', termErr);
        await replayAndClose(lastSeq);
        return;
      }

      if (termRes.ended) {
        writeClient(toWire({ seq: termRes.end.seq, type: termRes.end.t, payload: termRes.end, ts: Date.now() }));
      } else {
        await replayAndClose(lastSeq);
      }
    }

    try {
      // Ending: await the chain
      await appendChain;

      if (endedElsewhere) {
        // Step 0: endedElsewhere
        await replayAndClose(lastSeq);
        return;
      }

      const outcome = (lastValues as AgentStateType | null)?.outcome;

      if (outcome) {
        // Step 1: lastValues?.outcome exists -> completed wins
        let uploadFailed = false;
        let stlArtifact: string | undefined;
        let stepArtifact: string | undefined;

        if (outcome.design?.stl) {
          try {
            stlArtifact = await putArtifact(
              o.ownerKey,
              'stl',
              Buffer.from(outcome.design.stl, 'utf8'),
              { threadId: o.threadId, runId: o.runId },
              { db }
            );
          } catch (err) {
            console.error('STL upload failed:', err);
            uploadFailed = true;
          }
        }

        if (!uploadFailed && outcome.design?.step) {
          try {
            stepArtifact = await putArtifact(
              o.ownerKey,
              'step',
              Buffer.from(outcome.design.step, 'base64'),
              { threadId: o.threadId, runId: o.runId },
              { db }
            );
          } catch (err) {
            console.error('STEP upload failed:', err);
            uploadFailed = true;
          }
        }

        if (uploadFailed) {
          await terminateAndFinish('failed', 'internal');
          return;
        }

        let plan: CommitPlan;
        if (outcome.design) {
          const design = {
            ...outcome.design,
            stlArtifact,
            stepArtifact,
          };
          delete (design as { stl?: string }).stl;
          delete (design as { step?: string }).step;
          plan = {
            ...outcome,
            costUsd: costTotal > 0 ? costTotal : (outcome.costUsd ?? 0),
            design,
          };
        } else {
          plan = {
            replyKind: outcome.replyKind,
            replyMarkdown: outcome.replyMarkdown,
            userKind: outcome.userKind,
            wallMs: outcome.wallMs,
            turns: outcome.turns,
            costUsd: costTotal > 0 ? costTotal : (outcome.costUsd ?? 0),
          };
        }

        let commitResult: { committed: true; end: EndEvent } | { committed: false } | null = null;
        try {
          commitResult = await withRetry(
            () => db.transaction((q) => store.commit(q, o.runId, plan)),
            commitRetryMs()
          );
        } catch (commitErr) {
          console.error('Commit failed after retries exhausted:', commitErr);
          // Retries exhausted after a commit -> terminate('failed', 'internal') once more
          await terminateAndFinish('failed', 'internal');
          return;
        }

        if (commitResult.committed) {
          writeClient(toWire({ seq: commitResult.end.seq, type: commitResult.end.t, payload: commitResult.end, ts: Date.now() }));
        } else {
          await replayAndClose(lastSeq);
        }
        return;
      }

      // No outcome
      if (controller.signal.aborted && !storeOutage) {
        // Step 2
        await terminateAndFinish('cancelled', 'cancelled');
      } else if (storeOutage) {
        // Step 3
        await terminateAndFinish('failed', 'internal');
      } else if (graphThrew !== null) {
        // Step 4
        console.error('Graph threw error:', graphThrew);
        await terminateAndFinish('failed', 'graph');
      } else {
        // Step 5
        console.error('graph ended without an outcome');
        await terminateAndFinish('failed', 'graph');
      }
    } catch (e) {
      console.error('Run ending failed:', e);
      await replayAndClose(lastSeq);
    } finally {
      clearInterval(beatTimer);
      unregisterRun(o.runId, controller);
      try {
        await o.onFinally?.();
      } catch (e) {
        console.warn('onFinally failed:', e);
      }
      if (!clientGone) {
        try {
          client.close();
        } catch {
          // already closed
        }
      }
    }
  })().catch((err) => console.error('streamRun background task failed:', err));

  return new Response(readable, { headers: SSE_HEADERS });
}
