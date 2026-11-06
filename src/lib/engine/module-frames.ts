import { compileScad } from './scad-compiler';
import { stripTopLevelGeometry } from '../design/compose-assembly';
import type { Vec3 } from '../design/placement-geometry';

export interface ModuleFrame {
  name: string;
  /** False when the module compiled to nothing (empty, 2D, or errored). */
  valid: boolean;
  min: Vec3;
  max: Vec3;
  size: Vec3;
  error?: string;
  /**
   * Connected pieces of this module's mesh with positive signed volume.
   * A sealed void is `cavityCount`, not another piece.
   */
  shellCount?: number;
  /** Connected pieces with negative signed volume: sealed voids. */
  cavityCount?: number;
}

const ZERO: Vec3 = [0, 0, 0];

/**
 * Compiles each named module ALONE and reads OpenSCAD's own bounding box for
 * it. This is what makes the "origin at the min corner" contract measurable
 * instead of hoped for: the min corner is the correction the composer applies,
 * and the size is what the extents audit compares to the spec.
 *
 * One wasm compile per module (about a second each), run sequentially so a
 * ten-part assembly does not spawn ten wasm instances at once.
 */
export async function measureModuleFrames(code: string, moduleNames: string[]): Promise<ModuleFrame[]> {
  if (moduleNames.length === 0) return [];
  const modules = stripTopLevelGeometry(code).code;
  const frames: ModuleFrame[] = [];

  for (const name of moduleNames) {
    const result = await compileScad(`${modules}\n${name}();\n`);
    const bb = result.summary?.boundingBox;
    const usable =
      result.valid && !!bb && [...bb.min, ...bb.max].every((n) => Number.isFinite(n));
    if (!usable || !bb) {
      // A failed compile is not a measurement, even if a partial summary named volumes.
      frames.push({
        name,
        valid: false,
        min: ZERO,
        max: ZERO,
        size: ZERO,
        error: result.error ?? 'module produced no measurable 3D geometry',
      });
      continue;
    }
    const round = (n: number) => Math.round(n * 1000) / 1000;
    frames.push({
      name,
      valid: true,
      min: bb.min.map(round) as Vec3,
      max: bb.max.map(round) as Vec3,
      size: bb.size.map(round) as Vec3,
      ...pieceFields(result.stl),
    });
  }
  return frames;
}

/**
 * Connected components of an ASCII STL, split by signed volume.
 * Positive volume is a solid piece. Negative volume is a void. CGAL's
 * `volumes` counts both, so a sealed tray must not be reported as two pieces.
 */
export function meshPieceCounts(stl: string): { positive: number; negative: number } {
  const verts = [...stl.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => [+m[1], +m[2], +m[3]]);
  if (verts.length < 3) return { positive: 0, negative: 0 };
  const key = (v: number[]) => v.map((n) => n.toFixed(4)).join(',');
  const id = new Map<string, number>();
  const parent: number[] = [];
  // Iterative path halving. A recursive find overflows on a long facet strip.
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const tris: number[][] = [];
  for (let i = 0; i + 2 < verts.length; i += 3) {
    const tri = [verts[i], verts[i + 1], verts[i + 2]].map((v) => {
      const k = key(v);
      let n = id.get(k);
      if (n === undefined) {
        n = parent.length;
        id.set(k, n);
        parent.push(n);
      }
      return n;
    });
    parent[find(tri[1])] = find(tri[0]);
    parent[find(tri[2])] = find(tri[0]);
    tris.push([i, i + 1, i + 2, tri[0]]);
  }
  const vol = new Map<number, number>();
  for (const [a, b, c, v] of tris) {
    const [p, q, r] = [verts[a], verts[b], verts[c]];
    const signed = (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    const root = find(v);
    vol.set(root, (vol.get(root) ?? 0) + signed);
  }
  let positive = 0;
  let negative = 0;
  for (const n of vol.values()) {
    const rounded = Math.round(n);
    if (rounded > 0) positive++;
    else if (rounded < 0) negative++;
  }
  return { positive, negative };
}

function pieceFields(stl: string | undefined): { shellCount?: number; cavityCount?: number } {
  if (!stl) return {};
  const { positive, negative } = meshPieceCounts(stl);
  return {
    ...(positive > 0 ? { shellCount: positive } : {}),
    ...(negative > 0 ? { cavityCount: negative } : {}),
  };
}
