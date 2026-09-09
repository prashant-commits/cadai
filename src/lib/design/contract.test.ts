import { describe, it, expect } from 'vitest';
import { checkStanding, applyContract } from './contract';
import { ScadParam, StandingConstraints, DesignContract, ModelInfo } from '../../types';

describe('checkStanding', () => {
  it('returns buildplate violation if part exceeds build volume', () => {
    const s: StandingConstraints = { buildVolumeMm: [50, 50, 50] };
    const info = { dimensions: { x: 55, y: 40, z: 20 } } as ModelInfo;
    const violations = checkStanding([], info, s);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('buildplate');
    expect(violations[0].severity).toBe('error');
  });

  it('rejects pin below min wall naming the nozzle', () => {
    const s: StandingConstraints = { nozzleMm: 0.4 };
    const params: ScadParam[] = [{
      name: 'wall_thickness', kind: 'number', value: 1.2, authoredValue: 1.2, group: '', line: 1
    }];
    const violations = checkStanding(params, null, s);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('nozzle 0.4');
  });

  it('warns on layer height exceeding 80% of nozzle', () => {
    const s: StandingConstraints = { nozzleMm: 0.4, layerHeightMm: 0.35 };
    const violations = checkStanding([], null, s);
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('warning');
  });
});

describe('applyContract', () => {
  const code = `
w = 40;
h = 20;
wall_thickness = 3;
`;

  const baseContract: DesignContract = {
    standing: { nozzleMm: 0.4 },
    pinnedParams: {}
  };

  it('applies all four classifications correctly', () => {
    const contract: DesignContract = {
      standing: { nozzleMm: 0.4 },
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
