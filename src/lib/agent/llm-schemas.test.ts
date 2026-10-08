import { describe, it, expect } from 'vitest';
import type { ZodType } from 'zod';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { VisualCritiqueSchema, SheetReviewSchema, ArchitectPlanSchema } from './llm-schemas';

type Node = { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };

/** Collects every object node that violates OpenAI strict json_schema (all properties required). */
function violations(node: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(node)) {
    node.forEach((n, i) => violations(n, `${path}[${i}]`, out));
  } else if (node && typeof node === 'object') {
    const n = node as Node;
    if (n.properties) {
      const missing = Object.keys(n.properties).filter((k) => !(n.required ?? []).includes(k));
      if (missing.length) out.push(`${path}: not required: ${missing.join(', ')}`);
    }
    for (const [k, v] of Object.entries(n)) violations(v, `${path}.${k}`, out);
  }
  return out;
}

describe('structured-output schemas are strict-json_schema safe', () => {
  const schemas: Record<string, ZodType> = { VisualCritiqueSchema, SheetReviewSchema, ArchitectPlanSchema };
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name}: every object lists all its properties as required`, () => {
      const json = toJsonSchema(schema, { cycles: 'ref', reused: 'ref' }) // same options as interopZodResponseFormat;
      expect(violations(json, name, [])).toEqual([]);
    });
  }
});

describe('structuredFor', () => {
  const FORBIDDEN = ['maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern'];

  const recorder = () => {
    const seen: Array<{ schema: unknown; opts: unknown }> = [];
    return { seen, model: { withStructuredOutput(schema: unknown, opts: unknown) { seen.push({ schema, opts }); return 'bound'; } } };
  };

  it('claude slugs get an Anthropic-safe strict JSON schema; other slugs get the schema unchanged', async () => {
    const { structuredFor, ArchitectPlanSchema } = await import('./llm-schemas');
    const { variantSpecRequestSchema } = await import('./assembly-spec');

    const claude = recorder();
    structuredFor(claude.model as never, 'claude-opus-5.5', ArchitectPlanSchema, { name: 'ArchitectPlan', strict: true });
    const sent = JSON.stringify(claude.seen[0].schema);
    for (const k of FORBIDDEN) expect(sent).not.toContain(`"${k}"`);
    expect(claude.seen[0].opts).toMatchObject({ name: 'ArchitectPlan', strict: true });
    expect((claude.seen[0].schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);

    // The variant JSON schema (bounded for the decoder) is stripped too.
    const variantJson = variantSpecRequestSchema();
    const claudeVariant = recorder();
    structuredFor(claudeVariant.model as never, 'claude-opus-5.5', variantJson, { name: 'AssemblySpec', strict: true });
    const variantSent = JSON.stringify(claudeVariant.seen[0].schema);
    for (const k of FORBIDDEN) expect(variantSent).not.toContain(`"${k}"`);

    const luna = recorder();
    structuredFor(luna.model as never, 'gpt-5.6-luna', ArchitectPlanSchema, { name: 'ArchitectPlan', strict: true });
    expect(luna.seen[0].schema).toBe(ArchitectPlanSchema); // exactly as before
    const lunaVariant = recorder();
    structuredFor(lunaVariant.model as never, 'gpt-5.6-luna', variantJson, { name: 'AssemblySpec', strict: true });
    expect(lunaVariant.seen[0].schema).toBe(variantJson);
  });

  it('replies are still validated by the original zod schema (too many variants fails)', async () => {
    const { ArchitectPlanSchema } = await import('./llm-schemas');
    const v = (id: string) => ({ id, name: id, idea: id });
    expect(ArchitectPlanSchema.safeParse({ variants: [v('A'), v('B'), v('C'), v('A')] }).success).toBe(false);
  });
});
