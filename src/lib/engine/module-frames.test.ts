import { describe, it, expect } from 'vitest';
import { measureModuleFrames } from './module-frames';

const CODE = `
$fn = 24;
module at_origin() { cube([10, 20, 30]); }
module centred_cyl() { cylinder(d = 10, h = 5); }
module hanging() { rotate([-90, 0, 0]) linear_extrude(4) square([10, 20]); }
module nothing() { }
// The model placed things itself; measurement must ignore this.
union() { at_origin(); translate([50, 50, 50]) centred_cyl(); }
`;

describe('measureModuleFrames', () => {
  it('measures each module alone, ignoring top-level geometry', async () => {
    const frames = await measureModuleFrames(CODE, ['at_origin', 'centred_cyl', 'hanging', 'nothing']);
    expect(frames.map((f) => f.name)).toEqual(['at_origin', 'centred_cyl', 'hanging', 'nothing']);

    const [origin, cyl, hang, none] = frames;
    expect(origin.valid).toBe(true);
    expect(origin.min).toEqual([0, 0, 0]);
    expect(origin.size).toEqual([10, 20, 30]);

    // A cylinder is centred on its axis: min corner at [-r, -r, 0].
    expect(cyl.valid).toBe(true);
    expect(cyl.min[0]).toBeCloseTo(-5, 1);
    expect(cyl.min[1]).toBeCloseTo(-5, 1);
    expect(cyl.min[2]).toBeCloseTo(0, 3);

    // rotate([-90,0,0]) maps +y to -z: the part hangs from z=-20 to 0.
    expect(hang.valid).toBe(true);
    expect(hang.min[2]).toBeCloseTo(-20, 3);
    expect(hang.max[2]).toBeCloseTo(0, 3);
    expect(hang.max[1]).toBeCloseTo(4, 3);

    expect(none.valid).toBe(false);
  });

  it('returns an empty list for no names without compiling', async () => {
    expect(await measureModuleFrames(CODE, [])).toEqual([]);
  });
});
