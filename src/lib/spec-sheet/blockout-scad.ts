import type { AssemblySpec, BedFace } from '../agent/assembly-spec';
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

  return { code: `${lines.join('\n').trimEnd()}\n`, skipped };
}

function identifierIssue(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'not a valid OpenSCAD identifier';
  if (BUILTINS.has(name)) return `${name} shadows an OpenSCAD builtin`;
  return null;
}

function moduleLines(comp: Component, ex: number, ey: number, ez: number, placeholderReason: string | null): string[] {
  const name = comp.name;
  let body = shapeBody(comp, ex, ey, ez, placeholderReason !== null);
  const cutters = (comp.holes ?? [])
    .map((hole) => holeLine(name, hole, ex, ey, ez))
    .filter((line): line is string => line !== null);
  if (cutters.length > 0) {
    body = [
      `difference() { // holes of ${name}`,
      ...indent(body, 4),
      ...indent(cutters, 4),
      '}',
    ];
  }
  const header = /\d/.test(name) ? `module ${name}() { // local module ${name}` : `module ${name}() {`;
  const marked = placeholderReason
    ? [`// PLACEHOLDER: ${placeholderReason} - build from the skeleton`, ...body]
    : body;
  return [header, ...indent(marked, 4), '}'];
}

function shapeBody(comp: Component, ex: number, ey: number, ez: number, fallback: boolean): string[] {
  const shape = comp.shape;
  const name = comp.name;
  if (fallback || !shape || shape.kind === 'box') return [cubeLine(name, ex, ey, ez)];
  if (shape.kind === 'cylinder' && shape.axis) {
    return [roundLine(name, ex, ey, ez, shape.axis, crossDiameter(shape.axis, ex, ey), false, 'cylinder')];
  }
  if (shape.kind === 'tube' && shape.axis && shape.innerD !== undefined) {
    return tubeBody(name, ex, ey, ez, shape.axis, shape.innerD);
  }
  if (shape.kind === 'shell' && shape.openFace && shape.wall !== undefined) {
    return shellBody(name, ex, ey, ez, shape.wall, shape.openFace);
  }
  if (shape.kind === 'profile' && shape.plane && shape.points) {
    return profileBody(name, shape.plane, shape.points, shape.holes, ex, ey, ez);
  }
  return [cubeLine(name, ex, ey, ez)];
}

function cubeLine(name: string, ex: number, ey: number, ez: number): string {
  return `cube([${fmt(ex)}, ${fmt(ey)}, ${fmt(ez)}]); // localExtents of ${name}`;
}

function tubeBody(name: string, ex: number, ey: number, ez: number, axis: Axis, innerD: number): string[] {
  const outerD = crossDiameter(axis, ex, ey);
  return [
    `difference() { // bore of ${name}`,
    `    ${roundLine(name, ex, ey, ez, axis, outerD, false, 'outer cylinder')}`,
    `    ${roundLine(name, ex, ey, ez, axis, innerD, true, 'inner cylinder')}`,
    '}',
  ];
}

function shellBody(name: string, ex: number, ey: number, ez: number, wall: number, openFace: BedFace): string[] {
  const box = cavity(ex, ey, ez, wall, openFace);
  return [
    `difference() { // shell cavity of ${name}, open ${openFace}`,
    `    ${cubeLine(name, ex, ey, ez)}`,
    `    translate([${fmt(box.origin[0])}, ${fmt(box.origin[1])}, ${fmt(box.origin[2])}]) cube([${fmt(box.size[0])}, ${fmt(box.size[1])}, ${fmt(box.size[2])}]); // wall of ${name} inset from each closed face, 0.01 mm overshoot through the open face`,
    '}',
  ];
}

function cavity(
  ex: number,
  ey: number,
  ez: number,
  wall: number,
  face: BedFace
): { origin: [number, number, number]; size: [number, number, number] } {
  const origin: [number, number, number] = [wall, wall, wall];
  const size: [number, number, number] = [ex - 2 * wall, ey - 2 * wall, ez - 2 * wall];
  if (face === '-X') {
    origin[0] = -OVERSHOOT;
    size[0] = ex - wall + OVERSHOOT;
  } else if (face === '+X') {
    size[0] = ex - wall + OVERSHOOT;
  } else if (face === '-Y') {
    origin[1] = -OVERSHOOT;
    size[1] = ey - wall + OVERSHOOT;
  } else if (face === '+Y') {
    size[1] = ey - wall + OVERSHOOT;
  } else if (face === '-Z') {
    origin[2] = -OVERSHOOT;
    size[2] = ez - wall + OVERSHOOT;
  } else {
    size[2] = ez - wall + OVERSHOOT;
  }
  return { origin, size };
}

function profileBody(
  name: string,
  plane: Plane,
  points: number[][],
  holes: number[][][] | undefined,
  ex: number,
  ey: number,
  ez: number
): string[] {
  const outline = wind(loopOf(points) ?? [], true);
  const inners = (holes ?? [])
    .map((hole) => loopOf(hole))
    .filter((hole): hole is Pt[] => hole !== null)
    .map((hole) => wind(hole, false));
  const poly = polygonCall(outline, inners);
  if (plane === 'xy') {
    return [
      `linear_extrude(height = ${fmt(ez)}) ${poly}; // xy profile of ${name}; height is localExtents.z; points are the outline and holes`,
    ];
  }
  if (plane === 'xz') {
    return [
      `translate([0, ${fmt(ey)}, 0]) rotate([90, 0, 0]) linear_extrude(height = ${fmt(ey)}) ${poly}; // xz profile of ${name}; +90 deg about x and a shift of localExtents.y map polygon (x, z) into the local box`,
    ];
  }
  return [
    `rotate([90, 0, 90]) linear_extrude(height = ${fmt(ex)}) ${poly}; // yz profile of ${name}; the rotation maps polygon (y, z) into the local box and height is localExtents.x`,
  ];
}

function roundLine(
  name: string,
  ex: number,
  ey: number,
  ez: number,
  axis: Axis,
  diameter: number,
  overshoot: boolean,
  role: string
): string {
  const extent = axis === 'x' ? ex : axis === 'y' ? ey : ez;
  const start = overshoot ? -OVERSHOOT : 0;
  const height = overshoot ? extent + OVERSHOOT * 2 : extent;
  const spin =
    axis === 'x'
      ? ' rotate([0, 90, 0])'
      : axis === 'y'
        ? ' rotate([-90, 0, 0])'
        : '';
  const why = overshoot
    ? `${role} of ${name}; d is innerD; h is localExtents.${axis} plus 0.01 mm past each end`
    : `${role} of ${name}; h is localExtents.${axis}; d is the cross-section extent; centred on the other two axes${axis === 'z' ? '' : `; ${axis === 'x' ? '+90 deg about y' : '-90 deg about x'} sends the axis along ${axis}`}`;
  return `${alongTranslate(axis, start, ex, ey, ez)}${spin} cylinder(h = ${fmt(height)}, d = ${fmt(diameter)}); // ${why}`;
}

function holeLine(
  name: string,
  hole: NonNullable<Component['holes']>[number],
  ex: number,
  ey: number,
  ez: number
): string | null {
  if (!(hole.d > 0) || !hole.at || hole.at.length < 3) return null;
  const axis = hole.axis;
  const extent = axis === 'x' ? ex : axis === 'y' ? ey : ez;
  const along = hole.at[axis === 'x' ? 0 : axis === 'y' ? 1 : 2];
  const fromMin = Math.abs(along) <= Math.abs(along - extent);
  const through = hole.depth === undefined;
  const start = through || fromMin ? -OVERSHOOT : extent - (hole.depth ?? 0);
  const height = through ? extent + OVERSHOOT * 2 : (hole.depth ?? 0) + OVERSHOOT;
  const spin = axis === 'x' ? ' rotate([0, 90, 0])' : axis === 'y' ? ' rotate([-90, 0, 0])' : '';
  const where = axis === 'z'
    ? `translate([${fmt(hole.at[0])}, ${fmt(hole.at[1])}, ${fmt(start)}])`
    : axis === 'y'
      ? `translate([${fmt(hole.at[0])}, ${fmt(start)}, ${fmt(hole.at[2])}])`
      : `translate([${fmt(start)}, ${fmt(hole.at[1])}, ${fmt(hole.at[2])}])`;
  const kind = through ? 'through' : 'blind';
  const reach = through
    ? 'spans localExtents plus 0.01 mm overshoot at each end'
    : 'bores inward from the entry face to hole.depth, with 0.01 mm outward overshoot';
  return `${where}${spin} cylinder(h = ${fmt(height)}, d = ${fmt(hole.d)}); // ${kind} hole of ${name} along ${axis}; d is hole.d; h ${reach}`;
}

function alongTranslate(axis: Axis, start: number, ex: number, ey: number, ez: number): string {
  if (axis === 'z') return `translate([${fmt(ex / 2)}, ${fmt(ey / 2)}, ${fmt(start)}])`;
  if (axis === 'y') return `translate([${fmt(ex / 2)}, ${fmt(start)}, ${fmt(ez / 2)}])`;
  return `translate([${fmt(start)}, ${fmt(ey / 2)}, ${fmt(ez / 2)}])`;
}

function crossDiameter(axis: Axis, ex: number, ey: number): number {
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
