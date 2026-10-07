import { describe, it, expect } from 'vitest';
import { auditSpecShapes } from './spec-shape-audit';
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
