import { z } from 'zod';
import { toStrictJsonSchema, toAnthropicCompatibleSchema } from './strict-schema';

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


/**
 * `model.withStructuredOutput(schema, opts)`, except for Claude slugs: those go
 * through the gateway to Anthropic's structured outputs, which reject several
 * JSON Schema keywords (maxItems, numeric bounds ...). For them the schema is
 * converted to JSON Schema, made strict, and stripped of the unsupported
 * keywords. The reply is still validated by the caller against the zod schema.
 */
export function structuredFor<M extends { withStructuredOutput: (...args: never[]) => unknown }>(
  model: M,
  slug: string,
  schema: z.ZodType | Record<string, unknown>,
  opts: { name?: string; strict?: boolean; includeRaw?: boolean } = {}
): ReturnType<M['withStructuredOutput']> {
  const call = model.withStructuredOutput as unknown as (s: unknown, o?: unknown) => ReturnType<M['withStructuredOutput']>;
  if (!slug.startsWith('claude-')) return call.call(model, schema, opts);
  const json = schema instanceof z.ZodType ? (z.toJSONSchema(schema) as Record<string, unknown>) : schema;
  const safe = toAnthropicCompatibleSchema(toStrictJsonSchema(json));
  delete safe.$schema;
  return call.call(model, safe, { ...opts, name: opts.name ?? 'Reply', strict: true });
}
