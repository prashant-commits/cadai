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
