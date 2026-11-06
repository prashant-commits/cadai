import { NextRequest } from 'next/server';
import { createCadAgent } from '@/lib/agent/graph';
import { getLangfuseCallbackHandler, getLangfuseSpanProcessor } from '@/lib/tracing/langfuse';
import { getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { Command } from '@langchain/langgraph';
import { GateDecision } from '@/types';
import { coerceRouteModel } from '@/lib/agent/models';
import { graphRecursionLimit } from '@/lib/agent/run-limits';
import { getRunStore } from '@/lib/runs/run-store';
import { SSE_HEADERS, sse, streamRun } from '@/lib/runs/stream-run';
import { errorResponse } from '@/lib/runs/api-error';
import type { ApiError } from '@/lib/contract/run-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const EXPIRED_MESSAGE = 'This paused run expired or was not found on this server. Send the request again.';

/** Appends events to a run that never reaches the graph, and returns them as a one-shot SSE body. */
async function staticStream(runId: string, events: Array<Record<string, unknown>>): Promise<Response> {
  const store = getRunStore();
  let body = '';
  for (const event of events) {
    const ts = Date.now();
    const seq = await store.append(runId, { ...event, ts });
    body += sse({ ...event, seq, ts });
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

    const store = getRunStore();
    const checkpointKey = runCheckpointKey(threadId, runId);

    // A run record exists for every run started after run IDs went up front.
    // A paused run from before that has only a checkpoint: adopt it.
    let info = await store.get(runId).catch(() => undefined);
    if (info && info.status !== 'paused') {
      return errorResponse('run_conflict', `Run ${runId} is ${info.status}, not paused, so it cannot be resumed.`);
    }
    if (info && info.threadId !== threadId) {
      return errorResponse('bad_request', 'threadId does not match this run.');
    }

    const paused = await getCheckpointer().getTuple({ configurable: { thread_id: checkpointKey } });

    // A paused run is deleted after CADAI_CHECKPOINT_TTL_MS, or lives on another
    // server that does not share this one's store. Streaming a resume into a
    // missing checkpoint yields no steps and no error, so the client would show
    // an approved gate and a blank result. Say so instead.
    if (!paused) {
      const apiError: ApiError = { code: 'run_expired', message: EXPIRED_MESSAGE };
      if (!info) info = await store.create({ runId, threadId, status: 'paused' }).catch(() => undefined);
      if (info) {
        await store.setStatus(runId, 'failed', apiError);
        return staticStream(runId, [
          { t: 'run', runId, threadId, status: 'failed', resumed: true },
          { t: 'error', message: apiError.message, apiError },
        ]);
      }
      return new Response(sse({ t: 'error', message: apiError.message, apiError }), { headers: SSE_HEADERS });
    }

    if (!info) info = await store.create({ runId, threadId, status: 'paused' });

    // A cancelled gate never re-enters the graph: there is nothing to
    // resume toward, so the only correct action is to drop the paused
    // checkpoint. Invoking the graph here would just make it silently
    // proceed with generation, which is the one thing "Cancel" must not do.
    if (decision?.action === 'cancel') {
      await getCheckpointer().deleteThread(checkpointKey);
      await store.setStatus(runId, 'cancelled', { code: 'cancelled', message: 'Generation cancelled by user.' });
      return staticStream(runId, [
        { t: 'run', runId, threadId, status: 'cancelled', resumed: true },
        { t: 'result', summary: 'Generation cancelled by user.' },
      ]);
    }

    await store.setStatus(runId, 'running');

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
