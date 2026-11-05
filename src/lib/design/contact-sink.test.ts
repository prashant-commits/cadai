import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '../agent/assembly-spec';
import { contactSinks } from './contact-sink';
import { composeAssembly } from './compose-assembly';

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
});
