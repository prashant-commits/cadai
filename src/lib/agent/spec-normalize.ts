import type { AssemblySpec } from './assembly-spec';
import { resolveSpec } from './spec-expr';
import { impliedEnvelope } from './spec-coherence';
import { identifierIssue } from '../spec-sheet/blockout-scad';


/** "Wall Mount Backplate" -> "wall_mount_backplate"; always a valid OpenSCAD identifier. */
export function toSnakeCase(name: string): string {
  const s = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  if (!s) return 'part';
  return /^[a-z]/.test(s) ? s : `part_${s}`;
}

export type NormalizedAssemblySpec = AssemblySpec & {
  boundingBox: { width: number; length: number; height: number };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** An expression term moved by -min with the outline; a literal (null) was already shifted as a number. */
const shiftTerm = (term: string | null, min: number): string | null => {
  if (term === null || min === 0) return term;
  return min < 0 ? `(${term}) + ${round2(Math.abs(min))}` : `(${term}) - ${round2(min)}`;
};

/**
 * Makes a parsed spec usable by deterministic code: component names become
 * module identifiers (with every reference renamed to match), every component
 * has a position. Applied to what the Architect returns and to what the client
 * sends back from the spec gate, so downstream code never sees "Cup Receptacle".
 */
export function normalizeSpec(rawSpec: AssemblySpec): NormalizedAssemblySpec {
  // Expression strings become numbers first, so every step below (and every consumer) sees numbers.
  // Unresolvable fields are left at 0 here; auditSpecCoherence reports them to the Architect's retry.
  const resolved = resolveSpec(rawSpec);
  const spec = resolved.spec;
  const rename = new Map<string, string>();
  const prose = new Set<string>();
  const used = new Set<string>();

  const components = (spec.components ?? []).map((c) => {
    // A name that shadows an OpenSCAD builtin (hull, cube, offset ...) cannot be a
    // module name, so it gets a suffix; every reference follows via `rename`.
    const snake = toSnakeCase(c.name);
    const base = identifierIssue(snake) ? `${snake}_part` : snake;
    // The sheet's prose is rewritten only for format renames ("Wall Mount" ->
    // wall_mount); a builtin suffix would turn "the cylinder" into "the cylinder_part".
    if (base === snake) prose.add(c.name);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    rename.set(c.name, name);
    return {
      ...c,
      name,
      position: c.position ?? [0, 0, 0]
    };
  });

  const normalizedComponents = components.map((c) => {
    if (resolved.errors.length > 0) return c;
    if (c.shape?.kind !== 'profile' || !c.shape.plane || !c.shape.points || c.shape.points.length === 0) {
      return c;
    }

    // L1: If no localExtents, leave the profile alone so the shape error still fires
    if (!c.localExtents || !Array.isArray(c.localExtents) || c.localExtents.length < 3) {
      return c;
    }

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [u, v] of c.shape.points) {
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    if (!Number.isFinite(minU) || !Number.isFinite(minV)) return c;

    const sizeU = round2(maxU - minU);
    const sizeV = round2(maxV - minV);

    const shiftedPoints = c.shape.points.map(([u, v]) => [round2(u - minU), round2(v - minV)]);
    const shiftedHoles = c.shape.holes?.map((hole) =>
      hole.map(([u, v]) => [round2(u - minU), round2(v - minV)])
    );

    const [ex = 0, ey = 0, ez = 0] = (c.localExtents ?? []) as number[];
    let localExtents: [number, number, number];
    let uAxis: 0 | 1 | 2;
    let vAxis: 0 | 1 | 2;
    if (c.shape.plane === 'xy') {
      localExtents = [sizeU, sizeV, ez];
      uAxis = 0;
      vAxis = 1;
    } else if (c.shape.plane === 'xz') {
      localExtents = [sizeU, ey, sizeV];
      uAxis = 0;
      vAxis = 2;
    } else {
      localExtents = [ex, sizeU, sizeV];
      uAxis = 1;
      vAxis = 2;
    }

    // M3: Shift component holes with the outline
    let shiftedComponentHoles = c.holes;
    let shiftedExpr = c.expr ? { ...c.expr } : undefined;

    if (c.holes && (minU !== 0 || minV !== 0)) {
      shiftedComponentHoles = c.holes.map((h) => {
        const at = Array.isArray(h.at) ? ([...h.at] as [number, number, number]) : h.at;
        if (at) {
          if (minU !== 0) at[uAxis] = round2(at[uAxis] - minU);
          if (minV !== 0) at[vAxis] = round2(at[vAxis] - minV);
        }
        return { ...h, at };
      });

      if (shiftedExpr?.holes) {
        shiftedExpr = {
          ...shiftedExpr,
          holes: shiftedExpr.holes.map((he) => {
            if (!he.at) return he;
            const at = [...he.at];
            if (minU !== 0 && at[uAxis]) {
              at[uAxis] = minU < 0
                ? `(${at[uAxis]}) + ${round2(Math.abs(minU))}`
                : `(${at[uAxis]}) - ${round2(minU)}`;
            }
            if (minV !== 0 && at[vAxis]) {
              at[vAxis] = minV < 0
                ? `(${at[vAxis]}) + ${round2(Math.abs(minV))}`
                : `(${at[vAxis]}) - ${round2(minV)}`;
            }
            return { ...he, at };
          }),
        };
      }
    }

    // The kept outline expressions follow the shift, so a parametric outline stays parametric
    // (and a second resolve of this spec does not undo the shift).
    if (shiftedExpr?.outline || shiftedExpr?.outlineHoles) {
      const shiftPoint = (pt: (string | null)[]) => [
        shiftTerm(pt[0], minU),
        shiftTerm(pt[1], minV),
      ];
      shiftedExpr = {
        ...shiftedExpr,
        ...(shiftedExpr.outline ? { outline: shiftedExpr.outline.map(shiftPoint) } : {}),
        ...(shiftedExpr.outlineHoles ? { outlineHoles: shiftedExpr.outlineHoles.map((h) => h.map(shiftPoint)) } : {}),
      };
    }

    // H1: Null out in-plane expr.localExtents entries that disagree with the outline by > 0.5 mm
    if (shiftedExpr?.localExtents) {
      const leExpr = [...shiftedExpr.localExtents] as (string | null)[];
      const checkAxis = (axis: number, outlineSize: number) => {
        const currentVal = c.localExtents![axis];
        if (typeof currentVal === 'number' && Math.abs(currentVal - outlineSize) > 0.5) {
          leExpr[axis] = null;
        }
      };
      checkAxis(uAxis, sizeU);
      checkAxis(vAxis, sizeV);
      if (leExpr.every((x) => x === null || x === undefined)) {
        const restExpr = { ...shiftedExpr };
        delete restExpr.localExtents;
        shiftedExpr = Object.keys(restExpr).length > 0 ? restExpr : undefined;
      } else {
        shiftedExpr = { ...shiftedExpr, localExtents: leExpr };
      }
    }

    const updated = {
      ...c,
      localExtents,
      holes: shiftedComponentHoles,
      shape: {
        ...c.shape,
        points: shiftedPoints,
        ...(c.shape.holes ? { holes: shiftedHoles } : {}),
      },
    };
    if (shiftedExpr) {
      updated.expr = shiftedExpr;
    } else {
      delete updated.expr;
    }
    return updated;
  });

  const ref = (x?: string) => (x === undefined ? undefined : rename.get(x) ?? x);
  
  let sheet = spec.sheet;
  if (sheet) {
    const sortedNames = Array.from(rename.keys()).filter((n) => prose.has(n)).sort((a, b) => b.length - a.length);
    for (const oldName of sortedNames) {
      const newName = rename.get(oldName)!;
      if (oldName === newName) continue;
      const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sheet = sheet.replace(new RegExp(`\\b${escaped}\\b`, 'g'), newName);
    }
  }

  // The assembly envelope is derived from the components: the model's separately declared box is
  // a second place to get arithmetic wrong. Code derives it from impliedEnvelope when it can be computed
  // (literal specs included), falling back to the declared box, else zeros.
  // M1: When resolution has errors, fall back to the box implied by the partly resolved components
  // (never 0x0x0 if any component has extents).
  let boundingBox: { width: number; length: number; height: number };
  if (resolved.errors.length === 0) {
    const envelope = impliedEnvelope({ ...spec, components: normalizedComponents });
    boundingBox = envelope
      ? { width: envelope.size[0], length: envelope.size[1], height: envelope.size[2] }
      : (spec.boundingBox ?? { width: 0, length: 0, height: 0 });
  } else {
    if (spec.boundingBox) {
      boundingBox = spec.boundingBox;
    } else {
      const partialEnvelope = impliedEnvelope({ ...spec, components: normalizedComponents });
      boundingBox = partialEnvelope
        ? { width: partialEnvelope.size[0], length: partialEnvelope.size[1], height: partialEnvelope.size[2] }
        : { width: 0, length: 0, height: 0 };
    }
  }

  return {
    ...spec,
    sheet,
    boundingBox,
    components: normalizedComponents,
    guides: spec.guides ?? [],
    jointContracts: spec.jointContracts?.map((j) => ({ ...j, partA: ref(j.partA), partB: ref(j.partB) })),
    stressPoints: (spec.stressPoints ?? []).map((s) => ({ ...s, component: ref(s.component) })),
  };
}
