import { z } from 'zod';
import { toAnthropicCompatibleSchema } from './strict-schema';
import { AssemblySpecSchema } from './assembly-spec';

// Schemas handed to withStructuredOutput. The gateway enforces OpenAI strict
// json_schema, which rejects `.optional()` (use `.default()` or a required field).

/** What the Design Inspector is allowed to say about a set of renders. */
export const VisualCritiqueSchema = z.object({
  matchesIntent: z.boolean(),
  findings: z
    .array(
      z.object({
        issue: z.string().describe('What is visibly wrong, in one sentence.'),
        severity: z.enum(['minor', 'major']),
        // NOT optional. The vision default (gpt-5.6-luna) enforces OpenAI
        // strict json_schema, which rejects any property missing from
        // `required` with a 400 before the model ever runs.
        view: z.string().describe('front | right | top | iso, or "" if it applies to all views'),
      })
    )
    .default([]),
});

export const SheetReviewSchema = z.object({
  matchesRequest: z.boolean(),
  findings: z.array(
    z.object({
      issue: z.string(),
      severity: z.enum(['minor', 'major']),
    })
  ),
});


export const ArchitectPlanSchema = z.object({
  brief: z.string().default(''),
  assumptions: z
    .array(z.object({ field: z.string(), value: z.string(), rationale: z.string() }))
    .default([]),
  openQuestions: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        // `.default`, not `.optional()`: strict json_schema lists defaulted keys as required, and a reply that omits it still parses.
        options: z.array(z.string()).default([]),
        suggestedAnswer: z.string().default(''),
      })
    )
    .default([]),
  variants: z
    .array(
      z.object({
        id: z.enum(['A', 'B', 'C']),
        name: z.string(),
        idea: z.string(),
      })
    )
    .min(1)
    .max(3),
  recommendedId: z.enum(['A', 'B', 'C']).default('A'),
});


function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireComponentFields(json: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const props = isPlainObject(json.properties) ? json.properties : undefined;
  const components = props?.components as { items?: { properties?: Record<string, unknown>; required?: string[] } } | undefined;
  const items = components?.items;
  if (!items?.properties) return json;
  items.required = [...new Set<string>([...(items.required ?? []), ...fields])];
  return json;
}

/**
 * Variant AssemblySpec JSON Schema tailored for Anthropic/Claude:
 * built from AssemblySpecSchema without OpenAI strict transforms (no nullable unions),
 * components/position/localExtents/shape required, sheet first,
 * unsupported Anthropic keywords stripped, additionalProperties: false.
 */
export function claudeVariantSpecSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(AssemblySpecSchema) as Record<string, unknown>;
  delete json.$schema;
  const props = isPlainObject(json.properties) ? json.properties : undefined;
  if (props) {
    delete props.specApprovedAt;
    delete props.openQuestions;

    // Ensure top-level components is required
    json.required = [...new Set<string>([...((json.required as string[]) ?? []), 'components'])];

    // Place sheet first in properties and required
    if ('sheet' in props) {
      const { sheet, ...rest } = props;
      json.properties = { sheet, ...rest };
      if (Array.isArray(json.required) && json.required.includes('sheet')) {
        json.required = ['sheet', ...(json.required as string[]).filter((k) => k !== 'sheet')];
      }
    }
  }

  requireComponentFields(json, ['position', 'localExtents', 'shape']);

  const safe = toAnthropicCompatibleSchema(json);
  delete safe.$schema;
  return safe;
}

/**
 * `model.withStructuredOutput(schema, opts)`, except for Claude slugs: those go
 * through the gateway to Anthropic's structured outputs, which reject several
 * JSON Schema keywords (maxItems, numeric bounds ...) and cap union types.
 * For Claude routes, the schema is built without OpenAI strict nullable unions:
 * optional properties are omitted from required, additionalProperties: false
 * is kept, unsupported keywords and default keywords are stripped.
 * The reply is still validated by the caller against the zod schema.
 */
export function structuredFor<M extends { withStructuredOutput: (...args: never[]) => unknown }>(
  model: M,
  slug: string,
  schema: z.ZodType | Record<string, unknown>,
  opts: { name?: string; strict?: boolean; includeRaw?: boolean } = {}
): ReturnType<M['withStructuredOutput']> {
  const call = model.withStructuredOutput as unknown as (s: unknown, o?: unknown) => ReturnType<M['withStructuredOutput']>;
  if (!slug.startsWith('claude-')) return call.call(model, schema, opts);

  const schemaProps =
    isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : undefined;
  const isVariantSpec =
    opts.name === 'AssemblySpec' ||
    schema === AssemblySpecSchema ||
    (schemaProps !== undefined && 'assemblyName' in schemaProps);

  if (isVariantSpec) {
    const safe = claudeVariantSpecSchema();
    return call.call(model, safe, { ...opts, name: opts.name ?? 'AssemblySpec', strict: true });
  }

  let json: Record<string, unknown>;
  if (schema instanceof z.ZodType) {
    json = z.toJSONSchema(schema) as Record<string, unknown>;
    delete json.$schema;

    const props = isPlainObject(json.properties) ? json.properties : undefined;
    if (props) {
      if ('components' in props) {
        json.required = [...new Set<string>([...((json.required as string[]) ?? []), 'components'])];
        requireComponentFields(json, ['position', 'localExtents', 'shape']);
      }
      if ('sheet' in props) {
        const { sheet, ...rest } = props;
        json.properties = { sheet, ...rest };
        if (Array.isArray(json.required) && json.required.includes('sheet')) {
          json.required = ['sheet', ...(json.required as string[]).filter((k) => k !== 'sheet')];
        }
      }
    }
  } else {
    json = schema;
  }

  const safe = toAnthropicCompatibleSchema(json);
  delete safe.$schema;
  return call.call(model, safe, { ...opts, name: opts.name ?? 'Reply', strict: true });
}


