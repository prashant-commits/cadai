import { describe, it, expect } from 'vitest';
import { auditSpec } from './spec-audit';
import type { AssemblySpec } from './assembly-spec';
import type { ValidationResult, ScadDiagnostic } from '../engine/scad-compiler';
import type { ModelInfo, DesignContract } from '@/types';

const spec: AssemblySpec = {
  assemblyName: 'test_box',
  boundingBox: { width: 40, length: 40, height: 40 },
  components: [{ name: 'box', description: 'a box' }],
  edgeTreatments: [],
  stressPoints: [],
  assumptions: [],
  openQuestions: []
};

function validation(over: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: true,
    stl: 'facet normal',
    exitCode: 0,
    errors: [],
    warnings: [],
    summary: {
      dimensions: 3,
      boundingBox: { min: [0, 0, 0], max: [40, 40, 40], size: [40, 40, 40] },
    },
    compileTimeMs: 10,
    rawStderr: [],
    ...over,
  };
}

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    dimensions: { x: 40, y: 40, z: 40 },
    volumeMm3: 64000,
    triangleCount: 12,
    vertexCount: 36,
    isWatertight: true,
    isFlatPackable: true,
    boundingBox: { min: [0, 0, 0], max: [40, 40, 40] },
    ...over,
  };
}

const errorsOf = (v: ReturnType<typeof auditSpec>) => v.filter((x) => x.severity === 'error');

describe('auditSpec', () => {
  it('passes a part that matches its spec', () => {
    expect(auditSpec(spec, model(), validation())).toHaveLength(0);
  });

  it('does not crash when the compile produced no geometry', () => {
    const v = validation({
      valid: false,
      stl: undefined,
      exitCode: 1,
      summary: undefined,
      errors: [{ severity: 'error', code: 'parse_error', message: 'syntax error', count: 1, raw: '' }],
    });
    const violations = auditSpec(spec, null, v);
    expect(violations.some((x) => x.kind === 'compile')).toBe(true);
  });

  it('does not invent a dimensionality failure when OpenSCAD reported none', () => {
    // A missing summary must not read as "not a 3D model".
    const violations = auditSpec(spec, model(), validation({ summary: undefined }));
    expect(violations.some((x) => x.kind === 'dimensionality')).toBe(false);
  });

  it('flags a 2D top-level object when the compiler reported one', () => {
    const v = validation({ summary: { dimensions: 2 } });
    expect(auditSpec(spec, model(), v).some((x) => x.kind === 'dimensionality')).toBe(true);
  });

  describe('silent corruption', () => {
    const corrupt = (code: ScadDiagnostic['code']) =>
      validation({
        warnings: [
          { severity: 'warning', code, message: 'Ignoring unknown thing', line: 7, count: 3, raw: '' },
        ],
      });

    it('promotes an unknown variable to a hard failure despite a clean compile', () => {
      const violations = auditSpec(spec, model(), corrupt('unknown_variable'));
      const unknown = errorsOf(violations).filter((x) => x.kind === 'unknown_symbol');
      expect(unknown).toHaveLength(1);
      expect(unknown[0].message).toContain('line 7');
      expect(unknown[0].message).toContain('x3');
    });

    it('promotes an unknown module even when the bounding box looks right', () => {
      // The dropped feature does not change the bbox, so only the symbol gate catches it.
      const violations = auditSpec(spec, model(), corrupt('unknown_module'));
      expect(errorsOf(violations).some((x) => x.kind === 'unknown_symbol')).toBe(true);
      expect(violations.some((x) => x.kind === 'bbox')).toBe(false);
    });

    it('ignores warnings that are not geometry-corrupting', () => {
      const v = validation({
        warnings: [
          { severity: 'warning', code: 'non_manifold', message: 'may not be 2-manifold', count: 1, raw: '' },
        ],
      });
      expect(auditSpec(spec, model(), v).some((x) => x.kind === 'unknown_symbol')).toBe(false);
    });
  });

  it('flags a non-manifold result', () => {
    const violations = auditSpec(spec, model({ isManifold: false }), validation());
    expect(errorsOf(violations).some((x) => x.kind === 'manifold')).toBe(true);
  });

  it('flags a model that fell into more shells than the spec declares', () => {
    const violations = auditSpec(spec, model({ shellCount: 3 }), validation());
    const shells = errorsOf(violations).filter((x) => x.kind === 'shells');
    expect(shells).toHaveLength(1);
    expect(shells[0].measured).toBe(3);
  });

  it('accepts a shell per declared component', () => {
    const twoParts: AssemblySpec = {
      ...spec,
      components: [
        { name: 'a', description: 'a' },
        { name: 'b', description: 'b' },
      ],
    };
    expect(auditSpec(twoParts, model({ shellCount: 2 }), validation())).toHaveLength(0);
  });

  describe('bed face', () => {
    const onBed: AssemblySpec = {
      ...spec,
      components: [{ name: 'box', description: 'a box', bedFace: '-Z' }],
    };
    const bedFaceWarnings = (v: ReturnType<typeof auditSpec>) =>
      v.filter((x) => x.kind === 'buildplate' && x.field === 'bedFace');

    it('warns when a single part declares a bed face but nothing flat rests on the plate', () => {
      const violations = auditSpec(onBed, model({ isFlatPackable: false, bottomAreaMm2: 0 }), validation());
      const hits = bedFaceWarnings(violations);
      expect(hits).toHaveLength(1);
      // A posture concern opens the accept gate; it must never drive the repair loop.
      expect(hits[0].severity).toBe('warning');
      expect(hits[0].message).toContain('-Z');
      expect(errorsOf(violations)).toHaveLength(0);
    });

    it('is silent when the part is flat-packable', () => {
      expect(bedFaceWarnings(auditSpec(onBed, model({ isFlatPackable: true }), validation()))).toHaveLength(0);
    });

    it('is silent when no bed face was declared', () => {
      expect(bedFaceWarnings(auditSpec(spec, model({ isFlatPackable: false }), validation()))).toHaveLength(0);
    });

    it('does not judge a placed assembly by its lowest plane', () => {
      const assembly: AssemblySpec = {
        ...spec,
        components: [
          { name: 'a', description: 'a', bedFace: '-Z', position: [0, 0, 0] },
          { name: 'b', description: 'b', bedFace: '-X', position: [0, 0, 5] },
        ],
      };
      expect(
        bedFaceWarnings(auditSpec(assembly, model({ isFlatPackable: false, shellCount: 2 }), validation()))
      ).toHaveLength(0);
    });
  });

  describe('bounding box', () => {
    it('ignores deviation within the absolute tolerance', () => {
      const violations = auditSpec(spec, model({ dimensions: { x: 43, y: 40, z: 40 } }), validation());
      expect(violations).toHaveLength(0);
    });

    it('warns on a deviation that is absolute but not gross', () => {
      // 6mm on a 40mm axis is 15% - over the 5mm floor, under the 20% ceiling.
      const violations = auditSpec(spec, model({ dimensions: { x: 46, y: 40, z: 40 } }), validation());
      const bbox = violations.filter((x) => x.kind === 'bbox');
      expect(bbox).toHaveLength(1);
      expect(bbox[0].severity).toBe('warning');
      expect(bbox[0].deltaMm).toBe(6);
    });

    it('fails hard when the geometry is grossly the wrong size', () => {
      const violations = auditSpec(
        spec,
        model({ dimensions: { x: 400, y: 400, z: 400 } }),
        validation()
      );
      const bbox = errorsOf(violations).filter((x) => x.kind === 'bbox');
      expect(bbox).toHaveLength(3);
      expect(bbox[0].field).toBe('width');
    });

    it('skips the bbox check when there is no spec to compare against', () => {
      expect(auditSpec(null, model({ dimensions: { x: 999, y: 999, z: 999 } }), validation())).toHaveLength(0);
    });

    it('hard-fails a deviation past 1mm if the spec is trusted', () => {
      const trustedSpec = { ...spec, specApprovedAt: Date.now() };
      // 3mm on a 40mm axis is normally fine (abs < 5mm), but fails trusted spec (>1.0mm)
      const violations = auditSpec(trustedSpec, model({ dimensions: { x: 43, y: 40, z: 40 } }), validation());
      const bbox = errorsOf(violations).filter((x) => x.kind === 'bbox');
      expect(bbox).toHaveLength(1);
      expect(bbox[0].severity).toBe('error');
    });
  });

  describe('design contract enforcement', () => {
    const contract: DesignContract = {
      standing: { buildVolumeMm: [100, 100, 100], nozzleMm: 0.4 },
      pinnedParams: {
        'width': { value: 55, supersededValue: 40, pinnedAt: Date.now() }
      }
    };

    it('emits buildplate violation when geometry exceeds standing build volume', () => {
      const violations = auditSpec(spec, model({ dimensions: { x: 150, y: 40, z: 40 } }), validation(), 'width = 55;', contract);
      const bounds = errorsOf(violations).filter((x) => x.kind === 'buildplate');
      expect(bounds).toHaveLength(1);
    });

    it('fails if a pinned parameter was dropped from the code', () => {
      const violations = auditSpec(spec, model(), validation(), 'length = 40;', contract);
      const pins = errorsOf(violations).filter((x) => x.kind === 'standing');
      expect(pins).toHaveLength(1);
      expect(pins[0].message).toContain("was removed or incorrectly formatted");
    });

    it('fails if a pinned parameter has the wrong value in code', () => {
      const violations = auditSpec(spec, model(), validation(), 'width = 99;', contract);
      const pins = errorsOf(violations).filter((x) => x.kind === 'standing');
      expect(pins).toHaveLength(1);
      expect(pins[0].message).toContain("the code emitted 99");
    });

    it('passes when standing bounds are met and pins survive', () => {
      const violations = auditSpec(spec, model(), validation(), 'width = 55;', contract);
      const contractViols = errorsOf(violations).filter((x) => x.kind === 'buildplate' || x.kind === 'standing');
      expect(contractViols).toHaveLength(0);
    });
  });
});
