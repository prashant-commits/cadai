import type { AssemblySpec, HoleSpec } from './assembly-spec';
import type { SpecViolation } from './spec-audit';
import { checkInterference } from '../engine/assembly-verifier';
import type { ModuleFrame } from '../engine/module-frames';
import { FRAME_EPS, isZeroVec, Vec3 } from '../design/placement-geometry';

/**
 * Verifies that every hole the Architect declared is actually in the compiled
 * part, at the declared place and roughly the declared size.
 *
 * Holes are invisible to every other check in the pipeline. Deleting one,
 * moving it to the opposite end of the plate or opening it from M3 to 8 mm
 * leaves the bounding box, the shell count, the manifold verdict, the overhang
 * and the declared localExtents all unchanged, so the audit passes a part whose
 * defining feature is wrong. The measured-geometry checks cannot reach inside a
 * module; the only way in is to ask the geometry a direct question.
 *
 * Two probes per hole, each an intersection compiled in wasm:
 *
 *   BORE - a cylinder slightly narrower than the hole, down the hole's axis.
 *   It must find no material. Material there means the hole is missing,
 *   displaced, or drilled along the wrong axis.
 *
 *   RIM - a thin annulus just outside the nominal radius. It must find
 *   material. Void there means the hole is wider than declared.
 *
 * Together they pin both position and size from opposite directions, which
 * neither probe does alone: a bore probe passes an oversized hole, and a rim
 * probe passes a hole that was never drilled at all.
 */

/**
 * Probe clearances, in fractions of the nominal diameter and in mm.
 *
 * The bore probe is deliberately narrower than the hole and the rim probe
 * deliberately outside it, so that ordinary tolerance - a 3.4 mm hole drafted
 * at 3.5, a centre rounded to 0.1 mm - never registers. What must register is
 * a hole in the wrong place or off by a size class, and those are far outside
 * these margins.
 */
export const BORE_PROBE_FRACTION = 0.7;
export const RIM_INNER_MARGIN_MM = 0.4;
export const RIM_OUTER_MARGIN_MM = 1.2;

/** Below this a probe hit is tessellation noise on the bore wall, not material. */
export const BORE_NOISE_MM3 = 0.5;
/** A rim probe finding less than this has no wall where the spec wants one. */
export const RIM_MIN_MATERIAL_MM3 = 0.5;

/**
 * Each probe is a wasm compile, and compileScad builds a fresh instance every
 * time, so probe count is a real cost inside the repair loop. Matches
 * MAX_INTERFERENCE_CHECKS: the first few holes are the load-bearing ones.
 */
export const MAX_HOLE_CHECKS = 4;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rotation that turns OpenSCAD's +Z cylinder onto the hole's axis. */
function axisRotation(axis: HoleSpec['axis']): string {
  if (axis === 'x') return 'rotate([0, 90, 0]) ';
  if (axis === 'y') return 'rotate([-90, 0, 0]) ';
  return '';
}

/**
 * Where a probe of length `len` starts. `at` is the centre of the hole's mouth
 * on the face it enters, and the hole runs INTO the part: a mouth near
 * coordinate 0 bores toward +axis, one near `extent` bores toward -axis (the
 * rule blockout-scad.ts and geometry.ts cut and draw by). Without a known
 * extent the mouth is taken to be on the min face.
 */
function probeOrigin(h: HoleSpec, extent: number | undefined, len: number): number[] {
  const i = h.axis === 'x' ? 0 : h.axis === 'y' ? 1 : 2;
  const along = h.at[i];
  const fromMin = extent === undefined || Math.abs(along) <= Math.abs(along - extent);
  const origin = [...h.at];
  origin[i] = fromMin ? along : along - len;
  return origin;
}

/**
 * A probe solid at the hole, as an instantiation string.
 *
 * `depth` is the span along the axis. It is overshot at both ends so a probe
 * never ends exactly on the part's surface, where coincident faces make CGAL's
 * answer depend on rounding. `extent` is the component's size along the hole's
 * axis, which decides which face the mouth is on.
 */
export function boreProbe(h: HoleSpec, extent?: number, fn = 32): string {
  const len = (h.depth ?? 1000) + 0.04; // 1000 mm: longer than any part, so a through-hole probe spans it; 0.04 mm = 0.02 mm overshoot at each end
  const origin = probeOrigin(h, extent, h.depth ?? 1000);
  return (
    `translate([${origin.map(round2).join(', ')}]) ${axisRotation(h.axis)}` +
    `translate([0, 0, -0.02]) cylinder(d = ${round2(h.d * BORE_PROBE_FRACTION)}, h = ${round2(len)}, $fn = ${fn});`
  );
}

/**
 * The rim probe stops short of a through-hole's far end, because the annulus
 * would otherwise stick out past the part and find nothing there either way.
 */
export function rimProbe(h: HoleSpec, extent?: number, fn = 32): string {
  const len = h.depth ?? 1000; // 1000 mm: as in boreProbe
  const origin = probeOrigin(h, extent, len);
  const inner = round2(h.d + RIM_INNER_MARGIN_MM);
  const outer = round2(h.d + RIM_OUTER_MARGIN_MM);
  return (
    `translate([${origin.map(round2).join(', ')}]) ${axisRotation(h.axis)}` +
    `difference() { ` +
    `cylinder(d = ${outer}, h = ${round2(len)}, $fn = ${fn}); ` +
    `translate([0, 0, -0.01]) cylinder(d = ${inner}, h = ${round2(len + 0.02)}, $fn = ${fn}); ` +
    `}`
  );
}

const describe = (h: HoleSpec, c: string) =>
  `the ${h.d} mm hole on ${c} at [${h.at.join(', ')}] along ${h.axis}` + (h.note ? ` (${h.note})` : '');

/**
 * Probes every declared hole. `code` must carry the component modules; the
 * probes call each module in its own local frame, so placement is irrelevant
 * here and a hole is checked in the frame the Architect declared it in.
 *
 * An indeterminate probe (a compile that failed for its own reasons) is
 * skipped rather than reported: a probe that cannot answer must not invent a
 * defect in a part that may be fine.
 */
export async function auditHoles(
  code: string,
  spec: AssemblySpec | null,
  frames: ModuleFrame[] = []
): Promise<SpecViolation[]> {
  const violations: SpecViolation[] = [];
  const jobs: { component: string; hole: HoleSpec; extent: number | undefined }[] = [];
  for (const c of spec?.components ?? []) {
    for (const hole of c.holes ?? []) {
      const axisIndex = hole.axis === 'x' ? 0 : hole.axis === 'y' ? 1 : 2;
      jobs.push({ component: c.name, hole, extent: c.localExtents?.[axisIndex] });
    }
  }
  if (jobs.length === 0) return violations;

  // The composer corrects a module whose min corner is not at its origin, and
  // the spec's hole coordinates describe the CORRECTED part. Probing the raw
  // module would then report a displaced hole on a part that compiles
  // perfectly - a false alarm on the one defect the composer already fixes -
  // so the probe is corrected the same way the placement is.
  const byName = new Map(frames.map((f) => [f.name, f]));

  const checked = jobs.slice(0, MAX_HOLE_CHECKS);
  const callFor = (component: string) => {
    const frame = byName.get(component);
    const correction: Vec3 = frame?.valid
      ? (frame.min.map((v) => (Math.abs(v) <= FRAME_EPS ? 0 : -v)) as Vec3)
      : [0, 0, 0];
    return isZeroVec(correction)
      ? `${component}();`
      : `translate([${correction.join(', ')}]) ${component}();`;
  };

  // Fast path: probe every bore of a component in ONE compile. When the part is
  // right - which is the common case, and the case that runs on every attempt
  // of every repair loop - that single empty intersection clears all of its
  // holes at once. Only a component that fails it pays for per-hole probes to
  // say which hole, and only holes with an open bore pay for a rim probe.
  const suspect = new Set<string>();
  for (const component of new Set(checked.map((j) => j.component))) {
    const inComponent = checked.filter((j) => j.component === component);
    const holes = inComponent.map((j) => j.hole);
    const probe = `union() { ${inComponent.map((j) => boreProbe(j.hole, j.extent)).join(' ')} }`;
    const all = await checkInterference(code, callFor(component), probe);
    if (all.error || (all.intersectionVolumeMm3 ?? 0) > BORE_NOISE_MM3 * holes.length) {
      suspect.add(component);
    }
  }

  for (const { component, hole, extent } of checked) {
    const call = callFor(component);

    const bore = suspect.has(component)
      ? await checkInterference(code, call, boreProbe(hole, extent))
      : { error: undefined, intersectionVolumeMm3: 0 };
    if (!bore.error && (bore.intersectionVolumeMm3 ?? 0) > BORE_NOISE_MM3) {
      violations.push({
        kind: 'feature',
        field: `${component}.hole@[${hole.at.join(',')}]`,
        expected: 'an open bore',
        measured: `${round2(bore.intersectionVolumeMm3!)} mm3 of solid material in the bore`,
        deltaMm: undefined,
        severity: 'error',
        message:
          `${describe(hole, component)} is not there: a probe down its axis hit ` +
          `${round2(bore.intersectionVolumeMm3!)} mm3 of solid material. The hole is missing, at a different ` +
          'position, or drilled along a different axis. Cut it where the spec declares it.',
      });
      continue;
    }
    if (bore.error) continue;

    const rim = await checkInterference(code, call, rimProbe(hole, extent));
    if (rim.error) continue;
    const wall = rim.intersectionVolumeMm3 ?? 0;
    if (wall < RIM_MIN_MATERIAL_MM3) {
      violations.push({
        kind: 'feature',
        field: `${component}.hole@[${hole.at.join(',')}]`,
        expected: `material just outside d = ${hole.d} mm`,
        measured: `${round2(wall)} mm3`,
        severity: 'error',
        message:
          `${describe(hole, component)} is wider than declared: there is no material in the ring just ` +
          `outside ${hole.d} mm, so the bore is at least ${round2(hole.d + RIM_INNER_MARGIN_MM)} mm across. ` +
          'Cut it to the declared diameter - an oversized hole loses the fit the spec was sized for.',
      });
    }
  }

  return violations;
}
