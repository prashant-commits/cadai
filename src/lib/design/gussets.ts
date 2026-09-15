import type { AssemblySpec, GussetSpec } from '../agent/assembly-spec';
import type { Bounds, Vec3 } from './placement-geometry';

/**
 * Deterministic gussets.
 *
 * A gusset is a triangular prism bracing an inside corner where a wall rises
 * (+Z) from a floor. The Architect declares it as numbers in the component's
 * LOCAL frame (corner point, the axis the corner runs along, which way the
 * floor extends, leg length, thickness, centre positions) and code emits the
 * OpenSCAD. The Drafter never models one: every transform here is fixed and
 * verified by gussets.test.ts against the compiled bounding box, which is the
 * one job the model reliably got wrong.
 */

/** How far a gusset is sunk into the wall and the floor so the union is one solid. */
export const GUSSET_SINK_MM = 0.01;

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** One OpenSCAD statement per gusset, in the component's local frame. */
export function gussetScad(g: GussetSpec, indent = ''): string[] {
  const dir = g.floorDir === '+' ? 1 : -1;
  const L = g.legMm;
  const t = g.thicknessMm;
  const [cx, cy, cz] = g.corner as Vec3;
  // Right triangle in the (floor, up) plane with the right angle at the corner,
  // extended GUSSET_SINK_MM into the wall (behind the corner) and the floor.
  const poly = `polygon([[${fmt(-dir * GUSSET_SINK_MM)}, ${fmt(-GUSSET_SINK_MM)}], [${fmt(dir * L)}, ${fmt(-GUSSET_SINK_MM)}], [${fmt(-dir * GUSSET_SINK_MM)}, ${fmt(L)}]])`;

  return g.at.map((a) => {
    if (g.along === 'x') {
      // rotate([90, 0, 90]) maps polygon (px, py) to (y, z) and the extrusion to +x.
      return `${indent}translate([${fmt(a - t / 2)}, ${fmt(cy)}, ${fmt(cz)}]) rotate([90, 0, 90]) linear_extrude(${fmt(t)}) ${poly};`;
    }
    // rotate([90, 0, 0]) maps polygon (px, py) to (x, z) and the extrusion to -y.
    return `${indent}translate([${fmt(cx)}, ${fmt(a + t / 2)}, ${fmt(cz)}]) rotate([90, 0, 0]) linear_extrude(${fmt(t)}) ${poly};`;
  });
}

/** Axis-aligned bounds of every gusset in one spec, sink excluded. Null when `at` is empty. */
export function gussetBounds(g: GussetSpec): Bounds | null {
  if (g.at.length === 0) return null;
  const dir = g.floorDir === '+' ? 1 : -1;
  const [cx, cy, cz] = g.corner as Vec3;
  const half = g.thicknessMm / 2;
  const lo = Math.min(...g.at) - half;
  const hi = Math.max(...g.at) + half;
  const floorLo = Math.min(0, dir * g.legMm);
  const floorHi = Math.max(0, dir * g.legMm);
  if (g.along === 'x') {
    return { min: [lo, cy + floorLo, cz], max: [hi, cy + floorHi, cz + g.legMm] };
  }
  return { min: [cx + floorLo, lo, cz], max: [cx + floorHi, hi, cz + g.legMm] };
}

/** The structured gussets the spec attaches to one component, with the stress point each mitigates. */
export function gussetsFor(
  spec: AssemblySpec,
  componentName: string
): Array<{ location: string; gusset: GussetSpec }> {
  const single = (spec.components?.length ?? 0) === 1;
  return (spec.stressPoints ?? [])
    .filter((s) => s.gusset && (s.component === componentName || (!s.component && single)))
    .map((s) => ({ location: s.location, gusset: s.gusset as GussetSpec }));
}
