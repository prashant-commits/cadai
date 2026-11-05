import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from './assembly-spec';
import { assembleScript, parseBuild, sanitizeBody } from './build-format';
import { blockoutBody } from '../spec-sheet/blockout-scad';

const spec = {
  sheet: '', assemblyName: 'holder', boundingBox: { width: 120, length: 106, height: 160 },
  guides: [], stressPoints: [], assumptions: [], openQuestions: [],
  components: [
    { name: 'backplate', description: 'plate', localExtents: [120, 6, 160], position: [0, 0, 0], shape: { kind: 'box' } },
    { name: 'cup_ring', description: 'ring', localExtents: [100, 100, 30], position: [10, 6, 100], shape: { kind: 'tube', axis: 'z', innerD: 90 } },
    { name: 'lip', description: 'lip', localExtents: [100, 4, 8], position: [10, 102, 100], shape: { kind: 'box' } },
  ],
} as unknown as AssemblySpec;
const names = ['backplate', 'cup_ring', 'lip'];

describe('parseBuild', () => {
  it('keeps complete sections and drops a truncated one', () => {
    const text = '@body backplate\ncube([w, 6, 160]);\n@end\n@body cup_ring\ncylinder(d = 100, h = 30);\n@end\n@body lip\ncube([100, 4,';
    const r = parseBuild(text, names);
    expect(Object.keys(r.bodies).sort()).toEqual(['backplate', 'cup_ring']);
    expect(r.dropped).toEqual(['lip']);
  });

  it('records blockout requests, addressed findings and unknown names', () => {
    const text = '@body backplate blockout\n@body ghost\ncube(1);\n@end\n@addressed H1: lip raised to 8 mm\n@addressed A2';
    const r = parseBuild(text, names);
    expect(r.keepBlockout).toEqual(['backplate']);
    expect(r.addressed).toEqual(['H1', 'A2']);
    expect(r.dropped).toContain('ghost');
    expect(r.bodies).toEqual({});
  });
});

describe('sanitizeBody', () => {
  it('removes a module wrapper, a whole-body translate and parameter assignments', () => {
    const body = 'module cup_ring() {\n  translate([0, 0, 5]) {\n    w = 3;\n    cylinder(d = 100, h = 30);\n  }\n}';
    const out = sanitizeBody(body);
    expect(out).toContain('cylinder(d = 100, h = 30);');
    expect(out).not.toMatch(/module|translate|w = 3/);
  });

  it('keeps translates that are part of the geometry', () => {
    const body = 'difference() {\n  cube([10, 10, 10]);\n  translate([5, 5, -0.01]) cylinder(d = 3, h = 10.02);\n}';
    expect(sanitizeBody(body)).toBe(body);
  });
});

describe('assembleScript', () => {
  it('emits the header and exactly one module per component, falling back to the blockout', () => {
    const parsed = parseBuild('@body cup_ring\ncylinder(d = 100, h = 30);\n@end', names);
    const code = assembleScript(spec, parsed, 'w = 120; // [60:240] width\n');
    expect(code.startsWith('w = 120;')).toBe(true);
    for (const n of names) expect(code.match(new RegExp(`module ${n}\\(\\)`, 'g'))).toHaveLength(1);
    expect(code).toContain('cylinder(d = 100, h = 30);');
    expect(code).toContain(blockoutBody(spec, 'backplate')!.trim().split('\n')[0]);
  });
});

describe('blockoutBody', () => {
  it('returns the module body without its header, and null for an unknown part', () => {
    const body = blockoutBody(spec, 'cup_ring')!;
    expect(body).not.toMatch(/module cup_ring/);
    expect(body).toMatch(/cylinder|difference/);
    expect(blockoutBody(spec, 'nope')).toBeNull();
  });
});
