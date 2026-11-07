import type { ApiError, RunStatus } from '@/lib/contract/run-contract';
import { bridgeGraphStream } from '@/lib/agent/stream-bridge';
import type { StreamEvent } from '@/lib/agent/stream-events';
import { deleteRunCheckpoint, getCheckpointer } from '@/lib/agent/checkpointer';
import { describeGraphError } from '@/lib/agent/run-limits';
import { runHeartbeatMs, type RunStore } from './run-store';
import { registerRun, unregisterRun } from './run-control';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

/** Anything the run log can hold: the graph's events plus the contract's. */
export type RunEvent = StreamEvent | Record<string, unknown>;

export function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** How often the owner checks for a cancel requested on another instance. */
const cancelPollMs = () => envMs('CADAI_CANCEL_POLL_MS', 500);
/** Unread bytes queued for a client before it is treated as gone (it can replay). */
const clientBacklogBytes = () => envMs('CADAI_CLIENT_BACKLOG_BYTES', 64 * 1024 * 1024);

/**
 * The raw failure text for ApiError.detail: one line, capped, with anything
 * shaped like a credential removed. The `message` stays the generic label.
 */
export function errorDetail(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

export interface StreamRunOptions {
  store: RunStore;
  runId: string;
  threadId: string;
  resumed: boolean;
  /** LangGraph thread key whose checkpoint belongs to this run. */
  checkpointKey: string;
  /** Prefix for the user-facing failure label, e.g. "Agent execution failed". */
  failLabel: string;
  /** Starts the graph stream; must pass `signal` to it. */
  invoke: (signal: AbortSignal) => Promise<AsyncIterable<unknown>>;
  /** Runs after the last event, before the stream closes (e.g. tracing flush). */
  onFinally?: () => Promise<void>;
}

/**
 * Drives one run (fresh or resumed) and returns its SSE Response.
 *
 * Every event gets seq + ts, is appended to the run store and then written to
 * the client; the client's connection dropping never stops the run (reconnect
 * with GET /api/runs/:id/events). Only the cancel flag does.
 *
 * Exactly one terminal outcome is stored: the final event and the final status
 * are written in one atomic store step that only applies while the run is still
 * `running`, so a racing cancel, a lost-run reaper and this owner cannot both
 * end it.
 *
 * Caller contract: the run record exists and the caller has already moved it
 * to `running` (create, or a paused -> running claim).
 */
export function streamRun(o: StreamRunOptions): Response {
  const { store, runId } = o;
  const encoder = new TextEncoder();

  // The client side is a stream this run controls: enqueue never blocks and
  // close is immediate, so nothing in the run ever waits on the reader. A
  // reader that falls more than CADAI_CLIENT_BACKLOG_BYTES behind is cut off
  // (it reconnects via replay); a disconnect only stops the writes.
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
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
  );

  // Appends are strictly ordered so seq follows emission order.
  let appendChain: Promise<unknown> = Promise.resolve();
  let lastSeq = 0;
  let storeBroken = false;

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

  /** Seq for an event the store could not take: keeps the live stream monotonic and unique. */
  const localSeq = () => ++lastSeq;

  const emit = (event: RunEvent): void => {
    appendChain = appendChain.then(async () => {
      const stamped: Record<string, unknown> = { ...event, ts: Date.now() };
      if (stamped.t === 'error' && !stamped.apiError) {
        stamped.apiError = { code: 'internal', message: String(stamped.message ?? 'Run failed') } satisfies ApiError;
      }
      let seq: number;
      if (storeBroken) {
        seq = localSeq();
      } else {
        try {
          if (stamped.t === 'gate') {
            // Durable before visible: the checkpoint is on disk and the status is
            // `paused` (in the same step as the gate event) before the client can
            // see the gate and POST a resume.
            getCheckpointer().flushNow();
            seq = await store.append(runId, stamped, { status: 'paused', expect: ['running'] });
            if (seq === 0) return; // the run was ended by someone else; nothing to pause
          } else {
            seq = await store.append(runId, stamped);
          }
          lastSeq = seq;
        } catch (e) {
          console.error('Run store append failed; the live stream continues unstored:', e);
          storeBroken = true;
          seq = localSeq();
        }
      }
      writeClient({ ...stamped, seq });
    });
  };

  /** Stores `event` and moves the run to `status` atomically, only if it is still `expect`. */
  const finish = async (event: RunEvent | null, status: RunStatus, error: ApiError | undefined, expect: RunStatus[]) => {
    await appendChain;
    if (storeBroken) {
      if (event) writeClient({ ...event, ts: Date.now(), seq: localSeq() });
      return;
    }
    try {
      if (event) {
        const stamped = { ...event, ts: Date.now() };
        const seq = await store.append(runId, stamped, { status, error, expect });
        if (seq > 0) {
          lastSeq = seq;
          writeClient({ ...stamped, seq });
        }
      } else {
        await store.setStatus(runId, status, error, { expect });
      }
    } catch (e) {
      console.error('Run finalization write failed:', e);
    }
  };

  (async () => {
    const controller = registerRun(runId);
    const poll = setInterval(() => {
      void store.isCancelled(runId).then((c) => {
        if (c) controller.abort();
      }, () => undefined);
    }, cancelPollMs());
    // Liveness: a reader treats a running run without a heartbeat for
    // CADAI_RUN_LOST_MS as lost (its instance died) and fails it.
    const beat = setInterval(() => {
      void store.heartbeat(runId).catch(() => undefined);
    }, runHeartbeatMs());

    let sawGate = false;
    let sawResult = false;
    let graphError: ApiError | null = null;
    let threw: unknown = null;

    try {
      emit({ t: 'run', runId: o.runId, threadId: o.threadId, status: 'running', resumed: o.resumed });
      const chunks = await o.invoke(controller.signal);
      await bridgeGraphStream(chunks, runId, (event) => {
        if (event.t === 'gate') sawGate = true;
        if (event.t === 'result') sawResult = true;
        if (event.t === 'error') {
          const ev = event as { message: string; apiError?: ApiError };
          graphError = ev.apiError ?? { code: 'internal', message: ev.message };
        }
        emit(event);
      });
    } catch (err) {
      threw = err;
    }

    clearInterval(poll);
    clearInterval(beat);
    unregisterRun(runId, controller);

    try {
      await appendChain;
      const flagged = controller.signal.aborted || (await store.isCancelled(runId).catch(() => false));
      // A stream that ran to its end keeps its outcome even if a cancel landed
      // during the last drain: the result is already out, so `done` wins.
      const completed = threw === null && (sawResult || sawGate);
      const cancelled: ApiError = { code: 'cancelled', message: 'The run was stopped.' };

      if (threw === null && sawGate) {
        if (flagged) {
          // Stop was pressed while the run was reaching its gate: stop it there.
          await deleteRunCheckpoint(o.checkpointKey);
          await finish({ t: 'cancelled', at: Date.now() }, 'cancelled', cancelled, ['paused']);
        }
        // else: already `paused`, set atomically with the gate event.
      } else if (flagged && !completed) {
        await deleteRunCheckpoint(o.checkpointKey);
        await finish({ t: 'cancelled', at: Date.now() }, 'cancelled', cancelled, ['running']);
      } else if (threw !== null) {
        await deleteRunCheckpoint(o.checkpointKey);
        const message = describeGraphError(threw, o.failLabel);
        const apiError: ApiError = { code: 'internal', message, detail: errorDetail(threw) };
        await finish({ t: 'error', message, apiError }, 'failed', apiError, ['running']);
      } else if (graphError) {
        await deleteRunCheckpoint(o.checkpointKey);
        await finish(null, 'failed', graphError, ['running']);
      } else {
        // Finished runs cannot be resumed; dropping the checkpoint keeps one-key-per-run bounded.
        await deleteRunCheckpoint(o.checkpointKey);
        await finish(null, 'done', undefined, ['running']);
      }
    } catch (e) {
      console.error('Run finalization failed:', e);
    } finally {
      try {
        await o.onFinally?.();
      } catch (e) {
        console.warn('Run cleanup failed:', e);
      }
      if (!clientGone) {
        try {
          client.close(); // queued data is still delivered; nothing waits for it
        } catch {
          // errored or cancelled meanwhile
        }
      }
    }
  })().catch((err) => console.error('Run IIFE failed:', err));

  return new Response(readable, { headers: SSE_HEADERS });
}
