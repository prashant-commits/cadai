import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { auditPlacement } from '@/lib/agent/placement-audit';
import { componentAtLine } from '@/lib/agent/nodes/validate-brep';
import { normalizeSpec } from '@/lib/agent/spec-normalize';
import type { BrepResult } from '@/lib/engine/brep-runner';
import { emitBrepScript } from './emit-script';
import { toModuleFrames, toPlacementReport } from './measurements';
import { geoPython, runGeoCliForTest, runScriptForTest, type TestRun } from './test-run';

const run = existsSync(geoPython()) ? it : it.skip;

const base = { sheet: '', assemblyName: 'a', assumptions: [], openQuestions: [] };
const param = (name: string, value: number) => ({ name, value, min: 0, max: 1000, unit: 'mm', description: `${name} doc` });
const comp = (name: string, extents: unknown[], position: unknown[], extra: Record<string, unknown> = {}) =>
  ({ name, description: '', localExtents: extents, position, ...extra });
const spec = (s: Record<string, unknown>) => normalizeSpec({ ...base, ...s } as unknown as AssemblySpec);
const part = (r: TestRun, label: string) => {
  const p = r.parts.find((x) => x.label === label);
  if (!p) throw new Error(`no part ${label} in ${JSON.stringify(r.parts.map((x) => x.label))} ${r.error ?? ''}`);
  return p;
};
const size = (p: { min: number[]; max: number[] }) => p.max.map((v, i) => v - p.min[i]);
const tri = (plane: string) => ({ kind: 'profile', plane, points: [[0, 0], [20, 0], [0, 20]] });

describe('names that are unsafe in Python (High 1, 2)', () => {
  run('a parameter named like a Python keyword emits and runs', async () => {
    const s = spec({ parameters: [param('class', 12), param('lambda', 3)], components: [comp('plate', ['class', 20, 'lambda'], [0, 0, 0])] });
    const { script } = emitBrepScript(s);
    expect(script).not.toMatch(/^class = /m);
    const r = await runScriptForTest(script);
    expect(r.ok, r.error).toBe(true);
    expect(size(part(r, 'plate'))).toEqual([12, 20, 3].map((v) => expect.closeTo(v, 2)));
  }, 120_000);

  run('a parameter named extrude does not break the profile that calls extrude()', async () => {
    const s = spec({ parameters: [param('extrude', 12)], components: [comp('wedge', [20, 'extrude', 20], [0, 0, 0], { shape: tri('xz') })] });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    expect(size(part(r, 'wedge'))[1]).toBeCloseTo(12, 2);
  }, 120_000);

  run('a component named extrude does not replace the build123d function', async () => {
    const s = spec({ components: [comp('extrude', [10, 10, 10], [0, 0, 0]), comp('wedge', [20, 10, 20], [50, 0, 0], { shape: tri('xz') })] });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    expect(part(r, 'extrude').max[0]).toBeCloseTo(10, 2);
    expect(size(part(r, 'wedge'))[1]).toBeCloseTo(10, 2);
  }, 120_000);

  run('a parameter named radians does not break degree trig in a derived value', async () => {
    const s = spec({
      parameters: [param('radians', 30), param('reach', 40)],
      derived: [{ name: 'h', expr: 'reach * sin(radians)' }],
      components: [comp('bar', [10, 10, 'h'], [0, 0, 0])],
    });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    expect(size(part(r, 'bar'))[2]).toBeCloseTo(20, 2);
  }, 120_000);

  run('components named min and sin do not break min() and sin() in another part', async () => {
    const s = spec({
      parameters: [param('aa', 30), param('bb', 20), param('ang', 30)],
      components: [
        comp('min', [5, 5, 5], [0, 0, 0]),
        comp('sin', [5, 5, 5], [20, 0, 0]),
        comp('other', ['min(aa, bb)', 10, '10 + 20 * sin(ang)'], [40, 0, 0]),
      ],
    });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    expect(size(part(r, 'other'))[0]).toBeCloseTo(20, 2);
    expect(size(part(r, 'other'))[2]).toBeCloseTo(20, 2);
    expect(part(r, 'min').max[0]).toBeCloseTo(5, 2);
  }, 120_000);

  it('keeps the plain names and the documented line format when nothing collides', () => {
    const { script } = emitBrepScript(spec({ parameters: [param('w', 40)], components: [comp('plate', ['w', 20, 5], [0, 0, 0])] }));
    expect(script).toMatch(/^w = 40\s+# \[0:\S*:1000\] w doc$/m);
  });
});

describe('expressions are re-printed, never pasted (High 3)', () => {
  run('a newline in a derived expression does not drop the second line', async () => {
    const s = spec({ parameters: [param('w', 10)], derived: [{ name: 'h', expr: 'w\n+ 1' }], components: [comp('plate', [10, 10, 'h'], [0, 0, 0])] });
    const { script } = emitBrepScript(s);
    expect(script).toMatch(/^h = w \+ 1$/m);
    const r = await runScriptForTest(script);
    expect(size(part(r, 'plate'))[2]).toBeCloseTo(11, 2);
  }, 120_000);

  it('statements inside an expression never reach the script', () => {
    // Raw objects: normalizeSpec would flag these, but the emitter must hold even if one gets through.
    const evil = 'w\nimport os\n#';
    const raw = {
      ...base,
      parameters: [param('w', 10)],
      derived: [{ name: 'h', expr: evil }, { name: 'k', expr: 'w; import sys' }],
      components: [
        comp('plate', [10, 10, 5], [0, 0, 0], {
          expr: { localExtents: ['w', evil, null], position: [evil, 'w; import socket', null], rotation: [null, null, 'w\nimport ctypes'], innerD: evil, wall: evil },
        }),
      ],
    } as unknown as AssemblySpec;
    const { script, skipped } = emitBrepScript(raw);
    for (const word of ['import os', 'import sys', 'import socket', 'import ctypes']) expect(script).not.toContain(word);
    expect(script.split('\n').every((l) => !/^(import|from) (?!build123d|math)/.test(l))).toBe(true);
    expect(skipped.map((x) => x.name)).toEqual(expect.arrayContaining(['h', 'k']));
  });

  run('an injected expression leaves a script that still runs, on the resolved numbers', async () => {
    const raw = {
      ...base,
      parameters: [param('w', 10)],
      components: [comp('plate', [10, 10, 5], [0, 0, 0], { expr: { localExtents: ['w', 'w\nimport os\n#', null] } })],
    } as unknown as AssemblySpec;
    const r = await runScriptForTest(emitBrepScript(raw).script);
    expect(r.ok, r.error).toBe(true);
    expect(size(part(r, 'plate'))).toEqual([10, 10, 5].map((v) => expect.closeTo(v, 2)));
  }, 120_000);

  it('descriptions and notes cannot break out of their comment', () => {
    const s = spec({ parameters: [{ ...param('w', 10), description: 'line1\rimport os import sys\u0000x' }], components: [comp('plate', [10, 10, 5], [0, 0, 0])] });
    const { script } = emitBrepScript(s);
    expect(script).not.toMatch(/^import (os|sys)/m);
    expect(script).not.toContain('\r');
    expect(script).not.toContain('\u0000');
  });
});

describe('a supplied body is checked again by the emitter', () => {
  run('a body that imports, writes files or rebinds a parameter falls back to the labelled blockout', async () => {
    const s = spec({ parameters: [param('w', 30)], components: [comp('a', ['w', 10, 10], [0, 0, 0]), comp('b', [5, 5, 5], [50, 0, 0]), comp('c', [5, 5, 5], [70, 0, 0])] });
    const bodies = {
      a: 'import os\nreturn Box(1, 1, 1)',
      b: 'export_stl(Box(1, 1, 1), "/tmp/x.stl")\nreturn Box(1, 1, 1)',
      c: 'w = 1\nif True:\n    w = 2\nreturn Box(1, 1, 1)',
    };
    const { script, skipped } = emitBrepScript(s, bodies);
    expect(script).not.toMatch(/^\s*import os/m);
    expect(script).not.toContain('export_stl');
    expect(skipped.map((x) => x.name).sort()).toEqual(['a', 'b', 'c']);
    expect(skipped.every((x) => /body rejected/.test(x.reason))).toBe(true);
    const r = await runScriptForTest(script);
    expect(r.ok, r.error).toBe(true);
    expect(size(part(r, 'a'))[0]).toBeCloseTo(30, 2); // the blockout, not the 1 mm box
  }, 120_000);

  it('a carriage return cannot start a line at column 0 inside the function', () => {
    const s = spec({ components: [comp('a', [5, 5, 5], [0, 0, 0])] });
    const { script, skipped } = emitBrepScript(s, { a: 'x = 1\rimport os\nreturn Box(1, 1, 1)' });
    expect(script).not.toContain('\r');
    expect(skipped[0]?.name).toBe('a');
  });
});

describe('fusing only what truly touches (Medium 5)', () => {
  run('boxes that meet at an edge stay two solids and are not labelled as fused', async () => {
    const s = spec({ components: [comp('a', [10, 10, 10], [0, 0, 0]), comp('b', [10, 10, 10], [10, 10, 0])] });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    expect(r.solids).toBe(2);
    expect(r.children.sort()).toEqual(['a', 'b']);
  }, 120_000);

  run('two profiles whose boxes overlap but whose material does not stay separate', async () => {
    const s = spec({
      components: [
        comp('lo', [10, 10, 5], [0, 0, 0], { shape: { kind: 'profile', plane: 'xy', points: [[0, 0], [10, 0], [0, 10]] } }),
        comp('hi', [8, 8, 5], [2, 2, 0], { shape: { kind: 'profile', plane: 'xy', points: [[8, 8], [8, 0], [0, 8]] } }),
      ],
    });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    expect(r.solids).toBe(2);
  }, 120_000);

  run('a real face contact still fuses to one solid with the joined label', async () => {
    const s = spec({ components: [comp('a', [10, 10, 10], [0, 0, 0]), comp('b', [10, 10, 10], [0, 0, 10])] });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.solids).toBe(1);
    expect(r.children).toEqual(['a+b']);
  }, 120_000);
});

describe('round parts with unequal cross extents (Low 6)', () => {
  run('a cylinder of 20 x 20.4 spans both extents', async () => {
    const s = spec({
      components: [
        comp('cz', [20, 20.4, 30], [0, 0, 0], { shape: { kind: 'cylinder', axis: 'z' } }),
        comp('cx', [30, 20, 20.4], [50, 0, 0], { shape: { kind: 'cylinder', axis: 'x' } }),
        comp('cy', [20, 30, 20.4], [100, 0, 0], { shape: { kind: 'cylinder', axis: 'y' } }),
        comp('tz', [20, 20.4, 30], [150, 0, 0], { shape: { kind: 'tube', axis: 'z', innerD: 10 } }),
      ],
    });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    for (const c of s.components!) {
      const p = part(r, c.name);
      size(p).forEach((v, i) => expect(v).toBeCloseTo(c.localExtents![i], 2));
      p.min.forEach((v, i) => expect(v).toBeCloseTo(c.position![i], 2));
    }
  }, 120_000);
});

describe('blind holes follow a parameter past the midpoint (Low 7)', () => {
  const blind = (m: number) =>
    spec({
      parameters: [param('m', m)],
      components: [comp('plate', [40, 30, 10], [0, 0, 0], { holes: [{ d: 6, axis: 'z', at: [20, 15, 'm'], depth: 4 }] })],
    });
  const slab = (z0: number, z1: number) =>
    `\n_slab = Pos(0, 0, ${z0}) * Box(40, 30, ${z1 - z0}, align=(Align.MIN, Align.MIN, Align.MIN))\n_cut = (_p_plate & _slab)\n_cut.label = "slab"\n_cadai_parts = [_cut]\n`;
  run('the cutter sits on the face the parameter selects', async () => {
    const { script } = emitBrepScript(blind(0));
    const bottomVol = async (s: string) => part(await runScriptForTest(s + slab(0, 2)), 'slab').volume;
    const topVol = async (s: string) => part(await runScriptForTest(s + slab(8, 10)), 'slab').volume;
    const hole = Math.PI * 9 * 2;
    // m = 0: hole from the bottom face. Move the mouth to the top face by editing the parameter line.
    const flipped = script.replace(/^m = 0\b/m, 'm = 10');
    expect(await bottomVol(script)).toBeCloseTo(40 * 30 * 2 - hole, 0);
    expect(await topVol(script)).toBeCloseTo(40 * 30 * 2, 0);
    expect(await bottomVol(flipped)).toBeCloseTo(40 * 30 * 2, 0);
    expect(await topVol(flipped)).toBeCloseTo(40 * 30 * 2 - hole, 0);
  }, 120_000);
});

describe('profile inserts get a mating cavity (Low 8)', () => {
  run('the host is relieved around a triangular prism by the clearance', async () => {
    const s = spec({
      components: [
        comp('h', [40, 40, 20], [0, 0, 0]),
        comp('ins', [10, 10, 30], [10, 10, 5], { shape: { kind: 'profile', plane: 'xy', points: [[0, 0], [10, 0], [0, 10]] } }),
      ],
      jointContracts: [{ type: 'peg', clearance: 0.3, partA: 'h', partB: 'ins' }],
    });
    const { script } = emitBrepScript(s);
    expect(script).toContain('offset(');
    const r = await runScriptForTest(`${script}\n_cadai_parts = list(result.children)\n`);
    expect(r.ok, r.error).toBe(true);
    const host = part(r, 'h');
    // The prism fills 15 mm of the host (area 50); the cavity is that grown by 0.3 mm: more, but not much more.
    expect(host.volume).toBeLessThan(40 * 40 * 20 - 50 * 15);
    expect(host.volume).toBeGreaterThan(40 * 40 * 20 - 90 * 16);
    expect(r.solids).toBe(2);
  }, 120_000);
});

describe('traceback line -> component (b5 High 2)', () => {
  const s = () => spec({ components: [comp('a', [10, 10, 10], [0, 0, 0]), comp('b', [10, 10, 10], [30, 0, 0]), comp('min', [10, 10, 10], [60, 0, 0])] });

  run('a one-line TypeError in the second part is traced to that part', async () => {
    const { script } = emitBrepScript(s(), { b: 'return Box(1, 1)' });
    const r = await runGeoCliForTest(script);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/TypeError/);
    expect(componentAtLine(script, r.line, ['a', 'b', 'min'])).toBe('b');
  }, 120_000);

  run('a part renamed by the emitter (min -> min_part) is still traced', async () => {
    const { script } = emitBrepScript(s(), { min: 'return Cylinder(1, 2, axis="z")' });
    const r = await runGeoCliForTest(script);
    expect(r.ok).toBe(false);
    expect(componentAtLine(script, r.line, ['a', 'b', 'min'])).toBe('min');
  }, 120_000);

  run('an error that names another part in its message is not blamed on it', async () => {
    const { script } = emitBrepScript(s(), { a: 'raise ValueError("b does not fit next to min")\nreturn Box(1, 1, 1)' });
    const r = await runGeoCliForTest(script);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('b does not fit');
    expect(componentAtLine(script, r.line, ['a', 'b', 'min'])).toBe('a');
  }, 120_000);

  it('maps def bodies and placement statements, and nothing in the prelude', () => {
    const { script } = emitBrepScript(s());
    const lines = script.split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.startsWith(needle)) + 1;
    expect(componentAtLine(script, at('def b():') + 1, ['a', 'b', 'min'])).toBe('b');
    expect(componentAtLine(script, at('def min_part():') + 2, ['a', 'b', 'min'])).toBe('min');
    expect(componentAtLine(script, at('_p_a = '), ['a', 'b', 'min'])).toBe('a');
    expect(componentAtLine(script, at('def _fuse'), ['a', 'b', 'min'])).toBe('');
    expect(componentAtLine(script, undefined, ['a'])).toBe('');
  });
});

describe('local-frame measurement (b5 High 4)', () => {
  run('a rotated part built at the wrong local size is caught', async () => {
    const s = spec({ components: [comp('plate', [40, 20, 10], [0, 0, 0], { rotation: [0, 0, 45], position: [30, 0, 0] })] });
    // 50 x 10 x 10 and 40 x 20 x 10 have the same box once turned 45 degrees about z.
    const wrong = emitBrepScript(s, { plate: 'return Box(50, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN))' }).script;
    const r = await runGeoCliForTest(wrong);
    expect(r.ok).toBe(true);
    expect(r.local?.map((p) => p.label)).toEqual(['plate']);
    const brep = r as unknown as BrepResult;
    const frames = toModuleFrames(brep);
    const without = toPlacementReport(s, frames);
    const withLocal = toPlacementReport(s, frames, toModuleFrames({ ...brep, parts: brep.local ?? [] }));
    const kinds = (report: ReturnType<typeof toPlacementReport>) => auditPlacement(report, (r.bbox?.min ?? null) as [number, number, number] | null, s).map((v) => v.kind);
    expect(kinds(without)).not.toContain('extents'); // the reconstruction cannot see it
    expect(kinds(withLocal)).toContain('extents');
  }, 120_000);

  run('a correct rotated part passes', async () => {
    const s = spec({ components: [comp('plate', [40, 20, 10], [0, 0, 0], { rotation: [0, 0, 45], position: [30, 0, 0] })] });
    const r = await runGeoCliForTest(emitBrepScript(s).script);
    const brep = r as unknown as BrepResult;
    const report = toPlacementReport(s, toModuleFrames(brep), toModuleFrames({ ...brep, parts: brep.local ?? [] }));
    expect(auditPlacement(report, (r.bbox?.min ?? null) as [number, number, number] | null, s).map((v) => v.kind)).not.toContain('extents');
  }, 120_000);
});
