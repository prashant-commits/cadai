import type { AssemblySpec } from './assembly-spec';
import type { SpecViolation } from './spec-audit';
import { FRAME_EPS, placedBounds, Vec3 } from '../design/placement-geometry';

/**
 * Spec-internal coherence: does the Architect's own JSON agree with itself?
 *
 * Every other audit compares compiled geometry against the spec, so it can only
 * ever catch the Drafter disagreeing with the Architect. When the Architect is
 * the one who is wrong, the Drafter implements it faithfully, the composer
 * places it faithfully, and every measurement matches - the pipeline confirms a
 * part nobody asked for. That is the failure the user sees as "the output is
 * bad", and no amount of measuring the compiled model can reach it.
 *
 * What makes it reachable is that the Architect states the assembly envelope
 * TWICE and independently: once as `boundingBox`, and once implicitly, as the
 * union of every component's `position` + `rotation` + `localExtents`. Those
 * two statements have no reason to disagree, and both are pure arithmetic over
 * numbers the model chose. Requiring them to agree forces the placement
 * arithmetic to be done twice and come out the same - which is exactly the
 * arithmetic (trigonometry, stacked heights, rotated offsets) that language
 * models get wrong, and exactly what a bounding-box-vs-reality check cannot
 * see, because a wrong spec moves both sides of that comparison together.
 *
 * It costs nothing and needs no geometry, so it runs at the spec gate, BEFORE
 * the Drafter is paid to implement a spec that is already inconsistent.
 */

/**
 * 1 mm. This compares two numbers the model wrote in the same document, not a
 * measurement, so there is no tessellation or kernel noise to absorb - only
 * the model's own rounding. Anything looser would wave through the errors this
 * exists to catch: a 60-degree joint drafted at 45 is 9 mm of height.
 */
export const COHERENCE_TOLERANCE_MM = 1.0;

const ZERO: Vec3 = [0, 0, 0];
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ImpliedEnvelope {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  /** Components that carried enough information to contribute. */
  counted: number;
}

/**
 * The assembly envelope implied by the components alone, each treated as a
 * solid box of its localExtents rotated about its own origin and moved to its
 * position - the same transform order composeAssembly emits.
 *
 * Returns null when no component declares localExtents, since then the spec
 * makes no second statement to check against.
 */
export function impliedEnvelope(spec: AssemblySpec | null): ImpliedEnvelope | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let counted = 0;

  for (const c of spec?.components ?? []) {
    const ext = c.localExtents as Vec3 | undefined;
    if (!ext || ext.some((n) => !Number.isFinite(n))) continue;
    const placed = placedBounds(
      { min: ZERO, max: ext },
      (c.position ?? ZERO) as Vec3,
      (c.rotation ?? ZERO) as Vec3
    );
    for (let i = 0; i < 3; i++) {
      if (placed.min[i] < min[i]) min[i] = placed.min[i];
      if (placed.max[i] > max[i]) max[i] = placed.max[i];
    }
    counted++;
  }

  if (counted === 0) return null;
  return {
    min: min.map(round2) as Vec3,
    max: max.map(round2) as Vec3,
    size: [0, 1, 2].map((i) => round2(max[i] - min[i])) as Vec3,
    counted,
  };
}

/** boundingBox names its axes; placement is indexed. This is the one mapping. */
const AXES: { key: 'width' | 'length' | 'height'; index: 0 | 1 | 2; label: string }[] = [
  { key: 'width', index: 0, label: 'x' },
  { key: 'length', index: 1, label: 'y' },
  { key: 'height', index: 2, label: 'z' },
];

/**
 * Audits the spec against itself. Pure: no compile, no geometry, no model call.
 *
 * `boundingBox` disagreeing with the placements is an error, because one of the
 * two is wrong and the Architect is the only one who can say which.
 *
 * The assembly sitting off the x/y origin is a warning, not an error: z = 0 is
 * the build plate and physical, but x and y are only a convention, and a part
 * that is 10 mm along x prints exactly the same. It is still worth saying,
 * because an unexplained offset usually means a position was derived wrongly.
 */
export function auditSpecCoherence(spec: AssemblySpec | null): SpecViolation[] {
  const violations: SpecViolation[] = [];
  const implied = impliedEnvelope(spec);
  if (!spec || !implied) return violations;

  const declared = spec.boundingBox;
  if (declared) {
    for (const { key, index, label } of AXES) {
      const stated = declared[key];
      if (typeof stated !== 'number' || !Number.isFinite(stated)) continue;
      const delta = Math.abs(stated - implied.size[index]);
      if (delta <= COHERENCE_TOLERANCE_MM) continue;
      violations.push({
        kind: 'coherence',
        field: `boundingBox.${key}`,
        expected: stated,
        measured: implied.size[index],
        deltaMm: round2(delta),
        tolerance: COHERENCE_TOLERANCE_MM,
        severity: 'error',
        message:
          `The spec contradicts itself on ${label}: boundingBox.${key} says ${stated} mm, but the ` +
          `components' own positions, rotations and localExtents span ${implied.size[index]} mm ` +
          `(delta ${round2(delta)} mm). Recompute the placement arithmetic and make the two agree - ` +
          'one of them is wrong, and nothing downstream can tell which.',
      });
    }
  }

  for (const { index, label } of AXES) {
    if (index === 2) continue; // z = 0 is the build plate; auditPlacement owns it.
    const m = implied.min[index];
    if (Math.abs(m) <= FRAME_EPS) continue;
    violations.push({
      kind: 'coherence',
      field: `assembly.min.${label}`,
      expected: 0,
      measured: m,
      deltaMm: round2(Math.abs(m)),
      severity: 'warning',
      message:
        `The assembly's lowest ${label} is ${m} mm, not 0: every part is offset from the origin along ${label}. ` +
        'Positions place a component\'s min corner in assembly coordinates, so unless this offset is ' +
        'deliberate, a position was derived from the wrong reference.',
    });
  }

  return violations;
}
