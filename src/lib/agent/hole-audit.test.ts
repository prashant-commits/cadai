import { describe, it, expect } from 'vitest';
import { auditHoles } from './hole-audit';
import { blockoutScad } from '../spec-sheet/blockout-scad';
import type { AssemblySpec } from './assembly-spec';

/** A 40 x 30 x 6 plate whose holes enter from the MAX faces (top z, +x). */
function plate(holes: unknown[]): AssemblySpec {
  return {
    assemblyName: 'plate_asm',
    sheet: 'plate',
    boundingBox: { width: 40, length: 30, height: 6 },
    components: [
      {
        name: 'plate',
        description: 'a plate',
        localExtents: [40, 30, 6],
        position: [0, 0, 0],
        shape: { kind: 'box' },
        holes,
      },
    ],
    guides: [],
    stressPoints: [],
    assumptions: [],
    openQuestions: [],
  } as unknown as AssemblySpec;
}

describe('auditHoles probes INTO the part from the face `at` lies on', () => {
  it('a blind hole and a through hole on the top face, and a blind hole on the +x face, audit clean against the blockout', async () => {
    const spec = plate([
      { d: 4, axis: 'z', at: [10, 15, 6], depth: 3 }, // blind, mouth on the top face
      { d: 4, axis: 'z', at: [30, 15, 6] }, // through, mouth on the top face
      { d: 4, axis: 'x', at: [40, 15, 3], depth: 10 }, // blind, mouth on the +x face
    ]);
    const violations = await auditHoles(blockoutScad(spec).code, spec);
    expect(violations).toEqual([]);
  }, 60_000);

  it('holes on the min faces still audit clean (the existing convention is unchanged)', async () => {
    const spec = plate([
      { d: 4, axis: 'z', at: [10, 15, 0], depth: 3 },
      { d: 4, axis: 'x', at: [0, 15, 3], depth: 10 },
    ]);
    expect(await auditHoles(blockoutScad(spec).code, spec)).toEqual([]);
  }, 60_000);

  it('a top-face hole the part never got is still reported missing', async () => {
    const spec = plate([{ d: 4, axis: 'z', at: [10, 15, 6], depth: 3 }]);
    const solid = 'module plate() { cube([40, 30, 6]); }\n';
    const violations = await auditHoles(solid, spec);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('is not there');
  }, 60_000);
});
