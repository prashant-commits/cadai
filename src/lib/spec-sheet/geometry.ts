import { ShapeUtils, Vector2 } from 'three';
import type { AssemblySpec, BedFace } from '../agent/assembly-spec';
import { isSimplePolygon, pointInPolygon } from '../agent/spec-shape-audit';
import { rotatePoint } from '../design/placement-geometry';
import type { ColoredTriangle, RGB, Vec3 } from '../engine/stl-renderer';

/**
 * Turns an assembly spec into coloured triangles and dashed guide lines.
 *
 * Local frames put the min corner at the origin and size the part by
 * `localExtents`. Every vertex is then `rotatePoint` + `position`, the same
 * order `composeAssembly` emits (`translate(position) rotate(rotation) module()`).
 */

export const PART_PALETTE: RGB[] = [
  [196, 78, 68],
  [46, 116, 186],
  [42, 148, 96],
  [204, 138, 42],
  [132, 84, 176],
  [36, 152, 164],
  [184, 86, 132],
  [118, 128, 48],
  [72, 96, 168],
];

/** Dark disc drawn on a hole mouth so the opening reads on a light sheet. */
export const HOLE_DISC_COLOR: RGB = [35, 35, 40];

export interface SheetGeometry {
  tris: ColoredTriangle[];
  /** Legend entries, in component order, for every part that was drawn. */
  parts: { name: string; color: RGB }[];
  /** Parts that could not be drawn as specified. The stand-in is still in `tris`. */
  skipped: { name: string; reason: string }[];
  /** World bbox of the drawn triangles. Null when nothing was drawn. */
  bounds: { min: Vec3; max: Vec3 } | null;
}

export interface GuideLines {
  label: string;
  polylines: Vec3[][];
}

type Component = NonNullable<AssemblySpec['components']>[number];
type Axis = 'x' | 'y' | 'z';
type Plane = 'xy' | 'xz' | 'yz';
type Pt2 = [number, number];

/** Curve resolution for cylinders and tubes. Divisible by 4 so the bbox hits the extents. */
const CURVE_SEGMENTS = 48;
const DISC_SEGMENTS = 24;
const GUIDE_SEGMENTS = 16;
/** Lift a hole disc off its face, outward, so it sits in front of the surface and wins the z-buffer. */
const HOLE_LIFT_MM = 0.05;

const BOX_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export type DrawClass =
  | { kind: 'shape' }
  | { kind: 'box'; reason: string }
  | { kind: 'omit'; reason: string };

export function classifyComponent(comp: Component): DrawClass {
  const ext = asVec3(comp.localExtents);
  if (!ext) return { kind: 'omit', reason: 'missing localExtents' };
  const [ex, ey, ez] = ext;
  if (!(ex > 0) || !(ey > 0) || !(ez > 0)) {
    return { kind: 'omit', reason: 'localExtents must be positive' };
  }
  const issue = shapeIssue(comp.shape, ex, ey, ez);
  if (issue) return { kind: 'box', reason: issue };
  return { kind: 'shape' };
}

export function specGeometry(spec: AssemblySpec): SheetGeometry {
  const tris: ColoredTriangle[] = [];
  const parts: SheetGeometry['parts'] = [];
  const skipped: SheetGeometry['skipped'] = [];
  let colorIndex = 0;

  for (const comp of spec.components ?? []) {
    const decision = classifyComponent(comp);
    if (decision.kind === 'omit') {
      skipped.push({ name: comp.name, reason: decision.reason });
      continue;
    }
    const ext = asVec3(comp.localExtents)!;
    const color = PART_PALETTE[colorIndex % PART_PALETTE.length];
    colorIndex += 1;
    parts.push({ name: comp.name, color });
    if (decision.kind === 'box') {
      skipped.push({ name: comp.name, reason: `${decision.reason}; drawn as a box` });
    }

    const local =
      decision.kind === 'shape' ? shapeTriangles(comp, ext, color) : boxBetween([0, 0, 0], ext, color);
    const drawn = local ?? boxBetween([0, 0, 0], ext, color);
    if (!local && decision.kind === 'shape') {
      skipped.push({ name: comp.name, reason: 'profile could not be triangulated; drawn as a box' });
    }
    const rotation = asVec3(comp.rotation) ?? [0, 0, 0];
    const position = asVec3(comp.position) ?? [0, 0, 0];
    for (const tri of [...drawn, ...holeDiscs(comp, ext)]) {
      tris.push({
        a: place(tri.a, rotation, position),
        b: place(tri.b, rotation, position),
        c: place(tri.c, rotation, position),
        color: tri.color,
      });
    }
  }

  return { tris, parts, skipped, bounds: boundsOf(tris.filter((t) => t.color !== HOLE_DISC_COLOR)) };
}

export function guideGeometry(spec: AssemblySpec): GuideLines[] {
  const out: GuideLines[] = [];
  for (const guide of spec.guides ?? []) {
    if (guide.kind === 'line') {
      const points = (guide.points ?? [])
        .map(asVec3)
        .filter((p): p is Vec3 => p !== null);
      if (points.length < 2) continue;
      out.push({ label: guide.label, polylines: [points] });
      continue;
    }
    const ext = asVec3(guide.localExtents);
    if (!ext || !(ext[0] > 0) || !(ext[1] > 0) || !(ext[2] > 0)) continue;
    const rotation = asVec3(guide.rotation) ?? [0, 0, 0];
    const position = asVec3(guide.position) ?? [0, 0, 0];
    const local = envelopePolylines(guide.shape, ext);
    out.push({
      label: guide.label,
      polylines: local.map((line) => line.map((p) => place(p, rotation, position))),
    });
  }
  return out;
}

function shapeIssue(
  shape: Component['shape'],
  ex: number,
  ey: number,
  ez: number
): string | null {
  if (!shape || shape.kind === 'box') return null;
  if (shape.kind === 'cylinder' || shape.kind === 'tube') {
    if (!shape.axis) return `${shape.kind} is missing axis`;
    const [e1, e2] = crossExtents(shape.axis, ex, ey, ez);
    if (Math.abs(e1 - e2) > 0.5) {
      return `${shape.kind} cross-section extents differ by more than 0.5 mm`;
    }
    if (shape.kind === 'tube') {
      const inner = shape.innerD;
      if (inner === undefined || !(inner > 0) || inner >= Math.min(e1, e2)) {
        return 'tube innerD is missing or does not fit the cross-section';
      }
    }
    return null;
  }
  if (shape.kind === 'shell') {
    if (!shape.openFace || shape.wall === undefined) return 'shell is missing openFace or wall';
    if (!(shape.wall > 0)) return 'shell wall must be positive';
    const wall2 = 2 * shape.wall;
    if (wall2 >= ex || wall2 >= ey || wall2 >= ez) return 'shell wall is too thick for the extents';
    return null;
  }
  if (shape.kind === 'profile') {
    if (!shape.plane) return 'profile is missing plane';
    const points = asLoop(shape.points);
    if (!points) return 'profile has fewer than 3 points';
    if (!isSimplePolygon(points)) return 'profile polygon is not simple';
    if (Math.abs(signedArea(points)) < 1e-6) return 'profile outline has no area';
    for (let i = 0; i < (shape.holes ?? []).length; i++) {
      const hole = asLoop(shape.holes?.[i]);
      if (!hole) return `profile hole ${i + 1} has fewer than 3 points`;
      if (!isSimplePolygon(hole)) return `profile hole ${i + 1} is not a simple polygon`;
      if (hole.some((p) => !pointInPolygon(p, points))) {
        return `profile hole ${i + 1} is not inside the outline`;
      }
    }
    return null;
  }
  return `unknown shape kind`;
}

function shapeTriangles(comp: Component, ext: Vec3, color: RGB): ColoredTriangle[] | null {
  const shape = comp.shape;
  const [ex, ey, ez] = ext;
  if (!shape || shape.kind === 'box') return boxBetween([0, 0, 0], ext, color);
  if (shape.kind === 'cylinder' && shape.axis) {
    return cylinderMesh(ex, ey, ez, shape.axis, 1, color);
  }
  if (shape.kind === 'tube' && shape.axis && shape.innerD !== undefined) {
    return tubeMesh(ex, ey, ez, shape.axis, shape.innerD, color);
  }
  if (shape.kind === 'shell' && shape.openFace && shape.wall !== undefined) {
    return shellMesh(ex, ey, ez, shape.wall, shape.openFace, color);
  }
  if (shape.kind === 'profile' && shape.plane && shape.points) {
    return profileMesh(shape.plane, shape.points, shape.holes ?? [], ex, ey, ez, color);
  }
  return null;
}

function boxBetween(origin: Vec3, size: Vec3, color: RGB): ColoredTriangle[] {
  const p = (x: number, y: number, z: number): Vec3 => [
    origin[0] + x,
    origin[1] + y,
    origin[2] + z,
  ];
  const [sx, sy, sz] = size;
  const c = [
    p(0, 0, 0), p(sx, 0, 0), p(sx, sy, 0), p(0, sy, 0),
    p(0, 0, sz), p(sx, 0, sz), p(sx, sy, sz), p(0, sy, sz),
  ];
  const faces: [number, number, number, number][] = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 1, 5, 4], // -Y
    [3, 7, 6, 2], // +Y
    [0, 4, 7, 3], // -X
    [1, 2, 6, 5], // +X
  ];
  const tris: ColoredTriangle[] = [];
  for (const [a, b, d, e] of faces) tris.push(...quad(c[a], c[b], c[d], c[e], color));
  return tris;
}

function cylinderMesh(
  ex: number,
  ey: number,
  ez: number,
  axis: Axis,
  radiusScale: number,
  color: RGB
): ColoredTriangle[] {
  const extent = axisExtent(axis, ex, ey, ez);
  const bottom = ring(axis, ex, ey, ez, 0, radiusScale, CURVE_SEGMENTS);
  const top = ring(axis, ex, ey, ez, extent, radiusScale, CURVE_SEGMENTS);
  const tris: ColoredTriangle[] = [];
  const botC = ringCenter(axis, ex, ey, ez, 0);
  const topC = ringCenter(axis, ex, ey, ez, extent);
  for (let i = 0; i < CURVE_SEGMENTS; i++) {
    const j = (i + 1) % CURVE_SEGMENTS;
    tris.push(...quad(bottom[i], bottom[j], top[j], top[i], color));
    tris.push(tri(botC, bottom[j], bottom[i], color));
    tris.push(tri(topC, top[i], top[j], color));
  }
  return tris;
}

function tubeMesh(
  ex: number,
  ey: number,
  ez: number,
  axis: Axis,
  innerD: number,
  color: RGB
): ColoredTriangle[] {
  const [e1] = crossExtents(axis, ex, ey, ez);
  const innerScale = innerD / e1;
  const extent = axisExtent(axis, ex, ey, ez);
  const out0 = ring(axis, ex, ey, ez, 0, 1, CURVE_SEGMENTS);
  const out1 = ring(axis, ex, ey, ez, extent, 1, CURVE_SEGMENTS);
  const in0 = ring(axis, ex, ey, ez, 0, innerScale, CURVE_SEGMENTS);
  const in1 = ring(axis, ex, ey, ez, extent, innerScale, CURVE_SEGMENTS);
  const tris: ColoredTriangle[] = [];
  for (let i = 0; i < CURVE_SEGMENTS; i++) {
    const j = (i + 1) % CURVE_SEGMENTS;
    tris.push(...quad(out0[i], out0[j], out1[j], out1[i], color));
    tris.push(...quad(in0[i], in1[i], in1[j], in0[j], color));
    tris.push(...quad(out1[i], out1[j], in1[j], in1[i], color));
    tris.push(...quad(out0[i], in0[i], in0[j], out0[j], color));
  }
  return tris;
}

const FACE_LOOPS: Record<BedFace, [number, number, number, number]> = {
  '-Z': [0, 3, 2, 1],
  '+Z': [4, 5, 6, 7],
  '-Y': [0, 1, 5, 4],
  '+Y': [3, 7, 6, 2],
  '-X': [0, 4, 7, 3],
  '+X': [1, 2, 6, 5],
};

/**
 * A wall of thickness `wall` on every face except `openFace`.
 * Outer shell, inner cavity and the rim around the opening share edges,
 * so the wall is one closed mesh and the outer bbox stays the full extents.
 */
function shellMesh(
  ex: number,
  ey: number,
  ez: number,
  wall: number,
  openFace: BedFace,
  color: RGB
): ColoredTriangle[] {
  const outer = boxCorners([0, 0, 0], [ex, ey, ez]);
  const cavityMin: Vec3 = [wall, wall, wall];
  const cavityMax: Vec3 = [ex - wall, ey - wall, ez - wall];
  if (openFace === '-X') cavityMin[0] = 0;
  else if (openFace === '+X') cavityMax[0] = ex;
  else if (openFace === '-Y') cavityMin[1] = 0;
  else if (openFace === '+Y') cavityMax[1] = ey;
  else if (openFace === '-Z') cavityMin[2] = 0;
  else cavityMax[2] = ez;
  const inner = boxCorners(cavityMin, cavityMax);

  const tris: ColoredTriangle[] = [];
  const faces: BedFace[] = ['-X', '+X', '-Y', '+Y', '-Z', '+Z'];
  for (const face of faces) {
    const loop = FACE_LOOPS[face];
    if (face === openFace) {
      for (let k = 0; k < 4; k++) {
        const n = (k + 1) % 4;
        tris.push(...quad(outer[loop[k]], outer[loop[n]], inner[loop[n]], inner[loop[k]], color));
      }
      continue;
    }
    const [a, b, c, d] = loop;
    tris.push(...quad(outer[a], outer[b], outer[c], outer[d], color));
    tris.push(...quad(inner[a], inner[b], inner[c], inner[d], color));
  }
  return tris;
}

function boxCorners(min: Vec3, max: Vec3): Vec3[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
}

function profileMesh(
  plane: Plane,
  rawPoints: number[][],
  rawHoles: number[][][],
  ex: number,
  ey: number,
  ez: number,
  color: RGB
): ColoredTriangle[] | null {
  const outline = asLoop(rawPoints);
  if (!outline) return null;
  const holes = rawHoles.map(asLoop);
  if (holes.some((h) => !h)) return null;
  const outer = wind(outline, true);
  const inners = (holes as Pt2[][]).map((h) => wind(h, false));
  const contour = outer.map(([u, v]) => new Vector2(u, v));
  const holeVecs = inners.map((h) => h.map(([u, v]) => new Vector2(u, v)));
  const faces = ShapeUtils.triangulateShape(contour, holeVecs);
  if (faces.length === 0) return null;

  const flat: Pt2[] = [...outer, ...inners.flat()];
  const t1 = extrusionLength(plane, ex, ey, ez);
  const tris: ColoredTriangle[] = [];
  for (const face of faces) {
    const [i, j, k] = face;
    tris.push(oriented(flat[i], flat[j], flat[k], plane, t1, true, color));
    tris.push(oriented(flat[i], flat[j], flat[k], plane, 0, false, color));
  }
  addWalls(outer, plane, t1, color, tris);
  for (const hole of inners) addWalls(hole, plane, t1, color, tris);
  return tris;
}

function oriented(
  a: Pt2,
  b: Pt2,
  c: Pt2,
  plane: Plane,
  t: number,
  outwardPositive: boolean,
  color: RGB
): ColoredTriangle {
  const pa = mapProfile(plane, a[0], a[1], t);
  let pb = mapProfile(plane, b[0], b[1], t);
  let pc = mapProfile(plane, c[0], c[1], t);
  const n = cross(sub(pb, pa), sub(pc, pa));
  const along = plane === 'xy' ? n[2] : plane === 'xz' ? n[1] : n[0];
  const want = outwardPositive ? 1 : -1;
  if (along * want < 0) {
    const swap = pb;
    pb = pc;
    pc = swap;
  }
  return tri(pa, pb, pc, color);
}

function addWalls(loop: Pt2[], plane: Plane, t1: number, color: RGB, tris: ColoredTriangle[]) {
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    const a = mapProfile(plane, loop[i][0], loop[i][1], 0);
    const b = mapProfile(plane, loop[j][0], loop[j][1], 0);
    const c = mapProfile(plane, loop[j][0], loop[j][1], t1);
    const d = mapProfile(plane, loop[i][0], loop[i][1], t1);
    tris.push(...quad(a, b, c, d, color));
  }
}

function holeDiscs(comp: Component, ext: Vec3): ColoredTriangle[] {
  const tris: ColoredTriangle[] = [];
  for (const hole of comp.holes ?? []) {
    if (!(hole.d > 0) || !asVec3(hole.at)) continue;
    const at = asVec3(hole.at)!;
    const extent = axisExtent(hole.axis, ext[0], ext[1], ext[2]);
    const along = at[axisIndex(hole.axis)];
    const fromMin = Math.abs(along - 0) <= Math.abs(along - extent);
    // Outward, so the disc sits in front of the face and wins the z-buffer.
    const entry = fromMin ? -HOLE_LIFT_MM : extent + HOLE_LIFT_MM;
    tris.push(...disc(setAxis(at, hole.axis, entry), hole.axis, hole.d / 2));
    if (hole.depth === undefined) {
      const exit = fromMin ? extent + HOLE_LIFT_MM : -HOLE_LIFT_MM;
      tris.push(...disc(setAxis(at, hole.axis, exit), hole.axis, hole.d / 2));
    }
  }
  return tris;
}

function disc(center: Vec3, axis: Axis, radius: number): ColoredTriangle[] {
  const ringPts: Vec3[] = [];
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const a = (i / DISC_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(a) * radius;
    const s = Math.sin(a) * radius;
    if (axis === 'z') ringPts.push([center[0] + c, center[1] + s, center[2]]);
    else if (axis === 'y') ringPts.push([center[0] + c, center[1], center[2] + s]);
    else ringPts.push([center[0], center[1] + c, center[2] + s]);
  }
  const tris: ColoredTriangle[] = [];
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    tris.push(tri(center, ringPts[i], ringPts[(i + 1) % DISC_SEGMENTS], HOLE_DISC_COLOR));
  }
  return tris;
}

function envelopePolylines(shape: Component['shape'], ext: Vec3): Vec3[][] {
  const [ex, ey, ez] = ext;
  if (shape?.kind === 'cylinder' || shape?.kind === 'tube') {
    if (!shape.axis) return boxEdges(ext);
    return roundEnds(shape.axis, ex, ey, ez);
  }
  if (shape?.kind === 'profile' && shape.plane && asLoop(shape.points)) {
    return profileEnds(shape.plane, asLoop(shape.points)!, (shape.holes ?? []).map(asLoop).filter((h): h is Pt2[] => !!h), ex, ey, ez);
  }
  return boxEdges(ext);
}

function boxEdges(ext: Vec3): Vec3[][] {
  const [ex, ey, ez] = ext;
  const c: Vec3[] = [
    [0, 0, 0], [ex, 0, 0], [ex, ey, 0], [0, ey, 0],
    [0, 0, ez], [ex, 0, ez], [ex, ey, ez], [0, ey, ez],
  ];
  return BOX_EDGES.map(([a, b]) => [c[a], c[b]]);
}

function roundEnds(axis: Axis, ex: number, ey: number, ez: number): Vec3[][] {
  const extent = axisExtent(axis, ex, ey, ez);
  const a = circle(axis, ex, ey, ez, 0, GUIDE_SEGMENTS);
  const b = circle(axis, ex, ey, ez, extent, GUIDE_SEGMENTS);
  const lines: Vec3[][] = [closeLoop(a), closeLoop(b)];
  for (let i = 0; i < GUIDE_SEGMENTS; i += GUIDE_SEGMENTS / 4) {
    lines.push([a[i], b[i]]);
  }
  return lines;
}

function profileEnds(
  plane: Plane,
  outline: Pt2[],
  holes: Pt2[][],
  ex: number,
  ey: number,
  ez: number
): Vec3[][] {
  const t1 = extrusionLength(plane, ex, ey, ez);
  const lines: Vec3[][] = [];
  for (const loop of [outline, ...holes]) {
    const a = loop.map(([u, v]) => mapProfile(plane, u, v, 0));
    const b = loop.map(([u, v]) => mapProfile(plane, u, v, t1));
    lines.push(closeLoop(a), closeLoop(b));
    for (let i = 0; i < loop.length; i++) lines.push([a[i], b[i]]);
  }
  return lines;
}

function circle(axis: Axis, ex: number, ey: number, ez: number, along: number, segments: number): Vec3[] {
  return ring(axis, ex, ey, ez, along, 1, segments);
}

function ring(
  axis: Axis,
  ex: number,
  ey: number,
  ez: number,
  along: number,
  radiusScale: number,
  segments: number
): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    if (axis === 'z') {
      pts.push([ex / 2 + (ex / 2) * radiusScale * c, ey / 2 + (ey / 2) * radiusScale * s, along]);
    } else if (axis === 'y') {
      pts.push([ex / 2 + (ex / 2) * radiusScale * c, along, ez / 2 + (ez / 2) * radiusScale * s]);
    } else {
      pts.push([along, ey / 2 + (ey / 2) * radiusScale * c, ez / 2 + (ez / 2) * radiusScale * s]);
    }
  }
  return pts;
}

function ringCenter(axis: Axis, ex: number, ey: number, ez: number, along: number): Vec3 {
  if (axis === 'z') return [ex / 2, ey / 2, along];
  if (axis === 'y') return [ex / 2, along, ez / 2];
  return [along, ey / 2, ez / 2];
}

function mapProfile(plane: Plane, u: number, v: number, t: number): Vec3 {
  if (plane === 'xy') return [u, v, t];
  if (plane === 'xz') return [u, t, v];
  return [t, u, v];
}

function extrusionLength(plane: Plane, ex: number, ey: number, ez: number): number {
  if (plane === 'xy') return ez;
  if (plane === 'xz') return ey;
  return ex;
}

function place(p: Vec3, rotation: Vec3, position: Vec3): Vec3 {
  const r = rotatePoint(p, rotation);
  return [r[0] + position[0], r[1] + position[1], r[2] + position[2]];
}

function crossExtents(axis: Axis, ex: number, ey: number, ez: number): [number, number] {
  if (axis === 'x') return [ey, ez];
  if (axis === 'y') return [ex, ez];
  return [ex, ey];
}

function axisExtent(axis: Axis, ex: number, ey: number, ez: number): number {
  if (axis === 'x') return ex;
  if (axis === 'y') return ey;
  return ez;
}

function axisIndex(axis: Axis): 0 | 1 | 2 {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}

function setAxis(p: Vec3, axis: Axis, value: number): Vec3 {
  const out: Vec3 = [p[0], p[1], p[2]];
  out[axisIndex(axis)] = value;
  return out;
}

function asVec3(v: number[] | undefined): Vec3 | null {
  if (!v || v.length < 3) return null;
  if (!v.slice(0, 3).every((n) => Number.isFinite(n))) return null;
  return [v[0], v[1], v[2]];
}

function asLoop(points: number[][] | undefined): Pt2[] | null {
  if (!points || points.length < 3) return null;
  const loop: Pt2[] = [];
  for (const p of points) {
    if (!p || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    loop.push([p[0], p[1]]);
  }
  // A repeated closing vertex shifts every hole index in triangulateShape.
  if (samePoint(loop[0], loop[loop.length - 1])) loop.pop();
  return loop.length >= 3 ? loop : null;
}

function samePoint(a: Pt2, b: Pt2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function signedArea(pts: Pt2[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return area / 2;
}

function wind(pts: Pt2[], ccw: boolean): Pt2[] {
  const positive = signedArea(pts) > 0;
  const ordered = positive === ccw ? pts : [...pts].reverse();
  return ordered.map((p) => [p[0], p[1]]);
}

function closeLoop(pts: Vec3[]): Vec3[] {
  if (pts.length === 0) return pts;
  return [...pts, pts[0]];
}

function boundsOf(tris: ColoredTriangle[]): { min: Vec3; max: Vec3 } | null {
  if (tris.length === 0) return null;
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

function tri(a: Vec3, b: Vec3, c: Vec3, color: RGB): ColoredTriangle {
  return { a, b, c, color };
}

function quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: RGB): ColoredTriangle[] {
  return [tri(a, b, c, color), tri(a, c, d, color)];
}

function sub(p: Vec3, q: Vec3): Vec3 {
  return [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
}

function cross(p: Vec3, q: Vec3): Vec3 {
  return [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ];
}
