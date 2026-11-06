import type { AssemblySpec } from '../agent/assembly-spec';
import { contactSinks } from '../design/contact-sink';
import { matingCuts } from '../design/mating-cuts';
import { placedBounds, type Vec3 } from '../design/placement-geometry';
import { classifyComponent } from '../spec-sheet/geometry';
import {
  add,
  blockoutBody,
  boxExpr,
  div,
  emit,
  extentTerms,
  fmt,
  MIN3,
  profileOuterExpr,
  type Component,
  type Term,
} from './blockout-b123d';
import { checkPythonBody } from './body-check';
import { comment, specNames, isReservedName, type TermContext } from './py-names';

/**
 * Spec -> build123d script. The spec stays the source of truth; this is the
 * Python counterpart of `blockoutScad` + `composeAssembly`:
 *
 *   1. parameters, then derived values, as top-level assignments;
 *   2. one `<name>_pos_<axis>` variable per non-zero placement coordinate;
 *   3. one `def <name>():` per component, returning a Part in its local frame
 *      (a supplied body, else the code-drawn blockout);
 *   4. each part placed as `Pos(position + contact sink) * Rot(rotation) * <name>()`
 *      and labelled with the component name;
 *   5. mating cavities cut from their hosts;
 *   6. parts that touch fuse into one solid, except across a jointContract
 *      (lid, drawer): those stay separate solids;
 *   7. `result = Compound(...)` of the fused groups.
 *
 * Fusing loses labels, so the labelled, placed, un-fused, un-cut parts are also
 * bound to `_parts`; a runner that measures per component reads that list.
 */

const AXES = ['x', 'y', 'z'] as const;

/**
 * Fuses the parts that really share material. Box contact only nominates candidates:
 * two boxes that meet at an edge, or whose boxes overlap in empty space, would fuse into a
 * compound of two solids, so a pair merges only when the fuse has fewer solids than its inputs.
 */
const FUSE_HELPER = `def _fuse(items):
    groups = [([name], shape) for name, shape in items]
    merged = True
    while merged:
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                a, b = groups[i][1], groups[j][1]
                fused = a + b
                if len(fused.solids()) < len(a.solids()) + len(b.solids()):
                    groups[i] = (groups[i][0] + groups[j][0], fused)
                    del groups[j]
                    merged = True
                    break
            if merged:
                break
    out = []
    for names, shape in groups:
        shape.label = "+".join(names)
        out.append(shape)
    return out`;
export interface EmitResult {
  script: string;
  skipped: { name: string; reason: string }[];
}

interface Placed {
  comp: Component;
  fn: string;
  placement: string;
  sink: Vec3 | undefined;
  min: Vec3;
  max: Vec3;
}

export function emitBrepScript(spec: AssemblySpec, bodies: Record<string, string> = {}): EmitResult {
  const skipped: EmitResult['skipped'] = [];
  const sinks = contactSinks(spec);
  const { names, parameterLines } = specNames(spec, fmt);
  const ctx = names.ctx;
  const declared = names.taken;
  for (const name of names.badDerived) {
    skipped.push({ name, reason: 'derived expression is not a valid spec expression; set to 0' });
  }

  const lines: string[] = [
    '# Generated from the approved Assembly Spec. Edit a parameter to preview; change the spec to keep it.',
    'from build123d import *',
    'import math as _math',
    'from math import sin, cos, tan, radians, sqrt, pi',
    '',
    '# Spec expressions take degrees; model bodies use the math functions above (radians).',
    'def _sind(deg): return _math.sin(_math.radians(deg))',
    'def _cosd(deg): return _math.cos(_math.radians(deg))',
    'def _tand(deg): return _math.tan(_math.radians(deg))',
    '',
    FUSE_HELPER,
    '',
  ];

  // 1. Parameters and derived values.
  if (parameterLines.length > 0) lines.push('# ---- parameters', ...parameterLines, '');

  // Which components are drawn at all.
  const drawn: Component[] = [];
  const seen = new Set<string>();
  for (const comp of spec.components ?? []) {
    const issue = identifierIssue(comp.name) ?? (seen.has(comp.name) ? 'duplicate component name' : null);
    if (issue) {
      skipped.push({ name: comp.name, reason: issue });
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
    if (decision.kind === 'box' && bodies[comp.name] === undefined) {
      skipped.push({ name: comp.name, reason: `${decision.reason}; drawn as a box` });
    }
    seen.add(comp.name);
    drawn.push(comp);
  }

  // 2. Placement variables.
  const placeLines: string[] = [];
  const posTokens = new Map<string, [string, string, string]>();
  for (const comp of drawn) {
    posTokens.set(comp.name, positionTokens(comp, declared, placeLines, ctx));
  }
  if (placeLines.length > 0) lines.push('# ---- placement (assembly coordinates, mm)', ...placeLines, '');

  // 3. One function per component, in the local frame. A name the script uses or inherits
  // (`min`, `extrude`, a keyword) gets a `_part` suffix; labels keep the spec name.
  const fnNames = new Map<string, string>();
  for (const comp of drawn) {
    let fn = comp.name;
    if (!/^[a-z][a-z0-9_]*$/.test(fn) || isReservedName(fn) || declared.has(fn)) {
      fn = `${comp.name}_part`;
      for (let n = 2; isReservedName(fn) || declared.has(fn); n++) fn = `${comp.name}_part${n}`;
    }
    declared.add(fn);
    fnNames.set(comp.name, fn);
  }
  const reservedPy = [...names.map.values()];
  const componentRefs = [...drawn.map((c) => c.name), ...fnNames.values()];
  lines.push('# ---- components, each in its own frame with the min corner at the origin');
  for (const comp of drawn) {
    let body: string | null = null;
    const supplied = bodies[comp.name];
    if (supplied !== undefined) {
      const verdict = checkPythonBody(supplied, { reserved: reservedPy, components: componentRefs });
      if (verdict.ok) body = supplied;
      else skipped.push({ name: comp.name, reason: `body rejected (${verdict.reason}); drawn from the blockout` });
    }
    lines.push(`def ${fnNames.get(comp.name)}():`, ...indent((body ?? blockoutBody(comp, ctx)).split('\n'), 4), '');
  }

  // 4. Placement, pre-fusion, with labels.
  const placed = new Map<string, Placed>();
  const partLines: string[] = [];
  for (const comp of drawn) {
    const ext = comp.localExtents as number[];
    const position = vec3(comp.position) ?? [0, 0, 0];
    const rotation = vec3(comp.rotation) ?? [0, 0, 0];
    const sink = sinks.get(comp.name);
    const box = placedBounds({ min: [0, 0, 0], max: [ext[0], ext[1], ext[2]] }, position, rotation);
    const placement = placementPrefix(comp, posTokens.get(comp.name)!, sink, ctx);
    placed.set(comp.name, {
      comp,
      fn: fnNames.get(comp.name)!,
      placement,
      sink,
      min: shift(box.min, sink),
      max: shift(box.max, sink),
    });
    const label = JSON.stringify(comp.name);
    partLines.push(
      `${localVar(comp.name)} = ${fnNames.get(comp.name)}()`,
      `${localVar(comp.name)}.label = ${label}`,
      `${varOf(comp.name)} = ${placement} * ${localVar(comp.name)}`,
      `${varOf(comp.name)}.label = ${label}`,
    );
  }
  lines.push('# ---- parts: each measured in its own frame, then placed in the assembly (labelled)', ...partLines);
  lines.push(`_local = [${drawn.map((c) => localVar(c.name)).join(', ')}]`);
  lines.push(`_parts = [${drawn.map((c) => varOf(c.name)).join(', ')}]`, '');

  // 5. Mating cavities.
  const cutLines: string[] = [];
  const finalVar = new Map<string, string>(drawn.map((c) => [c.name, varOf(c.name)]));
  const notes: string[] = [];
  for (const cut of matingCuts(spec, (a, b) => notes.push(`# skipped mutual cut cycle between ${a} and ${b}`))) {
    const host = placed.get(cut.host);
    const insert = placed.get(cut.inserted);
    if (!host || !insert) continue;
    const grown = grownLocal(insert.comp, cut.clearance, ctx);
    if (!grown) {
      notes.push(`# skipped cavity for ${cut.inserted} in ${cut.host}: ${cut.inserted} has a shape the cavity cannot follow`);
      continue;
    }
    const current = finalVar.get(cut.host)!;
    cutLines.push(`${cavVar(cut.host)} = ${current} - ${insert.placement} * ${grown}  # cavity for ${cut.inserted}, ${fmt(cut.clearance)} mm clearance`, `${cavVar(cut.host)}.label = ${JSON.stringify(cut.host)}`);
    finalVar.set(cut.host, cavVar(cut.host));
  }
  if (cutLines.length > 0 || notes.length > 0) lines.push('# ---- mating cavities', ...notes, ...cutLines, '');

  // 6. Fuse what touches; keep jointContract partners apart.
  const groups = fuseGroups(spec, drawn, placed);
  const children: string[] = [];
  const groupLines: string[] = [];
  groups.forEach((members, i) => {
    const names = members.map((c) => c.name);
    if (members.length === 1) {
      children.push(finalVar.get(names[0])!);
      return;
    }
    // Candidates by box contact; `_fuse` keeps only the ones that really share material.
    const g = `_group_${i + 1}`;
    groupLines.push(`${g} = _fuse([${names.map((n) => `(${JSON.stringify(n)}, ${finalVar.get(n)!})`).join(', ')}])`);
    children.push(`*${g}`);
  });
  lines.push('# ---- fuse parts that really touch; jointContract partners stay separate solids', ...groupLines, '');

  // 7. Result.
  lines.push(`result = Compound(children=[${children.join(', ')}], label=${JSON.stringify(spec.assemblyName || 'assembly')})`);
  return { script: `${lines.join('\n').trimEnd()}\n`, skipped };
}

/** `Pos(...) * Rot(...)` for one component: position (with its contact sink), then rotation about the min corner. */
function placementPrefix(comp: Component, tokens: [string, string, string], sink: Vec3 | undefined, ctx: TermContext): string {
  const pos = tokens.map((t, i) => offsetAxis(t, sink?.[i] ?? 0));
  const rot = vec3(comp.rotation) ?? [0, 0, 0];
  // The spec rotates about X, then Y, then Z (extrinsic), like OpenSCAD's rotate([x, y, z]).
  // build123d's Rot(x, y, z) composes differently, so chain one axis at a time, X applied first.
  const turns = [2, 1, 0]
    .map((i) => {
      const deg = ctx.term(comp.expr?.rotation?.[i], rot[i]);
      if (typeof deg === 'number' && deg === 0) return null;
      return `Rot(${[0, 1, 2].map((k) => (k === i ? emit(deg) : '0')).join(', ')})`;
    })
    .filter((t): t is string => t !== null);
  return `Pos(${pos.join(', ')})${turns.map((t) => ` * ${t}`).join('')}`;
}

/**
 * The insert grown by `g` mm on every side, local frame: its box, its cylinder, or for a profile
 * its outline (without holes) offset by `g` and extruded `g` further each way.
 */
function grownLocal(comp: Component, g: number, ctx: TermContext): string | null {
  const ext = comp.localExtents;
  if (!ext || ext.length < 3) return null;
  const [ex, ey, ez] = extentTerms(comp, ext[0], ext[1], ext[2], ctx);
  const decision = classifyComponent(comp);
  const shape = comp.shape;
  const grow = (t: Term) => add(t, 2 * g);
  if (decision.kind === 'shape' && shape && (shape.kind === 'cylinder' || shape.kind === 'tube') && shape.axis) {
    const axis = shape.axis;
    const extent = axis === 'x' ? ex : axis === 'y' ? ey : ez;
    const radius = add(div(axis === 'x' ? ey : ex, 2), g);
    const cyl = `Cylinder(${emit(radius)}, ${emit(grow(extent))}, align=(Align.CENTER, Align.CENTER, Align.MIN))`;
    const [cx, cy, cz] = [emit(div(ex, 2)), emit(div(ey, 2)), emit(div(ez, 2))];
    if (axis === 'z') return `Pos(${cx}, ${cy}, ${fmt(-g)}) * ${cyl}`;
    if (axis === 'y') return `Pos(${cx}, ${fmt(-g)}, ${cz}) * Rot(-90, 0, 0) * ${cyl}`;
    return `Pos(${fmt(-g)}, ${cy}, ${cz}) * Rot(0, 90, 0) * ${cyl}`;
  }
  if (decision.kind === 'shape' && shape && shape.kind === 'profile') {
    return `offset(${profileOuterExpr(comp, ex, ey, ez, ctx)}, amount=${fmt(g)}, kind=Kind.INTERSECTION)`;
  }
  return `Pos(${fmt(-g)}, ${fmt(-g)}, ${fmt(-g)}) * ${boxExpr(grow(ex), grow(ey), grow(ez), MIN3)}`;
}

/**
 * Connected groups of touching parts in spec order. A pair joined by a
 * jointContract never fuses, directly or through a third part.
 */
function fuseGroups(spec: AssemblySpec, drawn: Component[], placed: Map<string, Placed>): Component[][] {
  const parent = drawn.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const index = new Map(drawn.map((c, i) => [c.name, i]));
  const joints = (spec.jointContracts ?? [])
    .filter((j) => j.partA && j.partB && index.has(j.partA) && index.has(j.partB))
    .map((j) => [index.get(j.partA!)!, index.get(j.partB!)!] as const);
  const separated = (ra: number, rb: number) =>
    joints.some(([a, b]) => (find(a) === ra && find(b) === rb) || (find(a) === rb && find(b) === ra));
  const TOUCH = 1e-6;
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const a = placed.get(drawn[i].name)!;
      const b = placed.get(drawn[j].name)!;
      const touching = [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) >= -TOUCH);
      if (!touching) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra === rb || separated(ra, rb)) continue;
      parent[rb] = ra;
    }
  }
  const byRoot = new Map<number, Component[]>();
  drawn.forEach((c, i) => {
    const r = find(i);
    byRoot.set(r, [...(byRoot.get(r) ?? []), c]);
  });
  return [...byRoot.values()];
}

/**
 * Per-axis position tokens. A zero literal stays `0`; anything else becomes
 * `<name>_pos_<axis> = <expr or literal>` so one assignment moves the part.
 */
function positionTokens(comp: Component, declared: Set<string>, out: string[], ctx: TermContext): [string, string, string] {
  const position = vec3(comp.position) ?? [0, 0, 0];
  const note = comment(comp.positionNote);
  let noted = false;
  return AXES.map((axis, i) => {
    const term = ctx.term(comp.expr?.position?.[i], position[i]);
    if (term === 0) return '0';
    const rhs = emit(term);
    const name = freshName(`${comp.name}_pos_${axis}`, declared);
    const suffix = note && !noted && position[i] !== 0 ? `  # ${note}` : '';
    if (position[i] !== 0) noted = true;
    out.push(`${name} = ${rhs}${suffix}`);
    return name;
  }) as [string, string, string];
}

/** `base`, or `base_2`, `base_3` ... when `base` is taken; the result is added to `taken`. */
function freshName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

/** `0` with a negative sink becomes `-0.02`; a named axis becomes `name - 0.02`. */
function offsetAxis(token: string, delta: number): string {
  if (!delta) return token;
  const mag = fmt(Math.abs(delta));
  if (token === '0') return delta < 0 ? `-${mag}` : mag;
  return `${token} ${delta < 0 ? '-' : '+'} ${mag}`;
}

export function identifierIssue(name: string): string | null {
  // ASCII letters first: no leading underscore, so a component never collides with the script's own `_names`.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return 'not a valid Python identifier';
  return null;
}

const varOf = (name: string) => `_p_${name}`;
const cavVar = (name: string) => `_cav_${name}`;
const localVar = (name: string) => `_l_${name}`;

function indent(lines: string[], spaces: number): string[] {
  const pad = ' '.repeat(spaces);
  return lines.map((line) => (line.trim() ? pad + line : line));
}

function shift(v: Vec3, sink: Vec3 | undefined): Vec3 {
  return sink ? [v[0] + sink[0], v[1] + sink[1], v[2] + sink[2]] : v;
}

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}
