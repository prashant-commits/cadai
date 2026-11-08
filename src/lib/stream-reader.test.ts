import { describe, it, expect } from 'vitest';
import { readStream, streamMessagePatch, type StreamState } from './stream-reader';
import { parseTranscript, serializeTranscript } from './agent/transcript';
import type { StreamEvent } from './agent/stream-events';

function sse(events: StreamEvent[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new Blob([body]).stream());
}

async function run(events: StreamEvent[]) {
  let final: StreamState | undefined;
  const updates: StreamState[] = [];
  await readStream(sse(events), {
    onUpdate: (s) => updates.push(structuredClone({ ...s, nodes: [...s.nodes] })),
    onDone: (s) => {
      final = s;
    },
  });
  return { final: final!, updates };
}

describe('readStream', () => {
  it('accumulates deltas into the open section', async () => {
    const { final } = await run([
      { t: 'section', id: 'designerNode', label: 'designerNode', state: 'open' },
      { t: 'delta', text: 'Bounding box: ' },
      { t: 'delta', text: '62 x 40 x 18 mm' },
      { t: 'section', id: 'designerNode', state: 'close', status: 'ok' },
      {
        t: 'end',
        seq: 2,
        status: 'done',
        reply: { messageId: 'm1', kind: 'result', markdown: 'Built it.' },
      },
    ]);
    expect(final.nodes).toEqual([
      {
        kind: 'section',
        id: 'designerNode',
        label: 'designerNode',
        status: 'ok',
        body: 'Bounding box: 62 x 40 x 18 mm',
      },
    ]);
    expect(final.summary).toBe('Built it.');
  });

  it('keeps later sections intact when a delta contains a comment marker', async () => {
    const { final } = await run([
      { t: 'section', id: 'designerNode', label: 'designerNode', state: 'open' },
      { t: 'delta', text: 'before <!-- notes --> after <!--/s--> tail' },
      { t: 'section', id: 'designerNode', state: 'close', status: 'ok' },
      { t: 'section', id: 'designerCheck', label: 'designerCheck', state: 'open' },
      { t: 'delta', text: 'drawn' },
      { t: 'section', id: 'designerCheck', state: 'close', status: 'ok' },
      {
        t: 'end',
        seq: 3,
        status: 'done',
        reply: { messageId: 'm1', kind: 'result', markdown: 'done' },
      },
    ]);
    const parsed = parseTranscript(serializeTranscript(final.nodes));
    expect(parsed.map((node) => node.id)).toEqual(['designerNode', 'designerCheck']);
    const designer = parsed[0];
    if (designer.kind !== 'section') throw new Error('expected a section');
    // Stored as an entity. The browser renders it back as a literal `<!-- notes -->`.
    expect(designer.body).toContain('&lt;!-- notes -->');
    expect(designer.body).toContain('tail');
    expect(designer.body).not.toContain('<!--');
    const check = parsed[1];
    if (check.kind !== 'section') throw new Error('expected a section');
    expect(check.label).toBe('designerCheck');
    expect(check.body).toBe('drawn');
  });

  it('emits an update per delta so the UI can render progressively', async () => {
    const { updates } = await run([
      { t: 'section', id: 'n', label: 'N', state: 'open' },
      { t: 'delta', text: 'a' },
      { t: 'delta', text: 'b' },
      { t: 'section', id: 'n', state: 'close', status: 'ok' },
      {
        t: 'end',
        seq: 2,
        status: 'done',
        reply: { messageId: 'm1', kind: 'result', markdown: 'done' },
      },
    ]);
    expect(updates.length).toBeGreaterThanOrEqual(4);
  });

  it('routes a delta with no open section into an implicit section rather than dropping it', async () => {
    const { final } = await run([
      { t: 'delta', text: 'orphan text' },
      {
        t: 'end',
        seq: 1,
        status: 'done',
        reply: { messageId: 'm1', kind: 'result', markdown: 'done' },
      },
    ]);
    expect(serializeOf(final)).toContain('orphan text');
  });

  it('surfaces an error event and closes the open section as failed', async () => {
    const { final } = await run([
      { t: 'section', id: 'n', label: 'N', state: 'open' },
      { t: 'delta', text: 'partial' },
      {
        t: 'end',
        seq: 2,
        status: 'failed',
        reply: { messageId: 'm1', kind: 'error', markdown: 'gateway refused' },
      },
    ]);
    expect(final.error).toBe('gateway refused');
    expect((final.nodes[0] as { status: string }).status).toBe('error');
  });

  it('turns a failed end event into an error message instead of a blank complete', async () => {
    const message = 'The build ran out of time. Try a simpler request or send it again.';
    const { final } = await run([
      {
        t: 'end',
        seq: 1,
        status: 'failed',
        reply: { messageId: 'm1', kind: 'error', markdown: message },
      },
    ]);
    const patch = streamMessagePatch(final);
    expect(patch.status).toBe('error');
    expect(patch.content).toBe(message);
    expect(patch.content?.trim()).not.toBe('');

    const finished = streamMessagePatch({
      nodes: [],
      summary: 'Built it.',
    });
    expect(finished.status).toBe('complete');
    expect(finished.content).toBe('Built it.');
  });

  it('handles a cancelled end event setting summary to reply.markdown', async () => {
    const { final } = await run([
      {
        t: 'end',
        seq: 1,
        status: 'cancelled',
        reply: { messageId: 'm1', kind: 'cancelled', markdown: 'Stopped.' },
      },
    ]);
    expect(final.summary).toBe('Stopped.');
    expect(final.error).toBeUndefined();
    const patch = streamMessagePatch(final);
    expect(patch.status).toBe('complete');
    expect(patch.content).toBe('Stopped.');
  });
});

function serializeOf(s: StreamState) {
  return s.nodes.map((n) => n.body).join('');
}
