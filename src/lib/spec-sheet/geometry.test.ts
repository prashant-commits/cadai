import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '../agent/assembly-spec';
import { placedBounds, type Vec3 } from '../design/placement-geometry';
import type { ColoredTriangle, RGB } from '../engine/stl-renderer';
import { fixtureSpec } from './fixtures';
import {
  HOLE_DISC_COLOR,
  PART_PALETTE,
  guideGeometry,
  specGeometry,
  type SheetGeometry,
} from './geometry';

function partSpec(
  component: NonNullable<AssemblySpec['components']>[number]
): AssemblySpec {
  return {
    sheet: '',
    assemblyName: 'one',
    boundingBox: { width: 1, length: 1, height: 1 },
    components: [component],
    guides: [],
    stressPoints: [],
    assumptions: [],
    openQuestions: [],
  };
}

function meshBounds(tris: ColoredTriangle[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const p of [t.a, t.b, t.c]) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
  }
  return { min, max };
}

function expectPlacedBox(
  geo: SheetGeometry,
  extents: Vec3,
  position: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0]
) {
  expect(geo.bounds).not.toBeNull();
  const expected = placedBounds({ min: [0, 0, 0], max: extents }, position, rotation);
  for (let i = 0; i < 3; i++) {
    expect(geo.bounds!.min[i]).toBeCloseTo(expected.min[i], 2);
    expect(geo.bounds!.max[i]).toBeCloseTo(expected.max[i], 2);
  }
}

function isClosed(tris: ColoredTriangle[]): boolean {
  const edges = new Map<string, number>();
  const key = (p: Vec3, q: Vec3) => {
    const a = p.map((n) => n.toFixed(4)).join(',');
    const b = q.map((n) => n.toFixed(4)).join(',');
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };
  for (const t of tris) {
    for (const [p, q] of [
      [t.a, t.b],
      [t.b, t.c],
      [t.c, t.a],
    ] as [Vec3, Vec3][]) {
      const k = key(p, q);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  if (tris.length === 0) return false;
  for (const count of edges.values()) if (count !== 2) return false;
  return true;
}

function bodyTris(tris: ColoredTriangle[], color: RGB): ColoredTriangle[] {
  return tris.filter((t) => t.color[0] === color[0] && t.color[1] === color[1] && t.color[2] === color[2]);
}

/** Barycentric inclusion in the xy plane. Degenerate projections are ignored by the caller. */
function pointInTri2d(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  c: [number, number]
): boolean {
  const v0x = c[0] - a[0];
  const v0y = c[1] - a[1];
  const v1x = b[0] - a[0];
  const v1y = b[1] - a[1];
  const v2x = p[0] - a[0];
  const v2y = p[1] - a[1];
  const dot = (x1: number, y1: number, x2: number, y2: number) => x1 * x2 + y1 * y2;
  const d00 = dot(v0x, v0y, v0x, v0y);
  const d01 = dot(v0x, v0y, v1x, v1y);
  const d11 = dot(v1x, v1y, v1x, v1y);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-8) return false;
  const d02 = dot(v0x, v0y, v2x, v2y);
  const d12 = dot(v1x, v1y, v2x, v2y);
  const u = (d11 * d02 - d01 * d12) / denom;
  const v = (d00 * d12 - d01 * d02) / denom;
  return u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6;
}

describe('specGeometry', () => {
  it('offers at least eight distinct colours', () => {
    expect(PART_PALETTE.length).toBeGreaterThanOrEqual(8);
    const keys = new Set(PART_PALETTE.map((c) => c.join(',')));
    expect(keys.size).toBe(PART_PALETTE.length);
  });

  it('draws each shape kind as a closed mesh whose bbox is the placed extents', () => {
    const cases: NonNullable<AssemblySpec['components']>[number][] = [
      {
        name: 'block',
        description: 'box',
        localExtents: [20, 30, 10],
        position: [4, 5, 0],
        shape: { kind: 'box' },
      },
      {
        name: 'pin',
        description: 'cylinder',
        localExtents: [12, 12, 28],
        position: [0, 0, 0],
        shape: { kind: 'cylinder', axis: 'z' },
      },
      {
        name: 'bush',
        description: 'tube',
        localExtents: [16, 16, 10],
        position: [2, 0, 1],
        shape: { kind: 'tube', axis: 'z', innerD: 6 },
      },
      {
        name: 'cup',
        description: 'shell',
        localExtents: [24, 18, 14],
        position: [0, 3, 0],
        shape: { kind: 'shell', wall: 2, openFace: '+Z' },
      },
      {
        name: 'plate',
        description: 'profile',
        localExtents: [30, 20, 8],
        position: [1, 2, 0],
        shape: {
          kind: 'profile',
          plane: 'xy',
          points: [
            [0, 0],
            [30, 0],
            [30, 20],
            [0, 20],
          ],
          holes: [
            [
              [10, 6],
              [20, 6],
              [20, 14],
              [10, 14],
            ],
          ],
        },
      },
    ];

    for (const component of cases) {
      const geo = specGeometry(partSpec(component));
      expect(geo.skipped, component.name).toEqual([]);
      expect(geo.parts.map((p) => p.name)).toEqual([component.name]);
      const solid = bodyTris(geo.tris, geo.parts[0].color);
      expect(solid.length, component.name).toBeGreaterThan(0);
      expect(isClosed(solid), component.name).toBe(true);
      expectPlacedBox(
        { ...geo, bounds: meshBounds(solid) },
        component.localExtents as Vec3,
        (component.position ?? [0, 0, 0]) as Vec3,
        (component.rotation ?? [0, 0, 0]) as Vec3
      );
    }
  });

  it('leaves the profile hole empty on both caps', () => {
    const geo = specGeometry(
      partSpec({
        name: 'plate',
        description: 'profile',
        localExtents: [30, 20, 8],
        shape: {
          kind: 'profile',
          plane: 'xy',
          points: [
            [0, 0],
            [30, 0],
            [30, 20],
            [0, 20],
          ],
          holes: [
            [
              [10, 6],
              [20, 6],
              [20, 14],
              [10, 14],
            ],
          ],
        },
      })
    );
    const centre: [number, number] = [15, 10];
    const caps = geo.tris.filter((t) => {
      const zs = [t.a[2], t.b[2], t.c[2]];
      return Math.max(...zs) - Math.min(...zs) < 1e-6;
    });
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      const inside = pointInTri2d(
        centre,
        [cap.a[0], cap.a[1]],
        [cap.b[0], cap.b[1]],
        [cap.c[0], cap.c[1]]
      );
      expect(inside).toBe(false);
    }
  });

  it('moves a 90 degree rotation about x the way placedBounds does', () => {
    const extents: Vec3 = [10, 20, 30];
    const position: Vec3 = [5, 30, 0];
    const rotation: Vec3 = [90, 0, 0];
    const geo = specGeometry(
      partSpec({
        name: 'bar',
        description: 'rotated box',
        localExtents: extents,
        position,
        rotation,
        shape: { kind: 'box' },
      })
    );
    expectPlacedBox(geo, extents, position, rotation);
    expect(geo.bounds!.min[2]).toBeGreaterThanOrEqual(-0.01);
  });

  it('draws an invalid profile as a box and records why', () => {
    const extents: Vec3 = [20, 10, 5];
    const geo = specGeometry(
      partSpec({
        name: 'bow',
        description: 'self-intersecting outline',
        localExtents: extents,
        position: [3, 0, 0],
        shape: {
          kind: 'profile',
          plane: 'xy',
          points: [
            [0, 0],
            [20, 10],
            [0, 10],
            [20, 0],
          ],
        },
      })
    );
    expect(geo.skipped).toHaveLength(1);
    expect(geo.skipped[0].name).toBe('bow');
    expect(geo.skipped[0].reason).toMatch(/not simple/);
    expect(geo.parts).toHaveLength(1);
    expect(isClosed(geo.tris)).toBe(true);
    expectPlacedBox(geo, extents, [3, 0, 0]);
  });

  it('marks a through hole with discs on both faces and a blind hole on the entry face', () => {
    const geo = specGeometry(
      partSpec({
        name: 'block',
        description: 'box with holes',
        localExtents: [40, 20, 10],
        holes: [
          { d: 4, axis: 'z', at: [10, 10, 0] },
          { d: 4, axis: 'z', at: [30, 10, 10], depth: 4 },
        ],
      })
    );
    const discs = geo.tris.filter(
      (t) =>
        t.color[0] === HOLE_DISC_COLOR[0] &&
        t.color[1] === HOLE_DISC_COLOR[1] &&
        t.color[2] === HOLE_DISC_COLOR[2]
    );
    const zs = new Set(discs.map((t) => t.a[2].toFixed(2)));
    expect(zs.has('-0.05')).toBe(true);
    expect(zs.has('10.05')).toBe(true);
    // Blind hole enters at z = 10 and bores toward -z, so its disc sits just outside that face.
    expect(discs.some((t) => Math.abs(t.a[0] - 30) < 1e-6 && Math.abs(t.a[2] - 10.05) < 1e-6)).toBe(true);
    expect(discs.some((t) => Math.abs(t.a[0] - 30) < 1e-6 && Math.abs(t.a[2] + 0.05) < 1e-6)).toBe(false);
    expect(geo.bounds!.min[2]).toBeGreaterThanOrEqual(-0.01);
    expect(geo.bounds!.max[2]).toBeLessThanOrEqual(10.01);
  });
});

describe('guideGeometry', () => {
  it('returns the envelope edges and the line polyline for the fixture', () => {
    const guides = guideGeometry(fixtureSpec());
    expect(guides.map((g) => g.label)).toEqual(['keep_out', 'ridge']);
    expect(guides[0].polylines).toHaveLength(12);
    expect(guides[0].polylines.every((line) => line.length === 2)).toBe(true);
    expect(guides[1].polylines).toEqual([
      [
        [0, 0, 42],
        [80, 0, 42],
        [80, 50, 42],
      ],
    ]);
  });

  it('draws a profile envelope at both ends, including its hole', () => {
    const spec = partSpec({
      name: 'panel',
      description: 'ignored',
      localExtents: [10, 8, 4],
    });
    spec.guides = [
      {
        label: 'window',
        kind: 'envelope',
        localExtents: [10, 8, 4],
        position: [1, 2, 0],
        shape: {
          kind: 'profile',
          plane: 'xy',
          points: [[0, 0], [10, 0], [10, 8], [0, 8]],
          holes: [[[2, 2], [6, 2], [6, 6], [2, 6]]],
        },
      },
    ];
    const [guide] = guideGeometry(spec);
    expect(guide.label).toBe('window');
    const closed = guide.polylines.filter((line) => line.length > 2);
    const connectors = guide.polylines.filter((line) => line.length === 2);
    expect(closed).toHaveLength(4);
    expect(connectors).toHaveLength(8);
    expect(closed[0][0][0]).toBeCloseTo(1);
    expect(closed[0][0][1]).toBeCloseTo(2);
  });

  it('draws a round envelope as 16-segment end loops', () => {
    const guides = guideGeometry({
      ...fixtureSpec(),
      guides: [
        {
          label: 'pin_zone',
          kind: 'envelope',
          shape: { kind: 'cylinder', axis: 'z' },
          localExtents: [10, 10, 20],
          position: [1, 2, 0],
          rotation: [0, 0, 0],
        },
      ],
    });
    expect(guides).toHaveLength(1);
    const loops = guides[0].polylines.filter((line) => line.length === 17);
    expect(loops).toHaveLength(2);
    expect(loops[0][0]).toEqual(loops[0][16]);
  });
});
