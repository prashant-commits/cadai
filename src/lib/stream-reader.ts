import type { ChatMessage, DesignContract } from '@/types';
import type { EndEvent } from '@/lib/persist/types';
import type { StreamEvent } from './agent/stream-events';
import type { TranscriptNode } from './agent/transcript';
import { serializeTranscript } from './agent/transcript';
import { TranscriptBuilder } from './agent/transcript-build';

export interface StreamState {
  nodes: TranscriptNode[];
  summary: string;
  code?: string;
  stl?: string;
  step?: string;
  /** Language of `code` when the server says so (always build123d). */
  language?: 'build123d';
  designContract?: DesignContract;
  /** The run that produced this message. */
  runId?: string;
  error?: string;
  designVersion?: number;
  endEvent?: EndEvent;
}

export interface StreamCallbacks {
  onUpdate: (state: StreamState) => void;
  onDone: (state: StreamState) => void;
}

/**
 * The message fields a finished stream writes.
 */
export function streamMessagePatch(state: StreamState): Partial<ChatMessage> {
  if (state.error) {
    const patch: Partial<ChatMessage> = {
      content: state.error,
      status: 'error',
    };
    if (state.nodes.length > 0) patch.transcript = serializeTranscript(state.nodes);
    return patch;
  }
  return {
    transcript: serializeTranscript(state.nodes),
    content: state.summary,
    code: state.code,
    runId: state.runId,
    status: 'complete',
  };
}

export async function readStream(response: Response, callbacks: StreamCallbacks): Promise<void> {
  if (!response.body) throw new Error('No response stream received.');

  const builder = new TranscriptBuilder();
  const state: StreamState = { nodes: builder.nodes, summary: '' };

  function apply(event: StreamEvent) {
    builder.apply(event);
    switch (event.t) {
      case 'run':
        state.runId = event.runId;
        return;
      case 'end':
        state.summary = event.reply.markdown;
        state.designVersion = event.designVersion;
        state.endEvent = event;
        if (event.status === 'failed') {
          state.error = event.reply.markdown;
        } else if (event.status === 'cancelled') {
          state.summary = event.reply.markdown;
        }
        return;
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      const trimmed = frame.trim();
      if (!trimmed.startsWith('data: ')) continue;
      try {
        apply(JSON.parse(trimmed.slice(6)) as StreamEvent);
        callbacks.onUpdate(state);
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    }
  }

  callbacks.onDone(state);
}
