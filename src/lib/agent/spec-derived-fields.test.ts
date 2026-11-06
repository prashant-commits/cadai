import { describe, expect, it } from 'vitest';
import { AssemblySpecSchema, assemblySpecRequestSchema, type AssemblySpec } from './assembly-spec';
import { normalizeSpec } from './spec-normalize';
import { auditSpecCoherence, auditSpecParameters } from './spec-coherence';
import { auditSpecShapes } from './spec-shape-audit';

// Council 2026-11-06, items 2 and 5: code owns the bounding box and the profile
// extents; a parameter that drives no geometry is an error at the spec stage.

const base = { sheet: '', assemblyName: 'a', assumptions: [], openQuestions: [] };
const param = (name: string, value: number) => ({ name, value, min: 0, max: 1000, unit: 'mm' as const, description: '' });

describe('boundingBox is derived by code', () => {
  it('is no longer requested from the model, and sheet is the LAST property of every request schema', () => {
    const json = assemblySpecRequestSchema() as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(json.properties)).not.toContain('boundingBox');
    expect(json.required ?? []).not.toContain('boundingBox');
    expect(Object.keys(json.properties).at(-1)).toBe('sheet');
  });

  it('parses a spec without boundingBox', () => {
    const r = AssemblySpecSchema.safeParse({ ...base, components: [{ name: 'p', description: '', localExtents: [10, 20, 30], position: [0, 0, 0] }] });
    expect(r.success).toBe(true);
  });

  it('replaces any declared box with the components\' own span, literal specs included', () => {
    const spec = normalizeSpec({
      ...base, boundingBox: { width: 80, length: 120, height: 5 },
      components: [
        { name: 'plate', description: '', localExtents: [120, 5, 160], position: [0, 0, 0] },
        { name: 'ring', description: '', localExtents: [100, 100, 60], position: [10, 5, 0] },
      ],
    } as unknown as AssemblySpec);
    expect(spec.boundingBox).toEqual({ width: 120, length: 105, height: 160 });
    expect(auditSpecCoherence(spec).filter((v) => v.field.startsWith('boundingBox'))).toEqual([]);
  });
});

describe('profile outlines are normalised by code', () => {
  it('shifts the outline to the origin and takes the in-plane extents from it', () => {
    const spec = normalizeSpec({
      ...base,
      components: [{
        name: 'wedge', description: '', localExtents: [40, 99, 30], position: [0, 0, 0],
        shape: { kind: 'profile', plane: 'xz', points: [[5, 2], [45, 2], [5, 22]] },
      }],
    } as unknown as AssemblySpec);
    const c = spec.components![0];
    expect(c.shape?.points).toEqual([[0, 0], [40, 0], [0, 20]]);
    expect(c.localExtents).toEqual([40, 99, 20]); // x and z from the outline; y (extrusion) kept
    expect(auditSpecShapes(spec).filter((v) => /profile bbox/.test(v.message))).toEqual([]);
  });
});

describe('dead-parameter lint at the spec stage', () => {
  const comp = (extents: unknown[]) => ({ name: 'p', description: '', localExtents: extents, position: [0, 0, 0] });

  it('reports a parameter no component or guide reaches, directly or through derived', () => {
    const spec = {
      ...base,
      parameters: [param('w', 40), param('lean', 15), param('t', 3)],
      derived: [{ name: 'w2', expr: 'w * 2' }, { name: 'rise', expr: 'lean * 2' }],
      components: [comp(['w2', 't', 10])],
    } as unknown as AssemblySpec;
    const dead = auditSpecParameters(spec).filter((v) => v.field.startsWith('parameters.'));
    expect(dead.map((v) => v.field)).toEqual(['parameters.lean']);
    expect(dead[0].severity).toBe('error');
    expect(dead[0].message).toMatch(/lean/);
  });

  it('is silent for a literal spec and for parameters used only via derived', () => {
    expect(auditSpecParameters({ ...base, components: [comp([1, 2, 3])] } as unknown as AssemblySpec)
      .filter((v) => v.field.startsWith('parameters.'))).toEqual([]);
    const spec = { ...base, parameters: [param('w', 4)], derived: [{ name: 'h', expr: 'w + 1' }], components: [comp(['h', 1, 1])] } as unknown as AssemblySpec;
    expect(auditSpecParameters(spec).filter((v) => v.field.startsWith('parameters.'))).toEqual([]);
  });

  it('never returns parameters.* violations from auditSpecCoherence', () => {
    const spec = {
      ...base,
      parameters: [param('w', 40), param('lean', 15)],
      components: [comp([40, 10, 10])],
    } as unknown as AssemblySpec;
    expect(auditSpecCoherence(spec).filter((v) => v.field.startsWith('parameters.'))).toEqual([]);
  });
});
