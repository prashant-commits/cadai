import { describe, it, expect } from 'vitest';
import { checkStanding, applyContract } from './contract';
import { ScadParam, StandingConstraints, DesignContract, ModelInfo } from '../../types';

describe('checkStanding', () => {
  it('returns a violation if the assembly exceeds the maximum size', () => {
    const s: StandingConstraints = { maxSizeMm: [50, 50, 50] };
    const info = { dimensions: { x: 55, y: 40, z: 20 } } as ModelInfo;
    const violations = checkStanding([], info, s);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('buildplate');
    expect(violations[0].severity).toBe('error');
  });

  it('rejects a wall parameter below the stated minimum wall', () => {
    const s: StandingConstraints = { minWallMm: 1.6 };
    const params: ScadParam[] = [{
      name: 'wall_thickness', kind: 'number', value: 1.2, authoredValue: 1.2, group: '', line: 1
    }];
    const violations = checkStanding(params, null, s);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('1.6');
  });

  it('states the minimum wall outright, deriving it from no process setting', () => {
    // minWallMm used to default to nozzleMm * 4, which meant a printing
    // setting silently decided a geometric limit. There is nothing to derive
    // from any more: with no minimum stated, no wall is checked.
    expect(checkStanding(
      [{ name: 'wall_t', kind: 'number', value: 0.2, authoredValue: 0.2, group: '', line: 1 }],
      null,
      {}
    )).toHaveLength(0);
  });

  it('does not judge a model against fabrication limits', () => {
    // Overhang is measured by analyzeStl for the separate printability pass;
    // it is not a generation constraint and must never reach the repair loop.
    const info = {
      dimensions: { x: 10, y: 10, z: 10 },
      overhang: { maxOverhangDeg: 80, unsupportedAreaMm2: 400 },
    } as ModelInfo;
    expect(checkStanding([], info, { maxSizeMm: [100, 100, 100] })).toHaveLength(0);
  });
});

describe('applyContract', () => {
  const code = `
w = 40;
h = 20;
wall_thickness = 3;
`;

  const baseContract: DesignContract = {
    standing: { minWallMm: 1.6 },
    pinnedParams: {}
  };

  it('applies all four classifications correctly', () => {
    const contract: DesignContract = {
      standing: { minWallMm: 1.6 },
      pinnedParams: {
        'w': { value: 55, supersededValue: 40, pinnedAt: 1 }, // applied
        'h': { value: 20, supersededValue: 20, pinnedAt: 1 }, // unchanged
        'x': { value: 10, supersededValue: 10, pinnedAt: 1 }, // dropped
        'wall_thickness': { value: 1.2, supersededValue: 3, pinnedAt: 1 } // rejected (min wall 1.6)
      }
    };

    const { code: updated, diff } = applyContract(code, contract);
    
    expect(diff.applied).toHaveLength(1);
    expect(diff.applied[0].name).toBe('w');
    
    expect(diff.unchanged).toEqual(['h']);
    expect(diff.dropped).toEqual(['x']);
    
    expect(diff.rejected).toHaveLength(1);
    expect(diff.rejected[0].name).toBe('wall_thickness');
    
    // Only w should be changed in the code
    expect(updated).toContain('w = 55;');
    expect(updated).toContain('wall_thickness = 3;'); // Rejected pin not applied
  });

  it('returns code untouched when contract is empty', () => {
    const { code: updated, diff } = applyContract(code, baseContract);
    expect(updated).toBe(code);
    expect(diff.applied).toHaveLength(0);
    expect(diff.dropped).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.rejected).toHaveLength(0);
  });
});
