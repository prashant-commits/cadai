import { describe, it, expect } from 'vitest';
import { checkAssemblyFit } from './graph';
import type { AssemblySpec } from './assembly-spec';

/**
 * Mating cavities are cut by code: the host (partA) has the inserted part's
 * skeleton shape, grown by the joint clearance, subtracted from it. The probe's
 * remaining job is to catch a DRAFTED inserted module that sticks out past
 * that cut, i.e. is larger than its declared localExtents.
 */
const host = 'module a() { cube([20, 20, 20]); }\n';
const fitting = host + 'module b() { cube([10, 10, 10]); }\n'; // exactly its localExtents
const oversized = host + 'module b() { cube([12, 12, 12]); }\n'; // 2 mm larger than its localExtents

function spec(clearance: number): AssemblySpec {
  return {
    assemblyName: 'pair',
    sheet: '',
    boundingBox: { width: 20, length: 20, height: 20 },
    components: [
      { name: 'a', description: 'host', localExtents: [20, 20, 20], position: [0, 0, 0] },
      // Declared 10 mm cube sitting INSIDE the host: the overlap the cut makes room for.
      { name: 'b', description: 'inserted', localExtents: [10, 10, 10], position: [5, 5, 5] },
    ],
    jointContracts: [{ type: 'snap_fit', clearance, partA: 'a', partB: 'b' }],
    guides: [],
    stressPoints: [],
    assumptions: [],
    openQuestions: [],
  } as unknown as AssemblySpec;
}

describe('checkAssemblyFit after code-cut mating cavities', () => {
  it('overlap within the inserted skeleton envelope plus a 0.2 mm clearance: no interference, the cavity is cut', async () => {
    expect(await checkAssemblyFit(fitting, spec(0.2))).toEqual([]);
  }, 60_000);

  it('a drafted inserted module larger than its localExtents sticks out past the cut and is still reported', async () => {
    const v = await checkAssemblyFit(oversized, spec(0.2));
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('interference');
    expect(v[0].message).toContain('0.2mm of clearance');
  }, 60_000);

  it('a 0-clearance joint (fused or touching) is not probed, even with an oversized module', async () => {
    expect(await checkAssemblyFit(oversized, spec(0))).toEqual([]);
  }, 60_000);
});
