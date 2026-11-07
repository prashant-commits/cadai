import type { AssemblySpec, BedFace } from '../agent/assembly-spec';
import { parameterBlock } from '../agent/parameter-block';
import { classifyComponent } from './geometry';

/**
 * The Drafter's starting script: one local-frame module per component.
 * Nothing is instantiated here. `composeAssembly` places the modules.
 * Every literal number in the emitted text says what it derives from.
 */

type Component = NonNullable<AssemblySpec['components']>[number];
type Axis = 'x' | 'y' | 'z';
type Plane = 'xy' | 'xz' | 'yz';
type Pt = [number, number];

const OVERSHOOT = 0.01;

const BUILTINS = new Set([
  'cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon', 'text',
  'translate', 'rotate', 'scale', 'mirror', 'multmatrix', 'color', 'offset', 'hull',
  'minkowski', 'union', 'difference', 'intersection', 'linear_extrude', 'rotate_extrude',
  'import', 'surface', 'projection', 'render', 'children',
]);

export function blockoutScad(spec: AssemblySpec): { code: string; skipped: { name: string; reason: string }[] } {
  const skipped: { name: string; reason: string }[] = [];
  const lines = ['$fn = 48; // segment count for cylinders, tubes and hole cutters', ''];

  for (const comp of spec.components ?? []) {
    const nameIssue = identifierIssue(comp.name);
    if (nameIssue) {
      skipped.push({ name: comp.name, reason: nameIssue });
      continue;
    }
    const decision = classifyComponent(comp);
    if (decision.kind === 'omit') {
      skipped.push({ name: comp.name, reason: decision.reason });
      continue;
    }
    const ext = comp.localExtents;
    if (!ext || ext.length < 3) {
      skipped.push({ name: comp.name, reason: 'missing localExtents' });
      continue;
    }
    if (decision.kind === 'box') {
      skipped.push({ name: comp.name, reason: `${decision.reason}; drawn as a box` });
    }
    lines.push(
      ...moduleLines(comp, ext[0], ext[1], ext[2], decision.kind === 'box' ? decision.reason : null),
      ''
    );
  }

  const body = `${lines.join('\n').trimEnd()}\n`;
  const header = parameterBlock(spec);
  return { code: header ? `${header}${body}` : body, skipped };
}

export function identifierIssue(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'not a valid OpenSCAD identifier';
  if (BUILTINS.has(name)) return `${name} shadows an OpenSCAD builtin`;
  return null;
}

/**
 * Indented body of one blockout module: no `module` header and no closing brace.
 * Null when the part is unknown or `blockoutScad` would not draw it.
 */
export function blockoutBody(spec: AssemblySpec, name: string): string | null {
  const comp = (spec.components ?? []).find((item) => item.name === name);
  if (!comp) return null;
  if (identifierIssue(comp.name)) return null;
  const decision = classifyComponent(comp);
  if (decision.kind === 'omit') return null;
  const ext = comp.localExtents;
  if (!ext || ext.length < 3) return null;
  const placeholder = decision.kind === 'box' ? decision.reason : null;
  return moduleBodyLines(comp, ext[0], ext[1], ext[2], placeholder).join('\n');
}

function moduleLines(comp: Component, ex: number, ey: number, ez: number, placeholderReason: string | null): string[] {
  const name = comp.name;
  const header = /\d/.test(name) ? `module ${name}() { // local module ${name}` : `module ${name}() {`;
  return [header, ...moduleBodyLines(comp, ex, ey, ez, placeholderReason), '}'];
}

function moduleBodyLines(comp: Component, ex: number, ey: number, ez: number, placeholderReason: string | null): string[] {
  const name = comp.name;
  const [tx, ty, tz] = extentTerms(comp, ex, ey, ez);
  let body = shapeBody(comp, tx, ty, tz, placeholderReason !== null);
  const cutters = (comp.holes ?? [])
    .map((hole, i) => holeLine(name, hole, i, comp, tx, ty, tz))
    .filter((line): line is string => line !== null);
  if (cutters.length > 0) {
    body = [
      `difference() { // holes of ${name}`,
      ...indent(body, 4),
      ...indent(cutters, 4),
      '}',
    ];
  }
  const marked = placeholderReason
    ? [`// PLACEHOLDER: ${placeholderReason} - build from the skeleton`, ...body]
    : body;
  return indent(marked, 4);
}


export function shapeScad(comp: Component, grow = 0, onNote?: (reason: string) => void): string {
  const shape = comp.shape;
  const name = comp.name;
  const ext = comp.localExtents;
  if (!ext || ext.length < 3) return '';
  const [ex, ey, ez] = extentTerms(comp, ext[0], ext[1], ext[2]);

  const decision = classifyComponent(comp);
  if (decision.kind !== 'shape') {
    onNote?.(decision.reason);
    return cubeLineGrown(name, ex, ey, ez, grow);
  }

  if (!shape || shape.kind === 'box') return cubeLineGrown(name, ex, ey, ez, grow);
  if (shape.kind === 'cylinder' && shape.axis) {
    return roundLineGrown(name, ex, ey, ez, shape.axis, crossDiameter(shape.axis, ex, ey), false, 'cylinder', grow);
  }
  if (shape.kind === 'tube' && shape.axis && shape.innerD !== undefined) {
    return roundLineGrown(name, ex, ey, ez, shape.axis, crossDiameter(shape.axis, ex, ey), false, 'outer cylinder', grow);
  }
  if (shape.kind === 'shell' && shape.openFace && shape.wall !== undefined) {
    return cubeLineGrown(name, ex, ey, ez, grow);
  }
  if (shape.kind === 'profile' && shape.plane && shape.points) {
    return profileBodyGrown(name, shape.plane, shape.points, shape.holes, ex, ey, ez, grow);
  }
  return cubeLineGrown(name, ex, ey, ez, grow);
}

function cubeLineGrown(name: string, ex: Term, ey: Term, ez: Term, grow: number): string {
  if (grow === 0) return cubeLine(name, ex, ey, ez);
  return `translate([-${fmt(grow)}, -${fmt(grow)}, -${fmt(grow)}]) cube([${emit(add(ex, 2 * grow))}, ${emit(add(ey, 2 * grow))}, ${emit(add(ez, 2 * grow))}]); // localExtents of ${name} grown by ${grow} mm clearance`;
}

function roundLineGrown(
  name: string,
  ex: Term,
  ey: Term,
  ez: Term,
  axis: Axis,
  diameter: Term,
  overshoot: boolean,
  role: string,
  grow: number
): string {
  if (grow === 0) return roundLine(name, ex, ey, ez, axis, diameter, overshoot, role);

  const extent = axis === 'x' ? ex : axis === 'y' ? ey : ez;
  const start = -grow;
  const height = add(extent, 2 * grow);
  const spin =
    axis === 'x'
      ? ' rotate([0, 90, 0])'
      : axis === 'y'
        ? ' rotate([-90, 0, 0])'
        : '';
  const n = 96;
  const cos = Math.cos(Math.PI / n);
  const circumscribedD: Term = typeof diameter === 'number'
    ? (diameter + 2 * grow) / cos
    : div(add(diameter, 2 * grow), cos);
  const why = `${role} of ${name} grown by ${grow} mm clearance (circumscribed, $fn = ${n})`;
  return `${alongTranslate(axis, start, ex, ey, ez)}${spin} cylinder(h = ${emit(height)}, d = ${emit(circumscribedD)}, $fn = ${n}); // ${why}`;
}

function profileBodyGrown(
  name: string,
  plane: Plane,
  points: number[][],
  holes: number[][][] | undefined,
  ex: Term,
  ey: Term,
  ez: Term,
  grow: number
): string {
  if (grow === 0) return profileBody(name, plane, points, holes, ex, ey, ez)[0];

  const outline = wind(loopOf(points) ?? [], true);
  // Profile inserts with holes cut a solid cavity: grow only the outer outline, not the holes.
  const poly = polygonCall(outline, []);

  if (plane === 'xy') {
    return `translate([0, 0, -${fmt(grow)}]) linear_extrude(height = ${emit(add(ez, 2 * grow))}) offset(delta = ${fmt(grow)}) ${poly}; // xy profile of ${name} grown by ${grow} mm clearance`;
  }
  if (plane === 'xz') {
    return `translate([0, ${emit(ey)}, 0]) rotate([90, 0, 0]) translate([0, 0, -${fmt(grow)}]) linear_extrude(height = ${emit(add(ey, 2 * grow))}) offset(delta = ${fmt(grow)}) ${poly}; // xz profile of ${name} grown by ${grow} mm clearance`;
  }
  return `rotate([90, 0, 90]) translate([0, 0, -${fmt(grow)}]) linear_extrude(height = ${emit(add(ex, 2 * grow))}) offset(delta = ${fmt(grow)}) ${poly}; // yz profile of ${name} grown by ${grow} mm clearance`;
}

function shapeBody(comp: Component, ex: Term, ey: Term, ez: Term, fallback: boolean): string[] {
  const shape = comp.shape;
  const name = comp.name;
  if (fallback || !shape || shape.kind === 'box') return [cubeLine(name, ex, ey, ez)];
  if (shape.kind === 'cylinder' && shape.axis) {
    return [roundLine(name, ex, ey, ez, shape.axis, crossDiameter(shape.axis, ex, ey), false, 'cylinder')];
  }
  if (shape.kind === 'tube' && shape.axis && shape.innerD !== undefined) {
    return tubeBody(name, ex, ey, ez, shape.axis, fieldTerm(comp.expr?.innerD, shape.innerD));
  }
  if (shape.kind === 'shell' && shape.openFace && shape.wall !== undefined) {
    return shellBody(name, ex, ey, ez, fieldTerm(comp.expr?.wall, shape.wall), shape.openFace);
  }
  if (shape.kind === 'profile' && shape.plane && shape.points) {
    return profileBody(name, shape.plane, shape.points, shape.holes, ex, ey, ez);
  }
  return [cubeLine(name, ex, ey, ez)];
}

function cubeLine(name: string, ex: Term, ey: Term, ez: Term): string {
  return `cube([${emit(ex)}, ${emit(ey)}, ${emit(ez)}]); // localExtents of ${name}`;
}

function tubeBody(name: string, ex: Term, ey: Term, ez: Term, axis: Axis, innerD: Term): string[] {
  const outerD = crossDiameter(axis, ex, ey);
  return [
    `difference() { // bore of ${name}`,
    `    ${roundLine(name, ex, ey, ez, axis, outerD, false, 'outer cylinder')}`,
    `    ${roundLine(name, ex, ey, ez, axis, innerD, true, 'inner cylinder')}`,
    '}',
  ];
}

function shellBody(name: string, ex: Term, ey: Term, ez: Term, wall: Term, openFace: BedFace): string[] {
  const box = cavity(ex, ey, ez, wall, openFace);
  return [
    `difference() { // shell cavity of ${name}, open ${openFace}`,
    `    ${cubeLine(name, ex, ey, ez)}`,
    `    translate([${emit(box.origin[0])}, ${emit(box.origin[1])}, ${emit(box.origin[2])}]) cube([${emit(box.size[0])}, ${emit(box.size[1])}, ${emit(box.size[2])}]); // wall of ${name} inset from each closed face, 0.01 mm overshoot through the open face`,
    '}',
  ];
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
  if (face === '-X') {
    origin[0] = -OVERSHOOT;
    size[0] = add(sub(ex, wall), OVERSHOOT);
  } else if (face === '+X') {
    size[0] = add(sub(ex, wall), OVERSHOOT);
  } else if (face === '-Y') {
    origin[1] = -OVERSHOOT;
    size[1] = add(sub(ey, wall), OVERSHOOT);
  } else if (face === '+Y') {
    size[1] = add(sub(ey, wall), OVERSHOOT);
  } else if (face === '-Z') {
    origin[2] = -OVERSHOOT;
    size[2] = add(sub(ez, wall), OVERSHOOT);
  } else {
    size[2] = add(sub(ez, wall), OVERSHOOT);
  }
  return { origin, size };
}

function profileBody(
  name: string,
  plane: Plane,
  points: number[][],
  holes: number[][][] | undefined,
  ex: Term,
  ey: Term,
  ez: Term
): string[] {
  const outline = wind(loopOf(points) ?? [], true);
  const inners = (holes ?? [])
    .map((hole) => loopOf(hole))
    .filter((hole): hole is Pt[] => hole !== null)
    .map((hole) => wind(hole, false));
  const poly = polygonCall(outline, inners);
  if (plane === 'xy') {
    return [
      `linear_extrude(height = ${emit(ez)}) ${poly}; // xy profile of ${name}; height is localExtents.z; points are the outline and holes`,
    ];
  }
  if (plane === 'xz') {
    return [
      `translate([0, ${emit(ey)}, 0]) rotate([90, 0, 0]) linear_extrude(height = ${emit(ey)}) ${poly}; // xz profile of ${name}; +90 deg about x and a shift of localExtents.y map polygon (x, z) into the local box`,
    ];
  }
  return [
    `rotate([90, 0, 90]) linear_extrude(height = ${emit(ex)}) ${poly}; // yz profile of ${name}; the rotation maps polygon (y, z) into the local box and height is localExtents.x`,
  ];
}

function roundLine(
  name: string,
  ex: Term,
  ey: Term,
  ez: Term,
  axis: Axis,
  diameter: Term,
  overshoot: boolean,
  role: string
): string {
  const extent = axis === 'x' ? ex : axis === 'y' ? ey : ez;
  const start = overshoot ? -OVERSHOOT : 0;
  const height = overshoot ? add(extent, OVERSHOOT * 2) : extent;
  const spin =
    axis === 'x'
      ? ' rotate([0, 90, 0])'
      : axis === 'y'
        ? ' rotate([-90, 0, 0])'
        : '';
  const why = overshoot
    ? `${role} of ${name}; d is innerD; h is localExtents.${axis} plus 0.01 mm past each end`
    : `${role} of ${name}; h is localExtents.${axis}; d is the cross-section extent; centred on the other two axes${axis === 'z' ? '' : `; ${axis === 'x' ? '+90 deg about y' : '-90 deg about x'} sends the axis along ${axis}`}`;
  return `${alongTranslate(axis, start, ex, ey, ez)}${spin} cylinder(h = ${emit(height)}, d = ${emit(diameter)}); // ${why}`;
}

function holeLine(
  name: string,
  hole: NonNullable<Component['holes']>[number],
  index: number,
  comp: Component,
  ex: Term,
  ey: Term,
  ez: Term
): string | null {
  if (!(hole.d > 0) || !hole.at || hole.at.length < 3) return null;
  const he = comp.expr?.holes?.[index];
  const d = fieldTerm(he?.d, hole.d);
  const at: [Term, Term, Term] = [
    fieldTerm(he?.at?.[0], hole.at[0]),
    fieldTerm(he?.at?.[1], hole.at[1]),
    fieldTerm(he?.at?.[2], hole.at[2]),
  ];
  const axis = hole.axis;
  const ext = comp.localExtents;
  const exN = ext && ext.length >= 3 ? ext[0] : 0;
  const eyN = ext && ext.length >= 3 ? ext[1] : 0;
  const ezN = ext && ext.length >= 3 ? ext[2] : 0;
  const extentNum = axis === 'x' ? exN : axis === 'y' ? eyN : ezN;
  const extent = axis === 'x' ? ex : axis === 'y' ? ey : ez;
  const along = hole.at[axis === 'x' ? 0 : axis === 'y' ? 1 : 2];
  const fromMin = Math.abs(along) <= Math.abs(along - extentNum);
  // No depth, or a depth of 0 or less (saved specs write `depth: 0` with the note "through"), is a through hole.
  // Through: no depth, or a LITERAL depth of 0 or less (saved specs write `depth: 0` meaning
  // through). A parametric depth stays blind whatever its default value; it is clamped at 0.
  const through = hole.depth === undefined || (!he?.depth && !(hole.depth > 0));
  const depthTerm: Term | undefined = through ? undefined : fieldTerm(he?.depth, hole.depth!);
  const depth: Term | undefined =
    depthTerm === undefined ? undefined : typeof depthTerm === 'string' ? `max(${depthTerm}, 0)` : Math.max(depthTerm, 0);
  const start: Term = through || fromMin ? -OVERSHOOT : sub(extent, depth ?? 0);
  const height: Term = through ? add(extent, OVERSHOOT * 2) : add(depth ?? 0, OVERSHOOT);
  const spin = axis === 'x' ? ' rotate([0, 90, 0])' : axis === 'y' ? ' rotate([-90, 0, 0])' : '';
  const where = axis === 'z'
    ? `translate([${emit(at[0])}, ${emit(at[1])}, ${emit(start)}])`
    : axis === 'y'
      ? `translate([${emit(at[0])}, ${emit(start)}, ${emit(at[2])}])`
      : `translate([${emit(start)}, ${emit(at[1])}, ${emit(at[2])}])`;
  const kind = through ? 'through' : 'blind';
  const reach = through
    ? 'spans localExtents plus 0.01 mm overshoot at each end'
    : 'bores inward from the entry face to hole.depth, with 0.01 mm outward overshoot';
  return `${where}${spin} cylinder(h = ${emit(height)}, d = ${emit(d)}); // ${kind} hole of ${name} along ${axis}; d is hole.d; h ${reach}`;
}

function alongTranslate(axis: Axis, start: Term, ex: Term, ey: Term, ez: Term): string {
  if (axis === 'z') return `translate([${emit(div(ex, 2))}, ${emit(div(ey, 2))}, ${emit(start)}])`;
  if (axis === 'y') return `translate([${emit(div(ex, 2))}, ${emit(start)}, ${emit(div(ez, 2))}])`;
  return `translate([${emit(start)}, ${emit(div(ey, 2))}, ${emit(div(ez, 2))}])`;
}

function crossDiameter(axis: Axis, ex: Term, ey: Term): Term {
  if (axis === 'x') return ey;
  if (axis === 'y') return ex;
  return ex;
}

function polygonCall(outline: Pt[], holes: Pt[][]): string {
  const all = [...outline, ...holes.flat()];
  const paths: number[][] = [];
  let index = 0;
  paths.push(outline.map(() => index++));
  for (const hole of holes) paths.push(hole.map(() => index++));
  const points = all.map(([u, v]) => `[${fmt(u)}, ${fmt(v)}]`).join(', ');
  const pathText = paths.map((path) => `[${path.join(', ')}]`).join(', ');
  return `polygon(points = [${points}], paths = [${pathText}])`;
}

function loopOf(points: number[][] | undefined): Pt[] | null {
  if (!points || points.length < 3) return null;
  const loop: Pt[] = [];
  for (const point of points) {
    if (!point || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
    loop.push([point[0], point[1]]);
  }
  // Drop a repeated closing vertex before the polygon is emitted.
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

function wind(pts: Pt[], ccw: boolean): Pt[] {
  const positive = signedArea(pts) > 0;
  const ordered = positive === ccw ? pts : [...pts].reverse();
  return ordered.map((point) => [point[0], point[1]]);
}

function indent(lines: string[], spaces: number): string[] {
  const pad = ' '.repeat(spaces);
  return lines.map((line) => (line.trim() ? pad + line : line));
}

function fmt(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  if (!Number.isFinite(rounded) || rounded === 0) return '0';
  const text = rounded.toFixed(6).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

/** A length: the resolved number, or the OpenSCAD expression that produced it. */
type Term = number | string;

function fieldTerm(expr: string | null | undefined, value: number): Term {
  return expr ? expr : value;
}

function extentTerms(comp: Component, ex: number, ey: number, ez: number): [Term, Term, Term] {
  const e = comp.expr?.localExtents;
  return [fieldTerm(e?.[0], ex), fieldTerm(e?.[1], ey), fieldTerm(e?.[2], ez)];
}

/** Literals format as before. An expression used inside a larger expression is parenthesised. */
function atom(t: Term): string {
  return typeof t === 'string' ? `(${t})` : fmt(t);
}

function emit(t: Term): string {
  return typeof t === 'string' ? t : fmt(t);
}

function add(a: Term, b: Term): Term {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  return `${atom(a)} + ${atom(b)}`;
}

function sub(a: Term, b: Term): Term {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return `${atom(a)} - ${atom(b)}`;
}

function mul(a: Term, b: Term): Term {
  if (typeof a === 'number' && typeof b === 'number') return a * b;
  return `${atom(a)} * ${atom(b)}`;
}

function div(a: Term, b: Term): Term {
  if (typeof a === 'number' && typeof b === 'number') return a / b;
  return `${atom(a)} / ${atom(b)}`;
}
