import { describe, expect, it } from 'vitest';
import { sweepParameters } from './param-sweep';
import { literalLint } from './literal-lint';

const live = `w = 40; // [20:80] width
module plate() { cube([w, 30, 5]); }
plate();
`;

const dead = `w = 40; // [20:80] width
h = 10; // [5:20] height
module plate() { cube([w, 30, 10]); }
plate();
`;

// +20% of drop pushes the part below z = 0.
const breaks = `drop = 0; // [-10:10] offset
w = 40; // [20:80] width
module plate() { translate([0, 0, -drop * 50]) cube([w, 30, 5]); }
plate();
`;

describe('sweepParameters', () => {
  it('finds no dead parameter when every one drives geometry', async () => {
    const r = await sweepParameters(live, { budgetMs: 60_000 });
    expect(r.dead).toEqual([]);
    expect(r.failures).toEqual([]);
  }, 120_000);

  it('reports a declared parameter that changes nothing', async () => {
    const r = await sweepParameters(dead, { budgetMs: 60_000 });
    expect(r.dead).toEqual(['h']);
  }, 120_000);

  it('reports a parameter whose sweep breaks the part, without throwing', async () => {
    const r = await sweepParameters(breaks.replace('drop = 0;', 'drop = 1;'), { budgetMs: 60_000 });
    expect(r.failures.map((f) => f.name)).toContain('drop');
    expect(r.failures.find((f) => f.name === 'drop')!.reason).toMatch(/z = 0|floor|below/i);
  }, 120_000);

  it('skips everything when the budget is spent', async () => {
    const r = await sweepParameters(dead, { budgetMs: 0 });
    expect(r.skipped.sort()).toEqual(['h', 'w']);
    expect(r.dead).toEqual([]);
  });
});

describe('literalLint', () => {
  it('flags a body literal equal to a parameter value', () => {
    const code = 'w = 40;\nlen = 80;\nmodule plate() { cube([80, w, 6]); }\n';
    expect(literalLint(code)).toEqual([{ component: 'plate', literal: 80, param: 'len' }]);
  });

  it('ignores common angles, small integers and $fn', () => {
    const code = 'a = 90;\nb = 2;\nn = 48;\nmodule p() { $fn = 48; rotate(90) cube([2, 1, 3]); }\n';
    expect(literalLint(code)).toEqual([]);
  });
});

describe('review round 1', () => {
  const composed = `w = 40; // [20:80] width
module plate() { cube([w, 30, 5]); }
module post() { cylinder(d = 4, h = 10); }
// ---- Assembly placement (generated from the approved Assembly Spec) ----
post_pos_x = 10; // x = inside plate
post_pos_y = 10;
post_pos_z = 5;
plate();
translate([post_pos_x, post_pos_y, post_pos_z]) post();
`;

  it('ignores generated placement assignments below the generated-assembly header', async () => {
    const r = await sweepParameters(composed, { budgetMs: 60_000 });
    expect([...r.dead, ...r.skipped, ...r.failures.map((f) => f.name)].filter((n) => n.includes('_pos_'))).toEqual([]);
    expect(literalLint(composed).filter((h) => h.param.includes('_pos_'))).toEqual([]);
  }, 120_000);

  it('perturbs an integer-step parameter by at least one step', async () => {
    const code = `n = 2; // [2:1:6] count
module row() { for (i = [0:n-1]) translate([i * 10, 0, 0]) cube(5); }
row();
`;
    const r = await sweepParameters(code, { budgetMs: 60_000 });
    expect(r.dead).not.toContain('n');
  }, 120_000);

  it('does not sweep $fn and does not call a moved hole dead', async () => {
    const code = `$fn = 32;
hole_x = 10; // [5:25] hole position
module plate() { difference() { cube([40, 30, 5]); translate([hole_x, 15, -1]) cylinder(d = 4, h = 7); } }
plate();
`;
    const r = await sweepParameters(code, { budgetMs: 60_000 });
    expect([...r.dead, ...r.skipped]).not.toContain('$fn');
    expect(r.dead).not.toContain('hole_x');
  }, 120_000);

  it('stays near its budget', async () => {
    const t0 = Date.now();
    await sweepParameters(`a = 1;\nb = 2;\nc = 3;\nmodule m() { cube([a, b, c]); }\nm();\n`, { budgetMs: 1500 });
    expect(Date.now() - t0).toBeLessThan(1500 * 1.5 + 3000);
  }, 60_000);
});

