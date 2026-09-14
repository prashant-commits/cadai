import { describe, it, expect } from 'vitest';
import { auditPlacement } from './placement-audit';
import type { PlacementReport, PlacementComponent } from '../design/placement-report';

const part = (name: string, min: [number, number, number], max: [number, number, number], localMin: [number, number, number] = [0, 0, 0]): PlacementComponent => ({
  name, measured: true, localMin, localMax: [10, 10, 10], size: [10, 10, 10], correction: [0, 0, 0],
  position: [0, 0, 0], rotation: [0, 0, 0], placedMin: min, placedMax: max,
});
const report = (components: PlacementComponent[], composed = true): PlacementReport => ({ composed, removedStatements: 0, components });
const kinds = (v: ReturnType<typeof auditPlacement>) => v.map((x) => `${x.severity}:${x.kind}`);

describe('auditPlacement', () => {
  it('is silent for a grounded assembly on the floor', () => {
    expect(auditPlacement(report([part('base', [0, 0, 0], [40, 40, 10])]), [0, 0, 0], null)).toEqual([]);
  });

  it('errors when the model hangs below or floats above the floor', () => {
    expect(kinds(auditPlacement(null, [0, 0, -13.5], null))).toEqual(['error:floor']);
    expect(kinds(auditPlacement(null, [0, 0, 5], null))).toEqual(['error:floor']);
    expect(auditPlacement(null, [0, 0, 0.01], null)).toEqual([]);
  });

  it('errors for each floating part, but only when placement was composed', () => {
    const r = report([part('base', [0, 0, 0], [40, 40, 10]), part('peg', [10, 10, 15], [20, 20, 25])]);
    const v = auditPlacement(r, [0, 0, 0], null);
    expect(kinds(v)).toEqual(['error:floating']);
    expect(v[0].message).toContain("'peg'");
    expect(v[0].message).toContain('5');
    expect(auditPlacement({ ...r, composed: false }, [0, 0, 0], null)).toEqual([]);
  });

  it('names the part that hangs below the plate, with its depth', () => {
    const r = report([part('base', [0, 0, 0], [40, 40, 10]), part('leg', [0, 0, -30], [10, 10, 0])]);
    const v = auditPlacement(r, [0, 0, -30], null);
    expect(kinds(v)).toEqual(['error:floor']);
    expect(v[0].field).toBe('leg');
    expect(v[0].message).toContain("'leg'");
    expect(v[0].message).toContain('30');
    expect(v[0].message).toMatch(/below the build plate/);
  });

  it('warns about a module whose min corner is off the origin', () => {
    const r = report([part('cyl', [0, 0, 0], [10, 10, 10], [-5, -5, 0])]);
    const v = auditPlacement(r, [0, 0, 0], null);
    expect(kinds(v)).toEqual(['warning:local_frame']);
    expect(v[0].message).toContain('cyl');
  });

  it('does not crash without a report or a model', () => {
    expect(auditPlacement(null, null, null)).toEqual([]);
  });
});
