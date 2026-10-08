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
  const FORBIDDEN = ['maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'default'];

  const recorder = () => {
    const seen: Array<{ schema: unknown; opts: unknown }> = [];
    return { seen, model: { withStructuredOutput(schema: unknown, opts: unknown) { seen.push({ schema, opts }); return 'bound'; } } };
  };

  function countUnions(schema: unknown): { total: number; nullable: number; genuine: number } {
    let total = 0;
    let nullable = 0;
    let genuine = 0;

    function walk(node: unknown) {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        const union = obj.anyOf ?? obj.oneOf;
        if (Array.isArray(union)) {
          total++;
          const isNullable = union.some(
            (branch) => branch && typeof branch === 'object' && (branch as Record<string, unknown>).type === 'null'
          );
          if (isNullable) {
            nullable++;
          } else {
            genuine++;
          }
        }
        for (const v of Object.values(obj)) {
          walk(v);
        }
      }
    }

    walk(schema);
    return { total, nullable, genuine };
  }

  it('claude slugs get an Anthropic-safe strict JSON schema; other slugs get the schema unchanged', async () => {
    const { structuredFor, ArchitectPlanSchema } = await import('./llm-schemas');
    const { variantSpecRequestSchema } = await import('./assembly-spec');

    const claude = recorder();
    structuredFor(claude.model as never, 'claude-opus-5.5', ArchitectPlanSchema, { name: 'ArchitectPlan', strict: true });
    const sent = JSON.stringify(claude.seen[0].schema);
    for (const k of FORBIDDEN) expect(sent).not.toContain(`"${k}"`);
    expect(claude.seen[0].opts).toMatchObject({ name: 'ArchitectPlan', strict: true });
    expect((claude.seen[0].schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);

    // The variant JSON schema for Claude has 0 nullable unions and stripped forbidden keywords.
    const variantJson = variantSpecRequestSchema();
    const claudeVariant = recorder();
    structuredFor(claudeVariant.model as never, 'claude-opus-5.5', variantJson, { name: 'AssemblySpec', strict: true });
    const variantSent = JSON.stringify(claudeVariant.seen[0].schema);
    for (const k of FORBIDDEN) expect(variantSent).not.toContain(`"${k}"`);

    // Verify union-typed parameters: 0 nullable unions in Claude variant schema,
    // whereas OpenAI strict variant schema has ~30 nullable unions.
    const openaiCounts = countUnions(variantJson);
    expect(openaiCounts.nullable).toBeGreaterThanOrEqual(25);

    const claudeCounts = countUnions(claudeVariant.seen[0].schema);
    expect(claudeCounts.nullable).toBe(0);
    expect(claudeCounts.total).toBe(claudeCounts.genuine);
    expect(claudeCounts.total).toBeLessThan(5); // far below Anthropic's limit

    // Structural requirements on Claude variant schema:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaObj = claudeVariant.seen[0].schema as any;
    expect(schemaObj.additionalProperties).toBe(false);
    expect(schemaObj.required[0]).toBe('sheet'); // sheet first
    expect(schemaObj.required).toContain('components');
    const compReq = schemaObj.properties.components.items.required;
    expect(compReq).toContain('position');
    expect(compReq).toContain('localExtents');
    expect(compReq).toContain('shape');

    // OpenAI routes (gpt-5.6-luna, gpt-6-sol) stay byte-identical.
    const luna = recorder();
    structuredFor(luna.model as never, 'gpt-5.6-luna', ArchitectPlanSchema, { name: 'ArchitectPlan', strict: true });
    expect(luna.seen[0].schema).toBe(ArchitectPlanSchema);
    const lunaVariant = recorder();
    structuredFor(lunaVariant.model as never, 'gpt-5.6-luna', variantJson, { name: 'AssemblySpec', strict: true });
    expect(lunaVariant.seen[0].schema).toBe(variantJson);

    const solVariant = recorder();
    structuredFor(solVariant.model as never, 'gpt-6-sol', variantJson, { name: 'AssemblySpec', strict: true });
    expect(solVariant.seen[0].schema).toBe(variantJson);
    expect(JSON.stringify(solVariant.seen[0].schema)).toBe(JSON.stringify(variantJson));
  });

  it('replies are still validated by the original zod schema (too many variants fails)', async () => {
    const { ArchitectPlanSchema } = await import('./llm-schemas');
    const v = (id: string) => ({ id, name: id, idea: id });
    expect(ArchitectPlanSchema.safeParse({ variants: [v('A'), v('B'), v('C'), v('A')] }).success).toBe(false);
  });

  it('replies still go through nullsToUndefined and the same zod schemas', async () => {
    const { nullsToUndefined } = await import('./strict-schema');
    const { AssemblySpecSchema } = await import('./assembly-spec');

    // A model reply with nulls for optional fields or omitted fields parses cleanly
    const rawReply = {
      sheet: '## Plate\nPlate design.',
      assemblyName: 'plate_assembly',
      boundingBox: { width: 100, length: 50, height: 10 },
      jointContracts: null,
      components: [
        {
          name: 'base_plate',
          description: 'A mounting plate',
          position: [0, 0, 0],
          localExtents: [100, 50, 10],
          shape: { kind: 'box' },
          holes: null,
          bedFace: null,
        },
      ],
      guides: null,
      stressPoints: null,
      assumptions: null,
      openQuestions: null,
    };

    const cleaned = nullsToUndefined(rawReply);
    const parsed = AssemblySpecSchema.safeParse(cleaned);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sheet).toBe('## Plate\nPlate design.');
      expect(parsed.data.components?.[0].name).toBe('base_plate');
      expect(parsed.data.components?.[0].holes).toBeUndefined();
    }
  });
});

