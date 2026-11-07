import { NextRequest } from 'next/server';
import { createCadAgent } from '@/lib/agent/graph';
import { getLangfuseCallbackHandler, getLangfuseSpanProcessor } from '@/lib/tracing/langfuse';
import { getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { Command } from '@langchain/langgraph';
import { GateDecision } from '@/types';
import { coerceRouteModel } from '@/lib/agent/models';
import { graphRecursionLimit } from '@/lib/agent/run-limits';
import { getRunStore, isSafeRunId, type AppendOptions, type RunStore } from '@/lib/runs/run-store';
import { SSE_HEADERS, sse, streamRun } from '@/lib/runs/stream-run';
import { errorResponse } from '@/lib/runs/api-error';
import type { ApiError } from '@/lib/contract/run-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const EXPIRED_MESSAGE = 'This paused run expired or was not found on this server. Send the request again.';

/**
 * Stores events for a run that never reaches the graph and returns them as a
 * one-shot SSE body. The last event carries the terminal status (atomic with
 * its append).
 */
async function staticStream(
  store: RunStore,
  runId: string,
  events: Array<Record<string, unknown>>,
  final: AppendOptions,
): Promise<Response> {
  let body = '';
  for (let i = 0; i < events.length; i++) {
    const ts = Date.now();
    const seq = await store.append(runId, { ...events[i], ts }, i === events.length - 1 ? final : undefined);
    if (seq > 0) body += sse({ ...events[i], seq, ts });
  }
  return new Response(body, { headers: SSE_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { threadId, runId, model, decision } = body as {
      threadId: string;
      runId: string;
      model?: string;
      decision: GateDecision;
    };

    if (!threadId) return errorResponse('bad_request', 'Thread ID is required.');

    // Without the runId there is no way to name the paused checkpoint, and
    // resuming the wrong one would silently continue a different run.
    if (!runId) return errorResponse('bad_request', 'Run ID is required to resume a gated run.');
    if (!isSafeRunId(runId)) return errorResponse('bad_request', 'Run ID is not valid.');

    const store = getRunStore();
    const checkpointKey = runCheckpointKey(threadId, runId);
    const paused = await getCheckpointer().getTuple({ configurable: { thread_id: checkpointKey } });
    let info = await store.get(runId);

    if (!info) {
      // No record and no checkpoint: nothing to resume, and nothing is written
      // for an id the client made up.
      if (!paused) return errorResponse('run_expired', EXPIRED_MESSAGE);
      // A paused run from before run records existed has only a checkpoint: adopt it.
      try {
        await store.create({ runId, threadId, status: 'paused' });
      } catch {
        // created concurrently by another request; the claim below decides
      }
      info = await store.get(runId);
      if (!info) return errorResponse('internal', 'The run record could not be created.');
    }

    if (info.threadId !== threadId) return errorResponse('bad_request', 'threadId does not match this run.');
    if (info.status !== 'paused') {
      return errorResponse('run_conflict', `Run ${runId} is ${info.status}, not paused, so it cannot be resumed.`);
    }

    // Claim the run: paused -> running is atomic in the store, so of two
    // concurrent resumes (double click, retry, two instances) exactly one wins.
    if (!(await store.setStatus(runId, 'running', undefined, { expect: ['paused'] }))) {
      return errorResponse('run_conflict', `Run ${runId} is already being resumed or was stopped.`);
    }

    // A paused run is deleted after CADAI_CHECKPOINT_TTL_MS, or lives on another
    // server that does not share this one's store. Streaming a resume into a
    // missing checkpoint yields no steps and no error, so the client would show
    // an approved gate and a blank result. Say so instead.
    if (!paused) {
      const apiError: ApiError = { code: 'run_expired', message: EXPIRED_MESSAGE };
      return staticStream(
        store,
        runId,
        [
          { t: 'run', runId, threadId, status: 'failed', resumed: true },
          { t: 'error', message: apiError.message, apiError },
        ],
        { status: 'failed', error: apiError, expect: ['running'] },
      );
    }

    // A cancelled gate never re-enters the graph: there is nothing to
    // resume toward, so the only correct action is to drop the paused
    // checkpoint. Invoking the graph here would just make it silently
    // proceed with generation, which is the one thing "Cancel" must not do.
    // `result` stays for old clients; the contract's `cancelled` ends the stream.
    if (decision?.action === 'cancel') {
      await getCheckpointer().deleteThread(checkpointKey);
      const at = Date.now();
      return staticStream(
        store,
        runId,
        [
          { t: 'run', runId, threadId, status: 'cancelled', resumed: true },
          { t: 'result', summary: 'Generation cancelled by user.' },
          { t: 'cancelled', at },
        ],
        { status: 'cancelled', error: { code: 'cancelled', message: 'Generation cancelled by user.' }, expect: ['running'] },
      );
    }

    // Hoisted so onFinally can flush it. The factory swallows its own
    // construction errors and returns null, so this cannot throw.
    const effectiveModel = coerceRouteModel(model);
    const langfuseHandler = getLangfuseCallbackHandler({
      sessionId: threadId,
      tags: ['cadai', effectiveModel, 'resume'],
      metadata: { model: effectiveModel },
    });

    // A resumed run can hit ANOTHER gate - the accept gate right after the
    // spec gate. streamRun surfaces that identically to the first one.
    return streamRun({
      store,
      runId,
      threadId,
      resumed: true,
      checkpointKey,
      failLabel: 'Agent resume failed',
      invoke: async (signal) => {
        const agent = createCadAgent(effectiveModel);
        return agent.stream(new Command({ resume: decision }), {
          configurable: { thread_id: checkpointKey },
          recursionLimit: graphRecursionLimit(),
          streamMode: ['updates', 'messages', 'custom'],
          callbacks: langfuseHandler ? [langfuseHandler] : undefined,
          signal,
        });
      },
      // See the matching comment in ../route.ts: the run outlives the returned
      // Response, so the span queue must be drained before the stream closes.
      onFinally: async () => {
        try {
          await getLangfuseSpanProcessor()?.forceFlush();
        } catch (e) {
          console.warn('Langfuse flush failed:', e);
        }
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse('internal', message);
  }
}
