import { describe, it, expect } from 'vitest';
import {
  analyzeTopLevel,
  composeAssembly,
  instantiationFor,
  stripTopLevelGeometry,
  hasGeneratedAssembly,
  stripGeneratedAssembly,
} from './compose-assembly';
import { AssemblySpec } from '../agent/assembly-spec';

function spec(components: AssemblySpec['components']): AssemblySpec {
  return {
    assemblyName: 'test',
    boundingBox: { width: 100, length: 100, height: 100 },
    components,
    stressPoints: [],
    assumptions: [],
    openQuestions: [],
  };
}

const MODULES = `
wall_t = 2.4;

module base_plate() {
    cube([60, 40, 6]);
}

module upright() {
    cube([6, 40, 45]);
}
`;

describe('analyzeTopLevel', () => {
  it('finds module declarations and sees no geometry in a module-only file', () => {
    const a = analyzeTopLevel(MODULES);
    expect(a.moduleNames).toEqual(['base_plate', 'upright']);
    expect(a.hasTopLevelGeometry).toBe(false);
  });

  it('treats a bare call as top-level geometry', () => {
    const a = analyzeTopLevel(`${MODULES}\nbase_plate();`);
    expect(a.hasTopLevelGeometry).toBe(true);
  });

  it('treats a transformed call as top-level geometry', () => {
    const a = analyzeTopLevel(`${MODULES}\ntranslate([0,0,6]) upright();`);
    expect(a.hasTopLevelGeometry).toBe(true);
  });

  it('treats a CSG block as top-level geometry', () => {
    const a = analyzeTopLevel(`${MODULES}\nunion() {\n  base_plate();\n  upright();\n}`);
    expect(a.hasTopLevelGeometry).toBe(true);
  });

  it('does not mistake assignments or directives for geometry', () => {
    const a = analyzeTopLevel(`
      include <thing.scad>
      use <other.scad>
      $fn = 40;
      w = 10;
      h = w * 2;
      function area(x) = x * x;
      module m() { cube([1,1,1]); }
    `);
    expect(a.hasTopLevelGeometry).toBe(false);
    expect(a.moduleNames).toEqual(['m']);
  });

  it('ignores braces and calls inside comments', () => {
    const a = analyzeTopLevel(`
      // base_plate();
      /* union() {
           upright();
         } */
      module base_plate() { cube([1,1,1]); }
    `);
    expect(a.hasTopLevelGeometry).toBe(false);
    expect(a.moduleNames).toEqual(['base_plate']);
  });

  it('ignores braces inside string literals', () => {
    // An unbalanced brace in a string would corrupt depth tracking and make
    // every later module look nested.
    const a = analyzeTopLevel(`
      label = "a { brace";
      module after() { cube([1,1,1]); }
    `);
    expect(a.moduleNames).toEqual(['after']);
    expect(a.hasTopLevelGeometry).toBe(false);
  });

  it('does not see geometry inside a module body', () => {
    const a = analyzeTopLevel(`
      module wrapper() {
        translate([1,2,3]) cube([1,1,1]);
        union() { sphere(2); }
      }
    `);
    expect(a.hasTopLevelGeometry).toBe(false);
  });
});

describe('composeAssembly', () => {
  it('emits the placement block the model never wrote', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'base', position: [0, 0, 0] },
        { name: 'upright', description: 'arm', position: [0, 0, 6], rotation: [0, 0, 90] },
      ])
    );

    expect(result.composed).toBe(true);
    expect(result.code).toContain('union() {');
    // Identity transforms are omitted rather than emitted as noise.
    expect(result.code).toContain('base_plate();');
    expect(result.code).not.toContain('translate([0, 0, 0])');
    // Rotation sits inside translation: rotate about own origin, then move.
    expect(result.code).toContain('translate([0, 0, upright_pos_z]) rotate([0, 0, 90]) upright();');
    expect(result.code).toContain('upright_pos_z = 6;');
  });

  it('strips a model-written assembly and places from the spec instead', () => {
    const authored = `${MODULES}\nunion() { base_plate(); translate([0,0,99]) upright(); }`;
    const result = composeAssembly(
      authored,
      spec([
        { name: 'base_plate', description: 'b', position: [0, 0, 0] },
        { name: 'upright', description: 'u', position: [0, 0, 6] },
      ])
    );
    expect(result.composed).toBe(true);
    expect(result.report?.removedStatements).toBe(1);
    expect(result.code).not.toContain('translate([0,0,99])');
    expect(result.code).toContain('translate([0, 0, upright_pos_z]) upright();');
    // Exactly one top-level union: the generated one.
    expect(result.code.match(/union\(\)/g)).toHaveLength(1);
  });

  it('declines when the spec names a module the code never defined', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'b', position: [0, 0, 0] },
        { name: 'gusset', description: 'missing', position: [1, 1, 1] },
      ])
    );

    expect(result.composed).toBe(false);
    expect(result.reason).toBe('missing_modules');
    expect(result.missing).toEqual(['gusset']);
    expect(result.code).toBe(MODULES);
  });

  it('places every component at the origin when the spec gives no coordinates', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'b' },
        { name: 'upright', description: 'u' },
      ])
    );
    expect(result.composed).toBe(true);
    expect(result.code).toContain('    base_plate();');
    expect(result.code).toContain('    upright();');
  });

  it('declines with no spec at all', () => {
    expect(composeAssembly(MODULES, null).reason).toBe('no_spec');
  });

  it('places an unpositioned component at the origin alongside positioned ones', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'b' },
        { name: 'upright', description: 'u', position: [0, 0, 6] },
      ])
    );
    expect(result.composed).toBe(true);
    expect(result.code).toContain('base_plate();');
    expect(result.code).toContain('translate([0, 0, upright_pos_z]) upright();');
    expect(result.code).toContain('upright_pos_z = 6;');
  });

  it('trims float noise out of emitted vectors', () => {
    const result = composeAssembly(
      MODULES,
      spec([{ name: 'base_plate', description: 'b', position: [0.1 + 0.2, 1 / 3, 2] }])
    );
    expect(result.code).toContain('base_plate_pos_x = 0.3;');
    expect(result.code).toContain('base_plate_pos_y = 0.333;');
    expect(result.code).toContain('base_plate_pos_z = 2;');
    expect(result.code).toContain('translate([base_plate_pos_x, base_plate_pos_y, base_plate_pos_z]) base_plate();');
  });
});

describe('composeAssembly with measured frames', () => {
  const frames = [
    { name: 'base_plate', valid: true, min: [0, 0, 0] as [number, number, number], max: [60, 40, 6] as [number, number, number], size: [60, 40, 6] as [number, number, number] },
    { name: 'upright', valid: true, min: [-3, 0, -45] as [number, number, number], max: [3, 40, 0] as [number, number, number], size: [6, 40, 45] as [number, number, number] },
  ];

  it('corrects a module whose min corner is off the origin, inside the rotation', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'b', position: [0, 0, 0] },
        { name: 'upright', description: 'u', position: [0, 0, 6], rotation: [0, 0, 90] },
      ]),
      frames
    );
    expect(result.code).toContain(
      'translate([0, 0, upright_pos_z]) rotate([0, 0, 90]) translate([3, 0, 45]) upright();'
    );
    expect(result.code).toMatch(/local-frame correction.*upright.*\[-3, 0, -45\]/);
    const up = result.report?.components.find((c) => c.name === 'upright');
    expect(up?.correction).toEqual([3, 0, 45]);
    expect(up?.placedMin).toEqual([-40, 0, 6]);
  });

  it('writes the position note beside the first emitted parameter', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'b', position: [0, 0, 0] },
        { name: 'upright', description: 'u', position: [0, 10, 6], positionNote: 'z = top of base_plate (localExtents z = 6)' },
      ]),
      frames
    );
    expect(result.code).toContain('/* [Assembly Placement] */');
    expect(result.code).toContain('upright_pos_y = 10;   // z = top of base_plate (localExtents z = 6)');
    expect(result.code).toContain('upright_pos_z = 6;');
  });

  it('puts a note above the call when every coordinate is zero', () => {
    const result = composeAssembly(
      MODULES,
      spec([{ name: 'base_plate', description: 'b', position: [0, 0, 0], positionNote: 'sits on the floor' }]),
      frames
    );
    expect(result.code).toContain('    // base_plate: sits on the floor\n    base_plate();');
  });

  it('round-trips through stripGeneratedAssembly and re-composes identically', () => {
    const s = spec([{ name: 'upright', description: 'u', position: [0, 0, 6] }, { name: 'base_plate', description: 'b' }]);
    const once = composeAssembly(MODULES, s, frames).code;
    const twice = composeAssembly(stripGeneratedAssembly(once), s, frames).code;
    expect(twice).toBe(once);
  });
});

describe('instantiationFor', () => {
  it('reproduces a component call for the interference probe', () => {
    const s = spec([
      { name: 'lid', description: 'l', position: [0, 0, 20], rotation: [180, 0, 0] },
      { name: 'body', description: 'b' },
    ]);
    expect(instantiationFor(s, 'lid')).toBe('translate([0, 0, 20]) rotate([180, 0, 0]) lid();');
    expect(instantiationFor(s, 'body')).toBe('body();');
    expect(instantiationFor(s, 'nope')).toBeNull();
  });

  it('applies the same local-frame correction as the placement block', () => {
    const s = spec([{ name: 'lid', description: 'l', position: [0, 0, 20] }]);
    const frames = [{ name: 'lid', valid: true, min: [-10, -10, 0] as [number, number, number], max: [10, 10, 4] as [number, number, number], size: [20, 20, 4] as [number, number, number] }];
    expect(instantiationFor(s, 'lid', frames)).toBe('translate([0, 0, 20]) translate([10, 10, 0]) lid();');
  });
});

describe('stripTopLevelGeometry', () => {
  it('removes a bare call and reports how many statements went', () => {
    const r = stripTopLevelGeometry(`${MODULES}\nbase_plate();\n`);
    expect(r.removed).toBe(1);
    expect(r.code).not.toContain('base_plate();');
    expect(analyzeTopLevel(r.code).hasTopLevelGeometry).toBe(false);
    expect(analyzeTopLevel(r.code).moduleNames).toEqual(['base_plate', 'upright']);
  });

  it('removes transformed calls, CSG blocks and control flow with their bodies', () => {
    const authored = `${MODULES}
translate([0, 0, 6]) upright();
union() {
  base_plate();
  translate([0,0,6]) upright();
}
for (i = [0:2]) translate([i * 10, 0, 0]) upright();
if (true) { base_plate(); }
`;
    const r = stripTopLevelGeometry(authored);
    expect(r.removed).toBe(4);
    expect(r.code).not.toMatch(/translate|union\(\)|for \(|if \(/);
    expect(r.code).toContain('module base_plate()');
    expect(r.code).toContain('module upright()');
  });

  it('keeps assignments, functions, directives and comments that precede declarations', () => {
    const src = `include <x.scad>
$fn = 48;
wall_t = 2.4; // [1.6:5] wall
function area(x) = x * x;
// the base
module base_plate() { cube([60, 40, 6]); }
`;
    const r = stripTopLevelGeometry(src);
    expect(r.removed).toBe(0);
    expect(r.code.trim()).toBe(src.trim());
  });

  it('is not fooled by braces in strings or comments', () => {
    const src = `label = "a { brace";
// translate([9,9,9]) base_plate();
/* union() { base_plate(); } */
module base_plate() { cube([1,1,1]); }
base_plate();
`;
    const r = stripTopLevelGeometry(src);
    expect(r.removed).toBe(1);
    expect(r.code).toContain('label = "a { brace";');
    expect(r.code).toContain('module base_plate()');
    expect(r.code).not.toMatch(/^base_plate\(\);/m);
  });

  it('compiles to empty after stripping, and to geometry once a call is appended', async () => {
    const { compileScad } = await import('../engine/scad-compiler');
    const r = stripTopLevelGeometry(`${MODULES}\nunion() { base_plate(); upright(); }`);
    const empty = await compileScad(r.code);
    expect(empty.valid).toBe(false);
    const withCall = await compileScad(`${r.code}\nbase_plate();`);
    expect(withCall.valid).toBe(true);
    expect(withCall.summary?.boundingBox?.size).toEqual([60, 40, 6]);
  });
});

describe('hasGeneratedAssembly', () => {
  it('detects the generated placement block', () => {
    const composed = composeAssembly(MODULES, spec([{ name: 'base_plate', description: 'b', position: [0, 0, 0] }]));
    expect(hasGeneratedAssembly(composed.code)).toBe(true);
    expect(hasGeneratedAssembly(MODULES)).toBe(false);
  });
});
