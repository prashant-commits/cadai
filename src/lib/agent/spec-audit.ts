import { AssemblySpec } from './assembly-spec';
import { ValidationResult, SILENT_CORRUPTION_CODES } from '../engine/scad-compiler';
import { ModelInfo, DesignContract } from '@/types';

export interface SpecViolation {
  kind:
    | 'compile'
    | 'bbox'
    | 'manifold'
    | 'shells'
    | 'empty'
    | 'dimensionality'
    | 'buildplate'
    | 'interference'
    | 'clearance'
    | 'unknown_symbol'
    | 'standing'
    /** Emitted by the Design Inspector from rendered views. Always a warning. */
    | 'visual';
  field: string;
  expected: number | string | boolean;
  measured: number | string | boolean;
  deltaMm?: number;
  tolerance?: number;
  severity: 'error' | 'warning';
  message: string;
}

import { checkStanding } from '../design/contract';
import { parseParams } from '../design/parse-params';

/** A bbox axis fails hard only when it is both grossly and absolutely wrong. */
const BBOX_ABS_TOLERANCE_MM = 5;
const BBOX_REL_TOLERANCE = 0.2;

const TRUSTED_BBOX_ABS_TOLERANCE_MM = 1.0;

/**
 * Compares the compiled reality against the Architect's declared intent.
 *
 * `modelInfo` is null when the compile produced no measurable geometry; every
 * geometric check is skipped in that case and the compile failure carries the signal.
 */
export function auditSpec(
  spec: AssemblySpec | null,
  modelInfo: ModelInfo | null,
  validation: ValidationResult,
  code?: string,
  contract?: DesignContract
): SpecViolation[] {
  const violations: SpecViolation[] = [];

  if (!validation.valid) {
    violations.push({
      kind: 'compile',
      field: 'exitCode',
      expected: 0,
      measured: validation.exitCode,
      severity: 'error',
      message: validation.error
        ? `Compilation failed: ${validation.error}`
        : 'Compilation failed or produced no printable geometry.',
    });
  }

  // Silent corruption: OpenSCAD only warns, but the emitted solid is not the one
  // the model described. This is the failure class the compiler cannot fail on
  // its own, so promote it here.
  for (const w of validation.warnings) {
    if (w.code && SILENT_CORRUPTION_CODES.includes(w.code)) {
      violations.push({
        kind: 'unknown_symbol',
        field: w.code,
        expected: 'all identifiers declared before use',
        measured: w.message,
        severity: 'error',
        message:
          `${w.message}${w.line !== undefined ? ` (line ${w.line})` : ''}` +
          `${w.count > 1 ? ` [x${w.count}]` : ''}` +
          ' - OpenSCAD silently substituted undef here, so the rendered solid is NOT the intended geometry. Declare the identifier or remove the reference.',
      });
    }
  }

  // Dimensionality. Only meaningful when OpenSCAD actually reported it.
  const reportedDims = validation.summary?.dimensions;
  if (reportedDims !== undefined && reportedDims !== 3) {
    violations.push({
      kind: 'dimensionality',
      field: 'dimensions',
      expected: 3,
      measured: reportedDims,
      severity: 'error',
      message: `Top-level object is ${reportedDims}D, not a 3D solid. Extrude 2D profiles with linear_extrude() or rotate_extrude().`,
    });
  }

  const params = code ? parseParams(code) : [];

  // Contract enforcement: Standing bounds and Pin survival
  if (contract) {
    violations.push(...checkStanding(params, modelInfo, contract.standing));

    // Pin survival
    for (const [name, pin] of Object.entries(contract.pinnedParams)) {
      const p = params.find(param => param.name === name);
      if (!p) {
        violations.push({
          kind: 'standing',
          field: name,
          expected: pin.value,
          measured: 'missing',
          severity: 'error',
          message: `The user pinned parameter '${name}' to ${pin.value}, but it was removed or incorrectly formatted in the code.`
        });
      } else if (p.value !== pin.value) {
        violations.push({
          kind: 'standing',
          field: name,
          expected: pin.value,
          measured: p.value as any,
          severity: 'error',
          message: `The user pinned parameter '${name}' to ${pin.value}, but the code emitted ${p.value}. You must honor pinned values exactly.`
        });
      }
    }
  }

  if (!modelInfo) {
    return violations;
  }

  // CGAL's own 2-manifold verdict (summary.simple), when the backend reported one.
  if (modelInfo.isManifold === false) {
    violations.push({
      kind: 'manifold',
      field: 'isManifold',
      expected: true,
      measured: false,
      severity: 'error',
      message:
        'Model is not a valid 2-manifold. Check for coincident faces and zero-thickness membranes; extend difference() cutting tools by +0.02mm.',
    });
  }

  // Shell count is independent of manifoldness: a perfectly manifold result can
  // still have fallen into disconnected pieces.
  if (modelInfo.shellCount !== undefined) {
    const expectedShells = spec && spec.components && spec.components.length > 0 ? spec.components.length : 1;
    if (modelInfo.shellCount > expectedShells) {
      violations.push({
        kind: 'shells',
        field: 'shellCount',
        expected: expectedShells,
        measured: modelInfo.shellCount,
        severity: 'error',
        message: `Model split into ${modelInfo.shellCount} disconnected shells but the spec declares ${expectedShells} component(s). Parts that should be joined are not touching.`,
      });
    }
  }

  // Print posture. The Architect declared which face of a single part lies on
  // the build plate; analyzeStl measures whether ANY flat face does. Only
  // meaningful for a lone component: a placed assembly is compiled in
  // assembly pose, where the lowest plane says nothing about how each part
  // prints. Warning, not error - the human decides at the accept gate whether
  // to re-orient, since a repair loop chasing orientation can wreck a good part.
  const solo = spec?.components?.length === 1 ? spec.components[0] : undefined;
  if (solo?.bedFace && modelInfo.isFlatPackable === false) {
    violations.push({
      kind: 'buildplate',
      field: 'bedFace',
      expected: `${solo.bedFace} face flat on z=0`,
      measured: `bottom area ${modelInfo.bottomAreaMm2 ?? 0}mm2`,
      severity: 'warning',
      message:
        `The spec declares ${solo.bedFace} as the bed face, but the compiled part has no flat face resting on the build plate ` +
        `(bottom area ${modelInfo.bottomAreaMm2 ?? 0}mm2). Re-orient the module so that face is planar on z=0.`,
    });
  }

  // Intent vs. reality on the master bounding box.
  if (spec?.boundingBox && modelInfo.dimensions) {
    const isTrusted = !!spec.specApprovedAt;
    const absTolerance = isTrusted ? TRUSTED_BBOX_ABS_TOLERANCE_MM : BBOX_ABS_TOLERANCE_MM;

    const axes: Array<[string, number, number]> = [
      ['width', spec.boundingBox.width, modelInfo.dimensions.x],
      ['length', spec.boundingBox.length, modelInfo.dimensions.y],
      ['height', spec.boundingBox.height, modelInfo.dimensions.z],
    ];

    for (const [axis, expected, measured] of axes) {
      const delta = Math.abs(expected - measured);
      if (delta <= absTolerance) continue;

      const relative = expected > 0 ? delta / expected : Infinity;
      const gross = relative > BBOX_REL_TOLERANCE || isTrusted;

      violations.push({
        kind: 'bbox',
        field: axis,
        expected,
        measured,
        deltaMm: Number(delta.toFixed(2)),
        tolerance: absTolerance,
        severity: gross ? 'error' : 'warning',
        message: `Measured ${axis} is ${measured}mm but the spec declares ${expected}mm (delta ${delta.toFixed(2)}mm).${isTrusted ? ' [Trusted Spec Violation]' : ''}`,
      });
    }
  }

  return violations;
}
