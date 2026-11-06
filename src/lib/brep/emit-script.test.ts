import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { normalizeSpec } from '@/lib/agent/spec-normalize';
import { emitBrepScript } from './emit-script';
import { geoPython, runScriptForTest } from './test-run';

// P1 Task 3 acceptance: a normalized AssemblySpec emits a parametric build123d
// script whose parts, run through OpenCascade, have exactly the spec's sizes and
// placements. Runs only where a build123d interpreter exists (CADAI_GEO_PYTHON or
// geo/.venv/bin/python).
const run = existsSync(geoPython()) ? it : it.skip;

const base = { sheet: '', assemblyName: 'a', assumptions: [], openQuestions: [] };
const param = (name: string, value: number) => ({ name, value, min: 0, max: 1000, unit: 'mm', description: `${name} doc` });
const comp = (name: string, extents: unknown[], position: unknown[], extra: Record<string, unknown> = {}) =>
  ({ name, description: '', localExtents: extents, position, ...extra });
const spec = (s: Record<string, unknown>) => normalizeSpec({ ...base, ...s } as unknown as AssemblySpec);
const part = (r: Awaited<ReturnType<typeof runScriptForTest>>, label: string) => {
  const p = r.parts.find((x) => x.label === label);
  if (!p) throw new Error(`no part ${label} in ${JSON.stringify(r.parts.map((x) => x.label))} ${r.error ?? ''}`);
  return p;
};
const size = (p: { min: number[]; max: number[] }) => p.max.map((v, i) => v - p.min[i]);

describe('emitBrepScript', () => {
  it('writes every parameter as a top-level line with its range and description', () => {
    const { script } = emitBrepScript(spec({ parameters: [param('w', 40)], components: [comp('plate', ['w', 20, 5], [0, 0, 0])] }));
    expect(script).toMatch(/^from build123d import \*/m);
    expect(script).toMatch(/^w = 40\s+# \[0:\S*:1000\] w doc$/m);
    expect(script).toMatch(/^result = /m);
  });

  run('every shape kind has its spec size', async () => {
    const s = spec({
      components: [
        comp('b', [30, 20, 10], [0, 0, 0]),
        comp('c', [20, 20, 40], [50, 0, 0], { shape: { kind: 'cylinder', axis: 'z' } }),
        comp('t', [20, 20, 30], [100, 0, 0], { shape: { kind: 'tube', axis: 'z', innerD: 14 } }),
        comp('s', [40, 30, 20], [150, 0, 0], { shape: { kind: 'shell', wall: 2, openFace: '+Z' } }),
        comp('p', [10, 40, 30], [220, 0, 0], { shape: { kind: 'profile', plane: 'yz', points: [[0, 0], [40, 0], [0, 30]] } }),
        comp('px', [40, 10, 30], [260, 0, 0], { shape: { kind: 'profile', plane: 'xz', points: [[0, 0], [40, 0], [0, 30]] } }),
        comp('py', [40, 30, 10], [320, 0, 0], { shape: { kind: 'profile', plane: 'xy', points: [[0, 0], [40, 0], [0, 30]] } }),
      ],
    });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    for (const c of s.components!) {
      const p = part(r, c.name);
      size(p).forEach((v, i) => expect(v).toBeCloseTo(c.localExtents![i], 1));
      p.min.forEach((v, i) => expect(v).toBeCloseTo(c.position![i], 1));
      expect(p.valid).toBe(true);
    }
    expect(part(r, 't').volume).toBeLessThan(Math.PI * 10 * 10 * 30); // hollow
  }, 120_000);

  run('rotation matches placedBounds (min corner at position, rotated about it)', async () => {
    const s = spec({ components: [comp('arm', [100, 10, 5], [10, 20, 0], { rotation: [0, 0, 90] })] });
    const r = await runScriptForTest(emitBrepScript(s).script);
    const p = part(r, 'arm');
    expect(size(p)[0]).toBeCloseTo(10, 1);
    expect(size(p)[1]).toBeCloseTo(100, 1);
  }, 120_000);

  run('holes are cut through and nothing goes below the floor', async () => {
    const s = spec({ components: [comp('plate', [40, 40, 5], [0, 0, 0], { holes: [{ d: 6, at: [20, 20, 5], axis: 'z' }] })] });
    const r = await runScriptForTest(emitBrepScript(s).script);
    const p = part(r, 'plate');
    expect(p.volume).toBeCloseTo(40 * 40 * 5 - Math.PI * 9 * 5, 0);
    expect(p.min[2]).toBeGreaterThanOrEqual(-0.011);
  }, 120_000);

  run('a parameter drives the geometry: bumping it in the emitted script moves the dependent part', async () => {
    const s = spec({
      parameters: [param('base_t', 5)],
      components: [comp('base', [40, 40, 'base_t'], [0, 0, 0]), comp('post', [5, 5, 30], [0, 0, 'base_t'])],
    });
    const { script } = emitBrepScript(s);
    const r1 = await runScriptForTest(script);
    const r2 = await runScriptForTest(script.replace(/^base_t = 5\b/m, 'base_t = 9'));
    expect(part(r1, 'post').min[2]).toBeCloseTo(5, 1);
    expect(part(r2, 'post').min[2]).toBeCloseTo(9, 1);
  }, 120_000);

  run('a jointContract partB stays a separate solid; touching permanent parts fuse into one', async () => {
    const s = spec({
      components: [comp('box', [40, 40, 20], [0, 0, 0]), comp('lid', [40, 40, 3], [0, 0, 20]), comp('peg', [5, 5, 10], [0, 0, 23])],
      jointContracts: [{ type: 'lid', clearance: 0.2, partA: 'box', partB: 'lid' }],
    });
    const r = await runScriptForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    expect(r.solids).toBe(2); // box | lid+peg
  }, 120_000);

  it('skips a zero-size component with a reason instead of crashing', () => {
    const { skipped } = emitBrepScript(spec({ components: [comp('ok', [1, 1, 1], [0, 0, 0]), comp('flat', [10, 0, 10], [5, 0, 0])] }));
    expect(skipped.map((x) => x.name)).toEqual(['flat']);
  });

  run('uses a supplied body instead of the blockout', async () => {
    const s = spec({ components: [comp('knob', [20, 20, 10], [0, 0, 0])] });
    const body = 'return Cylinder(10, 10, align=(Align.MIN, Align.MIN, Align.MIN))';
    const r = await runScriptForTest(emitBrepScript(s, { knob: body }).script);
    expect(part(r, 'knob').volume).toBeCloseTo(Math.PI * 100 * 10, -1);
  }, 120_000);
});
