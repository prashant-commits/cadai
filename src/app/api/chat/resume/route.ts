import { NextRequest } from 'next/server';
import { createCadAgent, StreamEventPayload } from '@/lib/agent/graph';
import { getLangfuseCallbackHandler, getLangfuseSpanProcessor } from '@/lib/tracing/langfuse';
import { deleteRunCheckpoint, getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { Command, isInterrupted, INTERRUPT } from '@langchain/langgraph';
import { GateDecision, GatePayload } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { threadId, runId, apiKey, model, decision } = body as {
      threadId: string;
      runId: string;
      apiKey?: string;
      model?: string;
      decision: GateDecision;
    };

    if (!threadId) {
      return new Response(JSON.stringify({ error: 'Thread ID is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Without the runId there is no way to name the paused checkpoint, and
    // resuming the wrong one would silently continue a different run.
    if (!runId) {
      return new Response(JSON.stringify({ error: 'Run ID is required to resume a gated run.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const checkpointKey = runCheckpointKey(threadId, runId);

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    const sendEvent = async (event: StreamEventPayload) => {
      try {
        const payload = `data: ${JSON.stringify(event)}\n\n`;
        await writer.write(encoder.encode(payload));
      } catch (e) {
        console.error('Error writing to stream:', e);
      }
    };

    // A cancelled gate never re-enters the graph: there is nothing to
    // resume toward, so the only correct action is to drop the paused
    // checkpoint. Invoking the graph here would just make it silently
    // proceed with generation, which is the one thing "Cancel" must not do.
    if (decision?.action === 'cancel') {
      await getCheckpointer().deleteThread(checkpointKey);
      return new Response(
        `data: ${JSON.stringify({ type: 'ready', message: 'Cancelled.', explanation: 'Generation cancelled by user.', timestamp: Date.now() } satisfies StreamEventPayload)}\n\n`,
        {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        }
      );
    }

    // Run the agent graph asynchronously and stream events
    (async () => {
      // Hoisted above the try so the finally block can flush it. The factory
      // swallows its own construction errors and returns null, so this cannot
      // throw outside the try.
      const langfuseHandler = getLangfuseCallbackHandler({
        sessionId: threadId,
        tags: ['cadai', model || 'gemini-3.6-flash', 'resume'],
        metadata: {
          model: model || 'gemini-3.6-flash',
        },
      });

      try {
        const agent = createCadAgent(
          apiKey,
          (event) => {
            sendEvent(event);
          },
          model
        );

        // Resume using Command. A resumed run can hit ANOTHER gate (e.g. the
        // accept gate, right after the spec gate) - isInterrupted() catches
        // that exactly the same way the initial /api/chat POST does.
        const result = await agent.invoke(
          new Command({ resume: decision }),
          {
            configurable: { thread_id: checkpointKey },
            callbacks: langfuseHandler ? [langfuseHandler] : undefined,
          }
        );

        if (isInterrupted(result)) {
          await sendEvent({
            type: 'awaiting_input',
            message: 'Awaiting your review before continuing...',
            gate: result[INTERRUPT][0].value as GatePayload,
            // Same run, same checkpoint - echo the id so the client can resume
            // again from this second gate.
            runId,
            timestamp: Date.now(),
          });
        } else {
          await deleteRunCheckpoint(checkpointKey);
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await deleteRunCheckpoint(checkpointKey);
        await sendEvent({
          type: 'error',
          message: `Agent resume failed: ${errorMessage}`,
          timestamp: Date.now(),
        });
      } finally {
        // See the matching comment in ../route.ts: the detached IIFE outlives
        // the returned Response, so the span queue must be drained explicitly
        // before the stream closes or the tail of every resumed run is lost.
        // v5 moved that queue off the handler and onto the span processor.
        try {
          await getLangfuseSpanProcessor()?.forceFlush();
        } catch (e) {
          console.warn('Langfuse flush failed:', e);
        }
        await writer.close();
      }
    })().catch((err) => {
      console.error('Chat resume IIFE failed:', err);
    });

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
