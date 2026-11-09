import type { Topology } from './topology';

export type Vec3 = [number, number, number];

export type MeasurePick =
  | { kind: 'points'; a: Vec3; b: Vec3 }
  | { kind: 'edge'; edgeId: number }
  | { kind: 'face'; faceId: number };

export type MeasureResult =
  | { ok: true; value: number; label: string; kind: 'distance' | 'length' | 'diameter' }
  | { ok: false; error: string };

export const MEASURE_PICK_POINTS = 'Click two points on the model.';
export const MEASURE_PICK_EDGE = 'Click near an edge.';
export const MEASURE_PICK_FACE = 'Click a round face or hole.';
export const PICK_ROUND_FACE = 'Pick a round face or hole.';
export const MEASURE_NOTHING = 'Nothing to measure there.';

export function formatMm(n: number): string {
  const s = n.toFixed(2);
  return s === '-0.00' || s === '-0' ? '0.00' : s;
}

export function measure(topo: Topology, pick: MeasurePick): MeasureResult {
  if (pick.kind === 'face') {
    const face = topo.faces.find((f) => f.id === pick.faceId);
    if (!face) {
      return { ok: false, error: MEASURE_NOTHING };
    }
    if (face.kind === 'cylinder' && typeof face.radius === 'number' && Number.isFinite(face.radius)) {
      const value = 2 * face.radius;
      return {
        ok: true,
        value,
        label: `Ø ${formatMm(value)}`,
        kind: 'diameter',
      };
    }
    return { ok: false, error: PICK_ROUND_FACE };
  }

  if (pick.kind === 'edge') {
    const edge = topo.edges.find((e) => e.id === pick.edgeId);
    if (!edge) {
      return { ok: false, error: MEASURE_NOTHING };
    }
    if (edge.kind === 'circle' && typeof edge.radius === 'number' && Number.isFinite(edge.radius)) {
      const value = 2 * edge.radius;
      return {
        ok: true,
        value,
        label: `Ø ${formatMm(value)}`,
        kind: 'diameter',
      };
    }
    const value = edge.length;
    return {
      ok: true,
      value,
      label: `${formatMm(value)} mm`,
      kind: 'length',
    };
  }

  if (pick.kind === 'points') {
    const dx = pick.a[0] - pick.b[0];
    const dy = pick.a[1] - pick.b[1];
    const dz = pick.a[2] - pick.b[2];
    const d = Math.hypot(dx, dy, dz);
    return {
      ok: true,
      value: d,
      label: `${formatMm(d)} mm`,
      kind: 'distance',
    };
  }

  return { ok: false, error: MEASURE_NOTHING };
}

export function snapToVertex(topo: Topology, triIndex: number, point: Vec3, tolMm: number): Vec3 {
  if (triIndex < 0 || triIndex * 3 + 2 >= topo.mesh.indices.length) {
    return point;
  }

  const i0 = topo.mesh.indices[triIndex * 3];
  const i1 = topo.mesh.indices[triIndex * 3 + 1];
  const i2 = topo.mesh.indices[triIndex * 3 + 2];

  const pos = topo.mesh.positions;
  const c0: Vec3 = [pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]];
  const c1: Vec3 = [pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]];
  const c2: Vec3 = [pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]];

  const d0 = Math.hypot(point[0] - c0[0], point[1] - c0[1], point[2] - c0[2]);
  const d1 = Math.hypot(point[0] - c1[0], point[1] - c1[1], point[2] - c1[2]);
  const d2 = Math.hypot(point[0] - c2[0], point[1] - c2[1], point[2] - c2[2]);

  let bestCorner = c0;
  let minDist = d0;

  if (d1 < minDist) {
    minDist = d1;
    bestCorner = c1;
  }
  if (d2 < minDist) {
    minDist = d2;
    bestCorner = c2;
  }

  if (minDist <= tolMm) {
    return bestCorner;
  }

  return point;
}

export function nearestEdge(topo: Topology, faceId: number, point: Vec3): number | null {
  const candidateEdges = topo.edges.filter(
    (e) => e.faces[0] === faceId || e.faces[1] === faceId
  );

  if (candidateEdges.length === 0) {
    return null;
  }

  let bestEdgeId: number | null = null;
  let minEdgeDist = Infinity;

  const { positions, indices, faceIds } = topo.mesh;
  const numTris = faceIds.length;

  for (const edge of candidateEdges) {
    let dist = Infinity;

    if (edge.kind === 'circle' && edge.center && typeof edge.radius === 'number') {
      const distToCenter = Math.hypot(
        point[0] - edge.center[0],
        point[1] - edge.center[1],
        point[2] - edge.center[2]
      );
      dist = Math.abs(distToCenter - edge.radius);
    } else {
      // Find the "other" face of the edge (or same face for seam [a, a])
      const otherFaceId =
        edge.faces[0] === faceId && edge.faces[1] !== faceId
          ? edge.faces[1]
          : edge.faces[1] === faceId && edge.faces[0] !== faceId
            ? edge.faces[0]
            : faceId;

      let nearestVertexDist = Infinity;

      for (let t = 0; t < numTris; t++) {
        if (faceIds[t] === otherFaceId) {
          for (let c = 0; c < 3; c++) {
            const vIdx = indices[t * 3 + c];
            const vx = positions[vIdx * 3];
            const vy = positions[vIdx * 3 + 1];
            const vz = positions[vIdx * 3 + 2];
            const d = Math.hypot(point[0] - vx, point[1] - vy, point[2] - vz);
            if (d < nearestVertexDist) {
              nearestVertexDist = d;
            }
          }
        }
      }

      dist = nearestVertexDist;
    }

    if (dist < minEdgeDist) {
      minEdgeDist = dist;
      bestEdgeId = edge.id;
    }
  }

  return bestEdgeId;
}
