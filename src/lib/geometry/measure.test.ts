import { describe, it, expect } from 'vitest';
import type { Topology } from './topology';
import {
  measure,
  snapToVertex,
  nearestEdge,
  formatMm,
  PICK_ROUND_FACE,
  MEASURE_NOTHING,
  type Vec3,
} from './measure';

describe('measure', () => {
  it('measuring a Ø10 hole reads Ø 10.00', () => {
    // Build a coarse polygon mesh (hexagon of radius 4.9)
    // with a cylinder face of exact radius 5
    const angles = [0, 1, 2, 3, 4, 5].map((i) => (i * Math.PI) / 3);
    const rCoarse = 4.9;
    const positionsArr: number[] = [];
    // Bottom ring z=0 (indices 0..5), Top ring z=10 (indices 6..11)
    for (const a of angles) {
      positionsArr.push(rCoarse * Math.cos(a), rCoarse * Math.sin(a), 0);
    }
    for (const a of angles) {
      positionsArr.push(rCoarse * Math.cos(a), rCoarse * Math.sin(a), 10);
    }

    const indicesArr: number[] = [];
    const faceIdsArr: number[] = [];
    for (let i = 0; i < 6; i++) {
      const next = (i + 1) % 6;
      // Quad split into 2 triangles
      indicesArr.push(i, next, i + 6);
      faceIdsArr.push(1);
      indicesArr.push(next, next + 6, i + 6);
      faceIdsArr.push(1);
    }

    const topo: Topology = {
      mesh: {
        positions: new Float32Array(positionsArr),
        indices: new Uint32Array(indicesArr),
        faceIds: new Uint32Array(faceIdsArr),
      },
      faces: [
        {
          id: 1,
          part: 'body',
          kind: 'cylinder',
          area: 2 * Math.PI * 5 * 10,
          center: [0, 0, 5],
          axis: [0, 0, 1],
          radius: 5,
        },
      ],
      edges: [
        {
          id: 1,
          kind: 'circle',
          length: 2 * Math.PI * 5,
          radius: 5,
          center: [0, 0, 10],
          faces: [1, 1],
        },
      ],
      parts: [
        {
          label: 'body',
          min: [-5, -5, 0],
          max: [5, 5, 10],
        },
      ],
    };

    const faceRes = measure(topo, { kind: 'face', faceId: 1 });
    expect(faceRes.ok).toBe(true);
    if (faceRes.ok) {
      expect(faceRes.label).toBe('Ø 10.00');
      expect(faceRes.value).toBe(10);
      expect(faceRes.kind).toBe('diameter');
    }

    const edgeRes = measure(topo, { kind: 'edge', edgeId: 1 });
    expect(edgeRes.ok).toBe(true);
    if (edgeRes.ok) {
      expect(edgeRes.label).toBe('Ø 10.00');
      expect(edgeRes.value).toBe(10);
      expect(edgeRes.kind).toBe('diameter');
    }
  });

  it('the point-to-point distance on a 20 mm cube edge reads 20.00', () => {
    // 20 mm cube corners:
    // v0: [0, 0, 20], v1: [20, 0, 20], v2: [0, 20, 20], v3: [20, 20, 20]
    // v4: [0, 0, 0],  v5: [20, 0, 0],  v6: [0, 20, 0],  v7: [20, 20, 0]
    const positions = new Float32Array([
      0, 0, 20,   // 0
      20, 0, 20,  // 1
      0, 20, 20,  // 2
      20, 20, 20, // 3
      0, 0, 0,    // 4
      20, 0, 0,   // 5
      0, 20, 0,   // 6
      20, 20, 0,  // 7
    ]);

    // Triangle indices and faceIds
    // Top face (faceId 0, z=20):
    // Tri 0: 0, 1, 2
    // Tri 1: 1, 3, 2
    // Front face (faceId 1, y=0):
    // Tri 2: 0, 4, 5
    // Tri 3: 0, 5, 1
    // Other faces ...
    const indices = new Uint32Array([
      0, 1, 2, // Top 0
      1, 3, 2, // Top 1
      0, 4, 5, // Front 0
      0, 5, 1, // Front 1
      2, 3, 7, // Back 0
      2, 7, 6, // Back 1
      4, 6, 7, // Bottom 0
      4, 7, 5, // Bottom 1
      0, 2, 6, // Left 0
      0, 6, 4, // Left 1
      1, 5, 7, // Right 0
      1, 7, 3, // Right 1
    ]);

    const faceIds = new Uint32Array([
      0, 0, // Top
      1, 1, // Front
      2, 2, // Back
      3, 3, // Bottom
      4, 4, // Left
      5, 5, // Right
    ]);

    const edges = [
      { id: 0, kind: 'line' as const, length: 20, faces: [0, 1] as [number, number] }, // Top-front (v0-v1)
      { id: 1, kind: 'line' as const, length: 20, faces: [0, 5] as [number, number] }, // Top-right (v1-v3)
      { id: 2, kind: 'line' as const, length: 20, faces: [0, 2] as [number, number] }, // Top-back (v2-v3)
      { id: 3, kind: 'line' as const, length: 20, faces: [0, 4] as [number, number] }, // Top-left (v0-v2)
      { id: 4, kind: 'line' as const, length: 20, faces: [1, 3] as [number, number] }, // Bottom-front
      { id: 5, kind: 'line' as const, length: 20, faces: [5, 3] as [number, number] }, // Bottom-right
      { id: 6, kind: 'line' as const, length: 20, faces: [2, 3] as [number, number] }, // Bottom-back
      { id: 7, kind: 'line' as const, length: 20, faces: [4, 3] as [number, number] }, // Bottom-left
      { id: 8, kind: 'line' as const, length: 20, faces: [4, 1] as [number, number] }, // Front-left
      { id: 9, kind: 'line' as const, length: 20, faces: [1, 5] as [number, number] }, // Front-right
      { id: 10, kind: 'line' as const, length: 20, faces: [2, 4] as [number, number] }, // Back-left
      { id: 11, kind: 'line' as const, length: 20, faces: [2, 5] as [number, number] }, // Back-right
    ];

    const topo: Topology = {
      mesh: { positions, indices, faceIds },
      faces: [
        { id: 0, part: 'cube', kind: 'plane', area: 400, center: [10, 10, 20], normal: [0, 0, 1] },
        { id: 1, part: 'cube', kind: 'plane', area: 400, center: [10, 0, 10], normal: [0, -1, 0] },
        { id: 2, part: 'cube', kind: 'plane', area: 400, center: [10, 20, 10], normal: [0, 1, 0] },
        { id: 3, part: 'cube', kind: 'plane', area: 400, center: [10, 10, 0], normal: [0, 0, -1] },
        { id: 4, part: 'cube', kind: 'plane', area: 400, center: [0, 10, 10], normal: [-1, 0, 0] },
        { id: 5, part: 'cube', kind: 'plane', area: 400, center: [20, 10, 10], normal: [1, 0, 0] },
      ],
      edges,
      parts: [{ label: 'cube', min: [0, 0, 0], max: [20, 20, 20] }],
    };

    // Click points slightly off two adjacent corners on top-front edge:
    // Corner 0 is [0, 0, 20], Corner 1 is [20, 0, 20]. Both are on triangle 0.
    const p1: Vec3 = [0.3, 0.2, 19.8];
    const p2: Vec3 = [19.7, 0.1, 20.1];

    const snapped1 = snapToVertex(topo, 0, p1, 1.0);
    const snapped2 = snapToVertex(topo, 0, p2, 1.0);

    expect(snapped1).toEqual([0, 0, 20]);
    expect(snapped2).toEqual([20, 0, 20]);

    const res = measure(topo, { kind: 'points', a: snapped1, b: snapped2 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.label).toBe('20.00 mm');
      expect(res.value).toBeCloseTo(20, 2);
      expect(res.kind).toBe('distance');
    }

    // Edge pick of line edge
    const edgeRes = measure(topo, { kind: 'edge', edgeId: 0 });
    expect(edgeRes.ok).toBe(true);
    if (edgeRes.ok) {
      expect(edgeRes.label).toBe('20.00 mm');
      expect(edgeRes.value).toBe(20);
      expect(edgeRes.kind).toBe('length');
    }

    // nearestEdge for a point near the front edge on top face (face 0)
    const nEdge = nearestEdge(topo, 0, [10, 0.5, 20]);
    expect(nEdge).toBe(0);
  });

  it('a flat face is not a diameter', () => {
    const topo: Topology = {
      mesh: {
        positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
        indices: new Uint32Array([0, 1, 2]),
        faceIds: new Uint32Array([0]),
      },
      faces: [
        { id: 0, part: 'p', kind: 'plane', area: 50, center: [3.33, 3.33, 0], normal: [0, 0, 1] },
      ],
      edges: [],
      parts: [],
    };

    const res = measure(topo, { kind: 'face', faceId: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(PICK_ROUND_FACE);
    }
  });

  it('unknown face or edge returns MEASURE_NOTHING', () => {
    const topo: Topology = {
      mesh: {
        positions: new Float32Array([]),
        indices: new Uint32Array([]),
        faceIds: new Uint32Array([]),
      },
      faces: [],
      edges: [],
      parts: [],
    };

    expect(measure(topo, { kind: 'face', faceId: 99 })).toEqual({
      ok: false,
      error: MEASURE_NOTHING,
    });
    expect(measure(topo, { kind: 'edge', edgeId: 99 })).toEqual({
      ok: false,
      error: MEASURE_NOTHING,
    });
  });

  it('formatMm formats to 2 decimal places and avoids -0.00', () => {
    expect(formatMm(20)).toBe('20.00');
    expect(formatMm(10.5)).toBe('10.50');
    expect(formatMm(-0.0001)).toBe('0.00');
    expect(formatMm(0)).toBe('0.00');
  });
});
