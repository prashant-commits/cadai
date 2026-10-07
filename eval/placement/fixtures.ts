/**
 * Fixtures for the audit-coverage harness: correct specs with correct scripts.
 *
 * Each one is verified to produce zero error violations before any mutation is
 * applied (runner.ts asserts this), so a detection in a mutated run can only
 * come from the mutation.
 */
import type { AssemblySpec } from '../../src/lib/agent/assembly-spec';
import type { Fixture } from './harness';

const spec = (s: unknown) => s as AssemblySpec;

/** The case the pipeline was designed for: axis-aligned stacking. */
export const stackedBox: Fixture = {
  name: 'stacked_box',
  intent: 'a 60x40 box with a lid, with a finger tab, sitting on top of it',
  code: `
wall_t = 2.4;
$fn = 48;
module box_body() {
  difference() {
    cube([60, 40, 20]);
    translate([wall_t, wall_t, wall_t]) cube([60 - 2 * wall_t, 40 - 2 * wall_t, 20]);
  }
}
module box_lid() {
  union() {
    cube([60, 40, 3]);
    // Asymmetric finger tab at the -X end, so a mirrored or rotated lid is a
    // genuinely different solid rather than an accidental no-op.
    translate([0, 14, 0]) cube([8, 12, 6]);
  }
}
`,
  spec: spec({
    assemblyName: 'stacked_box',
    boundingBox: { width: 60, length: 40, height: 26 },
    components: [
      { name: 'box_body', description: 'open-top box',
        localExtents: [60, 40, 20], bedFace: '-Z',
        position: [0, 0, 0], positionNote: 'origin' },
      { name: 'box_lid', description: '3 mm lid with an 8x12x6 finger tab at its -X edge',
        localExtents: [60, 40, 6], bedFace: '-Z',
        position: [0, 0, 20], positionNote: 'z = top of box_body (localExtents z = 20)' },
    ],
    jointContracts: [],
    stressPoints: [], assumptions: [], openQuestions: [],
  }),
};

/** The user's request: a 2 mm plate joined to a second plate at 60 degrees. */
export const angledPlates: Fixture = {
  name: 'angled_plates',
  intent: 'a 2 mm plate with a second 2 mm plate joined to it at 60 degrees',
  code: `
plate_w = 80;
plate_d = 60;
wall_t = 2;
$fn = 48;
module base_plate() {
  cube([plate_w, plate_d, wall_t]);
}
module angled_plate() {
  cube([plate_w, plate_d, wall_t]);
}
`,
  spec: spec({
    assemblyName: 'angled_plate_joint',
    boundingBox: { width: 80, length: 90, height: 52.96 },
    components: [
      { name: 'base_plate', description: 'flat 2 mm plate on the bed',
        localExtents: [80, 60, 2], bedFace: '-Z',
        position: [0, 0, 0], positionNote: 'origin' },
      { name: 'angled_plate', description: '2 mm plate rising at 60 deg',
        localExtents: [80, 60, 2], bedFace: '-Z',
        position: [0, 60, 0], rotation: [60, 0, 0],
        positionNote: 'y = far edge of base_plate (localExtents y = 60)' },
    ],
    jointContracts: [
      { type: 'welded_edge', clearance: 0, partA: 'base_plate', partB: 'angled_plate' },
    ],
    stressPoints: [], assumptions: [], openQuestions: [],
  }),
};

/** A bracket with a bolt hole: mutations that move or resize a feature. */
export const boltedBracket: Fixture = {
  name: 'bolted_bracket',
  intent: 'a 40x30x4 plate with an M3 clearance hole 8 mm in from one corner',
  code: `
plate_w = 40;
plate_d = 30;
wall_t = 4;
$fn = 48;
module mount_plate() {
  difference() {
    cube([plate_w, plate_d, wall_t]);
    translate([8, plate_d / 2, -0.01]) cylinder(d = 3.4, h = wall_t + 0.02);
  }
}
`,
  spec: spec({
    assemblyName: 'bolted_bracket',
    boundingBox: { width: 40, length: 30, height: 4 },
    components: [
      { name: 'mount_plate', description: '4 mm plate, M3 clearance hole 8 mm from the -X edge',
        localExtents: [40, 30, 4], bedFace: '-Z',
        position: [0, 0, 0], positionNote: 'origin',
        holes: [{ d: 3.4, axis: 'z', at: [8, 15, 0], note: 'M3 pass-through' }] },
    ],
    jointContracts: [],
    stressPoints: [], assumptions: [], openQuestions: [],
  }),
};

export const FIXTURES = [stackedBox, angledPlates, boltedBracket];
