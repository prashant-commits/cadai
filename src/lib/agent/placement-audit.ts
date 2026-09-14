import type { AssemblySpec } from './assembly-spec';
import type { SpecViolation } from './spec-audit';
import { findFloating, PlacementReport } from '../design/placement-report';
import { FRAME_EPS, isZeroVec, Vec3 } from '../design/placement-geometry';

const vec = (v: Vec3) => `[${v.map((n) => Math.round(n * 100) / 100).join(', ')}]`;

/**
 * Turns the placement report and the compiled model's bounding box into
 * violations. `floor` is spec-independent (it only needs the model's min z);
 * `floating` needs composed placement, because only then do the per-part
 * boxes describe what was actually compiled.
 *
 * `spec` is reserved for the extents check added with localExtents.
 */
export function auditPlacement(
  report: PlacementReport | null,
  modelMin: Vec3 | null,
  spec: AssemblySpec | null
): SpecViolation[] {
  const violations: SpecViolation[] = [];
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Rule: nothing is ever below the build plate. Name each offending part when
  // the report knows them; fall back to the whole-model check otherwise.
  const below = (report?.components ?? []).filter((c) => c.measured && c.placedMin[2] < -FRAME_EPS);
  for (const c of below) {
    const depth = round2(-c.placedMin[2]);
    violations.push({
      kind: 'floor',
      field: c.name,
      expected: 'min z >= 0',
      measured: `${-depth} mm`,
      deltaMm: depth,
      severity: 'error',
      message:
        `'${c.name}' extends ${depth} mm below the build plate (z = 0). Nothing may ever be below the plate: ` +
        'raise its spec position or fix its module\'s local frame.',
    });
  }

  if (below.length === 0 && modelMin && Math.abs(modelMin[2]) > FRAME_EPS) {
    const z = round2(modelMin[2]);
    violations.push({
      kind: 'floor',
      field: 'boundingBox.min.z',
      expected: 0,
      measured: z,
      deltaMm: Math.abs(z),
      severity: 'error',
      message:
        z < 0
          ? `The compiled model extends ${-z} mm below the build plate (z = 0). Nothing may ever be below the plate.`
          : `The lowest point of the compiled model hovers ${z} mm above the build plate. The model must rest on z = 0.`,
    });
  }

  // Extents: the module the Drafter built must be the size the Architect
  // declared, or every position computed from those sizes is wrong too.
  if (report && spec?.components) {
    const approved = !!spec.specApprovedAt;
    const absTol = approved ? 1.0 : 5.0;
    const byName = new Map(report.components.map((c) => [c.name, c]));
    for (const sc of spec.components) {
      const ext = sc.localExtents as Vec3 | undefined;
      const c = byName.get(sc.name);
      if (!ext || !c?.measured) continue;
      (['x', 'y', 'z'] as const).forEach((axis, i) => {
        const delta = Math.abs(ext[i] - c.size[i]);
        if (delta <= 1.0) return;
        const relative = ext[i] > 0 ? delta / ext[i] : Infinity;
        const gross = approved || delta > absTol || relative > 0.2;
        violations.push({
          kind: 'extents',
          field: `${sc.name}.${axis}`,
          expected: ext[i],
          measured: c.size[i],
          deltaMm: round2(delta),
          tolerance: approved ? 1.0 : absTol,
          severity: gross ? 'error' : 'warning',
          message:
            `module ${sc.name}() measures ${c.size[i]} mm along ${axis} but the spec's localExtents say ${ext[i]} mm ` +
            `(delta ${delta.toFixed(2)} mm). Resize the module; do not move it.`,
        });
      });
    }
  }

  if (!report) return violations;

  for (const c of report.components) {
    if (!c.measured || isZeroVec(c.localMin)) continue;
    violations.push({
      kind: 'local_frame',
      field: c.name,
      expected: '[0, 0, 0]',
      measured: vec(c.localMin),
      severity: 'warning',
      message:
        `module ${c.name}() has its min corner at ${vec(c.localMin)} instead of the origin` +
        (isZeroVec(c.correction)
          ? '; its spec position lands the part offset by that much.'
          : `; placement corrected it by ${vec(c.correction)}.`),
    });
  }

  if (report.composed) {
    for (const f of findFloating(report.components)) {
      violations.push({
        kind: 'floating',
        field: f.name,
        expected: 'resting on the floor or on another component',
        measured: `${f.gapMm} mm gap below`,
        deltaMm: f.gapMm,
        severity: 'error',
        message:
          `'${f.name}' does not rest on the floor or on any other part (${f.gapMm} mm gap below it). ` +
          'Fix its spec position or its module\'s local frame.',
      });
    }
  }

  return violations;
}
