import { NextRequest } from 'next/server';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { isInterrupted, INTERRUPT } from '@langchain/langgraph';
import { createCadAgent, StreamEventPayload } from '@/lib/agent/graph';
import { getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { getLangfuseCallbackHandler, getLangfuseSpanProcessor } from '@/lib/tracing/langfuse';
import { DesignContract, GatePayload } from '@/types';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages, apiKey, model, threadId, designContract } = body as {
      messages: unknown;
      apiKey?: string;
      model?: string;
      threadId: string;
      designContract?: DesignContract;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Messages array is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Map client messages to LangChain BaseMessage objects
    const lcMessages = messages.map((m: { role: string; content: string; image?: string }) => {
      let content: any = m.content;
      
      if (m.image) {
        content = [
          { type: 'text', text: m.content || 'Please see the attached annotation.' },
          { type: 'image_url', image_url: { url: m.image } }
        ];
      }

      if (m.role === 'user') {
        return new HumanMessage({ content });
      } else {
        return new AIMessage({ content });
      }
    });

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

    // One checkpoint per RUN, not per chat thread. The checkpointer is here to
    // let interrupt() survive the gap between this request and /api/chat/resume
    // - it is not the conversation store. Keying it on threadId made turn N
    // resume turn N-1's state, replaying every earlier spec, code listing and
    // validation report into the next prompt on top of the history the client
    // already re-sends. See runCheckpointKey().
    const runId = randomUUID();
    const checkpointKey = runCheckpointKey(threadId, runId);

    // Run the agent graph asynchronously and stream events
    (async () => {
      // Hoisted above the try so the finally block can flush it. The factory
      // swallows its own construction errors and returns null, so this cannot
      // throw outside the try.
      const langfuseHandler = getLangfuseCallbackHandler({
        sessionId: threadId,
        tags: ['cadai', model || 'gemini-3.6-flash'],
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

        const result = await agent.invoke(
          {
            messages: lcMessages,
            designContract: designContract ?? null,
          },
          {
            configurable: { thread_id: checkpointKey },
            callbacks: langfuseHandler ? [langfuseHandler] : undefined,
          }
        );

        // A paused run's own invoke() result carries the interrupt payload
        // directly - no separate getState() call needed, and getState()
        // requires the checkpointer to have already committed the pausing
        // checkpoint, which is a race this avoids entirely.
        if (isInterrupted(result)) {
          await sendEvent({
            type: 'awaiting_input',
            message: 'Awaiting your review before continuing...',
            gate: result[INTERRUPT][0].value as GatePayload,
            // The client cannot resume without this: the checkpoint lives
            // under threadId::runId, and only the server knows the runId.
            runId,
            timestamp: Date.now(),
          });
        } else {
          // Ran to completion, so nothing can resume this checkpoint. Dropping
          // it here is what keeps one-key-per-run from growing without bound.
          await getCheckpointer().deleteThread(checkpointKey);
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        // A run that threw is equally unresumable - don't strand its checkpoint.
        await getCheckpointer().deleteThread(checkpointKey).catch(() => {});
        await sendEvent({
          type: 'error',
          message: `Agent execution failed: ${errorMessage}`,
          timestamp: Date.now(),
        });
      } finally {
        // Langfuse batches spans and ships them on a timer. This IIFE is
        // detached from a request whose Response already returned, so nothing
        // else guarantees the queue drains - on a serverless runtime the tail
        // of every run is dropped. Flush before closing the stream, while the
        // platform is still holding the invocation open for it; `after()` from
        // next/server runs only once the response is finished, which for a
        // stream is after this close, and would race that teardown.
        // A failed flush must never strand the stream, hence the inner catch.
        // v5 moved the export queue off the handler and onto the span
        // processor (see src/lib/tracing/langfuse.ts), so that's what gets
        // flushed now - flushing langfuseHandler itself is no longer a thing.
        try {
          await getLangfuseSpanProcessor()?.forceFlush();
        } catch (e) {
          console.warn('Langfuse flush failed:', e);
        }
        await writer.close();
      }
    })();

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
