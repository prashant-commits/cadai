import { describe, it, expect } from 'vitest';
import { gussetScad, gussetBounds, gussetsFor } from './gussets';
import { compileScad } from '../engine/scad-compiler';
import type { AssemblySpec, GussetSpec } from '../agent/assembly-spec';

const near = (v: number[], want: number[]) => v.forEach((n, i) => expect(n).toBeCloseTo(want[i], 1));

// The compile is the oracle for every rotation: each case states the bounding
// box the gusset must occupy in the component's own frame.
describe('gussetScad', () => {
  it.each<[string, GussetSpec, number[], number[]]>([
    [
      'corner along x, floor toward -y (wall at the back of an L-bracket)',
      { corner: [0, 37, 3], along: 'x', floorDir: '-', legMm: 20, thicknessMm: 2.4, at: [50] },
      [48.8, 17, 2.99], [51.2, 37.01, 23],
    ],
    [
      'corner along x, floor toward +y',
      { corner: [0, 3, 3], along: 'x', floorDir: '+', legMm: 20, thicknessMm: 2.4, at: [10] },
      [8.8, 2.99, 2.99], [11.2, 23, 23],
    ],
    [
      'corner along y, floor toward +x',
      { corner: [3, 0, 3], along: 'y', floorDir: '+', legMm: 15, thicknessMm: 2, at: [20] },
      [2.99, 19, 2.99], [18, 21, 18],
    ],
    [
      'corner along y, floor toward -x',
      { corner: [57, 0, 3], along: 'y', floorDir: '-', legMm: 15, thicknessMm: 2, at: [20] },
      [42, 19, 2.99], [57.01, 21, 18],
    ],
  ])('%s', async (_name, g, min, max) => {
    const lines = gussetScad(g);
    expect(lines).toHaveLength(1);
    const r = await compileScad(`${lines.join('\n')}\n`);
    expect(r.valid, r.error).toBe(true);
    near(r.summary!.boundingBox!.min, min);
    near(r.summary!.boundingBox!.max, max);
    // 0.5 * leg * leg * thickness, plus the tiny sink.
    expect(r.summary?.boundingBox).toBeDefined();
  });

  it('emits one prism per position and unions cleanly with the part it braces', async () => {
    const g: GussetSpec = { corner: [0, 37, 3], along: 'x', floorDir: '-', legMm: 20, thicknessMm: 2.4, at: [10, 30, 50] };
    expect(gussetScad(g)).toHaveLength(3);
    const bracket = `union() {
  cube([60, 40, 3]);
  translate([0, 37, 0]) cube([60, 3, 30]);
  ${gussetScad(g).join('\n  ')}
}`;
    const r = await compileScad(bracket);
    expect(r.valid, r.error).toBe(true);
    expect(r.isManifold).not.toBe(false);
    // The bracket's envelope is unchanged: gussets live inside the corner.
    near(r.summary!.boundingBox!.min, [0, 0, 0]);
    near(r.summary!.boundingBox!.max, [60, 40, 30]);
    // One shell: the sink fused the gussets into the bracket.
    expect(r.shellCount).toBe(1);
  });
});

describe('gussetBounds', () => {
  it('matches the compiled envelope, sink excluded', () => {
    const b = gussetBounds({ corner: [0, 37, 3], along: 'x', floorDir: '-', legMm: 20, thicknessMm: 2.4, at: [10, 50] });
    expect(b).toEqual({ min: [8.8, 17, 3], max: [51.2, 37, 23] });
    expect(gussetBounds({ corner: [0, 0, 0], along: 'y', floorDir: '+', legMm: 5, thicknessMm: 1, at: [] })).toBeNull();
  });
});

describe('gussetsFor', () => {
  const spec = (components: string[], stressPoints: AssemblySpec['stressPoints']): AssemblySpec => ({
    assemblyName: 't', boundingBox: { width: 1, length: 1, height: 1 },
    components: components.map((name) => ({ name, description: '' })),
    stressPoints, assumptions: [], openQuestions: [],
  });
  const gusset: GussetSpec = { corner: [0, 0, 0], along: 'x', floorDir: '+', legMm: 5, thicknessMm: 1, at: [1] };

  it('attaches by component name, and to the only component when the stress point names none', () => {
    const s = spec(['a', 'b'], [
      { component: 'b', location: 'root', loadCase: 'x', risk: 'high', mitigation: 'gusset', gusset },
      { location: 'no gusset here', loadCase: 'x', risk: 'low', mitigation: 'note' },
    ]);
    expect(gussetsFor(s, 'a')).toEqual([]);
    expect(gussetsFor(s, 'b').map((g) => g.location)).toEqual(['root']);

    const solo = spec(['only'], [{ location: 'root', loadCase: 'x', risk: 'high', mitigation: 'gusset', gusset }]);
    expect(gussetsFor(solo, 'only')).toHaveLength(1);
  });
});
