import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '../agent/assembly-spec';
import { validateOpenScadCode } from '../agent/code-validator';
import { composeAssembly } from '../design/compose-assembly';
import { parseStlTriangles, type Vec3 } from '../engine/stl-renderer';
import { blockoutScad } from './blockout-scad';
import { fixtureSpec } from './fixtures';
import { specGeometry } from './geometry';

function blankSpec(components: NonNullable<AssemblySpec['components']>): AssemblySpec {
  return {
    sheet: '',
    assemblyName: 'check',
    boundingBox: { width: 1, length: 1, height: 1 },
    components,
    guides: [],
    stressPoints: [],
    assumptions: [],
    openQuestions: [],
  };
}

async function compiledBox(spec: AssemblySpec) {
  const { code } = blockoutScad(spec);
  const composed = composeAssembly(code, spec);
  expect(composed.composed, composed.reason).toBe(true);
  const result = await validateOpenScadCode(composed.code);
  const detail = result.errors.map((error) => error.message).join('\n') || result.error;
  expect(result.valid, detail).toBe(true);
  expect(result.summary?.boundingBox).toBeDefined();
  expect(result.stl).toBeTruthy();
  return { box: result.summary!.boundingBox!, stl: result.stl! };
}

describe('blockoutScad', () => {
  it('comments every numeric line, skips builtins, and cuts holes from the entry face', () => {
    const spec = fixtureSpec();
    spec.components = [
      ...(spec.components ?? []),
      { name: 'cube', description: 'builtin name', localExtents: [4, 4, 4], shape: { kind: 'box' } },
      { name: 'not-a-name', description: 'bad identifier', localExtents: [4, 4, 4], shape: { kind: 'box' } },
      {
        name: 'bow',
        description: 'self-intersecting outline',
        localExtents: [20, 10, 5],
        shape: {
          kind: 'profile',
          plane: 'xy',
          points: [[0, 0], [20, 10], [0, 10], [20, 0]],
        },
      },
    ];
    const { code, skipped } = blockoutScad(spec);

    for (const line of code.split('\n')) {
      if (/\d/.test(line)) expect(line, line).toContain('//');
    }
    expect(skipped.map((item) => item.name)).toEqual(expect.arrayContaining(['cube', 'not-a-name', 'bow']));
    expect(skipped.find((item) => item.name === 'cube')?.reason).toMatch(/builtin/);
    expect(skipped.find((item) => item.name === 'not-a-name')?.reason).toMatch(/identifier/);
    expect(skipped.find((item) => item.name === 'bow')?.reason).toMatch(/not simple/);
    expect(code).not.toMatch(/module\s+cube\s*\(/);
    expect(code).not.toContain('not-a-name');
    expect(code).toContain('cube([20, 10, 5])');
    expect(code).toContain('module bow()');
    const bow = code.slice(code.indexOf('module bow()')).split('\n');
    expect(bow[1]).toBe('    // PLACEHOLDER: profile polygon is not simple - build from the skeleton');
    expect(code.match(/PLACEHOLDER/g)).toHaveLength(1);
    expect(code).toContain('translate([20, 25, -0.01])');
    expect(code).toContain('translate([4, 4, 2])');
    expect(code).not.toMatch(/^[^/\n]*\b(base_plate|post|sleeve|tray|link|rail)\s*\(\s*\)\s*;/m);
  });

  it('compiles the fixture to the same bbox as the sheet geometry', async () => {
    const spec = fixtureSpec();
    const { box } = await compiledBox(spec);
    const expected = specGeometry(spec).bounds;
    expect(expected).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(box.min[i] - expected!.min[i])).toBeLessThanOrEqual(0.5);
      expect(Math.abs(box.max[i] - expected!.max[i])).toBeLessThanOrEqual(0.5);
    }
  });

  it('compiles an xy profile into its local box', async () => {
    await expectProfileBox('xy', [10, 6, 4], [[0, 0], [10, 0], [0, 6]]);
  });

  it('compiles an xz profile into its local box', async () => {
    await expectProfileBox('xz', [10, 4, 6], [[0, 0], [10, 0], [0, 6]]);
  });

  it('compiles a yz profile into its local box', async () => {
    await expectProfileBox('yz', [4, 10, 6], [[0, 0], [10, 0], [0, 6]]);
  });

  it('drops a duplicate closing vertex before emitting a profile', () => {
    const { code, skipped } = blockoutScad(blankSpec([
      {
        name: 'wedge',
        description: 'closed outline',
        localExtents: [10, 6, 4],
        shape: { kind: 'profile', plane: 'xy', points: [[0, 0], [0, 6], [10, 0], [0, 0]] },
      },
    ]));
    expect(skipped).toEqual([]);
    expect(code).toContain('paths = [[0, 1, 2]]');
    expect(code).not.toContain('[0, 0], [0, 6], [10, 0], [0, 0]');
  });
});

async function expectProfileBox(
  plane: 'xy' | 'xz' | 'yz',
  extents: [number, number, number],
  points: number[][]
) {
  const spec = blankSpec([
    {
      name: 'panel',
      description: `${plane} profile`,
      localExtents: extents,
      position: [0, 0, 0],
      shape: { kind: 'profile', plane, points },
    },
  ]);
  const { box, stl } = await compiledBox(spec);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(box.min[i])).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.max[i] - extents[i])).toBeLessThanOrEqual(0.5);
  }
  const geo = specGeometry(spec);
  expect(geo.bounds).not.toBeNull();
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(box.min[i] - geo.bounds!.min[i])).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.max[i] - geo.bounds!.max[i])).toBeLessThanOrEqual(0.5);
  }

  // The right angle sits at the origin. The missing corner is the one a
  // mirrored mapping would invent, so a rectangle would not catch it.
  const apex = profileWorld(plane, 0, points[2][1], 0);
  const missing = profileWorld(plane, points[1][0], points[2][1], 0);
  const sheetPts = geo.tris.flatMap((tri) => [tri.a, tri.b, tri.c]);
  const stlPts = parseStlTriangles(stl).flatMap((tri) => [tri.a, tri.b, tri.c]);
  expect(hasPoint(sheetPts, apex)).toBe(true);
  expect(hasPoint(stlPts, apex)).toBe(true);
  expect(hasPoint(sheetPts, missing)).toBe(false);
  expect(hasPoint(stlPts, missing)).toBe(false);
}

function profileWorld(plane: 'xy' | 'xz' | 'yz', u: number, v: number, t: number): Vec3 {
  if (plane === 'xy') return [u, v, t];
  if (plane === 'xz') return [u, t, v];
  return [t, u, v];
}

function hasPoint(points: Vec3[], target: Vec3): boolean {
  return points.some(
    (point) =>
      Math.abs(point[0] - target[0]) <= 0.5 &&
      Math.abs(point[1] - target[1]) <= 0.5 &&
      Math.abs(point[2] - target[2]) <= 0.5
  );
}
