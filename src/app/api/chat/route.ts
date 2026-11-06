import { NextRequest } from 'next/server';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { createCadAgent } from '@/lib/agent/graph';
import { runCheckpointKey } from '@/lib/agent/checkpointer';
import { getRunStore } from '@/lib/runs/run-store';
import { streamRun } from '@/lib/runs/stream-run';
import { errorResponse } from '@/lib/runs/api-error';
import { getLangfuseCallbackHandler, getLangfuseSpanProcessor } from '@/lib/tracing/langfuse';
import { DesignContract } from '@/types';
import { coerceRouteModel } from '@/lib/agent/models';
import { graphRecursionLimit } from '@/lib/agent/run-limits';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages, model, threadId, designContract } = body as {
      messages: unknown;
      model?: string;
      threadId: string;
      designContract?: DesignContract;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return errorResponse('bad_request', 'Messages array is required.');
    }

    // Map client messages to LangChain BaseMessage objects
    const lcMessages = messages.map((m: { role: string; content: string; image?: string }) => {
      let content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> = m.content;
      
      if (m.image) {
        content = [
          { type: 'text', text: m.content || 'Please see the attached annotation.' },
          { type: 'image_url', image_url: { url: m.image } }
        ];
      }

      if (m.role === 'user') {
        return new HumanMessage({ content: content as never });
      } else {
        return new AIMessage({ content: content as never });
      }
    });

    // One checkpoint per RUN, not per chat thread. The checkpointer is here to
    // let interrupt() survive the gap between this request and /api/chat/resume
    // - it is not the conversation store. Keying it on threadId made turn N
    // resume turn N-1's state, replaying every earlier spec, code listing and
    // validation report into the next prompt on top of the history the client
    // already re-sends. See runCheckpointKey().
    // The runId is minted here, before any work, so the client can stop or
    // reconnect to the run from its first event (`{ t: 'run' }`).
    const runId = randomUUID();
    const chatThreadId = typeof threadId === 'string' && threadId ? threadId : runId;
    const checkpointKey = runCheckpointKey(chatThreadId, runId);
    await getRunStore().create({ runId, threadId: chatThreadId });

    // Hoisted so onFinally can flush it. The factory swallows its own
    // construction errors and returns null, so this cannot throw.
    const effectiveModel = coerceRouteModel(model);
    const langfuseHandler = getLangfuseCallbackHandler({
      sessionId: chatThreadId,
      tags: ['cadai', effectiveModel],
      metadata: { model: effectiveModel },
    });

    return streamRun({
      store: getRunStore(),
      runId,
      threadId: chatThreadId,
      resumed: false,
      checkpointKey,
      failLabel: 'Agent execution failed',
      invoke: async (signal) => {
        const agent = createCadAgent(effectiveModel);
        return agent.stream(
          { messages: lcMessages, designContract: designContract ?? null },
          {
            configurable: { thread_id: checkpointKey },
            recursionLimit: graphRecursionLimit(),
            streamMode: ['updates', 'messages', 'custom'],
            callbacks: langfuseHandler ? [langfuseHandler] : undefined,
            signal,
          }
        );
      },
      // Langfuse batches spans and ships them on a timer. The run is detached
      // from a request whose Response already returned, so nothing else
      // guarantees the queue drains - on a serverless runtime the tail of every
      // run is dropped. Flush before the stream closes, while the platform is
      // still holding the invocation open; `after()` would race that teardown.
      // v5 moved the export queue onto the span processor (see
      // src/lib/tracing/langfuse.ts), so that is what gets flushed.
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
