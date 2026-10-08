import { describe, it, expect } from 'vitest';
import { checkAssemblyFit } from './graph';
import type { AssemblySpec } from './assembly-spec';

const code = 'module a() { cube([10, 10, 10]); }\nmodule b() { cube([10, 10, 10]); }\n';

function spec(clearance: number): AssemblySpec {
  return {
    assemblyName: 'pair',
    sheet: '',
    boundingBox: { width: 15, length: 10, height: 10 },
    components: [
      { name: 'a', description: 'a', localExtents: [10, 10, 10], position: [0, 0, 0] },
      { name: 'b', description: 'b', localExtents: [10, 10, 10], position: [5, 0, 0] }, // overlaps a by 5 x 10 x 10 mm
    ],
    jointContracts: [{ type: 'snap_fit', clearance, partA: 'a', partB: 'b' }],
    guides: [],
    stressPoints: [],
    assumptions: [],
    openQuestions: [],
  } as unknown as AssemblySpec;
}

describe('checkAssemblyFit probes only joints with a stated clearance', () => {
  it('a 0-clearance joint (fused or touching) with overlapping parts gives no interference violation', async () => {
    expect(await checkAssemblyFit(code, spec(0))).toEqual([]);
  }, 60_000);

  it('a 0.2 mm joint with the same overlap still gives one', async () => {
    const v = await checkAssemblyFit(code, spec(0.2));
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('interference');
    expect(v[0].message).toContain('0.2mm of clearance');
  }, 60_000);
});
