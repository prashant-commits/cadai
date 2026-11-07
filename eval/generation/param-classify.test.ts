import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyParams } from './param-classify';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('classifyParams on saved night1 scripts', () => {
  it('pi_case (B-rep): board_l and the other min == max parameters are fixed, not dead', () => {
    const c = classifyParams(fixture('pi_case.brep.py'));
    expect(c.fixed).toEqual(['board_l', 'board_w', 'board_t', 'pat_x', 'pat_y']);
    expect(c.guide).toEqual([]);
    expect(c.eligible.map((p) => p.name)).toEqual(['hole_d', 'standoff_h', 'standoff_od', 'wall', 'cav', 'lid_t']);
    expect(c.total).toHaveLength(11);
  });

  it('phone_stand (B-rep): the phone envelope parameters are guide-only', () => {
    const c = classifyParams(fixture('phone_stand.brep.py'));
    expect(c.guide).toEqual(['phone_w', 'phone_t', 'phone_len', 'phone_s0']);
    expect(c.fixed).toEqual([]);
    expect(c.eligible.map((p) => p.name)).toEqual(['base_w', 'base_d', 'base_t', 'backrest_w', 'backrest_t', 'backrest_len', 'lean_deg', 'slot_from_rear']);
  });

  it('phone_stand (OpenSCAD): every parameter feeds geometry, through derived values too', () => {
    const c = classifyParams(fixture('phone_stand.scad'));
    expect(c.guide).toEqual([]);
    expect(c.eligible).toHaveLength(6);
  });
});

describe('classifyParams reachability', () => {
  const py = (body: string) => `from build123d import *\n# ---- parameters\n${body}\n# ---- components\n`;

  it('follows derived values to geometry, and drops chains that end nowhere', () => {
    const c = classifyParams(py('a = 1  # [0:1:5]\nb = 2  # [0:1:5]\nc = 3  # [0:1:5]\nd1 = a + b\nd2 = c * 2') + 'def body():\n    return Box(d1, 1, 1)\n');
    expect(c.guide).toEqual(['c']);
  });

  it('ignores names that only appear in comments', () => {
    const c = classifyParams(py('a = 1  # [0:1:5] mentions b\nb = 2  # [0:1:5]') + 'def body():\n    return Box(a, 1, 1)  # b is not used\n');
    expect(c.guide).toEqual(['b']);
  });

  it('counts a placement variable that reads a parameter as geometry', () => {
    const c = classifyParams(py('a = 1  # [0:1:5]') + 'part_pos_x = a\n');
    expect(c.guide).toEqual([]);
  });

  it('leaves $-prefixed parameters out entirely', () => {
    const c = classifyParams('$fn = 48;\nw = 5; // [1:1:9]\nmodule m() { cube(w); }\n');
    expect(c.total).toEqual(['w']);
  });

  it('keeps a pinned parameter fixed even when geometry reads it', () => {
    const c = classifyParams('w = 5; // [5:1:5]\nmodule m() { cube(w); }\n');
    expect(c.fixed).toEqual(['w']);
    expect(c.eligible).toEqual([]);
  });
});
