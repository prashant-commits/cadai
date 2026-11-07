import { describe, it, expect } from 'vitest';
import { bridgeGraphStream } from './stream-bridge';
import type { StreamEvent } from './stream-events';

async function bridge(chunks: unknown[], options?: { state?: Record<string, unknown> }) {
  const out: StreamEvent[] = [];
  await bridgeGraphStream((async function* () { yield* chunks; })(), 'run-1', (e) => out.push(e), options);
  return out;
}

function withAttempts(value: string | undefined, run: () => Promise<void>) {
  const previous = process.env.CADAI_MAX_ATTEMPTS;
  process.env.CADAI_MAX_ATTEMPTS = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env.CADAI_MAX_ATTEMPTS;
    else process.env.CADAI_MAX_ATTEMPTS = previous;
  });
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

  it('streams the text blocks of content-block chunks (native Anthropic tool or thinking calls), not thinking or tool input', async () => {
    const out = await bridge([
      ['messages', [{ content: [{ index: 0, type: 'thinking', thinking: 'secret' }] }, { langgraph_node: 'drafterNode' }]],
      ['messages', [{ content: [{ index: 1, type: 'text', text: 'Hel' }] }, { langgraph_node: 'drafterNode' }]],
      ['messages', [{ content: [{ index: 1, type: 'text', text: 'lo' }] }, { langgraph_node: 'drafterNode' }]],
      ['messages', [{ content: [{ index: 2, type: 'input_json_delta', input: '{"a"' }] }, { langgraph_node: 'drafterNode' }]],
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
      summary: 'Something went wrong on the server.',
      attempt: 1,
    });
  });

  it('closes architectBuild as retrying after an audit failure and emits a retry when it runs again', async () => {
    await withAttempts('3', async () => {
      const out = await bridge([
        ['updates', { architectNode: { pipeline: 'architect', kernel: 'openscad' } }],
        ['updates', { architectBuild: { attemptCount: 1, buildFallbacks: 0 } }],
        ['updates', {
          validateCode: {
            isValid: false,
            failureKind: 'semantic',
            semanticFailures: 1,
            specViolations: [{ severity: 'error', message: 'arm is short', kind: 'bbox' }],
          },
        }],
        ['updates', { architectBuild: { attemptCount: 2 } }],
      ]);
      const buildClose = out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'architectBuild');
      expect(buildClose).toMatchObject({ status: 'ok', attempt: 1 });
      if (buildClose?.t === 'section' && buildClose.state === 'close') expect(buildClose.summary).toBeUndefined();
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
  });

  it('routes a brep audit failure back to brepBuild from real update shapes', async () => {
    await withAttempts('3', async () => {
      const out = await bridge([
        ['updates', { architectNode: { pipeline: 'architect', kernel: 'brep' } }],
        ['updates', { brepBuild: { attemptCount: 1, buildFallbacks: 0 } }],
        ['updates', {
          validateBrep: {
            isValid: false,
            failureKind: 'compile',
            compileFailures: 1,
            specViolations: [{ severity: 'error', message: 'build123d script failed: name missing' }],
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
        status: 'ok',
        attempt: 1,
      });
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
    await withAttempts('1', async () => {
      const out = await bridge([
        ['updates', { architectNode: { pipeline: 'architect', kernel: 'openscad' } }],
        ['updates', { architectBuild: { attemptCount: 1 } }],
        ['updates', {
          validateCode: {
            isValid: false,
            failureKind: 'semantic',
            semanticFailures: 1,
            specViolations: [{ severity: 'error', message: 'arm is short', kind: 'bbox' }],
          },
        }],
        ['updates', { architectBuild: { attemptCount: 2 } }],
      ]);
      expect(out.filter((e) => e.t === 'retry')).toEqual([]);
      expect(out.find((e) => e.t === 'section' && e.id === 'architectBuild' && e.state === 'close')).toMatchObject({
        status: 'ok',
        attempt: 1,
      });
      expect(out.find((e) => e.t === 'section' && e.id === 'validateCode' && e.state === 'close')).toMatchObject({
        status: 'failed',
        summary: 'arm is short',
      });
    });
  });

  it('closes an exhausted brep audit as failed and does not keep a pending retry', async () => {
    await withAttempts('1', async () => {
      const out = await bridge([
        ['updates', { architectNode: { pipeline: 'architect', kernel: 'brep' } }],
        ['updates', { brepBuild: { attemptCount: 1, buildFallbacks: 0 } }],
        ['updates', {
          validateBrep: {
            isValid: false,
            failureKind: 'semantic',
            semanticFailures: 1,
            specViolations: [{ severity: 'error', message: 'too thin', kind: 'bbox' }],
          },
        }],
        ['updates', { brepBuild: { attemptCount: 2 } }],
      ]);
      expect(out.filter((e) => e.t === 'retry')).toEqual([]);
      expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'brepBuild')).toMatchObject({
        status: 'ok',
        attempt: 1,
      });
      expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'validateBrep')).toMatchObject({
        status: 'failed',
        summary: 'too thin',
      });
    });
  });

  it('repairs an invalid audit that has no extractable message while attempts remain', async () => {
    await withAttempts('3', async () => {
      const out = await bridge([
        ['updates', { architectNode: { pipeline: 'architect', kernel: 'brep' } }],
        ['updates', { brepBuild: { attemptCount: 1 } }],
        ['updates', { validateBrep: { isValid: false, failureKind: 'semantic', semanticFailures: 1 } }],
        ['updates', { brepBuild: { attemptCount: 2 } }],
      ]);
      expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'brepBuild')).toMatchObject({
        status: 'ok',
        attempt: 1,
      });
      expect(out.find((e) => e.t === 'retry')).toMatchObject({ step: 'brepBuild', attempt: 2, maxAttempts: 3 });
    });
  });

  it('resumes an accept-gate revise on the brep build, not fixCode', async () => {
    const out = await bridge([
      ['updates', { acceptGate: { gateAction: 'revise', acceptRevisionCount: 1, maxAttempts: 2 } }],
      ['updates', { brepBuild: { attemptCount: 2 } }],
      ['updates', { validateBrep: { isValid: true, failureKind: 'none' } }],
    ], { state: { pipeline: 'architect', kernel: 'brep', attemptCount: 1 } });
    expect(out.find((e) => e.t === 'retry')).toMatchObject({ step: 'brepBuild', attempt: 2, maxAttempts: 2 });
    expect(out.filter((e) => e.t === 'retry' && e.step === 'fixCode')).toEqual([]);
    expect(out.find((e) => e.t === 'section' && e.state === 'open' && e.id === 'brepBuild')).toMatchObject({
      attempt: 2,
      index: 5,
    });
  });

  it('times a silent build from its task start and finish, and closes it before the next open', async () => {
    await withAttempts('1', async () => {
      const out: StreamEvent[] = [];
      async function* gen() {
        yield ['tasks', { id: 'b', name: 'brepBuild', input: { attemptCount: 0, pipeline: 'architect', kernel: 'brep' }, triggers: [] }];
        yield ['updates', { brepBuild: { attemptCount: 1 } }];
        yield ['tasks', { id: 'b', name: 'brepBuild', result: { attemptCount: 1 } }];
        yield ['tasks', { id: 'v', name: 'validateBrep', input: { attemptCount: 1, pipeline: 'architect', kernel: 'brep' }, triggers: [] }];
        await new Promise((resolve) => setTimeout(resolve, 300));
        yield ['updates', {
          validateBrep: {
            isValid: false,
            failureKind: 'semantic',
            semanticFailures: 1,
            specViolations: [{ severity: 'error', message: 'too thin', kind: 'bbox' }],
          },
        }];
        yield ['tasks', { id: 'v', name: 'validateBrep', result: { isValid: false } }];
      }
      await bridgeGraphStream(gen(), 'run-1', (event) => out.push(event));
      const brep = out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'brepBuild');
      const validate = out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'validateBrep');
      expect(brep).toMatchObject({ status: 'ok', attempt: 1, durationMs: expect.any(Number) });
      expect(validate).toMatchObject({ durationMs: expect.any(Number) });
      if (brep?.t === 'section' && brep.state === 'close' && validate?.t === 'section' && validate.state === 'close') {
        expect(brep.durationMs).toBeLessThan(100);
        expect(validate.durationMs).toBeGreaterThanOrEqual(250);
      }
      const brepCloseAt = out.findIndex((e) => e.t === 'section' && e.state === 'close' && e.id === 'brepBuild');
      const validateOpenAt = out.findIndex((e) => e.t === 'section' && e.state === 'open' && e.id === 'validateBrep');
      expect(brepCloseAt).toBeGreaterThanOrEqual(0);
      expect(brepCloseAt).toBeLessThan(validateOpenAt);
    });
  });

  it('does not emit a retry for the first fixCode run', async () => {
    await withAttempts('3', async () => {
      const out = await bridge([
        ['updates', { architectNode: { pipeline: 'drafter', kernel: 'openscad' } }],
        ['custom', { t: 'delta', text: 'x', node: 'drafterNode' }],
        ['updates', { drafterNode: { attemptCount: 1 } }],
        ['updates', {
          validateCode: {
            isValid: false,
            failureKind: 'compile',
            compileFailures: 1,
            validation: { valid: false, errors: [{ severity: 'error', message: 'syntax' }] },
          },
        }],
        ['custom', { t: 'delta', text: 'fix', node: 'fixCode' }],
        ['updates', { fixCode: { attemptCount: 2 } }],
        ['updates', { validateCode: { isValid: true, failureKind: 'none' } }],
      ]);
      expect(out.filter((e) => e.t === 'retry')).toEqual([]);
      expect(out.find((e) => e.t === 'section' && e.state === 'open' && e.id === 'fixCode')).toMatchObject({ attempt: 1 });
    });
  });

  it('closes a bypassed visual critic as skipped', async () => {
    const out = await bridge([['updates', { visualCritic: {} }]]);
    expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'visualCritic')).toMatchObject({
      status: 'skipped',
    });
  });

  it('creates no section for an unlabeled node that produced no output', async () => {
    const out = await bridge([['updates', { mysteryNode: { foo: 1 } }]]);
    expect(out.filter((e) => e.t === 'section')).toEqual([]);
  });

  it('keeps one architect section across parallel variant retries', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'planning', node: 'architectNode' }],
      ['custom', { t: 'retry', step: 'architectNode', attempt: 2, maxAttempts: 3, reason: 'schema', variantId: 'A', node: 'architectNode' }],
      ['custom', { t: 'retry', step: 'architectNode', attempt: 3, maxAttempts: 3, reason: 'schema', variantId: 'B', node: 'architectNode' }],
      ['custom', { t: 'retry', step: 'architectNode', attempt: 2, maxAttempts: 3, reason: 'schema', variantId: 'A', node: 'architectNode' }],
    ]);
    const opens = out.filter((e) => e.t === 'section' && e.state === 'open');
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ id: 'architectNode', attempt: 1 });
    expect(out.find((e) => e.t === 'section' && e.state === 'close')).toMatchObject({ id: 'architectNode', attempt: 1 });
    const retries = out.filter((e) => e.t === 'retry');
    expect(retries.map((e) => e.t === 'retry' ? e.variantId : '')).toEqual(['A', 'B', 'A']);
    expect(retries.map((e) => e.t === 'retry' ? e.attempt : 0)).toEqual([2, 3, 2]);
  });

  it('closes architectNode ok when it finishes and announces the reviewer loop with a retry', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'spec', node: 'architectNode' }],
      ['updates', { specIllustrator: { illustrated: true } }],
      ['updates', {
        specReviewer: {
          specVariants: [{ needsRevision: true, review: { findings: [{ severity: 'major', issue: 'wall thin' }] } }],
        },
      }],
      ['updates', { architectNode: { pipeline: 'architect' } }],
    ]);
    const closeAt = out.findIndex((e) => e.t === 'section' && e.state === 'close' && e.id === 'architectNode');
    const illustratorAt = out.findIndex((e) => e.t === 'section' && e.state === 'open' && e.id === 'specIllustrator');
    const reviewerAt = out.findIndex((e) => e.t === 'section' && e.state === 'open' && e.id === 'specReviewer');
    const retryAt = out.findIndex((e) => e.t === 'retry');
    expect(out[closeAt]).toMatchObject({ status: 'ok', attempt: 1 });
    expect(closeAt).toBeLessThan(illustratorAt);
    expect(illustratorAt).toBeLessThan(reviewerAt);
    expect(reviewerAt).toBeLessThan(retryAt);
    const architectOpens = out.filter((e) => e.t === 'section' && e.state === 'open' && e.id === 'architectNode');
    expect(architectOpens.map((e) => e.t === 'section' && e.state === 'open' ? e.attempt : 0)).toEqual([1, 2]);
    expect(out[retryAt]).toMatchObject({ t: 'retry', step: 'architectNode', attempt: 2, reason: 'wall thin' });
  });

  it('strips absolute paths from a thrown internal summary and keeps the original error', async () => {
    const out: StreamEvent[] = [];
    const chunks = (async function* () {
      yield ['custom', { t: 'delta', text: 'a', node: 'drafterNode' }];
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
      yield ['custom', { t: 'delta', text: 'a', node: 'drafterNode' }];
      throw new Error('node exploded');
    })();
    await expect(bridgeGraphStream(chunks, 'run-1', () => {
      calls += 1;
      if (calls > 2) throw new Error('writer closed');
    })).rejects.toThrow('node exploded');
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

  it('streams the illustrator while the architect is already closed, before the reviewer runs', async () => {
    const out: StreamEvent[] = [];
    let illustratorOpenBeforeReviewer = false;
    let architectClosedOk = false;
    async function* gen() {
      yield ['tasks', { name: 'architectNode', input: {} }];
      yield ['custom', { t: 'delta', text: 'brief', node: 'architectNode' }];
      yield ['updates', { architectNode: { pipeline: 'architect', kernel: 'brep' } }];
      yield ['tasks', { name: 'architectNode', result: {} }];
      yield ['tasks', { name: 'specIllustrator', input: {} }];
      yield ['custom', { t: 'delta', text: 'Sheet A drawn', node: 'specIllustrator' }];
      architectClosedOk = out.some((e) => e.t === 'section' && e.state === 'close' && e.id === 'architectNode' && e.status === 'ok');
      illustratorOpenBeforeReviewer = out.some((e) => e.t === 'section' && e.state === 'open' && e.id === 'specIllustrator');
      const illustratorDelta = out.some((e) => e.t === 'delta' && e.text === 'Sheet A drawn');
      if (!illustratorDelta) illustratorOpenBeforeReviewer = false;
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield ['tasks', { name: 'specReviewer', input: {} }];
      yield ['updates', { specReviewer: { specVariants: [{ needsRevision: true, review: { findings: [{ severity: 'major', issue: 'overlap' }] } }] } }];
      yield ['tasks', { name: 'specReviewer', result: {} }];
      yield ['tasks', { name: 'architectNode', input: {} }];
    }
    await bridgeGraphStream(gen(), 'run-1', (event) => out.push(event));
    expect(architectClosedOk).toBe(true);
    expect(illustratorOpenBeforeReviewer).toBe(true);
    const reviewerAt = out.findIndex((e) => e.t === 'section' && e.state === 'open' && e.id === 'specReviewer');
    const retryAt = out.findIndex((e) => e.t === 'retry');
    const secondOpen = out.findIndex((e) => e.t === 'section' && e.state === 'open' && e.id === 'architectNode' && e.attempt === 2);
    expect(reviewerAt).toBeGreaterThanOrEqual(0);
    expect(retryAt).toBeGreaterThan(reviewerAt);
    expect(secondOpen).toBe(retryAt + 1);
    expect(out[retryAt]).toMatchObject({ step: 'architectNode', attempt: 2 });
  });

  it('opens one architect section per attempt when a reviewer loop and a self-check both retry', async () => {
    const out = await bridge([
      ['tasks', { name: 'architectNode', input: {} }],
      ['updates', { architectNode: { pipeline: 'architect' } }],
      ['tasks', { name: 'architectNode', result: {} }],
      ['tasks', { name: 'specReviewer', input: {} }],
      ['updates', { specReviewer: { specVariants: [{ needsRevision: true, review: { findings: [{ severity: 'major', issue: 'overlap' }] } }] } }],
      ['tasks', { name: 'specReviewer', result: {} }],
      ['tasks', { name: 'architectNode', input: {} }],
      ['custom', { t: 'retry', step: 'architectNode', attempt: 2, maxAttempts: 3, reason: 'self-check', node: 'architectNode' }],
      ['custom', { t: 'delta', text: 'x', node: 'architectNode' }],
    ]);
    const opens = out.filter((e) => e.t === 'section' && e.state === 'open' && e.id === 'architectNode');
    const attempts = opens.map((e) => e.t === 'section' && e.state === 'open' ? e.attempt : 0);
    expect(attempts).toEqual([1, 2, 3]);
    expect(new Set(attempts).size).toBe(attempts.length);
    const retries = out.filter((e) => e.t === 'retry' && e.step === 'architectNode');
    expect(retries.map((e) => e.t === 'retry' ? e.attempt : 0)).toEqual([2, 3]);
    const selfCheckClose = out.filter((e) => e.t === 'section' && e.state === 'close' && e.id === 'architectNode' && e.attempt === 2);
    expect(selfCheckClose).toHaveLength(1);
    expect(selfCheckClose[0]).toMatchObject({ status: 'retrying' });
  });

  it('counts reviewer retries when seeding a resumed architect attempt', async () => {
    const out = await bridge([
      ['updates', { specGate: { gateAction: 'revise', gateFeedback: 'taller', specRevisionCount: 1 } }],
      ['updates', { architectNode: { pipeline: 'architect' } }],
    ], {
      state: {
        pipeline: 'architect',
        assemblySpec: { components: [] },
        specRevisionCount: 0,
        specVariants: [{ id: 'A', retries: 2, needsRevision: false }],
      },
    });
    expect(out.find((e) => e.t === 'retry' && e.step === 'architectNode')).toMatchObject({ attempt: 4 });
    expect(out.find((e) => e.t === 'section' && e.state === 'open' && e.id === 'architectNode')).toMatchObject({ attempt: 4 });
    expect(out.filter((e) => e.t === 'retry' && e.step === 'specGate')).toEqual([]);
  });

  it('does not emit a retry when a gate is shown again', async () => {
    await withAttempts('2', async () => {
      const out = await bridge([
        ['updates', { acceptGate: { gateAction: 'revise', acceptRevisionCount: 1, maxAttempts: 2, pipeline: 'architect', kernel: 'brep', attemptCount: 1, isValid: true, stlContent: 'solid' } }],
        ['updates', { brepBuild: { attemptCount: 2, pipeline: 'architect', kernel: 'brep', isValid: true, stlContent: 'solid' } }],
        ['updates', { validateBrep: { isValid: true, failureKind: 'none', stlContent: 'solid', pipeline: 'architect', kernel: 'brep', attemptCount: 2, maxAttempts: 2 } }],
        ['updates', { visualCritic: { isValid: true, stlContent: 'solid', pipeline: 'architect', kernel: 'brep', attemptCount: 2 } }],
        ['updates', { acceptGate: { gateAction: null, pipeline: 'architect', kernel: 'brep', attemptCount: 2, isValid: true, stlContent: 'solid' } }],
      ], { state: { pipeline: 'architect', kernel: 'brep', attemptCount: 1, isValid: true, stlContent: 'solid', maxAttempts: 2 } });
      expect(out.filter((e) => e.t === 'retry' && e.step === 'acceptGate')).toEqual([]);
    });

    const variants = [{ id: 'A', spec: { components: [{}, {}] }, needsRevision: false, review: { validated: false, findings: [] }, retries: 0 }];
    const out = await bridge([
      ['updates', { specGate: { gateAction: 'revise', gateFeedback: 'taller', specRevisionCount: 1, specVariants: variants } }],
      ['updates', { architectNode: { pipeline: 'architect', specVariants: variants, specRevisionCount: 1 } }],
      ['updates', { specReviewer: { specVariants: variants, specRevisionCount: 1 } }],
      ['updates', { specGate: { gateAction: null, specRevisionCount: 1, specVariants: variants } }],
    ], {
      state: {
        pipeline: 'architect',
        assemblySpec: { components: [{}, {}] },
        specVariants: variants,
        specRevisionCount: 0,
      },
    });
    expect(out.filter((e) => e.t === 'retry' && e.step === 'specGate')).toEqual([]);
  });

  it('does not fail the architect section when the illustrator throws', async () => {
    const out: StreamEvent[] = [];
    const chunks = (async function* () {
      yield ['tasks', { name: 'architectNode', input: {} }];
      yield ['custom', { t: 'delta', text: 'brief', node: 'architectNode' }];
      yield ['updates', { architectNode: { pipeline: 'architect' } }];
      yield ['tasks', { name: 'architectNode', result: {} }];
      yield ['tasks', { name: 'specIllustrator', input: {} }];
      yield ['custom', { t: 'delta', text: 'sheet', node: 'specIllustrator' }];
      throw new Error('render crashed at /home/claude/work/wt-r2/src/x.ts');
    })();
    await expect(bridgeGraphStream(chunks, 'run-1', (event) => out.push(event))).rejects.toThrow(/render crashed/);
    const architect = out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'architectNode');
    expect(architect).toMatchObject({ status: 'ok', attempt: 1 });
    if (architect?.t === 'section' && architect.state === 'close') expect(architect.summary).toBeUndefined();
    expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'specIllustrator')).toMatchObject({
      status: 'failed',
      summary: 'Something went wrong on the server.',
    });
    const illustrator = out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'specIllustrator');
    if (illustrator?.t === 'section' && illustrator.state === 'close') {
      expect(illustrator.summary).not.toMatch(/render crashed/);
      expect(illustrator.summary).not.toMatch(/\/home\//);
    }
  });

  it('closes an open section as skipped when the user aborts, without the abort text', async () => {
    const out: StreamEvent[] = [];
    const chunks = (async function* () {
      yield ['tasks', { name: 'brepBuild', input: { attemptCount: 0, pipeline: 'architect', kernel: 'brep' } }];
      yield ['updates', { brepBuild: { attemptCount: 1 } }];
      yield ['tasks', { name: 'brepBuild', result: { attemptCount: 1 } }];
      yield ['tasks', { name: 'validateBrep', input: { attemptCount: 1 } }];
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    })();
    await expect(bridgeGraphStream(chunks, 'run-1', (event) => out.push(event))).rejects.toThrow(/aborted/);
    expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'brepBuild')).toMatchObject({
      status: 'ok',
      attempt: 1,
    });
    expect(out.find((e) => e.t === 'section' && e.state === 'close' && e.id === 'validateBrep')).toMatchObject({
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
      ['custom', { t: 'delta', text: 'a', node: 'drafterNode' }],
      ['custom', { t: 'error', message: raw, node: 'drafterNode' }],
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
