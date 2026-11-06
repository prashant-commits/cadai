import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from './assembly-spec';
import { normalizeSpec } from './spec-normalize';
import { auditSpecParameters } from './spec-param-lint';

// Front-half verification 2026-11-06: 304 saved profile components have
// parametric in-plane extents but a literal outline; the profile pass let the
// literal outline win and silently disconnected the parameters (127 of them).

const param = (name: string, value: number) => ({ name, value, min: 0, max: 1000, unit: 'mm', description: '' });
const bracket = (arm: number, plate: number) => ({
  sheet: '', assemblyName: 'shelf_bracket', assumptions: [], openQuestions: [],
  parameters: [param('width', 20), param('arm_len', arm), param('plate_len', plate), param('wall', 5)],
  components: [{
    name: 'l_bracket', description: '', localExtents: ['width', 'arm_len', 'plate_len'], position: [0, 0, 0],
    // L outline in the yz plane, drawn at 150 x 150 in plain numbers.
    shape: { kind: 'profile', plane: 'yz', points: [[0, 0], [150, 0], [150, 5], [5, 5], [5, 150], [0, 150]] },
  }],
}) as unknown as AssemblySpec;

describe('literal profile outline with parametric extents', () => {
  it('keeps the parameters driving the size: the outline is scaled to the resolved extents', () => {
    const n = normalizeSpec(bracket(200, 100));
    const c = n.components![0];
    expect(c.localExtents).toEqual([20, 200, 100]);
    const us = c.shape!.points!.map((p) => p[0]); const vs = c.shape!.points!.map((p) => p[1]);
    expect(Math.max(...us)).toBeCloseTo(200, 6);
    expect(Math.max(...vs)).toBeCloseTo(100, 6);
    expect(Math.min(...us)).toBe(0);
  });

  it('bumping a parameter moves the geometry, and the lint does not call it dead', () => {
    const a = normalizeSpec(bracket(150, 150)).components![0];
    const b = normalizeSpec(bracket(180, 150)).components![0];
    expect(b.localExtents![1]).toBe(180);
    expect(JSON.stringify(a.shape!.points)).not.toBe(JSON.stringify(b.shape!.points));
    expect(auditSpecParameters(bracket(150, 150)).map((v) => v.field)).toEqual([]);
  });

  it('is idempotent', () => {
    const once = normalizeSpec(bracket(200, 100));
    expect(normalizeSpec(once).components![0].shape!.points).toEqual(once.components![0].shape!.points);
  });
});
