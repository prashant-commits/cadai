import { describe, expect, it } from 'vitest';
import { AssemblySpecSchema, type AssemblySpec } from './assembly-spec';
import { normalizeClaudeSentinels } from './llm-schemas';
import { normalizeSpec } from './spec-normalize';
import { auditSpecParameters } from './spec-coherence';
import { nullsToUndefined } from './strict-schema';

// Post-council Haiku eval (2026-11-06): 10 schema failures in 109 specs, and
// 4 of 20 builds lost their spec to them. Each case below is a real failure.

const parse = (v: unknown) => AssemblySpecSchema.safeParse(nullsToUndefined(normalizeClaudeSentinels(v)));
const param = (name: string, value: number) => ({ name, value, min: 0, max: 1000, unit: 'mm', description: '' });
const base = { sheet: '', assemblyName: 'a', assumptions: [], openQuestions: [] };

describe('profile points take expressions', () => {
  it('resolves parameter expressions in a profile outline, so a parameter can drive it', () => {
    const raw = {
      ...base,
      parameters: [param('base_w', 80), param('lip_h', 12)],
      components: [{ name: 'wedge', description: '', localExtents: ['base_w', 30, 'lip_h'], position: [0, 0, 0],
        shape: { kind: 'profile', plane: 'xz', points: [[0, 0], ['base_w', 0], [0, 'lip_h']] } }],
    };
    const r = parse(raw);
    expect(r.success).toBe(true);
    const spec = normalizeSpec(r.data as AssemblySpec);
    expect(spec.components![0].shape?.points).toEqual([[0, 0], [80, 0], [0, 12]]);
    expect(auditSpecParameters(spec)).toEqual([]); // both parameters are reached through the outline
  });
});

describe('format tolerance', () => {
  it('accepts a number as an assumption value', () => {
    const r = parse({ ...base, assumptions: [{ field: 'wall', value: 3, rationale: 'typical' }], components: [{ name: 'p', description: '', localExtents: [1, 1, 1], position: [0, 0, 0] }] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.assumptions[0].value).toBe('3');
  });

  it('recovers components and guides sent as a string that swallowed later fields', () => {
    const r = parse({ ...base, components: '[{"name":"p","description":"","localExtents":[1,1,1],"position":[0,0,0]}], "guides": [{"label":"g","kind":"line","points":[[0,0,0],[1,1,1]]}]' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.components).toHaveLength(1);
      expect(r.data.guides).toHaveLength(1);
    }
  });
});
