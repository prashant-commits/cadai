import { describe, it, expect } from 'vitest';
import { compileScad } from './scad-compiler';
import { ENGINEERING_MODULE_REGISTRY } from '../agent/engineering-tools';

describe('scad-compiler', () => {
  it('should compile valid syntax correctly', async () => {
    const code = 'cube([10, 10, 10]);';
    const result = await compileScad(code);
    expect(result.valid).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.errors.length).toBe(0);
    expect(result.stl).toContain('facet normal');
  });

  it('should catch syntax errors', async () => {
    const code = 'cube([10, 10, 10]';
    const result = await compileScad(code);
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('syntax error');
    expect(result.errors[0].code).toBe('parse_error');
  });

  it('should catch unknown module calls as warnings or errors', async () => {
    const code = 'unknown_module();';
    const result = await compileScad(code);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.message.includes('Ignoring unknown module'))).toBe(true);
  });

  it('should compile all engineering modules without errors', async () => {
    for (const [key, mod] of Object.entries(ENGINEERING_MODULE_REGISTRY)) {
      const result = await compileScad(mod.codeTemplate);
      const actualErrors = result.errors.filter(
        (e) => !e.message.includes('Current top level object is empty')
      );
      if (actualErrors.length > 0) {
        console.error(`Error in module ${key}:`, actualErrors);
      }
      expect(actualErrors, `Module ${key} failed compilation`).toHaveLength(0);
    }
  });

  // The --summary payload nests everything under `geometry` and uses snake_case
  // for the bounding box. Parsing it at the wrong level silently yields
  // undefined for every field, which reads downstream as "not a 3D model".
  describe('summary parsing', () => {
    it('unwraps the geometry envelope into a bounding box', async () => {
      const result = await compileScad('cube([20, 30, 5]);');
      expect(result.summary).toBeDefined();
      expect(result.summary?.dimensions).toBe(3);
      expect(result.summary?.boundingBox?.size).toEqual([20, 30, 5]);
      expect(result.summary?.boundingBox?.min).toEqual([0, 0, 0]);
      expect(result.summary?.facets).toBeGreaterThan(0);
    });

    it('reports CGAL manifoldness and shell count for CSG results', async () => {
      const result = await compileScad(
        'difference(){ cube([40,40,40]); translate([5,5,-1]) cube([10,10,42]); }'
      );
      expect(result.isManifold).toBe(true);
      expect(result.shellCount).toBe(1);
    });

    it('counts disconnected shells independently of manifoldness', async () => {
      const result = await compileScad(
        'cube([5,5,5]); translate([50,0,0]) cube([5,5,5]);'
      );
      // Perfectly manifold, yet the model has fallen into two pieces.
      expect(result.isManifold).toBe(true);
      expect(result.shellCount).toBe(2);
    });

    it('leaves Nef-only fields undefined for a PolySet result', async () => {
      const result = await compileScad('cube([10,10,10]);');
      expect(result.summary?.convex).toBe(true);
      expect(result.isManifold).toBeUndefined();
      expect(result.shellCount).toBeUndefined();
    });
  });

  // These render successfully with exit code 0 and a plausible STL, but the
  // solid is not the one the author described. They are the highest-frequency
  // silent failure in generated CAD, so they must carry a machine-readable code.
  describe('silent corruption', () => {
    it('flags an undeclared variable and still renders a degenerate solid', async () => {
      const result = await compileScad('cube([w, 10, 10]);');
      expect(result.exitCode).toBe(0);
      expect(result.stl).toContain('facet normal');
      // OpenSCAD substituted undef: 1x1x1 instead of the intended part.
      expect(result.summary?.boundingBox?.size).toEqual([1, 1, 1]);
      expect(result.warnings.some((w) => w.code === 'unknown_variable')).toBe(true);
    });

    it('flags a call to an undefined module while the rest still renders', async () => {
      const result = await compileScad('foo_bar(); cube([40,40,40]);');
      expect(result.exitCode).toBe(0);
      expect(result.summary?.boundingBox?.size).toEqual([40, 40, 40]);
      expect(result.warnings.some((w) => w.code === 'unknown_module')).toBe(true);
    });

    it('deduplicates a warning repeated on every loop iteration', async () => {
      const result = await compileScad('for (i = [0:20]) translate([i*2,0,0]) cube([w,1,1]);');
      const unknownVar = result.warnings.filter((w) => w.code === 'unknown_variable');
      expect(unknownVar).toHaveLength(1);
      expect(unknownVar[0].count).toBeGreaterThan(1);
    });
  });

  it('reports a non-3D top level object as a fatal error', async () => {
    const result = await compileScad('square([10,10]);');
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e) => e.code === 'not_3d')).toBe(true);
  });

  it('reports an empty top level object as a fatal error', async () => {
    const result = await compileScad('// nothing here');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'empty_object')).toBe(true);
  });

  it('selects a part from a PART switch via -D without editing the source', async () => {
    const parts = `
PART = "none";
module tenon()   { cylinder(d=7.0, h=10, $fn=32); }
module bigplate(){ cube([50,50,4]); }
if (PART == "tenon") tenon();
if (PART == "bigplate") bigplate();
`;
    const tenon = await compileScad(parts, { defines: { PART: 'tenon' } });
    expect(tenon.valid).toBe(true);
    expect(tenon.summary?.boundingBox?.size?.[2]).toBe(10);

    const plate = await compileScad(parts, { defines: { PART: 'bigplate' } });
    expect(plate.valid).toBe(true);
    expect(plate.summary?.boundingBox?.size).toEqual([50, 50, 4]);
  });
});
