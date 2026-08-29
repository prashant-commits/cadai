import { NextRequest } from 'next/server';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { createCadAgent, StreamEventPayload } from '@/lib/agent/graph';
import { getLangfuseCallbackHandler } from '@/lib/tracing/langfuse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages, apiKey, model, threadId } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Messages array is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Map client messages to LangChain BaseMessage objects
    const lcMessages = messages.map((m: { role: string; content: string }) => {
      if (m.role === 'user') {
        return new HumanMessage(m.content);
      } else {
        return new AIMessage(m.content);
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

    // Run the agent graph asynchronously and stream events
    (async () => {
      try {
        const langfuseHandler = getLangfuseCallbackHandler({
          sessionId: threadId,
          tags: ['cadai', model || 'gemini-3.6-flash'],
          metadata: {
            model: model || 'gemini-3.6-flash',
          },
        });

        const agent = createCadAgent(
          apiKey,
          (event) => {
            sendEvent(event);
          },
          model
        );

        await agent.invoke(
          {
            messages: lcMessages,
            currentCode: '',
            explanation: '',
            validationError: null,
            attemptCount: 0,
            isValid: false,
            stlContent: null,
          },
          {
            callbacks: langfuseHandler ? [langfuseHandler] : undefined,
          }
        );
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await sendEvent({
          type: 'error',
          message: `Agent execution failed: ${errorMessage}`,
          timestamp: Date.now(),
        });
      } finally {
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
