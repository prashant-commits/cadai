import { describe, expect, it } from 'vitest';
import { AssemblySpecSchema, type AssemblySpec } from './assembly-spec';
import { auditSpecCoherence } from './spec-coherence';
import { ExprError, evalExpr, resolveSpec } from './spec-expr';

const base = {
  sheet: '',
  assemblyName: 'plate',
  boundingBox: { width: 80, length: 40, height: 6 },
  guides: [],
  stressPoints: [],
  assumptions: [],
  openQuestions: [],
};

describe('evalExpr', () => {
  it('evaluates arithmetic, functions and names', () => {
    expect(evalExpr('2*wall + max(a, 3)', { wall: 2, a: 1 })).toBe(7);
    expect(evalExpr('-(h)/2', { h: 10 })).toBe(-5);
    expect(evalExpr('sqrt(16) + min(4, 2)', {})).toBe(6);
    expect(evalExpr('12.5', {})).toBe(12.5);
  });

  it('rejects unknown names, naming them', () => {
    expect(() => evalExpr('foo + 1', {})).toThrow(ExprError);
    expect(() => evalExpr('foo + 1', {})).toThrow(/foo/);
  });

  it('rejects anything outside the grammar', () => {
    for (const bad of ['x; system()', 'x.y', 'pow(2, 3)', 'a = 1', '"s"', '2 ** 3', '']) {
      expect(() => evalExpr(bad, { x: 1, a: 1 }), bad).toThrow(ExprError);
    }
  });
});

describe('resolveSpec', () => {
  const relational = {
    ...base,
    parameters: [{ name: 'w', value: 80, min: 40, max: 160, unit: 'mm', description: 'plate width' }],
    derived: [{ name: 'half', expr: 'w/2' }],
    relations: [{ expr: 'half < w', why: 'half is half' }],
    components: [{ name: 'plate', description: 'p', localExtents: ['w', 'half', 6], position: [0, 0, 0], shape: { kind: 'box' } }],
  };

  it('writes numbers into the fields and keeps the expressions beside them', () => {
    const { spec, errors } = resolveSpec(relational as unknown as AssemblySpec);
    expect(errors).toEqual([]);
    expect(spec.components![0].localExtents).toEqual([80, 40, 6]);
    expect(spec.components![0].expr?.localExtents).toEqual(['w', 'half', null]);
  });

  it('resolves tube innerD, shell wall and hole fields', () => {
    const raw = {
      ...relational,
      components: [
        { name: 'ring', description: 'r', localExtents: [100, 100, 30], position: [0, 0, 0], shape: { kind: 'tube', axis: 'z', innerD: 'w + 10' } },
        { name: 'box', description: 'b', localExtents: [50, 50, 50], position: [0, 0, 0], shape: { kind: 'shell', wall: 'half/20', openFace: '+Z' },
          holes: [{ d: 'half/10', axis: 'z', at: ['half', 5, 0], depth: 'w/16' }] },
      ],
    };
    const { spec, errors } = resolveSpec(raw as unknown as AssemblySpec);
    expect(errors).toEqual([]);
    expect(spec.components![0].shape?.innerD).toBe(90);
    expect(spec.components![0].expr?.innerD).toBe('w + 10');
    expect(spec.components![1].shape?.wall).toBe(2);
    expect(spec.components![1].holes![0]).toMatchObject({ d: 4, at: [40, 5, 0], depth: 5 });
    expect(spec.components![1].expr?.holes?.[0]).toMatchObject({ d: 'half/10', at: ['half', null, null], depth: 'w/16' });
  });

  it('reports an unknown name instead of throwing', () => {
    const raw = { ...relational, components: [{ ...relational.components[0], position: ['missing', 0, 0] }] };
    const { errors } = resolveSpec(raw as unknown as AssemblySpec);
    expect(errors.join(' ')).toMatch(/missing/);
  });

  it('surfaces resolution errors through the coherence audit the Architect already retries on', () => {
    const raw = { ...relational, components: [{ ...relational.components[0], position: ['missing', 0, 0] }] };
    const violations = auditSpecCoherence(raw as unknown as AssemblySpec);
    expect(violations.some((v) => v.severity === 'error' && /missing/.test(v.message))).toBe(true);
  });

  it('leaves a literal-only spec unchanged', () => {
    const literal = { ...base, components: [{ name: 'plate', description: 'p', localExtents: [80, 40, 6], position: [0, 0, 0], shape: { kind: 'box' } }] };
    const parsed = AssemblySpecSchema.parse(literal);
    const { spec, errors } = resolveSpec(parsed);
    expect(errors).toEqual([]);
    expect(spec).toEqual(parsed);
  });
});
