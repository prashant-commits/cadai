import { describe, expect, it } from 'vitest';
import {
  variantSpecRequestSchema,
  type AssemblySpec,
} from './assembly-spec';
import { claudeVariantSpecSchema } from './llm-schemas';
import { normalizeSpec } from './spec-normalize';
import { auditSpecCoherence, auditSpecParameters } from './spec-coherence';
import { auditSpecShapes } from './spec-shape-audit';
import { resolveSpec } from './spec-expr';

const base = {
  sheet: '',
  assemblyName: 'test_assembly',
  assumptions: [],
  openQuestions: [],
};

const param = (name: string, value: number) => ({
  name,
  value,
  min: 0,
  max: 1000,
  unit: 'mm' as const,
  description: '',
});

describe('L6 & Schema verification: variantSpecRequestSchema and claudeVariantSpecSchema', () => {
  it('pins boundingBox absence and sheet-last for variantSpecRequestSchema', () => {
    const json = variantSpecRequestSchema() as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(json.properties)).not.toContain('boundingBox');
    expect(json.required ?? []).not.toContain('boundingBox');
    expect(Object.keys(json.properties).at(-1)).toBe('sheet');
    expect(json.required?.at(-1)).toBe('sheet');
  });

  it('pins boundingBox absence and sheet-last for claudeVariantSpecSchema', () => {
    const json = claudeVariantSpecSchema() as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(json.properties)).not.toContain('boundingBox');
    expect(json.required ?? []).not.toContain('boundingBox');
    expect(Object.keys(json.properties).at(-1)).toBe('sheet');
  });
});

describe('H1: profile pass vs component.expr', () => {
  it('nulls expr entries that disagree with the outline by > 0.5 mm, keeps agreeing ones, and resolveSpec is stable', () => {
    // w=40, d=10, h=20; localExtents: ["w", "d", "h"]; profile xz.
    // Triangle: [[0, 0], [50, 0], [0, 20]].
    // Outline x-extent is 50, but expr "w" evaluates to 40. Delta = 10 > 0.5 mm -> nulled.
    // Outline z-extent is 20, expr "h" evaluates to 20. Delta = 0 <= 0.5 mm -> kept!
    // Extrusion y-extent is 10, expr "d" is kept.
    const rawSpec = {
      ...base,
      parameters: [param('w', 40), param('d', 10), param('h', 20)],
      components: [
        {
          name: 'wedge',
          description: '',
          localExtents: ['w', 'd', 'h'],
          position: [0, 0, 0],
          shape: {
            kind: 'profile',
            plane: 'xz',
            points: [
              [0, 0],
              [50, 0],
              [0, 20],
            ],
          },
        },
      ],
    } as unknown as AssemblySpec;

    const candidate = normalizeSpec(rawSpec);
    const comp = candidate.components![0];

    // Local extents: [50, 10, 20]
    expect(comp.localExtents).toEqual([50, 10, 20]);
    // expr.localExtents: axis 0 nulled, axis 1 ('d') kept, axis 2 ('h') kept
    expect(comp.expr?.localExtents).toEqual([null, 'd', 'h']);

    // auditSpecCoherence on candidate must have no boundingBox errors
    const violations = auditSpecCoherence(candidate);
    expect(violations.filter((v) => v.field.startsWith('boundingBox'))).toEqual([]);

    // re-resolving the normalized spec must match candidate's localExtents
    const reResolved = resolveSpec(candidate);
    expect(reResolved.errors).toEqual([]);
    expect(reResolved.spec.components![0].localExtents).toEqual([50, 10, 20]);

    // Parameters d and h remain live because they drive valid geometry
    // Parameter w was only driving the overridden x-extent, so it is now dead
    const dead = auditSpecParameters(candidate);
    expect(dead.map((v) => v.field)).toEqual(['parameters.w']);
  });

  it('drops expr.localExtents entirely if all 3 entries become null', () => {
    // All extents driven by expressions that disagree with outline
    const rawSpec = {
      ...base,
      parameters: [param('w', 40), param('h', 20)],
      components: [
        {
          name: 'plate',
          description: '',
          localExtents: ['w', 0, 'h'],
          position: [0, 0, 0],
          shape: {
            kind: 'profile',
            plane: 'xz',
            points: [
              [0, 0],
              [60, 0],
              [0, 30],
            ],
          },
        },
      ],
    } as unknown as AssemblySpec;

    const candidate = normalizeSpec(rawSpec);
    expect(candidate.components![0].expr?.localExtents).toBeUndefined();
  });
});

describe('M3: Component holes shifted with profile outline', () => {
  it('shifts numeric holes[].at and string expr.holes[].at by (minU, minV)', () => {
    // Probe case: outline [[5,2],[45,2],[5,22]] on xz plane
    // minU = 5, minV = 2; sizeU = 40, sizeV = 20
    // Hole at [12, 0, 6] -> shifted by (-5, 0, -2) -> [7, 0, 4]
    const rawSpec = {
      ...base,
      parameters: [param('hx', 12), param('hz', 6)],
      components: [
        {
          name: 'bracket',
          description: '',
          localExtents: [40, 10, 20],
          position: [0, 0, 0],
          shape: {
            kind: 'profile',
            plane: 'xz',
            points: [
              [5, 2],
              [45, 2],
              [5, 22],
            ],
          },
          holes: [
            { d: 4, at: ['hx', 0, 'hz'], depth: 5 },
            { d: 3, at: [12, 0, 6], depth: 5 },
          ],
        },
      ],
    } as unknown as AssemblySpec;

    const candidate = normalizeSpec(rawSpec);
    const comp = candidate.components![0];

    // Points shifted to origin
    expect(comp.shape?.points).toEqual([
      [0, 0],
      [40, 0],
      [0, 20],
    ]);

    // Numeric hole positions shifted
    expect(comp.holes![1].at).toEqual([7, 0, 4]);

    // Expression hole positions shifted and wrapped
    expect(comp.expr?.holes![0].at).toEqual(['(hx) - 5', null, '(hz) - 2']);

    // Re-resolve candidate: expressions evaluate to [7, 0, 4]
    const reResolved = resolveSpec(candidate);
    expect(reResolved.errors).toEqual([]);
    expect(reResolved.spec.components![0].holes![0].at).toEqual([7, 0, 4]);
  });
});

describe('Plane mappings: xy and yz planes', () => {
  it('normalizes xy profile: in-plane are x and y (axes 0, 1), z (axis 2) kept', () => {
    const rawSpec = {
      ...base,
      components: [
        {
          name: 'c_xy',
          description: '',
          localExtents: [10, 10, 15],
          position: [0, 0, 0],
          shape: {
            kind: 'profile',
            plane: 'xy',
            points: [
              [10, 20],
              [50, 20],
              [10, 60],
            ],
          },
        },
      ],
    } as unknown as AssemblySpec;

    const candidate = normalizeSpec(rawSpec);
    const comp = candidate.components![0];
    expect(comp.shape?.points).toEqual([
      [0, 0],
      [40, 0],
      [0, 40],
    ]);
    expect(comp.localExtents).toEqual([40, 40, 15]);
  });

  it('normalizes yz profile: in-plane are y and z (axes 1, 2), x (axis 0) kept', () => {
    const rawSpec = {
      ...base,
      components: [
        {
          name: 'c_yz',
          description: '',
          localExtents: [25, 10, 10],
          position: [0, 0, 0],
          shape: {
            kind: 'profile',
            plane: 'yz',
            points: [
              [5, 10],
              [35, 10],
              [5, 50],
            ],
          },
        },
      ],
    } as unknown as AssemblySpec;

    const candidate = normalizeSpec(rawSpec);
    const comp = candidate.components![0];
    expect(comp.shape?.points).toEqual([
      [0, 0],
      [30, 0],
      [0, 40],
    ]);
    expect(comp.localExtents).toEqual([25, 30, 40]);
  });
});

describe('L1: Missing localExtents on profile', () => {
  it('leaves the profile alone so auditSpecShapes reports missing localExtents', () => {
    const rawSpec = {
      ...base,
      components: [
        {
          name: 'no_extents',
          description: '',
          position: [0, 0, 0],
          shape: {
            kind: 'profile',
            plane: 'xz',
            points: [
              [0, 0],
              [40, 0],
              [0, 20],
            ],
          },
        },
      ],
    } as unknown as AssemblySpec;

    const candidate = normalizeSpec(rawSpec);
    const shapeViolations = auditSpecShapes(candidate);
    expect(shapeViolations.some((v) => /localExtents/.test(v.message))).toBe(true);
  });
});

describe('M1: Resolution errors fallback to partial implied envelope', () => {
  it('uses implied envelope of partially resolved components, never 0x0x0', () => {
    // 2 components: one with broken expression ("unknown_var"), one valid
    const rawSpec = {
      ...base,
      components: [
        {
          name: 'valid_part',
          description: '',
          localExtents: [100, 50, 20],
          position: [0, 0, 0],
        },
        {
          name: 'broken_part',
          description: '',
          localExtents: ['unknown_var + 10', 10, 10],
          position: [0, 0, 0],
        },
      ],
    } as unknown as AssemblySpec;

    const candidate = normalizeSpec(rawSpec);
    // Bounding box should reflect valid_part: 100 x 50 x 20, NOT 0 x 0 x 0
    expect(candidate.boundingBox).toEqual({ width: 100, length: 50, height: 20 });

    // auditSpecCoherence should report the expression error, but NO spurious boundingBox mismatch
    const coherence = auditSpecCoherence(candidate);
    expect(coherence.some((v) => v.field === 'expression')).toBe(true);
    expect(coherence.filter((v) => v.field.startsWith('boundingBox'))).toEqual([]);
  });
});

describe('L5: Dead-parameter lint skipped when resolution has errors', () => {
  it('skips parameter lint when an expression does not resolve (typo)', () => {
    const rawSpec = {
      ...base,
      parameters: [param('width', 100)],
      components: [
        {
          name: 'box',
          description: '',
          localExtents: ['wdith', 50, 20], // typo!
          position: [0, 0, 0],
        },
      ],
    } as unknown as AssemblySpec;

    // auditSpecParameters should return [] because resolution failed
    const dead = auditSpecParameters(rawSpec);
    expect(dead).toEqual([]);
  });
});

describe('Dead-parameter reachability through various structures', () => {
  it('marks parameters reached through guides, holes, innerD, wall, and derived BFS', () => {
    const rawSpec = {
      ...base,
      parameters: [
        param('p_guide_ext', 10),
        param('p_guide_pos', 20),
        param('p_guide_rot', 30),
        param('p_guide_pt', 40),
        param('p_guide_inner', 5),
        param('p_guide_wall', 2),
        param('p_hole_d', 6),
        param('p_hole_at', 15),
        param('p_hole_dp', 8),
        param('p_shape_inner', 12),
        param('p_shape_wall', 3),
        param('p_derived_root', 50),
        param('p_dead', 99),
      ],
      derived: [
        { name: 'd_mid', expr: 'p_derived_root * 2' },
        { name: 'd_leaf', expr: 'd_mid + 5' },
      ],
      components: [
        {
          name: 'c1',
          description: '',
          localExtents: ['d_leaf', 20, 20],
          position: [0, 0, 0],
          shape: {
            kind: 'cylinder',
            innerD: 'p_shape_inner',
            wall: 'p_shape_wall',
          },
          holes: [
            {
              d: 'p_hole_d',
              at: ['p_hole_at', 0, 0],
              depth: 'p_hole_dp',
            },
          ],
        },
      ],
      guides: [
        {
          label: 'g1',
          kind: 'bounding',
          localExtents: ['p_guide_ext', 10, 10],
          position: ['p_guide_pos', 0, 0],
          rotation: [0, 0, 'p_guide_rot'],
          points: [['p_guide_pt', 0]],
          shape: {
            kind: 'cylinder',
            innerD: 'p_guide_inner',
            wall: 'p_guide_wall',
          },
        },
      ],
    } as unknown as AssemblySpec;

    const dead = auditSpecParameters(rawSpec);
    expect(dead.map((v) => v.field)).toEqual(['parameters.p_dead']);
  });
});

describe('Normalization idempotency', () => {
  it('is idempotent on a normalized spec', () => {
    const rawSpec = {
      ...base,
      parameters: [param('h', 30)],
      components: [
        {
          name: 'block',
          description: '',
          localExtents: [40, 20, 'h'],
          position: [5, 10, 0],
          shape: {
            kind: 'profile',
            plane: 'xz',
            points: [
              [10, 5],
              [50, 5],
              [10, 35],
            ],
          },
          holes: [{ d: 4, at: [15, 0, 10], depth: 5 }],
        },
      ],
    } as unknown as AssemblySpec;

    const once = normalizeSpec(rawSpec);
    const twice = normalizeSpec(once);

    expect(twice.boundingBox).toEqual(once.boundingBox);
    expect(twice.components).toEqual(once.components);
  });
});

describe('L6: Profile pass skipped on resolution errors', () => {
  it('does not shift profile points or override localExtents when expression resolution has errors', () => {
    const rawSpec = {
      ...base,
      components: [
        {
          name: 'wedge',
          description: '',
          localExtents: ['unresolvable_expr + 1', 10, 20],
          position: [0, 0, 0],
          shape: {
            kind: 'profile',
            plane: 'xz',
            points: [
              [5, 2],
              [45, 2],
              [5, 22],
            ],
          },
        },
      ],
    } as unknown as AssemblySpec;

    const normalized = normalizeSpec(rawSpec);
    const comp = normalized.components![0];

    // Profile pass was skipped: points were not shifted to origin
    expect(comp.shape?.points).toEqual([
      [5, 2],
      [45, 2],
      [5, 22],
    ]);
  });
});

describe('M2 & N1: auditSpecCoherence never returns parameters.* violations', () => {
  it('does not include dead parameter violations in auditSpecCoherence', () => {
    const spec = {
      ...base,
      parameters: [param('unused_w', 40), param('unused_h', 20)],
      components: [
        {
          name: 'c',
          description: '',
          localExtents: [10, 10, 10],
          position: [0, 0, 0],
        },
      ],
    } as unknown as AssemblySpec;

    const coherence = auditSpecCoherence(spec);
    expect(coherence.filter((v) => v.field.startsWith('parameters.'))).toEqual([]);

    const paramAudit = auditSpecParameters(spec);
    expect(paramAudit.map((v) => v.field)).toEqual(['parameters.unused_w', 'parameters.unused_h']);
  });
});
