import { describe, expect, it, vi } from 'vitest';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentStateType } from '../graph';
import type { AssemblySpec } from '../assembly-spec';
import { resolveSpec } from '../spec-expr';
import { makeBrepBuild, SHORTER_REPLY } from './brep-build';
import { systemPromptFor } from '../system-prompt';

const spec = resolveSpec({
  sheet: '## Holder\nA backplate and a ring.', assemblyName: 'holder', boundingBox: { width: 120, length: 106, height: 160 },
  guides: [], stressPoints: [], assumptions: [], openQuestions: [],
  parameters: [{ name: 'ring_id', value: 90, min: 60, max: 120, unit: 'mm', description: 'ring inner diameter' }],
  components: [
    { name: 'backplate', description: 'plate', localExtents: [120, 6, 160], position: [0, 0, 0], shape: { kind: 'box' } },
    { name: 'cup_ring', description: 'ring', localExtents: [100, 100, 30], position: [10, 6, 100], shape: { kind: 'tube', axis: 'z', innerD: 'ring_id' } },
  ],
} as unknown as AssemblySpec).spec;

const good = '@body backplate\npart = Box(120, 6, 160, align=(Align.MIN, Align.MIN, Align.MIN))\nreturn part\n@end\n@body cup_ring\npart = Cylinder(50, 30, align=(Align.MIN, Align.MIN, Align.MIN))\nreturn part\n@end';

function fakeModel(reply: AIMessage) {
  const calls: BaseMessage[][] = [];
  return { calls, model: { invoke: async (messages: BaseMessage[]) => { calls.push(messages); return reply; } } };
}

const state = (over: Partial<AgentStateType> = {}) =>
  ({ assemblySpec: spec, currentCode: '', specViolations: [], gateFeedback: null, gateAction: null, attemptCount: 0, messages: [], failureKind: 'none', ...over }) as unknown as AgentStateType;

describe('brepBuild system prompt', () => {
  it('goes out as a cached system message (parity with the native API nodes)', async () => {
    const { model, calls } = fakeModel(new AIMessage(good));
    await makeBrepBuild(model as never)(state());
    const system = calls[0][0];
    expect(system.getType()).toBe('system');
    expect(system.content).toEqual([{ type: 'text', text: systemPromptFor('brep-build'), cache_control: { type: 'ephemeral' } }]);
  });
});

describe('brepBuild stop reasons', () => {
  const previous = 'result = 1';

  it.each(['max_tokens', 'model_context_window_exceeded', 'pause_turn'])('a reply stopped by %s builds nothing and is a truncated attempt', async (stop) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { model } = fakeModel(new AIMessage({ content: good, response_metadata: { stop_reason: stop } }));
    const out = await makeBrepBuild(model as never)(state({ currentCode: previous, attemptCount: 1 }));
    expect(out.failureKind).toBe('truncated');
    expect(out.currentCode).toBe(previous);
    expect(out.attemptCount).toBe(2);
    expect(out.buildFallbacks).toBe(0);
    expect(out.gateAction).toBeNull();
    warn.mockRestore();
  });

  it('a refusal is a no_code attempt, also when the stop reason arrives as a streamed additional kwarg', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { model } = fakeModel(new AIMessage({ content: '', additional_kwargs: { stop_reason: 'refusal' } }));
    const out = await makeBrepBuild(model as never)(state());
    expect(out.failureKind).toBe('no_code');
    expect(out.currentCode).toBe('');
    warn.mockRestore();
  });

  it('a normal end_turn reply is built and clears a stale failure kind', async () => {
    const { model } = fakeModel(new AIMessage({ content: good, response_metadata: { stop_reason: 'end_turn' } }));
    const out = await makeBrepBuild(model as never)(state({ failureKind: 'no_code' }));
    expect(out.failureKind).toBe('none');
    expect(out.currentCode).toContain('def backplate():');
    expect(out.buildFallbacks).toBe(0);
  });
});

const text = (m: BaseMessage) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

describe('brepBuild retry after a cut-off reply', () => {
  it('asks for a shorter answer after a truncated attempt, and only then', async () => {
    const a = fakeModel(new AIMessage(good));
    await makeBrepBuild(a.model as never)(state({ failureKind: 'truncated' as never, currentCode: 'result = 1', attemptCount: 1 }));
    expect(text(a.calls[0][1])).toContain(SHORTER_REPLY);
    for (const kind of ['no_code', 'compile', 'none']) {
      const b = fakeModel(new AIMessage(good));
      await makeBrepBuild(b.model as never)(state({ failureKind: kind as never }));
      expect(text(b.calls[0][1])).not.toContain(SHORTER_REPLY);
    }
  });
});

describe('brepBuild body rejections', () => {
  const bad = '@body backplate\nwith BuildPart() as p:\n    Box(120, 6, 160)\nreturn p.part\n@end\n';
  const ring = '@body cup_ring\npart = Cylinder(50, 30)\nreturn part\n@end';

  it('a corrected body sent after a rejected one leaves no note and no error', async () => {
    const reply = `${bad}@body backplate\npart = Box(120, 6, 160, align=(Align.MIN, Align.MIN, Align.MIN))\nreturn part\n@end\n${ring}`;
    const out = await makeBrepBuild(fakeModel(new AIMessage(reply)).model as never)(state());
    expect(out.buildNotes ?? []).toEqual([]);
    expect(out.buildFallbacks).toBe(0);
  });

  it('a refused body for a part that keeps its previous body leaves no stale note', async () => {
    const first = await makeBrepBuild(fakeModel(new AIMessage(good)).model as never)(state());
    const out = await makeBrepBuild(fakeModel(new AIMessage(`${bad}`)).model as never)(state({
      currentCode: first.currentCode, attemptCount: 1,
      specViolations: [{ kind: 'compile', field: 'cup_ring', expected: 'x', measured: 'y', severity: 'error', message: 'cup_ring: fix' }] as never,
    }));
    expect((out.buildNotes ?? []).filter((n) => n.name === 'backplate')).toEqual([]);
    expect(out.currentCode).toContain('Box(120, 6, 160');
  });

  it('a with BuildPart body is replaced by its blockout and the note carries the reason and the fix', async () => {
    const reply = '@body backplate\nwith BuildPart() as p:\n    Box(120, 6, 160)\npart = p.part\nreturn part\n@end\n@body cup_ring\npart = Cylinder(50, 30)\nreturn part\n@end';
    const { model } = fakeModel(new AIMessage(reply));
    const out = await makeBrepBuild(model as never)(state());
    expect(out.currentCode).not.toContain('BuildPart');
    expect(out.buildFallbacks).toBe(1);
    const note = (out.buildNotes ?? []).find((n) => n.name === 'backplate');
    expect(note?.reason).toContain('algebra mode only');
    expect(note?.reason).toContain('extrude(Plane.YZ * Polygon(*pts, align=None), amount=w)');
    expect(note?.reason).toContain('drawn from the blockout');
  });

  it('tells the body model about edge_r and minor_r in parameter list (M3)', async () => {
    const sWithDl = resolveSpec({
      ...spec,
      designLanguage: {
        name: 'soft monolith',
        principles: ['soft 6mm'],
        edgeRadius: 6,
        minorRadius: 1.5,
      },
    } as unknown as AssemblySpec).spec;
    const { model, calls } = fakeModel(new AIMessage(good));
    await makeBrepBuild(model as never)(state({ assemblySpec: sWithDl }));
    const humanMsg = calls[0][1];
    expect(humanMsg.getType()).toBe('human');
    const content = typeof humanMsg.content === 'string' ? humanMsg.content : JSON.stringify(humanMsg.content);
    expect(content).toContain('Parameter names:');
    expect(content).toContain('edge_r');
    expect(content).toContain('minor_r');
  });
});
