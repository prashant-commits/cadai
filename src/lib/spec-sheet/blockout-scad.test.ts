import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '../agent/assembly-spec';
import { validateOpenScadCode } from '../agent/code-validator';
import { composeAssembly } from '../design/compose-assembly';
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
  return result.summary!.boundingBox!;
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
    expect(code).toContain('translate([20, 25, -0.01])');
    expect(code).toContain('translate([4, 4, 2])');
    expect(code).not.toMatch(/^[^/\n]*\b(base_plate|post|sleeve|tray|link|rail)\s*\(\s*\)\s*;/m);
  });

  it('compiles the fixture to the same bbox as the sheet geometry', async () => {
    const spec = fixtureSpec();
    const box = await compiledBox(spec);
    const expected = specGeometry(spec).bounds;
    expect(expected).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(box.min[i] - expected!.min[i])).toBeLessThanOrEqual(0.5);
      expect(Math.abs(box.max[i] - expected!.max[i])).toBeLessThanOrEqual(0.5);
    }
  });

  it('compiles an xy profile into its local box', async () => {
    await expectProfileBox('xy', [10, 6, 4], [[0, 0], [10, 0], [10, 6], [0, 6]]);
  });

  it('compiles an xz profile into its local box', async () => {
    await expectProfileBox('xz', [10, 4, 6], [[0, 0], [10, 0], [10, 6], [0, 6]]);
  });

  it('compiles a yz profile into its local box', async () => {
    await expectProfileBox('yz', [4, 10, 6], [[0, 0], [10, 0], [10, 6], [0, 6]]);
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
  const box = await compiledBox(spec);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(box.min[i])).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.max[i] - extents[i])).toBeLessThanOrEqual(0.5);
  }
  const geo = specGeometry(spec).bounds;
  expect(geo).not.toBeNull();
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(box.min[i] - geo!.min[i])).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.max[i] - geo!.max[i])).toBeLessThanOrEqual(0.5);
  }
}
