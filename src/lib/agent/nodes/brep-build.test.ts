import { describe, expect, it, vi } from 'vitest';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentStateType } from '../graph';
import type { AssemblySpec } from '../assembly-spec';
import { resolveSpec } from '../spec-expr';
import { makeBrepBuild } from './brep-build';
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

describe('brepBuild body rejections', () => {
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
});
