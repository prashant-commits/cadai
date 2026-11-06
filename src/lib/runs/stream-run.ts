import type { ApiError, RunStatus } from '@/lib/contract/run-contract';
import { bridgeGraphStream } from '@/lib/agent/stream-bridge';
import type { StreamEvent } from '@/lib/agent/stream-events';
import { deleteRunCheckpoint, getCheckpointer } from '@/lib/agent/checkpointer';
import { describeGraphError } from '@/lib/agent/run-limits';
import type { RunStore } from './run-store';
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

/** How often the owner checks for a cancel requested on another instance. */
function cancelPollMs(): number {
  const n = Number(process.env.CADAI_CANCEL_POLL_MS ?? 500);
  return Number.isFinite(n) && n > 0 ? n : 500;
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
 * Caller contract: the run record exists and its status is already `running`.
 */
export function streamRun(o: StreamRunOptions): Response {
  const { store, runId } = o;
  const encoder = new TextEncoder();
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();

  // Appends are strictly ordered so seq follows emission order; client writes
  // are chained separately so a slow reader never delays the store.
  let appendChain: Promise<unknown> = Promise.resolve();
  let writeChain: Promise<unknown> = Promise.resolve();
  let clientGone = false;

  const writeClient = (payload: Record<string, unknown>) => {
    writeChain = writeChain.then(async () => {
      if (clientGone) return;
      try {
        await writer.write(encoder.encode(sse(payload)));
      } catch {
        clientGone = true; // the run goes on; the client reconnects via replay
      }
    });
  };

  const emit = (event: RunEvent): void => {
    appendChain = appendChain.then(async () => {
      const stamped: Record<string, unknown> = { ...event, ts: Date.now() };
      if (stamped.t === 'error' && !stamped.apiError) {
        stamped.apiError = { code: 'internal', message: String(stamped.message ?? 'Run failed') } satisfies ApiError;
      }
      try {
        const seq = await store.append(runId, stamped);
        if (stamped.t === 'gate') {
          // Durable before visible: the checkpoint is on disk and the status is
          // `paused` before the client can see the gate and POST a resume.
          getCheckpointer().flushNow();
          await store.setStatus(runId, 'paused');
        }
        writeClient({ ...stamped, seq });
      } catch (e) {
        console.error('Run store append failed:', e);
        writeClient({ ...stamped, seq: 0 }); // never lose the event for the live client
      }
    });
  };

  const drain = () => appendChain;

  (async () => {
    const controller = registerRun(runId);
    const poll = setInterval(() => {
      void store.isCancelled(runId).then((c) => {
        if (c) controller.abort();
      }, () => undefined);
    }, cancelPollMs());

    let sawGate = false;
    let sawError = false;
    let threw: unknown = null;

    try {
      emit({ t: 'run', runId: o.runId, threadId: o.threadId, status: 'running', resumed: o.resumed });
      const chunks = await o.invoke(controller.signal);
      await bridgeGraphStream(chunks, runId, (event) => {
        if (event.t === 'gate') sawGate = true;
        if (event.t === 'error') sawError = true;
        emit(event);
      });
    } catch (err) {
      threw = err;
    }

    clearInterval(poll);
    unregisterRun(runId);

    try {
      await drain();
      const cancelled = controller.signal.aborted || (await store.isCancelled(runId));
      let status: RunStatus;
      let error: ApiError | undefined;
      if (cancelled) {
        await deleteRunCheckpoint(o.checkpointKey);
        emit({ t: 'cancelled', at: Date.now() });
        status = 'cancelled';
        error = { code: 'cancelled', message: 'The run was stopped.' };
      } else if (threw !== null) {
        await deleteRunCheckpoint(o.checkpointKey);
        const message = describeGraphError(threw, o.failLabel);
        emit({ t: 'error', message, apiError: { code: 'internal', message } });
        status = 'failed';
        error = { code: 'internal', message };
      } else if (sawGate) {
        status = 'paused'; // set when the gate event was appended
      } else if (sawError) {
        await deleteRunCheckpoint(o.checkpointKey);
        status = 'failed';
        error = { code: 'internal', message: 'The run reported an error.' };
      } else {
        // Finished runs cannot be resumed; dropping the checkpoint keeps one-key-per-run bounded.
        await deleteRunCheckpoint(o.checkpointKey);
        status = 'done';
      }
      await drain();
      // Terminal status is set after the last event is stored, so a reconnecting
      // tail that sees it can trust its final drain.
      if (status !== 'paused') await store.setStatus(runId, status, error);
    } catch (e) {
      console.error('Run finalization failed:', e);
    } finally {
      try {
        await o.onFinally?.();
      } catch (e) {
        console.warn('Run cleanup failed:', e);
      }
      await writeChain;
      await writer.close().catch(() => undefined);
    }
  })().catch((err) => console.error('Run IIFE failed:', err));

  return new Response(ts.readable, { headers: SSE_HEADERS });
}
