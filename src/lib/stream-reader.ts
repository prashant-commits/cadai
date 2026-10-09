import type { ChatMessage, DesignContract, GateRecord } from '@/types';
import type { StreamEvent } from './agent/stream-events';
import type { TranscriptNode, TranscriptSection } from './agent/transcript';
import { escapeMarkers, serializeTranscript } from './agent/transcript';
import { readExpiresAt, withExpiresAt, withOpenedAt } from './chat/rehydrate';

export interface StreamState {
  nodes: TranscriptNode[];
  gates: Record<string, GateRecord>;
  summary: string;
  code?: string;
  stl?: string;
  designContract?: DesignContract;
  /** The paused run to POST back to /api/chat/resume. */
  runId?: string;
  awaitingInput: boolean;
  error?: string;
}

export interface StreamCallbacks {
  onUpdate: (state: StreamState) => void;
  onDone: (state: StreamState) => void;
}

/**
 * The message fields a finished stream writes.
 *
 * An error event wins over a result: the message is marked `error` and the
 * event text is shown. Gates are left out of that patch when the stream
 * carried none, so a resume does not wipe the decision already stored on the
 * message or replace it with a blank complete.
 */
export function streamMessagePatch(state: StreamState): Partial<ChatMessage> {
  if (state.error) {
    const patch: Partial<ChatMessage> = {
      content: `**Error:** ${state.error}`,
      status: 'error',
    };
    // A resume that only sends the error keeps the transcript and the decision
    // already stored on the message. An empty string would wipe both.
    if (state.nodes.length > 0) patch.transcript = serializeTranscript(state.nodes);
    if (Object.keys(state.gates).length > 0) patch.gates = state.gates;
    return patch;
  }
  const status = state.awaitingInput ? 'awaiting_input' : 'complete';
  return {
    transcript: serializeTranscript(state.nodes),
    gates: Object.keys(state.gates).length ? state.gates : undefined,
    content: state.summary,
    code: state.code,
    runId: state.runId,
    status,
  };
}

export async function readStream(response: Response, callbacks: StreamCallbacks): Promise<void> {
  if (!response.body) throw new Error('No response stream received.');

  const state: StreamState = { nodes: [], gates: {}, summary: '', awaitingInput: false };
  let open: TranscriptSection | null = null;

  /** A delta with no open section still has to land somewhere visible. */
  function ensureOpen(): TranscriptSection {
    if (open) return open;
    open = { kind: 'section', id: 'agent', label: 'Agent', status: 'running', body: '' };
    state.nodes.push(open);
    return open;
  }

  function apply(event: StreamEvent) {
    switch (event.t) {
      case 'section':
        if (event.state === 'open') {
          open = { kind: 'section', id: event.id, label: event.label, status: 'running', body: '' };
          state.nodes.push(open);
        } else if (open) {
          open.status = event.status;
          if (event.summary) open.body += `\n\n${escapeMarkers(event.summary)}`;
          open = null;
        }
        return;
      case 'delta':
        // Model text can contain `<!--`, which is how transcript sections are delimited.
        ensureOpen().body += escapeMarkers(event.text);
        return;
      case 'gate': {
        if (open) { open.status = 'ok'; open = null; }
        // `expiresAt` is the server checkpoint deadline (epoch ms). Old events omit it.
        let record = withOpenedAt({ payload: event.payload, status: 'open' }, Date.now());
        const expiresAt = readExpiresAt(event);
        if (expiresAt !== undefined) record = withExpiresAt(record, expiresAt);
        state.gates[event.id] = record;
        state.nodes.push({ kind: 'gate', id: event.id });
        state.runId = event.runId;
        state.awaitingInput = true;
        return;
      }
      case 'result':
        if (open) { open.status = 'ok'; open = null; }
        state.summary = event.summary;
        if (event.code) state.code = event.code;
        if (event.stl) state.stl = event.stl;
        if (event.designContract) state.designContract = event.designContract;
        // A resumed run that reaches a result really has finished, even if it
        // paused earlier in this same stream.
        state.awaitingInput = false;
        return;
      case 'error':
        if (open) { open.status = 'error'; open = null; }
        state.error = event.message;
        state.awaitingInput = false;
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
