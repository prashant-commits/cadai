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

/** True if any node in the JSON Schema accepts both a number and a string (label/kind/enums are legitimately strings). */
function hasNumberOrString(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasNumberOrString);
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  const types = Array.isArray(n.type) ? n.type : [];
  const branches = Array.isArray(n.anyOf) ? n.anyOf.map((b) => (b as { type?: unknown }).type) : [];
  if ((types.includes('number') && types.includes('string')) || (branches.includes('number') && branches.includes('string'))) return true;
  return Object.values(n).some(hasNumberOrString);
}

describe('P0b review round 1', () => {
  it('does not advertise strings for guide fields in the Claude request schema (H1)', async () => {
    const { claudeVariantSpecSchema } = await import('./llm-schemas');
    // The original assertion (`not.toContain('"string"')` on the whole guides schema) cannot pass on any
    // tree: `label` and `kind` are strings. It is narrowed to what it meant: no number|string field.
    const guides = (claudeVariantSpecSchema() as { properties: { guides: unknown } }).properties.guides;
    expect(hasNumberOrString(guides)).toBe(false);
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

  it('advertises numbers only for guides, and no guide expr, in every request schema', async () => {
    const { assemblySpecRequestSchema, variantSpecRequestSchema } = await import('./assembly-spec');
    const { claudeVariantSpecSchema } = await import('./llm-schemas');
    for (const schema of [assemblySpecRequestSchema(), variantSpecRequestSchema(), claudeVariantSpecSchema()]) {
      const items = (schema as { properties: { guides: { items: { properties: Record<string, unknown> } } } }).properties.guides.items;
      expect(Object.keys(items.properties)).not.toContain('expr');
      expect(hasNumberOrString(items)).toBe(false);
    }
  });

  it('keeps a guide expression through a second normalize, so it follows parameter edits and stays reported', () => {
    const raw = { ...base, parameters: params, components: comps,
      guides: [{ label: 'g', kind: 'envelope', localExtents: ['w', 10, 10], position: [0, 0, 0], shape: { kind: 'box' } }] };
    const once = normalizeSpec(AssemblySpecSchema.parse(raw));
    expect(once.guides[0].localExtents).toEqual([80, 10, 10]);
    const edited = normalizeSpec({ ...once, parameters: [{ ...params[0], unit: 'mm' as const, value: 100 }] });
    expect(edited.guides[0].localExtents).toEqual([100, 10, 10]);
    const bad = normalizeSpec(normalizeSpec(AssemblySpecSchema.parse({ ...raw, guides: [{ ...raw.guides[0], localExtents: ['nope', 10, 10] }] })));
    expect(auditSpecCoherence(bad).some((v) => v.severity === 'error' && /nope/.test(v.message))).toBe(true);
  });

  it('unwraps wrapper objects for derived and relations too', () => {
    const parsed = AssemblySpecSchema.safeParse({ ...base, guides: [], components: comps,
      derived: JSON.stringify({ derived: [{ name: 'half', expr: 'w/2' }] }), relations: JSON.stringify({ items: [{ expr: 'w > 0', why: 'x' }] }) });
    expect(parsed.success && parsed.data.derived?.[0].name).toBe('half');
    expect(parsed.success && parsed.data.relations?.[0].why).toBe('x');
  });
});

