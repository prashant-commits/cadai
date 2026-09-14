/**
 * Pure geometry for spec-driven placement: the same transform order OpenSCAD
 * applies to `translate(position) rotate(rotation) translate(correction) part();`.
 */

export type Vec3 = [number, number, number];
export interface Bounds { min: Vec3; max: Vec3 }

/** Below this many mm a coordinate is treated as zero (tessellation noise). */
export const FRAME_EPS = 0.05;

export function isZeroVec(v: Vec3, eps: number = FRAME_EPS): boolean {
  return v.every((n) => Math.abs(n) <= eps);
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const clean = (n: number) => (Math.abs(n) < 1e-9 ? 0 : n);

/**
 * OpenSCAD's rotate([a, b, c]) rotates about X by a, then Y by b, then Z by c
 * (right-hand rule). Written out per axis so the sign conventions are visible.
 */
export function rotatePoint(p: Vec3, degrees: Vec3): Vec3 {
  let [x, y, z] = p;
  {
    const c = Math.cos(rad(degrees[0])), s = Math.sin(rad(degrees[0]));
    const y2 = y * c - z * s, z2 = y * s + z * c;
    y = y2; z = z2;
  }
  {
    const c = Math.cos(rad(degrees[1])), s = Math.sin(rad(degrees[1]));
    const x2 = x * c + z * s, z2 = -x * s + z * c;
    x = x2; z = z2;
  }
  {
    const c = Math.cos(rad(degrees[2])), s = Math.sin(rad(degrees[2]));
    const x2 = x * c - y * s, y2 = x * s + y * c;
    x = x2; y = y2;
  }
  return [clean(x), clean(y), clean(z)];
}

/** Axis-aligned bounds of a local box after correction, rotation and translation. */
export function placedBounds(
  local: Bounds,
  position: Vec3,
  rotation: Vec3,
  correction: Vec3 = [0, 0, 0]
): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const cx of [local.min[0], local.max[0]])
    for (const cy of [local.min[1], local.max[1]])
      for (const cz of [local.min[2], local.max[2]]) {
        const corrected: Vec3 = [cx + correction[0], cy + correction[1], cz + correction[2]];
        const r = rotatePoint(corrected, rotation);
        for (let i = 0; i < 3; i++) {
          const v = r[i] + position[i];
          if (v < min[i]) min[i] = v;
          if (v > max[i]) max[i] = v;
        }
      }
  return { min: min.map(clean) as Vec3, max: max.map(clean) as Vec3 };
}
