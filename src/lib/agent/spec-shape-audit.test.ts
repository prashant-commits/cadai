import { describe, it, expect } from 'vitest';
import { auditSpecShapes, isSimplePolygon } from './spec-shape-audit';
import { AssemblySpec } from './assembly-spec';

const baseSpec: AssemblySpec = {
  sheet: '',
  assemblyName: 'test',
  boundingBox: { width: 100, length: 100, height: 100 },
  components: [],
  guides: [],
  stressPoints: [],
  assumptions: [],
  openQuestions: [],
};

describe('auditSpecShapes', () => {
  it('returns no violations for empty or null spec', () => {
    expect(auditSpecShapes(null)).toEqual([]);
    expect(auditSpecShapes(baseSpec)).toEqual([]);
  });

  describe('missing localExtents', () => {
    it('passes when shape and localExtents are provided', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ name: 'a', description: 'b', position: [0,0,0], localExtents: [10, 10, 10], shape: { kind: 'cylinder', axis: 'z' } }]
      });
      expect(violations).toEqual([]);
    });

    it('fails when component has shape but no localExtents', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ name: 'a', description: 'b', position: [0,0,0], shape: { kind: 'cylinder', axis: 'z' } }]
      });
      expect(violations[0].message).toContain('no localExtents');
    });
  });

  describe('cylinder/tube', () => {
    it('passes valid cylinder', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ name: 'a', description: 'b', position: [0,0,0], localExtents: [10, 10, 20], shape: { kind: 'cylinder', axis: 'z' } }]
      });
      expect(violations).toEqual([]);
    });

    it('fails cylinder with non-matching cross extents', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ name: 'a', description: 'b', position: [0,0,0], localExtents: [10, 15, 20], shape: { kind: 'cylinder', axis: 'z' } }]
      });
      expect(violations[0].message).toContain('cross extents differ');
    });
  });

  describe('tube innerD', () => {
    it('passes valid tube', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ name: 'a', description: 'b', position: [0,0,0], localExtents: [10, 10, 20], shape: { kind: 'tube', axis: 'z', innerD: 8 } }]
      });
      expect(violations).toEqual([]);
    });

    it('fails tube with missing or invalid innerD', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ name: 'a', description: 'b', position: [0,0,0], localExtents: [10, 10, 20], shape: { kind: 'tube', axis: 'z', innerD: 12 } }]
      });
      expect(violations[0].message).toContain('missing or invalid innerD');
    });
  });

  describe('shell', () => {
    it('passes valid shell', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ name: 'a', description: 'b', position: [0,0,0], localExtents: [10, 10, 10], shape: { kind: 'shell', openFace: '+Z', wall: 1 } }]
      });
      expect(violations).toEqual([]);
    });

    it('fails shell with too thick wall', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ name: 'a', description: 'b', position: [0,0,0], localExtents: [10, 10, 10], shape: { kind: 'shell', openFace: '+Z', wall: 6 } }]
      });
      expect(violations[0].message).toContain('cavity would vanish');
    });
  });

  describe('profile', () => {
    it('passes valid profile', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ 
          name: 'a', description: 'b', position: [0,0,0], localExtents: [10, 10, 5], 
          shape: { kind: 'profile', plane: 'xy', points: [[0,0], [10,0], [10,10], [0,10]] } 
        }]
      });
      expect(violations).toEqual([]);
    });

    it('fails profile with self-intersecting polygon', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        components: [{ 
          name: 'a', description: 'b', position: [0,0,0], localExtents: [10, 10, 5], 
          shape: { kind: 'profile', plane: 'xy', points: [[0,0], [10,10], [10,0], [0,10]] } 
        }]
      });
      expect(violations[0].message).toContain('polygon is not simple');
    });
  });

  describe('guides', () => {
    it('passes valid envelope and line guides', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        guides: [
          { label: 'g1', kind: 'envelope', position: [0,0,0], localExtents: [5,5,5] },
          { label: 'g2', kind: 'line', points: [[0,0,0], [1,1,1]] }
        ]
      });
      expect(violations).toEqual([]);
    });

    it('fails envelope without localExtents', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        guides: [{ label: 'g1', kind: 'envelope', position: [0,0,0] }]
      });
      expect(violations[0].message).toContain('without localExtents');
    });

    it('fails line with too few points', () => {
      const violations = auditSpecShapes({
        ...baseSpec,
        guides: [{ label: 'g2', kind: 'line', points: [[0,0,0]] }]
      });
      expect(violations[0].message).toContain('< 2 points');
    });
  });
});

describe('placed minimum z (nothing below the ground plane)', () => {
  const spec = (components: unknown[]) =>
    ({ assemblyName: 'a', sheet: '', boundingBox: { width: 1, length: 1, height: 1 }, components, guides: [], assumptions: [], openQuestions: [] }) as never;
  const part = (name: string, extra: Record<string, unknown>) => ({
    name,
    description: name,
    localExtents: [10, 10, 10],
    position: [0, 0, 0],
    ...extra,
  });

  it('names the part and the depth for a part placed below z = 0', () => {
    const v = auditSpecShapes(spec([part('foot', { position: [0, 0, -5] })]));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: 'shape', severity: 'error' });
    expect(v[0].message).toContain("'foot'");
    expect(v[0].message).toContain('5 mm');
  });

  it('judges the ROTATED envelope: a rotation about the origin can push a part under the plane', () => {
    // Rotating the 10 mm cube -90 degrees about x sends its y extent to -z.
    const v = auditSpecShapes(spec([part('flipped', { rotation: [-90, 0, 0] })]));
    expect(v.some((x) => x.message.includes("'flipped'") && x.message.includes('10 mm'))).toBe(true);
  });

  it('a part resting exactly on z = 0 (or within rounding) is fine', () => {
    expect(auditSpecShapes(spec([part('base', {}), part('rounded', { position: [0, 0, -0.02] })]))).toEqual([]);
  });
});

describe('isSimplePolygon with a duplicate closing vertex', () => {
  it('ignores a final point equal to the first', () => {
    const open = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(isSimplePolygon(open)).toBe(true);
    expect(isSimplePolygon([...open, [0, 0]])).toBe(true);
    // A real bow-tie is still rejected, closed or not.
    expect(isSimplePolygon([[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]])).toBe(false);
  });
});
