import { z } from 'zod';

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
        // NOT optional: strict json_schema requires every property in `required`.
        options: z.array(z.string()),
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

