import { describe, it, expect } from 'vitest';
import { buildTranscript } from './transcript-build';
import { readStream, type StreamState } from '../stream-reader';
import type { StreamEvent } from './stream-events';

describe('transcript-build', () => {
  it('buildTranscript matches readStream for the same events', async () => {
    const events: StreamEvent[] = [
      { t: 'section', id: 'planner', label: 'Planner', state: 'open' },
      { t: 'delta', text: 'Analyzing <!--code--> requirement...\n' },
      { t: 'delta', text: 'Plan complete.' },
      { t: 'section', id: 'planner', state: 'close', status: 'ok', summary: 'Done planning' },
      { t: 'section', id: 'designer', label: 'Designer', state: 'open' },
      { t: 'delta', text: 'Generating CAD script...' },
      {
        t: 'end',
        seq: 5,
        status: 'done',
        reply: { messageId: 'm1', kind: 'result', markdown: 'Finished' },
      },
    ];

    // 1. Build using buildTranscript
    const nodesFromBuild = buildTranscript(events, 'done');

    // 2. Stream through readStream
    const ssePayload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload));
        controller.close();
      },
    });
    const fakeResponse = new Response(stream);

    let finalState: StreamState | null = null;
    await readStream(fakeResponse, {
      onUpdate: () => {},
      onDone: (state) => {
        finalState = state;
      },
    });

    expect(finalState).not.toBeNull();
    expect(nodesFromBuild).toEqual(finalState!.nodes);
  });
});
