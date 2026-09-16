import type { DesignContract, GateRecord } from '@/types';
import type { StreamEvent } from './agent/stream-events';
import type { TranscriptNode, TranscriptSection } from './agent/transcript';
import { escapeMarkers } from './agent/transcript';

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
        ensureOpen().body += event.text;
        return;
      case 'gate':
        if (open) { open.status = 'ok'; open = null; }
        state.gates[event.id] = { payload: event.payload, status: 'open' };
        state.nodes.push({ kind: 'gate', id: event.id });
        state.runId = event.runId;
        state.awaitingInput = true;
        return;
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
