import type { AssemblySpec, BedFace } from '../agent/assembly-spec';
import { classifyComponent } from '../spec-sheet/geometry';
import { comment, STANDALONE_CONTEXT, type TermContext } from './py-names';

/**
 * The code-drawn blockout of one component as a build123d function body, in the
 * component's LOCAL frame (min corner at the origin). Ported from
 * `shapeScad`/`moduleBodyLines` in spec-sheet/blockout-scad.ts.
 *
 * Every size is a Python expression over the parameter and derived names when
 * the spec carries one (`comp.expr`), else the resolved number. The lines are
 * unindented; the caller indents them under `def`.
 */

export type Component = NonNullable<AssemblySpec['components']>[number];
type Axis = 'x' | 'y' | 'z';
type Plane = 'xy' | 'xz' | 'yz';
type Pt = [number, number];
/** A length: the resolved number, or the Python expression that produced it. */
export type Term = number | string;

/** Cutters reach this far past every face they cut through (mm). */
export const OVERSHOOT = 0.02;

export const MIN3 = '(Align.MIN, Align.MIN, Align.MIN)';
const CMIN = '(Align.CENTER, Align.CENTER, Align.MIN)';

export function blockoutBody(comp: Component, ctx: TermContext = STANDALONE_CONTEXT): string {
  const ext = comp.localExtents;
  if (!ext || ext.length < 3) throw new Error(`${comp.name}: missing localExtents`);
  const [ex, ey, ez] = extentTerms(comp, ext[0], ext[1], ext[2], ctx);
  const decision = classifyComponent(comp);
  const lines = [`# blockout of ${comment(comp.name)}${decision.kind === 'box' ? ` (placeholder box: ${comment(decision.reason)})` : ''}`];
  lines.push(`_part = ${shapeExpr(comp, ex, ey, ez, decision.kind !== 'shape', ctx)}`);
  (comp.holes ?? []).forEach((hole, i) => {
    const cutter = holeExpr(hole, i, comp, ex, ey, ez, ctx);
    if (cutter) lines.push(`_part = _part - ${cutter}  # hole ${i + 1}`);
  });
  lines.push('return _part');
  return lines.join('\n');
}

/** The comment-free Python expression for the component's un-holed shape. */
export function shapeExpr(comp: Component, ex: Term, ey: Term, ez: Term, fallback: boolean, ctx: TermContext = STANDALONE_CONTEXT): string {
  const shape = comp.shape;
  if (fallback || !shape || shape.kind === 'box') return boxExpr(ex, ey, ez);
  if (shape.kind === 'cylinder' && shape.axis) {
    return outerRound(ex, ey, ez, shape.axis);
  }
  if (shape.kind === 'tube' && shape.axis && shape.innerD !== undefined) {
    const outer = outerRound(ex, ey, ez, shape.axis);
    const inner = roundExpr(ex, ey, ez, shape.axis, ctx.term(comp.expr?.innerD, shape.innerD), true);
    return `${outer} - ${inner}`;
  }
  if (shape.kind === 'shell' && shape.openFace && shape.wall !== undefined) {
    return shellExpr(ex, ey, ez, ctx.term(comp.expr?.wall, shape.wall), shape.openFace);
  }
  if (shape.kind === 'profile' && shape.plane && shape.points) {
    return profileExpr(comp, shape.plane, shape.points, shape.holes, ex, ey, ez, ctx);
  }
  return boxExpr(ex, ey, ez);
}

export function boxExpr(ex: Term, ey: Term, ez: Term, align = MIN3): string {
  return `Box(${emit(ex)}, ${emit(ey)}, ${emit(ez)}, align=${align})`;
}

/**
 * The outer body of a cylinder or tube along `axis`. Equal cross extents make a
 * Cylinder. Unequal ones (the classifier allows up to 0.5 mm) make an elliptical
 * prism, so the solid still spans both local extents exactly.
 */
function outerRound(ex: Term, ey: Term, ez: Term, axis: Axis): string {
  // Rot(0, 90, 0) sends the sketch's x to Z; Rot(-90, 0, 0) sends its y to -Z.
  const [c1, c2] = axis === 'x' ? [ez, ey] : axis === 'y' ? [ex, ez] : [ex, ey];
  if (emit(c1) === emit(c2)) return roundExpr(ex, ey, ez, axis, crossDiameter(axis, ex, ey), false);
  const extent = axis === 'x' ? ex : axis === 'y' ? ey : ez;
  const prism = `extrude(Plane.XY * Ellipse(${emit(div(c1, 2))}, ${emit(div(c2, 2))}), amount=${emit(extent)})`;
  // Cross-section centred on the two other axes, as for the cylinder.
  if (axis === 'z') return `Pos(${emit(div(ex, 2))}, ${emit(div(ey, 2))}, 0) * ${prism}`;
  if (axis === 'y') return `Pos(${emit(div(ex, 2))}, 0, ${emit(div(ez, 2))}) * Rot(-90, 0, 0) * ${prism}`;
  return `Pos(0, ${emit(div(ey, 2))}, ${emit(div(ez, 2))}) * Rot(0, 90, 0) * ${prism}`;
}

/**
 * A cylinder along `axis`, centred on the other two axes, spanning the local
 * extent on `axis` (plus `OVERSHOOT` past each end when it is a cutter).
 * build123d cylinders point along +Z; X and Y use the same rotations as OpenSCAD.
 */
function roundExpr(ex: Term, ey: Term, ez: Term, axis: Axis, diameter: Term, overshoot: boolean): string {
  const extent = axis === 'x' ? ex : axis === 'y' ? ey : ez;
  const start: Term = overshoot ? -OVERSHOOT : 0;
  const height = overshoot ? add(extent, OVERSHOOT * 2) : extent;
  return cylinderAt(axis, [div(ex, 2), div(ey, 2), div(ez, 2)], start, div(diameter, 2), height);
}

/** `Pos(...) * Rot(...) * Cylinder(...)`; `centre` supplies the two cross-axis coordinates. */
function cylinderAt(axis: Axis, centre: [Term, Term, Term], start: Term, radius: Term, height: Term): string {
  const cyl = `Cylinder(${emit(radius)}, ${emit(height)}, align=${CMIN})`;
  if (axis === 'z') return `Pos(${emit(centre[0])}, ${emit(centre[1])}, ${emit(start)}) * ${cyl}`;
  if (axis === 'y') return `Pos(${emit(centre[0])}, ${emit(start)}, ${emit(centre[2])}) * Rot(-90, 0, 0) * ${cyl}`;
  return `Pos(${emit(start)}, ${emit(centre[1])}, ${emit(centre[2])}) * Rot(0, 90, 0) * ${cyl}`;
}

function shellExpr(ex: Term, ey: Term, ez: Term, wall: Term, openFace: BedFace): string {
  const box = cavity(ex, ey, ez, wall, openFace);
  const cut = `Pos(${box.origin.map(emit).join(', ')}) * ${boxExpr(box.size[0], box.size[1], box.size[2])}`;
  return `${boxExpr(ex, ey, ez)} - ${cut}`;
}

function cavity(
  ex: Term,
  ey: Term,
  ez: Term,
  wall: Term,
  face: BedFace
): { origin: [Term, Term, Term]; size: [Term, Term, Term] } {
  const origin: [Term, Term, Term] = [wall, wall, wall];
  const size: [Term, Term, Term] = [sub(ex, mul(2, wall)), sub(ey, mul(2, wall)), sub(ez, mul(2, wall))];
  const i = face[1] === 'X' ? 0 : face[1] === 'Y' ? 1 : 2;
  const extent = [ex, ey, ez][i];
  // The open axis keeps one wall (the closed side) and overshoots through the open face.
  size[i] = add(sub(extent, wall), OVERSHOOT);
  if (face[0] === '-') origin[i] = -OVERSHOOT;
  return { origin, size };
}

/** The profile's outline alone (no holes), for the cavity that follows an insert. */
export function profileOuterExpr(comp: Component, ex: Term, ey: Term, ez: Term, ctx: TermContext): string {
  const shape = comp.shape;
  return profileExpr(comp, shape?.plane ?? 'xy', shape?.points ?? [], undefined, ex, ey, ez, ctx, false);
}

function profileExpr(
  comp: Component,
  plane: Plane,
  points: number[][],
  holes: number[][][] | undefined,
  ex: Term,
  ey: Term,
  ez: Term,
  ctx: TermContext,
  withHoles = true
): string {
  const outline = loopTerms(points, comp.expr?.outline, true, ctx) ?? [];
  const inners = (withHoles ? (holes ?? []) : [])
    .map((hole, i) => loopTerms(hole, comp.expr?.outlineHoles?.[i], false, ctx))
    .filter((hole): hole is [Term, Term][] => hole !== null);
  const poly = (loop: [Term, Term][]) => `Polygon(${loop.map(([u, v]) => `(${emit(u)}, ${emit(v)})`).join(', ')}, align=None)`;
  const sketch = inners.length > 0 ? `(${[poly(outline), ...inners.map(poly)].join(' - ')})` : poly(outline);
  // Plane.XY: x, y -> X, Y, normal +Z. Plane.XZ: x, y -> X, Z, normal -Y. Plane.YZ: x, y -> Y, Z, normal +X.
  if (plane === 'xy') return `extrude(Plane.XY * ${sketch}, amount=${emit(ez)})`;
  if (plane === 'xz') return `Pos(0, ${emit(ey)}, 0) * extrude(Plane.XZ * ${sketch}, amount=${emit(ey)})`;
  return `extrude(Plane.YZ * ${sketch}, amount=${emit(ex)})`;
}

/**
 * One hole's cutter, or null when the hole is unusable. A through hole spans the
 * local extent on its axis plus the overshoot; a blind hole bores `depth` inward
 * from the nearer face.
 */
export function holeExpr(
  hole: NonNullable<Component['holes']>[number],
  index: number,
  comp: Component,
  ex: Term,
  ey: Term,
  ez: Term,
  ctx: TermContext = STANDALONE_CONTEXT
): string | null {
  if (!(hole.d > 0) || !hole.at || hole.at.length < 3) return null;
  const he = comp.expr?.holes?.[index];
  const d = ctx.term(he?.d, hole.d);
  const at: [Term, Term, Term] = [
    ctx.term(he?.at?.[0], hole.at[0]),
    ctx.term(he?.at?.[1], hole.at[1]),
    ctx.term(he?.at?.[2], hole.at[2]),
  ];
  const axis = hole.axis;
  const ext = comp.localExtents;
  const extentNum = ext && ext.length >= 3 ? ext[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] : 0;
  const extent = axis === 'x' ? ex : axis === 'y' ? ey : ez;
  const alongIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const along = hole.at[alongIndex];
  const fromMin = Math.abs(along) <= Math.abs(along - extentNum);
  // No depth, or a depth of 0 or less (saved specs write `depth: 0` with the note "through"), is a through hole.
  // Through: no depth, or a LITERAL depth of 0 or less (saved specs write `depth: 0` meaning
  // through). A parametric depth stays blind whatever its default value; it is clamped at 0.
  const through = hole.depth === undefined || (!he?.depth && !(hole.depth > 0));
  const depthTerm = through ? 0 : ctx.term(he?.depth, hole.depth!);
  const depth: Term = typeof depthTerm === 'string' ? `max(${depthTerm}, 0)` : Math.max(depthTerm, 0);
  let start: Term = through || fromMin ? -OVERSHOOT : sub(extent, depth);
  if (!through && [at[alongIndex], extent, depth].some((t) => typeof t === 'string')) {
    // The mouth is on the nearer face. With a parameter in play that choice is made when the
    // script runs, so moving the hole past the midpoint moves the cutter to the other face.
    const a = at[alongIndex];
    start = `(${emit(-OVERSHOOT)} if abs(${emit(a)}) <= abs(${emit(sub(a, extent))}) else ${emit(sub(extent, depth))})`;
  }
  const height: Term = through ? add(extent, OVERSHOOT * 2) : add(depth, OVERSHOOT);
  return cylinderAt(axis, at, start, div(d, 2), height);
}

function crossDiameter(axis: Axis, ex: Term, ey: Term): Term {
  return axis === 'x' ? ey : ex;
}

/** The loop as terms (expression where the spec kept one), closing vertex dropped, wound as asked. */
function loopTerms(points: number[][] | undefined, exprs: (string | null)[][] | undefined, ccw: boolean, ctx: TermContext): [Term, Term][] | null {
  const loop = loopOf(points);
  if (!loop) return null;
  const terms: [Term, Term][] = loop.map((p, i) => [ctx.term(exprs?.[i]?.[0], p[0]), ctx.term(exprs?.[i]?.[1], p[1])]);
  return signedArea(loop) > 0 === ccw ? terms : terms.reverse();
}

function loopOf(points: number[][] | undefined): Pt[] | null {
  if (!points || points.length < 3) return null;
  const loop: Pt[] = [];
  for (const point of points) {
    if (!point || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
    loop.push([point[0], point[1]]);
  }
  const first = loop[0];
  const last = loop[loop.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) loop.pop();
  return loop.length >= 3 ? loop : null;
}

function signedArea(pts: Pt[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return area / 2;
}

export function fmt(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  if (!Number.isFinite(rounded) || rounded === 0) return '0';
  const text = rounded.toFixed(6).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

export function extentTerms(
  comp: Component,
  ex: number,
  ey: number,
  ez: number,
  ctx: TermContext = STANDALONE_CONTEXT
): [Term, Term, Term] {
  const e = comp.expr?.localExtents;
  return [ctx.term(e?.[0], ex), ctx.term(e?.[1], ey), ctx.term(e?.[2], ez)];
}

/** An expression nested in a larger one is parenthesised; a literal formats plainly. */
function atom(t: Term): string {
  return typeof t === 'string' ? `(${t})` : fmt(t);
}

export function emit(t: Term): string {
  return typeof t === 'string' ? t : fmt(t);
}

export function add(a: Term, b: Term): Term {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  return `${atom(a)} + ${atom(b)}`;
}

export function sub(a: Term, b: Term): Term {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return `${atom(a)} - ${atom(b)}`;
}

function mul(a: Term, b: Term): Term {
  if (typeof a === 'number' && typeof b === 'number') return a * b;
  return `${atom(a)} * ${atom(b)}`;
}

export function div(a: Term, b: Term): Term {
  if (typeof a === 'number' && typeof b === 'number') return a / b;
  return `${atom(a)} / ${atom(b)}`;
}
