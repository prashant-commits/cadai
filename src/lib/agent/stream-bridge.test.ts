import { describe, it, expect } from 'vitest';
import { bridgeGraphStream } from './stream-bridge';
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
  it('opens a section on the first delta for a node and labels it', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'hi', node: 'architectNode' }]]);
    expect(out[0]).toEqual(opened('architectNode', 'Mechanical Architect', 0));
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
    expect(out[2]).toEqual(closed('architectNode'));
    expect(out[3]).toEqual(opened('drafterNode', 'Parametric Drafter', 6));
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
    expect(out[2]).toEqual(closed('architectNode'));
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
    expect(out[0]).toEqual(opened('brandNewNode', 'brandNewNode', -1));
  });

  it('closes the trailing section when the stream ends', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'a', node: 'drafterNode' }]]);
    expect(out.at(-1)).toEqual(closed('drafterNode'));
    const close = out.at(-1) as { startedAt?: number; endedAt?: number; durationMs?: number };
    const open = out[0] as { startedAt: number };
    expect(close.endedAt).toBeGreaterThanOrEqual(open.startedAt);
    expect(close.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('drops raw messages-mode tokens from structured-output nodes', async () => {
    const out = await bridge([
      ['messages', [{ content: '{"assemblyName":' }, { langgraph_node: 'architectNode' }]],
      ['custom', { t: 'delta', text: '**spec**', node: 'architectNode' }],
    ]);
    expect(out.filter((e) => e.t === 'delta')).toEqual([{ t: 'delta', text: '**spec**' }]);
  });

  it('drops raw @body tokens from architectBuild', async () => {
    const out = await bridge([
      ['messages', [{ content: '@body box\ncube([40, 40, 40]);\n@end' }, { langgraph_node: 'architectBuild' }]],
    ]);
    expect(out.filter((e) => e.t === 'delta')).toEqual([]);
    expect(out.filter((e) => e.t === 'section')).toEqual([]);
  });

  it.each([
    ['brepBuild', '@body box\nreturn Box(40, 40, 40)\n@end'],
    ['validateBrep', '[Validation Report]\nValidation Result: Failed'],
  ])('drops raw %s output', async (node, content) => {
    const out = await bridge([['messages', [{ content }, { langgraph_node: node }]]]);
    expect(out.filter((e) => e.t === 'delta')).toEqual([]);
    expect(out.filter((e) => e.t === 'section')).toEqual([]);
  });

  it('closes failed with a one-line summary when the node update has an error-severity result', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'checking', node: 'validateCode' }],
      ['updates', {
        validateCode: {
          isValid: false,
          failureKind: 'semantic',
          attemptCount: 1,
          maxAttempts: 1,
          specViolations: [{ severity: 'error', message: 'lip clashes\nand more detail' }, { severity: 'warning', message: 'thin wall' }],
        },
      }],
    ]);
    const close = out.find((e) => e.t === 'section' && e.state === 'close');
    expect(close).toMatchObject({
      t: 'section',
      id: 'validateCode',
      state: 'close',
      status: 'failed',
      summary: 'lip clashes',
      attempt: 1,
    });
  });

  it('closes the open section as failed when the stream throws', async () => {
    const out: StreamEvent[] = [];
    const chunks = (async function* () {
      yield ['custom', { t: 'delta', text: 'a', node: 'drafterNode' }];
      throw new Error('node exploded\nstack line');
    })();
    await expect(bridgeGraphStream(chunks, 'run-1', (e) => out.push(e))).rejects.toThrow('node exploded');
    expect(out.at(-1)).toMatchObject({
      t: 'section',
      id: 'drafterNode',
      state: 'close',
      status: 'failed',
      summary: 'node exploded',
      attempt: 1,
    });
  });

  it('closes architectBuild as retrying after an audit failure and emits a retry when it runs again', async () => {
    const out = await bridge([
      ['updates', { architectBuild: { attemptCount: 1, pipeline: 'architect', kernel: 'openscad' } }],
      ['updates', {
        validateCode: {
          isValid: false,
          failureKind: 'semantic',
          specViolations: [{ severity: 'error', message: 'arm is short' }],
          attemptCount: 1,
          maxAttempts: 3,
          semanticFailures: 1,
        },
      }],
      ['updates', { architectBuild: { attemptCount: 2 } }],
    ]);
    const buildClose = out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'architectBuild');
    expect(buildClose).toMatchObject({ status: 'retrying', summary: 'arm is short', attempt: 1 });
    const validateClose = out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'validateCode');
    expect(validateClose).toMatchObject({ status: 'failed', summary: 'arm is short', attempt: 1 });
    expect(out.find((e) => e.t === 'retry')).toEqual({
      t: 'retry',
      step: 'architectBuild',
      attempt: 2,
      maxAttempts: 3,
      reason: 'arm is short',
    });
    const reopened = out.filter((e): e is Extract<StreamEvent, { t: 'section'; state: 'open' }> =>
      e.t === 'section' && e.state === 'open' && e.id === 'architectBuild');
    expect(reopened.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it('routes a brep audit failure back to brepBuild', async () => {
    const out = await bridge([
      ['updates', { brepBuild: { attemptCount: 1, pipeline: 'architect', kernel: 'brep' } }],
      ['updates', {
        validateBrep: {
          isValid: false,
          failureKind: 'compile',
          specViolations: [{ severity: 'error', message: 'build123d script failed: name missing' }],
          attemptCount: 1,
          maxAttempts: 3,
          compileFailures: 1,
        },
      }],
      ['updates', { brepBuild: { attemptCount: 2 } }],
    ]);
    expect(out.find((e) => e.t === 'retry')).toMatchObject({
      t: 'retry',
      step: 'brepBuild',
      attempt: 2,
      maxAttempts: 3,
      reason: 'build123d script failed: name missing',
    });
    expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'brepBuild')).toMatchObject({
      status: 'retrying',
    });
  });

  it('closes an architect self-check as retrying and forwards the retry event', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'planning', node: 'architectNode' }],
      ['custom', {
        t: 'retry',
        step: 'architectNode',
        attempt: 2,
        maxAttempts: 3,
        reason: 'spec is self-inconsistent',
        node: 'architectNode',
      }],
      ['custom', { t: 'delta', text: 'again', node: 'architectNode' }],
    ]);
    expect(out[2]).toMatchObject({
      t: 'section',
      id: 'architectNode',
      state: 'close',
      status: 'retrying',
      summary: 'spec is self-inconsistent',
      attempt: 1,
    });
    expect(out[3]).toEqual({
      t: 'retry',
      step: 'architectNode',
      attempt: 2,
      maxAttempts: 3,
      reason: 'spec is self-inconsistent',
    });
    expect(out[4]).toEqual(opened('architectNode', 'Mechanical Architect', 0, 2));
    expect(out[5]).toEqual({ t: 'delta', text: 'again' });
  });

  it('does not retry a validation failure once the attempt budget is spent', async () => {
    const out = await bridge([
      ['updates', { architectBuild: { attemptCount: 1, pipeline: 'architect', kernel: 'openscad' } }],
      ['updates', {
        validateCode: {
          isValid: false,
          failureKind: 'semantic',
          specViolations: [{ severity: 'error', message: 'arm is short' }],
          attemptCount: 1,
          maxAttempts: 1,
          semanticFailures: 1,
        },
      }],
    ]);
    expect(out.find((e) => e.t === 'retry')).toBeUndefined();
    expect(out.find((e) => e.t === 'section' && e.id === 'architectBuild' && e.state === 'close')).toMatchObject({
      status: 'ok',
    });
    expect(out.find((e) => e.t === 'section' && e.id === 'validateCode' && e.state === 'close')).toMatchObject({
      status: 'failed',
      summary: 'arm is short',
    });
  });

  it('puts apiError on a custom error event and keeps message', async () => {
    const out = await bridge([
      ['custom', { t: 'error', message: 'overloaded', node: 'architectNode' }],
    ]);
    expect(out.at(-1)).toMatchObject({
      t: 'error',
      message: 'overloaded',
      apiError: { code: 'model_unavailable', retryable: true },
    });
  });
});
