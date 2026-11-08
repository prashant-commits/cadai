import { describe, it, expect } from 'vitest';
import { bridgeGraphStream, NODE_LABELS } from './stream-bridge';
import type { StreamEvent } from './stream-events';

async function bridge(chunks: unknown[]) {
  const out: StreamEvent[] = [];
  await bridgeGraphStream((async function* () { yield* chunks; })(), 'run-1', (e) => out.push(e));
  return out;
}

function opened(id: string, label: string, index: number, attempt = 1) {
  return {
    t: 'section' as const,
    id,
    label,
    state: 'open' as const,
    index,
    startedAt: expect.any(Number),
    attempt,
  };
}

function closed(id: string, attempt = 1, extra: Record<string, unknown> = {}) {
  return {
    t: 'section' as const,
    id,
    state: 'close' as const,
    status: 'ok',
    endedAt: expect.any(Number),
    durationMs: expect.any(Number),
    attempt,
    ...extra,
  };
}

describe('bridgeGraphStream', () => {
  it('exports NODE_LABELS with only respondToUser', () => {
    expect(NODE_LABELS).toEqual({ respondToUser: 'Result' });
  });

  it('opens a section on the first delta for a node and labels it with its fallback id', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'hi', node: 'designerNode' }]]);
    expect(out[0]).toEqual(opened('designerNode', 'designerNode', 0));
    expect(out[1]).toEqual({ t: 'delta', text: 'hi' });
  });

  it('does not reopen a section for a second delta from the same node', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'designerNode' }],
      ['custom', { t: 'delta', text: 'b', node: 'designerNode' }],
    ]);
    // Exactly one OPEN. A trailing close is correct and is asserted separately.
    expect(out.filter((e) => e.t === 'section' && e.state === 'open')).toHaveLength(1);
  });

  it('closes the open section when a different node starts', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'designerNode' }],
      ['custom', { t: 'delta', text: 'b', node: 'designerCheck' }],
    ]);
    expect(out[2]).toEqual(closed('designerNode'));
    expect(out[3]).toEqual(opened('designerCheck', 'designerCheck', 1));
  });

  it('turns model token chunks into deltas under their own node', async () => {
    const out = await bridge([
      ['messages', [{ content: 'Hel' }, { langgraph_node: 'designerNode' }]],
      ['messages', [{ content: 'lo' }, { langgraph_node: 'designerNode' }]],
    ]);
    expect(out.filter((e) => e.t === 'delta')).toEqual([{ t: 'delta', text: 'Hel' }, { t: 'delta', text: 'lo' }]);
  });

  it('streams the text blocks of content-block chunks (native Anthropic tool or thinking calls), not thinking or tool input', async () => {
    const out = await bridge([
      ['messages', [{ content: [{ index: 0, type: 'thinking', thinking: 'secret' }] }, { langgraph_node: 'designerNode' }]],
      ['messages', [{ content: [{ index: 1, type: 'text', text: 'Hel' }] }, { langgraph_node: 'designerNode' }]],
      ['messages', [{ content: [{ index: 1, type: 'text', text: 'lo' }] }, { langgraph_node: 'designerNode' }]],
      ['messages', [{ content: [{ index: 2, type: 'input_json_delta', input: '{"a"' }] }, { langgraph_node: 'designerNode' }]],
    ]);
    expect(out.filter((e) => e.t === 'delta')).toEqual([{ t: 'delta', text: 'Hel' }, { t: 'delta', text: 'lo' }]);
  });

  it('passes a result event straight through and closes any open section', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'designerNode' }],
      ['custom', { t: 'result', summary: 'Built it.', node: 'respondToUser' }],
    ]);
    expect(out.at(-1)).toEqual({ t: 'result', summary: 'Built it.' });
    expect(out.some((e) => e.t === 'section' && e.state === 'close')).toBe(true);
  });

  it('labels an unknown node with its own id rather than dropping it', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'x', node: 'brandNewNode' }]]);
    expect(out[0]).toEqual(opened('brandNewNode', 'brandNewNode', -1));
  });

  it('closes the trailing section when the stream ends', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'a', node: 'designerNode' }]]);
    expect(out.at(-1)).toEqual(closed('designerNode'));
    const close = out.at(-1) as { startedAt?: number; endedAt?: number; durationMs?: number };
    const open = out[0] as { startedAt: number };
    expect(close.endedAt).toBeGreaterThanOrEqual(open.startedAt);
    expect(close.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('closes the open section as failed when the stream throws', async () => {
    const out: StreamEvent[] = [];
    const chunks = (async function* () {
      yield ['custom', { t: 'delta', text: 'a', node: 'designerNode' }];
      throw new Error('node exploded\nstack line');
    })();
    await expect(bridgeGraphStream(chunks, 'run-1', (e) => out.push(e))).rejects.toThrow('node exploded');
    expect(out.at(-1)).toMatchObject({
      t: 'section',
      id: 'designerNode',
      state: 'close',
      status: 'failed',
      summary: 'Something went wrong on the server.',
      attempt: 1,
    });
  });

  it('creates no section for an unlabeled node that produced no output', async () => {
    const out = await bridge([['updates', { mysteryNode: { foo: 1 } }]]);
    expect(out.filter((e) => e.t === 'section')).toEqual([]);
  });

  it('strips absolute paths from a thrown internal summary and keeps the original error', async () => {
    const out: StreamEvent[] = [];
    const chunks = (async function* () {
      yield ['custom', { t: 'delta', text: 'a', node: 'designerNode' }];
      throw new Error("ENOENT: no such file or directory, open '/home/claude/work/wt-r2/.cadai/x.sqlite'");
    })();
    await expect(bridgeGraphStream(chunks, 'run-1', (event) => out.push(event))).rejects.toThrow(/ENOENT/);
    const close = out.at(-1);
    expect(close).toMatchObject({
      t: 'section',
      state: 'close',
      status: 'failed',
      summary: 'Something went wrong on the server.',
    });
    if (close?.t === 'section' && close.state === 'close') {
      expect(close.summary).not.toMatch(/\/home\//);
      expect(close.summary).not.toMatch(/sqlite/);
    }
  });

  it('keeps the original stream error when emitting the close throws', async () => {
    let calls = 0;
    const chunks = (async function* () {
      yield ['custom', { t: 'delta', text: 'a', node: 'designerNode' }];
      throw new Error('node exploded');
    })();
    await expect(bridgeGraphStream(chunks, 'run-1', () => {
      calls += 1;
      if (calls > 2) throw new Error('writer closed');
    })).rejects.toThrow('node exploded');
  });

  it('puts apiError on a custom error event and keeps message', async () => {
    const out = await bridge([
      ['custom', { t: 'error', message: 'overloaded', node: 'designerNode' }],
    ]);
    expect(out.at(-1)).toMatchObject({
      t: 'error',
      message: 'overloaded',
      apiError: { code: 'model_unavailable', retryable: true },
    });
  });

  it('closes an open section as skipped when the user aborts, without the abort text', async () => {
    const out: StreamEvent[] = [];
    const chunks = (async function* () {
      yield ['custom', { t: 'delta', text: 'start', node: 'designerNode' }];
      yield ['custom', { t: 'delta', text: 'check', node: 'designerCheck' }];
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    })();
    await expect(bridgeGraphStream(chunks, 'run-1', (event) => out.push(event))).rejects.toThrow(/aborted/);
    expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'designerNode')).toMatchObject({
      status: 'ok',
      attempt: 1,
    });
    expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'designerCheck')).toMatchObject({
      status: 'skipped',
      summary: 'stopped',
    });
    for (const event of out) {
      if (event.t === 'section' && event.state === 'close' && event.summary) {
        expect(event.summary).not.toMatch(/aborted/i);
      }
    }
  });

  it('keeps model output out of a section summary and in apiError.detail only', async () => {
    const raw = 'Failed to parse. Text: {"secret model output": 1} /home/claude/work/wt-r2/a.ts';
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'designerNode' }],
      ['custom', { t: 'error', message: raw, node: 'designerNode' }],
    ]);
    const close = out.find((e) => e.t === 'section' && e.state === 'close');
    expect(close).toMatchObject({ status: 'failed', summary: 'Something went wrong on the server.' });
    if (close?.t === 'section' && close.state === 'close') expect(close.summary).not.toMatch(/secret model output/);
    const error = out.find((e) => e.t === 'error');
    expect(error).toMatchObject({
      t: 'error',
      message: raw,
      apiError: { code: 'internal', message: 'Something went wrong on the server.' },
    });
    if (error?.t === 'error') {
      expect(error.apiError?.detail).toContain('secret model output');
      expect(error.apiError?.detail).not.toMatch(/\/home\//);
      expect(error.apiError?.message).not.toMatch(/secret/);
    }
  });
});
