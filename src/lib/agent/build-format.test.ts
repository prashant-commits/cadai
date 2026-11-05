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
    const out = sanitizeBody(body, ['w']);
    expect(out).toContain('cylinder(d = 100, h = 30);');
    expect(out).not.toMatch(/module|translate|w = 3/);
  });

  it('keeps local variables that are not declared parameters', () => {
    const body = 'r = ring_id / 2;\ndifference() { cylinder(r = r + wall, h = 30); cylinder(r = r, h = 30.02); }';
    expect(sanitizeBody(body, ['ring_id', 'wall'])).toBe(body);
  });

  it('keeps a multi-line call intact', () => {
    const body = 'cylinder(\n  h = 20,\n  d = 10);';
    expect(sanitizeBody(body, ['h'])).toBe(body);
  });

  it('keeps a transform that applies to one statement', () => {
    const body = 'translate([5, 5, 0]) cylinder(d = 3, h = 10);';
    expect(sanitizeBody(body, [])).toBe(body);
  });

  it('keeps translates that are part of the geometry', () => {
    const body = 'difference() {\n  cube([10, 10, 10]);\n  translate([5, 5, -0.01]) cylinder(d = 3, h = 10.02);\n}';
    expect(sanitizeBody(body, [])).toBe(body);
  });
});

describe('fallbacks', () => {
  it('falls back to the blockout for an empty or comment-only body, listing it in dropped', () => {
    const r = parseBuild('@body lip\n// nothing here\n@end', names);
    expect(r.bodies.lip).toBeUndefined();
    expect(r.dropped).toContain('lip');
  });

  it('unwraps a module wrapper even with an assignment or helper beside it, or else falls back', () => {
    const r = parseBuild('@body lip\n$fn = 64;\nmodule lip() { cube([100, 4, 8]); };\n@end', names);
    const code = assembleScript(spec, r);
    expect(code).toMatch(/module lip\(\) \{[\s\S]*cube\(\[100, 4, 8\]\)/);
    expect(code.match(/module lip\(\)/g)).toHaveLength(1);
  });
});

describe('fallbacks, round 2', () => {
  it('treats a body that only assigns variables as empty', () => {
    const r = parseBuild('@body lip\nlip_h = 8;\n@end', names);
    expect(r.bodies.lip).toBeUndefined();
    expect(r.dropped).toContain('lip');
  });

  it('falls back to the blockout when other statements sit beside a module wrapper', () => {
    for (const text of [
      '@body lip\nmodule lip() { cube([100, 4, 8]); }\nlip();\n@end',
      '@body lip\nmodule rib() { cube([2, 4, 8]); }\nfor (i = [0:9]) translate([i * 10, 0, 0]) rib();\n@end',
    ]) {
      const r = parseBuild(text, names);
      expect(r.bodies.lip, text).toBeUndefined();
      expect(r.dropped, text).toContain('lip');
    }
  });

  it('never lists one part as both kept-blockout and dropped', () => {
    const r = parseBuild('@body lip blockout\n@body lip\ncube([1,', names);
    expect(r.keepBlockout.filter((n) => r.dropped.includes(n))).toEqual([]);
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
