import { describe, it, expect } from 'vitest';
import { AssemblySpecSchema, assemblySpecRequestSchema, variantSpecRequestSchema } from './assembly-spec';
import { claudeVariantSpecSchema, CLAUDE_KEEP_OPTIONAL } from './llm-schemas';

/**
 * bedFace is print orientation, which belongs to the future slicer node, so the
 * model is no longer asked for it. zod still accepts it, so stored specs parse.
 */
describe('bedFace is no longer requested from the model', () => {
  it('is absent from every request schema', () => {
    const schemas: Record<string, unknown> = {
      assemblySpecRequestSchema: assemblySpecRequestSchema(),
      variantSpecRequestSchema: variantSpecRequestSchema(),
      claudeVariantSpecSchema: claudeVariantSpecSchema(),
    };
    for (const [name, schema] of Object.entries(schemas)) {
      expect(JSON.stringify(schema), `${name} still requests bedFace`).not.toContain('"bedFace"');
    }
  });

  it('keeps the six-face enum for a shell openFace', () => {
    expect(JSON.stringify(variantSpecRequestSchema())).toContain('"openFace"');
    expect(JSON.stringify(claudeVariantSpecSchema())).toContain('"openFace"');
  });

  it('keeps 6 optional paths on the Claude variant schema, none of them bedFace', () => {
    expect([...CLAUDE_KEEP_OPTIONAL].sort()).toEqual([
      'components[].holes[].depth',
      'guides[].localExtents',
      'guides[].points',
      'guides[].position',
      'guides[].shape',
      'stressPoints[].gusset',
    ]);
  });

  it('still parses a stored spec that carries bedFace', () => {
    const spec = AssemblySpecSchema.parse({
      assemblyName: 'bracket',
      boundingBox: { width: 40, length: 30, height: 25 },
      components: [{ name: 'bracket', description: 'an L bracket', bedFace: '-Z' }],
    });
    expect(spec.components?.[0].bedFace).toBe('-Z');
  });
});
