import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '../agent/assembly-spec';
import { contactSinks } from './contact-sink';
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

  it('sinks a 0.05 mm gap and a 0.04 mm overlap, and ignores a 0.06 mm gap', () => {
    const touch = (y: number) => spec([comp('a', [10, 10, 10], [0, 0, 0]), comp('b', [10, 10, 10], [0, y, 0])]);
    expect(contactSinks(touch(10.05)).get('b')).toEqual([0, -0.02, 0]);
    expect(contactSinks(touch(9.96)).get('b')).toEqual([0, -0.02, 0]);
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
});
