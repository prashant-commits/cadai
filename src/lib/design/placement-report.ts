import type { AssemblySpec } from '../agent/assembly-spec';
import type { ModuleFrame } from '../engine/module-frames';
import { FRAME_EPS, isZeroVec, placedBounds, Vec3 } from './placement-geometry';

/** One component's measured local frame and where the spec puts it. */
export interface PlacementComponent {
  name: string;
  /** False when the module could not be compiled alone; placed bounds are meaningless then. */
  measured: boolean;
  localMin: Vec3;
  localMax: Vec3;
  size: Vec3;
  /** translate() applied inside the placement so the module's min corner lands on its origin. */
  correction: Vec3;
  position: Vec3;
  rotation: Vec3;
  placedMin: Vec3;
  placedMax: Vec3;
  /** Gussets code generated for this component from the spec's stress points. */
  gussets?: number;
}

export interface PlacementReport {
  /** True when the code carries the generated placement block. */
  composed: boolean;
  /** Model-written top-level statements the composer removed. */
  removedStatements: number;
  components: PlacementComponent[];
  notes?: string[];
}

const ZERO: Vec3 = [0, 0, 0];
const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildPlacementComponents(
  spec: AssemblySpec,
  frames: ModuleFrame[],
  correct: boolean
): PlacementComponent[] {
  const byName = new Map(frames.map((f) => [f.name, f]));
  return (spec.components ?? []).map((c) => {
    const position = (c.position ?? ZERO) as Vec3;
    const rotation = (c.rotation ?? ZERO) as Vec3;
    const frame = byName.get(c.name);
    if (!frame?.valid) {
      return {
        name: c.name, measured: false, localMin: ZERO, localMax: ZERO, size: ZERO,
        correction: ZERO, position, rotation, placedMin: position, placedMax: position,
      };
    }
    const correction: Vec3 = correct
      ? (frame.min.map((v) => (Math.abs(v) <= FRAME_EPS ? 0 : -v)) as Vec3)
      : ZERO;
    const placed = placedBounds({ min: frame.min, max: frame.max }, position, rotation, correction);
    return {
      name: c.name, measured: true, localMin: frame.min, localMax: frame.max, size: frame.size,
      correction, position, rotation,
      placedMin: placed.min.map(round2) as Vec3, placedMax: placed.max.map(round2) as Vec3,
    };
  });
}

function overlap1d(aMin: number, aMax: number, bMin: number, bMax: number, eps: number): boolean {
  return aMin <= bMax + eps && bMin <= aMax + eps;
}

function touches(a: PlacementComponent, b: PlacementComponent, eps: number): boolean {
  return [0, 1, 2].every((i) => overlap1d(a.placedMin[i], a.placedMax[i], b.placedMin[i], b.placedMax[i], eps));
}

/** Vertical gap from a part's underside to the nearest thing beneath it (floor or a part it overlaps in XY). */
function gapBelow(c: PlacementComponent, all: PlacementComponent[], eps: number): number {
  let gap = c.placedMin[2];
  for (const o of all) {
    if (o === c) continue;
    const xy =
      overlap1d(c.placedMin[0], c.placedMax[0], o.placedMin[0], o.placedMax[0], eps) &&
      overlap1d(c.placedMin[1], c.placedMax[1], o.placedMin[1], o.placedMax[1], eps);
    if (!xy) continue;
    const g = c.placedMin[2] - o.placedMax[2];
    if (g >= 0 && g < gap) gap = g;
  }
  return round2(gap);
}

/**
 * Support graph over axis-aligned boxes: a part is grounded when it sits on
 * the floor (min z <= eps) or touches a grounded part. Everything else floats.
 * Boxes over-approximate contact between concave parts, so this can miss a
 * gap between two L-shapes whose boxes overlap - but it never invents one.
 */
export function findFloating(
  components: PlacementComponent[],
  eps: number = FRAME_EPS
): Array<{ name: string; gapMm: number }> {
  const measured = components.filter((c) => c.measured);
  const grounded = new Set(measured.filter((c) => c.placedMin[2] <= eps).map((c) => c.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of measured) {
      if (grounded.has(c.name)) continue;
      if (measured.some((g) => grounded.has(g.name) && touches(c, g, eps))) {
        grounded.add(c.name);
        grew = true;
      }
    }
  }
  return measured
    .filter((c) => !grounded.has(c.name))
    .map((c) => ({ name: c.name, gapMm: gapBelow(c, measured, eps) }));
}

const vec = (v: Vec3) => `[${v.map(round2).join(', ')}]`;

/** One markdown sentence for the progress feed. Never JSON. */
export function placementSummary(report: PlacementReport | null, modelMinZ: number | null): string {
  const parts: string[] = [];
  if (report) {
    const measured = report.components.filter((c) => c.measured);
    parts.push(
      report.composed
        ? `placed ${report.components.length} component(s) from the spec`
        : 'placement was not composed from the spec'
    );
    if (report.removedStatements > 0) parts.push(`removed ${report.removedStatements} model-written top-level statement(s)`);
    const gussets = report.components.reduce((n, c) => n + (c.gussets ?? 0), 0);
    if (gussets > 0) parts.push(`generated ${gussets} gusset(s) from the spec`);
    const off = measured.filter((c) => !isZeroVec(c.localMin));
    if (off.length > 0) {
      parts.push(
        `modules off their origin: ${off.map((c) => `${c.name} ${vec(c.localMin)}`).join(', ')}` +
          (off.some((c) => !isZeroVec(c.correction)) ? ' (corrected)' : '')
      );
    }
    if (report.composed) {
      const floating = findFloating(report.components);
      if (floating.length > 0) parts.push(`floating: ${floating.map((f) => `${f.name} (${f.gapMm} mm gap)`).join(', ')}`);
    }
    if (report.notes && report.notes.length > 0) {
      parts.push(...report.notes);
    }
  }
  if (modelMinZ !== null) parts.push(`lowest point is at z = ${round2(modelMinZ)} mm`);
  return `Placement check: ${parts.join('; ') || 'nothing to measure'}.`;
}
