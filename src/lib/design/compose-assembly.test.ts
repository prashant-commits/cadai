import { describe, it, expect } from 'vitest';
import {
  analyzeTopLevel,
  composeAssembly,
  instantiationFor,
  stripTopLevelGeometry,
  hasGeneratedAssembly,
} from './compose-assembly';
import { AssemblySpec } from '../agent/assembly-spec';

function spec(components: AssemblySpec['components']): AssemblySpec {
  return {
    assemblyName: 'test',
    boundingBox: { width: 100, length: 100, height: 100 },
    components,
    edgeTreatments: [],
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
    expect(result.code).toContain('translate([0, 0, 6]) rotate([0, 0, 90]) upright();');
  });

  it('leaves the model in charge when it wrote its own assembly', () => {
    const authored = `${MODULES}\nunion() { base_plate(); translate([0,0,6]) upright(); }`;
    const result = composeAssembly(
      authored,
      spec([{ name: 'base_plate', description: 'b', position: [5, 5, 5] }])
    );

    expect(result.composed).toBe(false);
    expect(result.reason).toBe('model_wrote_assembly');
    // Untouched - appending would double the geometry.
    expect(result.code).toBe(authored);
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

  it('declines when no component declares a placement', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'b' },
        { name: 'upright', description: 'u' },
      ])
    );
    expect(result.composed).toBe(false);
    expect(result.reason).toBe('no_placements');
    expect(result.code).toBe(MODULES);
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
    expect(result.code).toContain('translate([0, 0, 6]) upright();');
  });

  it('trims float noise out of emitted vectors', () => {
    const result = composeAssembly(
      MODULES,
      spec([{ name: 'base_plate', description: 'b', position: [0.1 + 0.2, 1 / 3, 2] }])
    );
    expect(result.code).toContain('translate([0.3, 0.333, 2])');
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
