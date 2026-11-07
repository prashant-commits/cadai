import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import type { AgentStateType } from './graph';

const callMock = vi.fn();

vi.mock('@langchain/anthropic', () => {
  class FakeChatModel {
    invoke = (messages: unknown) => callMock(messages);
    async *stream(messages: unknown) { yield await callMock(messages); }
    withStructuredOutput() { return this; }
    withConfig() { return this; }
    bindTools() { return this; }
  }
  return { ChatAnthropic: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

import { createCadAgent } from './graph';
import { AssemblySpecSchema, assemblySpecRequestSchema, variantSpecRequestSchema } from './assembly-spec';
import { resolveSpec } from './spec-expr';
import { normalizeSpec } from './spec-normalize';
import { recoverBledFields } from './llm-schemas';
import { auditSpecParameters } from './spec-coherence';
import { nullsToUndefined } from './strict-schema';
import type { AssemblySpec } from './assembly-spec';

const param = (name: string, value: number) => ({ name, value, min: 0, max: 1000, unit: 'mm', description: '' });
const base = { sheet: '', assemblyName: 'a', assumptions: [], openQuestions: [] };
const parse = (v: unknown) => AssemblySpecSchema.safeParse(nullsToUndefined(v));
const profile = (points: unknown[][], extra: Record<string, unknown> = {}) => ({
  ...base,
  parameters: [param('w', 80), param('h', 12), param('ox', 3)],
  components: [{ name: 'wedge', description: '', localExtents: ['w', 30, 'h'], position: [0, 0, 0],
    shape: { kind: 'profile', plane: 'xz', points, ...extra } }],
});

type ShapeJson = {
  properties: { components: { items: { properties: { shape: { anyOf?: { properties: Record<string, unknown> }[]; properties: Record<string, unknown> } } } } };
};

describe('profile outline expressions', () => {
  it('resolves inner outlines too, and keeps every source in component.expr', () => {
    const raw = profile([[0, 0], ['w', 0], [0, 'h']], { holes: [[['ox', 1], [5, 1], [5, 'h - 2']]] });
    const r = parse(raw);
    expect(r.success).toBe(true);
    const { spec, errors } = resolveSpec(r.data as AssemblySpec);
    expect(errors).toEqual([]);
    const c = spec.components![0];
    expect(c.shape?.holes).toEqual([[[3, 1], [5, 1], [5, 10]]]);
    expect(c.expr?.outline).toEqual([[null, null], ['w', null], [null, 'h']]);
    expect(c.expr?.outlineHoles).toEqual([[['ox', null], [null, null], [null, 'h - 2']]]);
    // Resolving the resolved spec gives the same numbers (the kept expression is the source of truth).
    expect(resolveSpec(spec).spec.components![0].shape?.points).toEqual([[0, 0], [80, 0], [0, 12]]);
  });

  it('reports an unknown name in an outline instead of throwing', () => {
    const r = parse(profile([[0, 0], ['wdith', 0], [0, 5]]));
    expect(r.success).toBe(true);
    const { errors } = resolveSpec(r.data as AssemblySpec);
    expect(errors.join(' ')).toMatch(/shape\.points\[1\]\[0\].*wdith/);
  });

  it('keeps a shifted outline parametric: the expressions follow the shift and a second normalize is stable', () => {
    const r = parse(profile([[2, 5], ['w', 5], [2, 'h']]));
    const once = normalizeSpec(r.data as AssemblySpec);
    const c = once.components![0];
    expect(c.shape?.points).toEqual([[0, 0], [78, 0], [0, 7]]);
    expect(c.expr?.outline).toEqual([[null, null], ['(w) - 2', null], [null, '(h) - 5']]);
    const twice = normalizeSpec(once);
    expect(twice.components![0].shape?.points).toEqual([[0, 0], [78, 0], [0, 7]]);
    expect(auditSpecParameters(once).map((v) => v.field)).toEqual(['parameters.ox']);
  });

  it('counts an outline hole expression as parameter use', () => {
    const raw = profile([[0, 0], ['w', 0], [0, 'h']], { holes: [[['ox', 1], [5, 1], [5, 4]]] });
    expect(auditSpecParameters(parse(raw).data as AssemblySpec)).toEqual([]);
  });

  it('lets the request schema offer the outline strings the prompt now allows', () => {
    for (const schema of [assemblySpecRequestSchema(), variantSpecRequestSchema()]) {
      const shape = (schema as unknown as ShapeJson).properties.components.items.properties.shape;
      const points = (shape.anyOf?.[0] ?? shape).properties.points;
      expect(JSON.stringify(points)).toContain('{"type":"string"}'); // vertices may be expressions, like every other component field
    }
    expect(parse(profile([[0, 0], ['w', 0], [0, 'h']])).success).toBe(true);
  });
});

describe('format tolerance, more', () => {
  it('reads a boolean assumption value as text and leaves a string alone', () => {
    const r = parse({ ...base, assumptions: [{ field: 'a', value: true, rationale: '' }, { field: 'b', value: '4 mm', rationale: '' }], components: [{ name: 'p', description: '', localExtents: [1, 1, 1], position: [0, 0, 0] }] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.assumptions.map((a) => a.value)).toEqual(['true', '4 mm']);
  });

  it('recovers assumptions, jointContracts and openQuestions from a swallowing string, never overwriting a proper field', () => {
    const out = recoverBledFields({
      components: '[{"name":"p"}], "jointContracts": [{"type":"t","clearance":0}], "assumptions": [{"field":"f","value":"v","rationale":"r"}], "openQuestions": [{"id":"q","question":"?","suggestedAnswer":"s"}]',
      assumptions: [{ field: 'kept', value: 'x', rationale: '' }],
    });
    expect(out.components).toEqual([{ name: 'p' }]);
    expect(out.jointContracts).toEqual([{ type: 't', clearance: 0 }]);
    expect(out.openQuestions).toHaveLength(1);
    expect(out.assumptions).toEqual([{ field: 'kept', value: 'x', rationale: '' }]);
  });
});

describe('architectNode retry loss', () => {
  const keys: string[] = [];
  afterAll(async () => { for (const k of keys) await getCheckpointer().deleteThread(k); });
  beforeEach(() => {
    callMock.mockReset();
    process.env.CADAI_SPEC_SHEETS = 'off';
    process.env.CADAI_MAX_VARIANTS = '1';
    delete process.env.VERCEL;
  });

  const deadParamSpec = {
    sheet: '## Box', assemblyName: 'box_spec', parameters: [param('dead', 5)], derived: [], relations: [],
    components: [{ name: 'box', description: 'a box', localExtents: [40, 40, 40], position: [0, 0, 0], shape: { kind: 'box' } }],
    assumptions: [], openQuestions: [],
  };

  it('falls back to the parsed candidate, labelled with its errors, when the last attempts fail schema', async () => {
    let variantCalls = 0;
    callMock.mockImplementation(async (messages: unknown) => {
      const text = JSON.stringify(messages);
      if (text.includes('Mechanical Architect Planner')) {
        return { brief: 'Plan', assumptions: [], openQuestions: [], variants: [{ id: 'A', name: 'A', idea: 'box' }], recommendedId: 'A' };
      }
      if (text.includes('Generate the Assembly Spec for Variant')) {
        variantCalls++;
        return variantCalls === 1 ? deadParamSpec : { assemblyName: 5 }; // later attempts fail schema
      }
      return { matchesRequest: true, findings: [] };
    });
    const key = runCheckpointKey(`c4-${Date.now()}`, 'run-0');
    keys.push(key);
    const agent = createCadAgent('gpt-6-sol');
    const config = { configurable: { thread_id: key }, recursionLimit: 200 };
    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);
    const state = (await agent.getState(config)).values as AgentStateType;
    expect(variantCalls).toBe(3);
    const v = state.specVariants[0];
    expect(v.spec).not.toBeNull();
    expect(v.error).toBeUndefined();
    expect(v.specErrors?.some((e) => /dead/.test(e.issue))).toBe(true);
  }, 120_000);
});
