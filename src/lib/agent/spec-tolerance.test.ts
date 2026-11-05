import { describe, expect, it } from 'vitest';
import { AssemblySpecSchema, type AssemblySpec } from './assembly-spec';
import { normalizeSpec } from './spec-normalize';
import { auditSpecCoherence } from './spec-coherence';

const base = { sheet: '', assemblyName: 'a', boundingBox: { width: 10, length: 10, height: 10 }, assumptions: [], openQuestions: [] };
const params = [{ name: 'w', value: 80, min: 40, max: 160, unit: 'mm', description: 'width' }];
const comps = [{ name: 'plate', description: 'p', localExtents: ['w', 40, 6], position: [0, 0, 0], shape: { kind: 'box' } }];

describe('model-output tolerance for relational specs (P0b)', () => {
  it('accepts parameters, derived and relations sent as JSON strings', () => {
    const raw = { ...base, guides: [], components: comps,
      parameters: JSON.stringify(params), derived: JSON.stringify([{ name: 'half', expr: 'w/2' }]), relations: JSON.stringify([{ expr: 'w > 0', why: 'x' }]) };
    const parsed = AssemblySpecSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.parameters?.[0].name).toBe('w');
  });

  it('resolves expressions in guide fields to numbers instead of rejecting the spec', () => {
    const raw = { ...base, parameters: params, components: comps,
      guides: [{ label: 'laptop', kind: 'envelope', localExtents: ['w', 200, 10], position: [0, 0, 6], shape: { kind: 'box' } }] };
    const parsed = AssemblySpecSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    const spec = normalizeSpec(parsed.success ? parsed.data : (raw as unknown as AssemblySpec));
    expect(spec.guides[0].localExtents).toEqual([80, 200, 10]);
  });

  it('computes the bounding box from the parts for a relational spec, so a mis-added declared box is not an error', () => {
    const spec = normalizeSpec(AssemblySpecSchema.parse({ ...base, guides: [], parameters: params, components: comps }));
    expect(spec.boundingBox).toEqual({ width: 80, length: 40, height: 6 });
    expect(auditSpecCoherence(spec).filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('leaves a literal-only spec and its declared bounding box unchanged', () => {
    const literal = AssemblySpecSchema.parse({ ...base, guides: [], components: [{ ...comps[0], localExtents: [80, 40, 6] }] });
    expect(normalizeSpec(literal).boundingBox).toEqual({ width: 10, length: 10, height: 10 });
  });
});

describe('P0b review round 1', () => {
  it('does not advertise strings for guide fields in the Claude request schema (H1)', async () => {
    const { claudeVariantSpecSchema } = await import('./llm-schemas');
    const json = JSON.stringify((claudeVariantSpecSchema() as { properties: { guides: unknown } }).properties.guides);
    expect(json).not.toContain('"string"');
  });

  it('reports a guide expression that does not resolve (H2)', () => {
    const raw = { ...base, parameters: params, components: comps,
      guides: [{ label: 'x', kind: 'envelope', localExtents: ['nope', 10, 10], position: [0, 0, 0], shape: { kind: 'box' } }] };
    const spec = normalizeSpec(AssemblySpecSchema.parse(raw));
    expect(auditSpecCoherence(spec).some((v) => v.severity === 'error' && /nope/.test(v.message))).toBe(true);
  });

  it('keeps the declared box when a component field failed to resolve', () => {
    const raw = { ...base, guides: [], parameters: params, components: [{ ...comps[0], localExtents: ['w', 'missing', 6] }] };
    expect(normalizeSpec(AssemblySpecSchema.parse(raw)).boundingBox).toEqual({ width: 10, length: 10, height: 10 });
  });

  it('unwraps a JSON string holding an object around the array', () => {
    const parsed = AssemblySpecSchema.safeParse({ ...base, guides: [], components: comps, parameters: JSON.stringify({ parameters: params }) });
    expect(parsed.success && parsed.data.parameters?.[0].name).toBe('w');
  });
});

