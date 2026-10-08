import { describe, it, expect } from 'vitest';
import { bridgeGraphStream } from './stream-bridge';
import type { StreamEvent } from './stream-events';

async function bridge(chunks: unknown[]) {
  const out: StreamEvent[] = [];
  await bridgeGraphStream((async function* () { yield* chunks; })(), 'run-1', (e) => out.push(e));
  return out;
}

describe('bridgeGraphStream', () => {
  it('opens a section on the first delta for a node and labels it', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'hi', node: 'architectNode' }]]);
    expect(out[0]).toEqual({ t: 'section', id: 'architectNode', label: 'Mechanical Architect', state: 'open' });
    expect(out[1]).toEqual({ t: 'delta', text: 'hi' });
  });

  it('does not reopen a section for a second delta from the same node', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'architectNode' }],
      ['custom', { t: 'delta', text: 'b', node: 'architectNode' }],
    ]);
    // Exactly one OPEN. A trailing close is correct and is asserted separately.
    expect(out.filter((e) => e.t === 'section' && e.state === 'open')).toHaveLength(1);
  });

  it('closes the open section when a different node starts', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'architectNode' }],
      ['custom', { t: 'delta', text: 'b', node: 'drafterNode' }],
    ]);
    expect(out[2]).toEqual({ t: 'section', id: 'architectNode', state: 'close', status: 'ok' });
    expect(out[3]).toEqual({ t: 'section', id: 'drafterNode', label: 'Parametric Drafter', state: 'open' });
  });

  it('turns model token chunks into deltas under their own node', async () => {
    const out = await bridge([
      ['messages', [{ content: 'Hel' }, { langgraph_node: 'drafterNode' }]],
      ['messages', [{ content: 'lo' }, { langgraph_node: 'drafterNode' }]],
    ]);
    expect(out.filter((e) => e.t === 'delta')).toEqual([{ t: 'delta', text: 'Hel' }, { t: 'delta', text: 'lo' }]);
  });

  it('emits a gate event with the run id when an interrupt arrives', async () => {
    const payload = { kind: 'spec', spec: null, contract: null, revisionCount: 0 };
    const out = await bridge([['updates', { __interrupt__: [{ id: 'i1', value: payload }] }]]);
    const gate = out.find((e) => e.t === 'gate');
    expect(gate).toMatchObject({ t: 'gate', id: 'i1', runId: 'run-1', payload });
  });

  it('puts the gate expiry (now + CADAI_CHECKPOINT_TTL_MS) on the gate event', async () => {
    process.env.CADAI_CHECKPOINT_TTL_MS = '3600000';
    try {
      const before = Date.now();
      const out = await bridge([['updates', { __interrupt__: [{ id: 'i1', value: { kind: 'spec' } }] }]]);
      const gate = out.find((e) => e.t === 'gate') as { expiresAt?: number };
      expect(gate.expiresAt).toBeGreaterThanOrEqual(before + 3600000);
      expect(gate.expiresAt).toBeLessThanOrEqual(Date.now() + 3600000);
    } finally {
      delete process.env.CADAI_CHECKPOINT_TTL_MS;
    }
  });

  it('closes an open section before emitting a gate', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'architectNode' }],
      ['updates', { __interrupt__: [{ id: 'i1', value: { kind: 'spec' } }] }],
    ]);
    expect(out[2]).toEqual({ t: 'section', id: 'architectNode', state: 'close', status: 'ok' });
    expect(out[3]!.t).toBe('gate');
  });

  it('passes a result event straight through and closes any open section', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'drafterNode' }],
      ['custom', { t: 'result', summary: 'Built it.', node: 'respondToUser' }],
    ]);
    expect(out.at(-1)).toEqual({ t: 'result', summary: 'Built it.' });
    expect(out.some((e) => e.t === 'section' && e.state === 'close')).toBe(true);
  });

  it('labels an unknown node with its own id rather than dropping it', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'x', node: 'brandNewNode' }]]);
    expect(out[0]).toEqual({ t: 'section', id: 'brandNewNode', label: 'brandNewNode', state: 'open' });
  });

  it('closes the trailing section when the stream ends', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'a', node: 'drafterNode' }]]);
    expect(out.at(-1)).toEqual({ t: 'section', id: 'drafterNode', state: 'close', status: 'ok' });
  });

  it('drops raw messages-mode tokens from structured-output nodes', async () => {
    const out = await bridge([
      ['messages', [{ content: '{"assemblyName":' }, { langgraph_node: 'architectNode' }]],
      ['custom', { t: 'delta', text: '**spec**', node: 'architectNode' }],
    ]);
    expect(out.filter((e) => e.t === 'delta')).toEqual([{ t: 'delta', text: '**spec**' }]);
  });
});
