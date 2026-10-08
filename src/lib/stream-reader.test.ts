import { describe, it, expect } from 'vitest';
import { readStream, streamMessagePatch, type StreamState } from './stream-reader';
import { readOpenedAt } from './chat/rehydrate';
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
    onDone: (s) => { final = s; },
  });
  return { final: final!, updates };
}

describe('readStream', () => {
  it('accumulates deltas into the open section', async () => {
    const { final } = await run([
      { t: 'section', id: 'architectNode', label: 'Architect', state: 'open' },
      { t: 'delta', text: 'Bounding box: ' },
      { t: 'delta', text: '62 x 40 x 18 mm' },
      { t: 'section', id: 'architectNode', state: 'close', status: 'ok' },
      { t: 'result', summary: 'Built it.' },
    ]);
    expect(final.nodes).toEqual([
      { kind: 'section', id: 'architectNode', label: 'Architect', status: 'ok', body: 'Bounding box: 62 x 40 x 18 mm' },
    ]);
    expect(final.summary).toBe('Built it.');
  });

  it('records a gate and marks the run as awaiting input', async () => {
    const payload = { kind: 'spec', spec: null, contract: null, revisionCount: 0 } as const;
    const { final } = await run([
      { t: 'section', id: 'architectNode', label: 'Architect', state: 'open' },
      { t: 'delta', text: 'spec' },
      { t: 'section', id: 'architectNode', state: 'close', status: 'ok' },
      { t: 'gate', id: 'g1', runId: 'run-1', payload },
    ]);
    expect(final.awaitingInput).toBe(true);
    expect(final.runId).toBe('run-1');
    expect(final.gates.g1.status).toBe('open');
    expect(readOpenedAt(final.gates.g1)).toEqual(expect.any(Number));
    expect(final.nodes.at(-1)).toEqual({ kind: 'gate', id: 'g1' });
  });

  it('emits an update per delta so the UI can render progressively', async () => {
    const { updates } = await run([
      { t: 'section', id: 'n', label: 'N', state: 'open' },
      { t: 'delta', text: 'a' },
      { t: 'delta', text: 'b' },
      { t: 'section', id: 'n', state: 'close', status: 'ok' },
      { t: 'result', summary: 'done' },
    ]);
    expect(updates.length).toBeGreaterThanOrEqual(4);
  });

  it('routes a delta with no open section into an implicit section rather than dropping it', async () => {
    const { final } = await run([
      { t: 'delta', text: 'orphan text' },
      { t: 'result', summary: 'done' },
    ]);
    expect(serializeOf(final)).toContain('orphan text');
  });

  it('carries code, stl and contract off the result event', async () => {
    const { final } = await run([
      { t: 'result', summary: 'ok', code: 'cube(1);', stl: 'solid x facet normal', designContract: { standing: {}, pinnedParams: {} } },
    ]);
    expect(final.code).toBe('cube(1);');
    expect(final.stl).toContain('facet normal');
    expect(final.designContract).toBeDefined();
  });

  it('surfaces an error event and closes the open section as failed', async () => {
    const { final } = await run([
      { t: 'section', id: 'n', label: 'N', state: 'open' },
      { t: 'delta', text: 'partial' },
      { t: 'error', message: 'gateway refused' },
    ]);
    expect(final.error).toBe('gateway refused');
    expect((final.nodes[0] as { status: string }).status).toBe('error');
  });

  it('turns an error event into an error message instead of a blank complete', async () => {
    const message = 'This paused run expired (no decision within 24 h). Send the request again.';
    const { final } = await run([{ t: 'error', message }]);
    const patch = streamMessagePatch(final);
    expect(patch.status).toBe('error');
    expect(patch.content).toBe(`**Error:** ${message}`);
    expect(patch.content?.trim()).not.toBe('');
    expect(patch.gates).toBeUndefined();

    const finished = streamMessagePatch({
      nodes: [],
      gates: {},
      summary: 'Built it.',
      awaitingInput: false,
    });
    expect(finished.status).toBe('complete');
    expect(finished.content).toBe('Built it.');
  });
});

function serializeOf(s: StreamState) {
  return s.nodes.map((n) => ('body' in n ? n.body : '')).join('');
}
