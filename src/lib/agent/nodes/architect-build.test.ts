import { describe, expect, it } from 'vitest';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentStateType } from '../graph';
import type { AssemblySpec } from '../assembly-spec';
import { resolveSpec } from '../spec-expr';
import { makeArchitectBuild } from './architect-build';
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

function fakeModel(reply: string) {
  const calls: BaseMessage[][] = [];
  return {
    calls,
    model: { invoke: async (messages: BaseMessage[]) => { calls.push(messages); return new AIMessage(reply); } },
  };
}

const state = (over: Partial<AgentStateType> = {}) =>
  ({ assemblySpec: spec, currentCode: '', specViolations: [], gateFeedback: null, gateAction: null, attemptCount: 0, messages: [], ...over }) as unknown as AgentStateType;

const text = (m: BaseMessage) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

describe('architectBuild', () => {
  it('first visit: no REQUIRED CHANGES; one body used, the truncated one falls back to its blockout', async () => {
    const { model, calls } = fakeModel('@body cup_ring\ndifference() { cylinder(d = ring_id + 10, h = 30); cylinder(d = ring_id, h = 30.02); }\n@end\n@body backplate\ncube([120, 6,');
    const out = await makeArchitectBuild(model as never)(state());
    expect(calls).toHaveLength(1);
    expect(calls[0].map(text).join('\n')).not.toContain('REQUIRED CHANGES');
    expect(out.currentCode).toMatch(/^ring_id = 90;/);
    expect(out.currentCode).toContain('cylinder(d = ring_id + 10, h = 30)');
    expect(out.currentCode!.match(/module backplate\(\)/g)).toHaveLength(1);
    expect(out.buildFallbacks).toBe(1);
    expect(out.attemptCount).toBe(1);
  });

  it('repeat visit: names the failing part in REQUIRED CHANGES and keeps the other part as it was', async () => {
    const first = await makeArchitectBuild(fakeModel('@body cup_ring\ncylinder(d = ring_id, h = 30);\n@end\n@body backplate\ncube([120, 6, 160]);\n@end').model as never)(state());
    const { model, calls } = fakeModel('@body cup_ring\ndifference() { cylinder(d = ring_id + 10, h = 30); cylinder(d = ring_id, h = 30.02); }\n@end');
    const out = await makeArchitectBuild(model as never)(state({
      currentCode: first.currentCode,
      attemptCount: 1,
      specViolations: [{ kind: 'extents', severity: 'error', message: 'cup_ring measures 90 x 90 x 30, spec says 100 x 100 x 30', component: 'cup_ring' } as never],
    }));
    const sent = calls[0].map(text).join('\n');
    expect(sent).toContain('REQUIRED CHANGES');
    expect(sent).toContain('cup_ring');
    expect(out.currentCode).toContain('cube([120, 6, 160]);');
    expect(out.currentCode).toContain('cylinder(d = ring_id + 10, h = 30)');
    expect(out.attemptCount).toBe(2);
  });

  it('repeat visit: a severed component is named and the other part is kept', async () => {
    const first = await makeArchitectBuild(fakeModel('@body cup_ring\ncylinder(d = ring_id, h = 30);\n@end\n@body backplate\ncube([120, 6, 160]);\n@end').model as never)(state());
    const { model, calls } = fakeModel('@body cup_ring\ndifference() { cylinder(d = ring_id + 10, h = 30); cylinder(d = ring_id, h = 28); }\n@end');
    const out = await makeArchitectBuild(model as never)(state({
      currentCode: first.currentCode,
      attemptCount: 1,
      specViolations: [{
        kind: 'severed',
        severity: 'error',
        field: 'cup_ring',
        expected: 1,
        measured: 2,
        message: 'cup_ring is cut into 2 separate pieces on its own - a cut runs through it. Stop the cut short of the edge or bridge the pieces.',
      } as never],
    }));
    const sent = calls[0].map(text).join('\n');
    expect(sent).toContain('REQUIRED CHANGES');
    expect(sent).toContain('cup_ring is cut into 2 separate pieces');
    expect(sent).toContain('Write a module body only for: cup_ring');
    expect(out.currentCode).toContain('cube([120, 6, 160]);');
  });

  it('a human comment from the accept gate is a mandatory [HUMAN] line', async () => {
    const { model, calls } = fakeModel('@body cup_ring\ncylinder(d = ring_id, h = 40);\n@end\n@addressed H1');
    await makeArchitectBuild(model as never)(state({ currentCode: '', attemptCount: 1, gateAction: 'revise', gateFeedback: 'Make the ring 40 mm tall' } as never));
    expect(calls[0].map(text).join('\n')).toContain('[HUMAN] Make the ring 40 mm tall');
  });

  it('a body that calls its own part falls back to the blockout instead of recursing', async () => {
    const { model } = fakeModel('@body cup_ring\ncup_ring();\n@end');
    const out = await makeArchitectBuild(model as never)(state());
    expect(out.currentCode).not.toMatch(/module cup_ring\(\) \{\s*cup_ring\(\);/);
    expect(out.buildFallbacks).toBeGreaterThanOrEqual(1);
  });

  it('has a build system prompt without fabrication language', () => {
    const p = systemPromptFor('build');
    expect(p).toMatch(/module bod/i);
    expect(p).not.toMatch(/print|slicer|nozzle|overhang|filament/i);
  });
});

describe('review round 1', () => {
  it('returns placed, compilable code: the generated placement block is present (H1)', async () => {
    const { model } = fakeModel('@body cup_ring\ndifference() { cylinder(d = ring_id + 10, h = 30); cylinder(d = ring_id, h = 30.02); }\n@end\n@body backplate\ncube([120, 6, 160]);\n@end');
    const out = await makeArchitectBuild(model as never)(state());
    expect(out.currentCode).toContain('Assembly placement (generated from the approved Assembly Spec)');
    expect(out.currentCode).toMatch(/cup_ring\(\);/);
    const { validateOpenScadCode } = await import('../code-validator');
    const r = await validateOpenScadCode(out.currentCode!);
    expect(r.valid).toBe(true);
    expect(r.summary!.boundingBox!.size[2]).toBeGreaterThan(100);
  }, 120_000);

  it('keeps the previous body of a part whose re-sent section is cut off (H2)', async () => {
    const first = await makeArchitectBuild(fakeModel('@body cup_ring\ncylinder(d = ring_id, h = 30);\n@end\n@body backplate\ncube([120, 6, 160]); // good\n@end').model as never)(state());
    const out = await makeArchitectBuild(fakeModel('@body cup_ring\ncylinder(d = ring_id + 2, h = 30);\n@end\n@body backplate\ncube([120, 6,').model as never)(state({
      currentCode: first.currentCode, attemptCount: 1,
      specViolations: [{ kind: 'extents', severity: 'error', message: 'cup_ring is too small', component: 'cup_ring' } as never],
    }));
    expect(out.currentCode).toContain('cube([120, 6, 160]); // good');
  });

  it('sets a segment count so round parts measure true (M3)', async () => {
    const out = await makeArchitectBuild(fakeModel('@body cup_ring blockout\n@body backplate blockout').model as never)(state());
    expect(out.currentCode).toMatch(/\$fn = \d+;/);
  });

  it('asks for every part when a human note names none (M4)', async () => {
    const { model, calls } = fakeModel('@body cup_ring\ncylinder(d = ring_id, h = 30);\n@end');
    await makeArchitectBuild(model as never)(state({ currentCode: 'module backplate() { cube(1); }\nmodule cup_ring() { cube(1); }', attemptCount: 1, gateAction: 'revise', gateFeedback: 'Add ledges' } as never));
    expect(calls[0].map(text).join('\n')).not.toMatch(/Do not send/i);
  });

  it('a body that calls another part falls back too (L9) and the revise request is consumed (L10)', async () => {
    const out = await makeArchitectBuild(fakeModel('@body cup_ring\nbackplate();\n@end').model as never)(state({ gateAction: 'revise', gateFeedback: 'x' } as never));
    expect(out.buildFallbacks).toBeGreaterThanOrEqual(1);
    expect(out.gateAction ?? null).toBeNull();
    expect(out.gateFeedback ?? null).toBeNull();
  });
});

