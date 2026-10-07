import { NextRequest } from 'next/server';
import { createCadAgent } from '@/lib/agent/graph';
import { bridgeGraphStream } from '@/lib/agent/stream-bridge';
import type { StreamEvent } from '@/lib/agent/stream-events';
import { getLangfuseCallbackHandler, getLangfuseSpanProcessor } from '@/lib/tracing/langfuse';
import { deleteRunCheckpoint, getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { Command } from '@langchain/langgraph';
import { GateDecision } from '@/types';
import { DEFAULT_MODEL } from '@/lib/agent/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { threadId, runId, model, decision } = body as {
      threadId: string;
      runId: string;
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

    const sendEvent = async (event: StreamEvent) => {
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
        `data: ${JSON.stringify({ t: 'result', summary: 'Generation cancelled by user.' } satisfies StreamEvent)}\n\n`,
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
        tags: ['cadai', model || DEFAULT_MODEL, 'resume'],
        metadata: {
          model: model || DEFAULT_MODEL,
        },
      });

      try {
        const agent = createCadAgent(model);

        let sawGate = false;
        const stream = await agent.stream(new Command({ resume: decision }), {
          configurable: { thread_id: checkpointKey },
          streamMode: ['updates', 'messages', 'custom'],
          callbacks: langfuseHandler ? [langfuseHandler] : undefined,
        });

        // A resumed run can hit ANOTHER gate - the accept gate right after the
        // spec gate. The bridge surfaces that identically to the first one.
        await bridgeGraphStream(stream, runId, (event) => {
          if (event.t === 'gate') sawGate = true;
          sendEvent(event);
        });

        if (!sawGate) await deleteRunCheckpoint(checkpointKey);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await deleteRunCheckpoint(checkpointKey);
        await sendEvent({ t: 'error', message: `Agent resume failed: ${errorMessage}` });
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
