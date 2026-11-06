import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '../agent/assembly-spec';
import { compileScad } from '../engine/scad-compiler';
import { contactSinkPlan, contactSinks } from './contact-sink';
import { composeAssembly, stripGeneratedAssembly } from './compose-assembly';

// Council 2026-11-06, item 1: contact is placement, and placement is code.
// Parts that are permanently joined (no jointContract) and touch only flush get
// pushed 0.02 mm into their neighbour, so a tangent ring or a C-loop resting on a
// plate shares a chord with it instead of a line.

const comp = (name: string, extents: number[], position: number[], extra: Record<string, unknown> = {}) =>
  ({ name, description: '', localExtents: extents, position, ...extra });
const spec = (components: unknown[], extra: Record<string, unknown> = {}) =>
  ({ sheet: '', assemblyName: 'a', boundingBox: { width: 1, length: 1, height: 1 }, assumptions: [], openQuestions: [], components, ...extra }) as unknown as AssemblySpec;

describe('contactSinks', () => {
  it('moves a ring that only touches a backplate face 0.02 mm into it (hair_dryer_holder)', () => {
    const s = spec([
      comp('backplate', [120, 5, 160], [0, 0, 0]),
      comp('cup_ring', [100, 100, 60], [10, 5, 0], { shape: { kind: 'tube', axis: 'z', innerD: 90 } }),
    ]);
    const sinks = contactSinks(s);
    expect(sinks.get('cup_ring')).toEqual([0, -0.02, 0]);
    expect(sinks.has('backplate')).toBe(false);
  });

  it('moves a loop resting on a plate top down 0.02 mm (cable_clip), never below z = 0', () => {
    const s = spec([comp('base_plate', [40, 20, 3], [0, 0, 0]), comp('clip_arm', [14, 20, 14], [13, 0, 3])]);
    expect(contactSinks(s).get('clip_arm')).toEqual([0, 0, -0.02]);
    // Grounded parts are never moved down through the floor.
    const flat = spec([comp('a', [10, 10, 5], [0, 0, 0]), comp('b', [10, 10, 5], [10, 0, 0])]);
    for (const v of contactSinks(flat).values()) expect(v[2]).toBeGreaterThanOrEqual(0);
  });

  it('leaves alone parts with a gap, parts already overlapping, and parts joined by a jointContract', () => {
    expect(contactSinks(spec([comp('a', [10, 10, 10], [0, 0, 0]), comp('b', [10, 10, 10], [0, 10.5, 0])])).size).toBe(0);
    expect(contactSinks(spec([comp('a', [10, 10, 10], [0, 0, 0]), comp('b', [10, 10, 10], [0, 9, 0])])).size).toBe(0);
    const joined = spec(
      [comp('host', [10, 10, 10], [0, 0, 0]), comp('peg', [10, 10, 10], [0, 10, 0])],
      { jointContracts: [{ type: 'peg', clearance: 0.2, partA: 'host', partB: 'peg' }] },
    );
    expect(contactSinks(joined).size).toBe(0);
  });

  it('is applied by composeAssembly to the emitted placement', () => {
    const s = spec([comp('backplate', [120, 5, 160], [0, 0, 0]), comp('cup_ring', [100, 100, 60], [10, 5, 0])]);
    const code = 'module backplate() { cube([120, 5, 160]); }\nmodule cup_ring() { cylinder(h = 60, d = 100); }\n';
    const out = composeAssembly(code, s).code;
    const line = out.split('\n').find((l) => /cup_ring\(\);/.test(l) && /translate/.test(l)) ?? '';
    expect(line).toMatch(/0\.02/);
  });

  it('keeps the spec position parameter and re-composes the same sink', () => {
    const s = spec([comp('backplate', [120, 5, 160], [0, 0, 0]), comp('cup_ring', [100, 100, 60], [10, 5, 0])]);
    const code = 'module backplate() { cube([120, 5, 160]); }\nmodule cup_ring() { cylinder(h = 60, d = 100); }\n';
    const once = composeAssembly(code, s).code;
    expect(once).toContain('cup_ring_pos_y = 5;');
    expect(once).toContain('cup_ring_pos_y - 0.02');
    expect(once).toContain('// sinks 0.02 mm into backplate');
    expect(composeAssembly(stripGeneratedAssembly(once), s).code).toBe(once);
  });

  it('moves the earlier part when it is the one off the floor', () => {
    const s = spec([comp('arm', [10, 10, 5], [0, 0, 5]), comp('base', [10, 10, 5], [0, 0, 0])]);
    expect(contactSinks(s).get('arm')).toEqual([0, 0, -0.02]);
    expect(contactSinks(s).has('base')).toBe(false);
  });

  it('honours rotation when the rotated envelope is what touches', () => {
    // rotate([0,0,90]) of a [10, 4, 10] box spans x [-4, 0]. Position x = 14 puts its min x on the plate's max x.
    const s = spec([
      comp('plate', [10, 10, 10], [0, 0, 0]),
      comp('tab', [10, 4, 10], [14, 0, 0], { rotation: [0, 0, 90] }),
    ]);
    expect(contactSinks(s).get('tab')).toEqual([-0.02, 0, 0]);
  });

  it('closes a gap of up to 0.05 mm by the gap plus 0.02 mm, and leaves a real overlap alone', () => {
    const touch = (y: number) => spec([comp('a', [10, 10, 10], [0, 0, 0]), comp('b', [10, 10, 10], [0, y, 0])]);
    // 0.05 mm gap moves 0.07 mm, so the faces overlap by 0.02 mm. A 0.04 mm overlap is already joined.
    expect(contactSinks(touch(10.05)).get('b')).toEqual([0, -0.07, 0]);
    expect(contactSinkPlan(touch(10.05)).notes.get('b')).toBe('sinks 0.07 mm into a');
    expect(contactSinks(touch(9.96)).size).toBe(0);
    expect(contactSinks(touch(10.06)).size).toBe(0);
  });

  it('applies at most one sink per axis when two neighbours want the same move', () => {
    const s = spec([
      comp('a', [10, 10, 10], [20, 0, 0]),
      comp('b', [10, 10, 10], [20, 0, 0]),
      comp('mid', [10, 10, 10], [10, 0, 0]),
    ]);
    expect(contactSinks(s).get('mid')).toEqual([0.02, 0, 0]);
  });

  it('refuses a downward sink that would put the part below z = 0', () => {
    const s = spec([comp('a', [10, 10, 0.015], [0, 0, 0]), comp('b', [10, 10, 5], [0, 0, 0.015])]);
    expect(contactSinks(s).size).toBe(0);
  });

  it('ignores a joint named in either part order', () => {
    const s = spec(
      [comp('peg', [10, 10, 10], [0, 10, 0]), comp('host', [10, 10, 10], [0, 0, 0])],
      { jointContracts: [{ type: 'peg', clearance: 0.2, partA: 'peg', partB: 'host' }] },
    );
    expect(contactSinks(s).size).toBe(0);
  });

  it('leaves a shelf flush between two uprights instead of sinking it into one of them', async () => {
    // left x [0,5], shelf x [5,45] at z 30, right x [45,50]. Sinking the shelf
    // into the left upright opens a gap at the right, and the union falls apart.
    const s = spec([
      comp('left', [5, 20, 60], [0, 0, 0]),
      comp('right', [5, 20, 60], [45, 0, 0]),
      comp('shelf', [40, 20, 3], [5, 0, 30]),
    ]);
    expect(contactSinks(s).size).toBe(0);
    const code = [
      'module left() { cube([5, 20, 60]); }',
      'module right() { cube([5, 20, 60]); }',
      'module shelf() { cube([40, 20, 3]); }',
      '',
    ].join('\n');
    const out = composeAssembly(code, s).code;
    expect(out).not.toMatch(/shelf_pos_[xyz] [+-]/);
    const compiled = await compileScad(out);
    expect(compiled.shellCount).toBe(1);
  });

  it('keeps an arm on its base when the spec lists the cap first', async () => {
    // Spec order cap, base, arm. The arm must move down onto the base, and the
    // cap must follow the arm, or the pair lifts off the base.
    const s = spec([
      comp('cap', [10, 10, 2], [0, 0, 10]),
      comp('base', [10, 10, 5], [0, 0, 0]),
      comp('arm', [10, 10, 5], [0, 0, 5]),
    ]);
    const sinks = contactSinks(s);
    expect(sinks.get('arm')).toEqual([0, 0, -0.02]);
    expect(sinks.get('cap')).toEqual([0, 0, -0.04]);
    expect(sinks.has('base')).toBe(false);
    const code = [
      'module cap() { cube([10, 10, 2]); }',
      'module base() { cube([10, 10, 5]); }',
      'module arm() { cube([10, 10, 5]); }',
      '',
    ].join('\n');
    const out = composeAssembly(code, s).code;
    expect(out).toContain('arm_pos_z - 0.02');
    expect(out).not.toContain('arm_pos_z + 0.02');
    expect(out).toContain('// sinks 0.02 mm into base');
    expect(out).toContain('// sinks 0.04 mm: 0.02 into arm, which sank 0.02');
    const compiled = await compileScad(out);
    expect(compiled.shellCount).toBe(1);
  });

  it('sinks a ring relative to the post after the post has sunk into the plate', async () => {
    // Equal absolute sinks leave the ring tangent on the post. The ring's move
    // is measured from the post's final position, so the two overlap by 0.02 mm.
    const s = spec([
      comp('plate', [40, 20, 3], [0, 0, 0]),
      comp('post', [10, 10, 10], [15, 5, 3]),
      comp('ring', [10, 10, 10], [15, 5, 13]),
    ]);
    const sinks = contactSinks(s);
    expect(sinks.get('post')).toEqual([0, 0, -0.02]);
    expect(sinks.get('ring')).toEqual([0, 0, -0.04]);
    expect(sinks.has('plate')).toBe(false);
    const code = [
      'module plate() { cube([40, 20, 3]); }',
      'module post() { cube([10, 10, 10]); }',
      'module ring() { cube([10, 10, 10]); }',
      '',
    ].join('\n');
    const out = composeAssembly(code, s).code;
    expect(out).toContain('// sinks 0.04 mm: 0.02 into post, which sank 0.02');
    const compiled = await compileScad(out);
    expect(compiled.shellCount).toBe(1);
  });

  it('takes the largest same-axis move so a lintel follows the support that already sank', async () => {
    // postA sits on the base, so it sinks 0.02. postB is already on the floor.
    // The lintel must follow postA by 0.04, not stop at 0.02 and stay tangent on it.
    const s = spec([
      comp('base', [40, 10, 3], [0, 0, 0]),
      comp('postB', [5, 10, 10], [30, 0, 0]),
      comp('postA', [5, 10, 7], [5, 0, 3]),
      comp('lintel', [40, 10, 3], [0, 0, 10]),
    ]);
    const sinks = contactSinks(s);
    expect(sinks.get('postA')).toEqual([0, 0, -0.02]);
    expect(sinks.get('lintel')).toEqual([0, 0, -0.04]);
    expect(sinks.has('postB')).toBe(false);
    expect(sinks.has('base')).toBe(false);
    expect(contactSinkPlan(s).notes.get('lintel')).toBe('sinks 0.04 mm: 0.02 into postA, which sank 0.02');
    const code = [
      'module base() { cube([40, 10, 3]); }',
      'module postB() { cube([5, 10, 10]); }',
      'module postA() { cube([5, 10, 7]); }',
      'module lintel() { cube([40, 10, 3]); }',
      '',
    ].join('\n');
    const compiled = await compileScad(composeAssembly(code, s).code);
    expect(compiled.shellCount).toBe(1);
  });

  it('moves by the larger same-direction gap instead of the nearer face', () => {
    // near is flush (move 0.02). far is 0.05 mm back (move 0.07). Same direction.
    const s = spec([
      comp('near', [10, 10, 10], [0, 0, 0]),
      comp('far', [9.95, 10, 10], [0, 0, 0]),
      comp('block', [10, 10, 10], [10, 0, 5]),
    ]);
    expect(contactSinks(s).get('block')).toEqual([-0.07, 0, 0]);
  });

  it('does not fall through to a smaller same-direction move when the largest opens a gap', () => {
    // +0.07 toward far would pull the bar off its 0.03 mm overlap with left.
    // Taking the smaller +0.02 instead would leave far exactly tangent.
    const s = spec([
      comp('left', [10, 10, 10], [0, 0, 0]),
      comp('near', [10, 10, 10], [19.97, 0, 0]),
      comp('far', [10, 10, 10], [20.02, 0, 0]),
      comp('bar', [10, 10, 10], [9.97, 0, 5]),
    ]);
    const bar = contactSinks(s).get('bar');
    expect(bar?.[0] ?? 0).toBe(0);
  });

  it('refuses a move that would turn an overlap into a flush face', () => {
    // The bar overlaps the left upright by 0.02 and is flush with the right.
    // Moving +0.02 toward the right would leave the left face exactly tangent.
    const s = spec([
      comp('left', [5, 10, 40], [0, 0, 0]),
      comp('right', [5, 10, 40], [44.98, 0, 0]),
      comp('bar', [40, 10, 3], [4.98, 0, 30]),
    ]);
    expect(contactSinks(s).size).toBe(0);
  });

  it('returns when two components share a name and sinks the later one', () => {
    const s = spec([
      comp('a', [10, 10, 10], [0, 0, 0]),
      comp('a', [10, 10, 10], [10, 0, 0]),
    ]);
    expect(contactSinks(s).get('a')).toEqual([-0.02, 0, 0]);
  });

  it('names each partner when one part sinks on two axes', () => {
    const s = spec([
      comp('base', [20, 20, 5], [0, 0, 0]),
      comp('wall', [5, 20, 20], [0, 0, 0]),
      comp('block', [10, 10, 10], [5, 5, 5]),
    ]);
    expect(contactSinks(s).get('block')).toEqual([-0.02, 0, -0.02]);
    const code = [
      'module base() { cube([20, 20, 5]); }',
      'module wall() { cube([5, 20, 20]); }',
      'module block() { cube([10, 10, 10]); }',
      '',
    ].join('\n');
    expect(composeAssembly(code, s).code).toContain('// sinks 0.02 mm into wall; sinks 0.02 mm into base');
  });
});
