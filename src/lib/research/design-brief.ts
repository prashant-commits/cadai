import { z } from 'zod';
import { boundNumbers } from '../agent/assembly-spec';
import { normalizeUrl, type SearchHit } from './search-provider';

/**
 * The Design Brief: what the research node hands the human, and what the
 * Architect is bound to once one approach is chosen.
 *
 * Structured, not prose, for the same reason stress mitigations became
 * structured gussets: a prose brief gets ignored. Two of its fields are never
 * requested from the model - `grounding` is a verification result code
 * computes, and `searchQueries` is what code actually sent to the provider -
 * so the request schemas below are the zod schemas minus those fields.
 */

export const GroundingSchema = z.enum(['cited', 'recalled']);
export type Grounding = z.infer<typeof GroundingSchema>;

export const SourceSchema = z.object({ title: z.string(), url: z.string() });
export type Source = z.infer<typeof SourceSchema>;

/** An approach as the model emits it: no grounding; code sets that afterwards. */
const ApproachRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 2-4 sentences: what bodies, how they join, how it prints. */
  construction: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  /** May be empty, and is pruned to URLs the search actually returned. */
  sources: z.array(SourceSchema),
});
export type ApproachRequest = z.infer<typeof ApproachRequestSchema>;

export const ApproachSchema = ApproachRequestSchema.extend({ grounding: GroundingSchema });
export type Approach = z.infer<typeof ApproachSchema>;

export const MIN_APPROACHES = 2;
export const MAX_APPROACHES = 3;

/** What the query-plan call returns. */
export const QueryPlanSchema = z.object({
  partClass: z.string(),
  queries: z.array(z.string()).min(2).max(4),
});
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

/** What the brief-synthesis call returns. */
export const BriefResponseSchema = z.object({
  approaches: z.array(ApproachRequestSchema).min(MIN_APPROACHES).max(MAX_APPROACHES),
  recommendedId: z.string(),
});
export type BriefResponse = z.infer<typeof BriefResponseSchema>;

/** Assembled by code from the two replies and the hits; shown at the gate. */
export const DesignBriefSchema = z.object({
  partClass: z.string(),
  approaches: z.array(ApproachSchema).min(MIN_APPROACHES).max(MAX_APPROACHES),
  recommendedId: z.string(),
  searchQueries: z.array(z.string()),
});
export type DesignBrief = z.infer<typeof DesignBriefSchema>;

/**
 * The approach a human picked, as it travels between turns inside the Design
 * Contract. Graph state is per run, so this is the only thing that survives.
 */
export interface ChosenApproach {
  partClass: string;
  approach: Approach;
  chosenAt: number;
}

/** JSON Schema for a structured-output call: no $schema, every number bounded (see boundNumbers). */
function requestSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return boundNumbers(json) as Record<string, unknown>;
}
export function queryPlanRequestSchema(): Record<string, unknown> {
  return requestSchema(QueryPlanSchema);
}
export function briefRequestSchema(): Record<string, unknown> {
  return requestSchema(BriefResponseSchema);
}

/**
 * Labels grounding and prunes sources; never drops an approach.
 *
 * An approach is `cited` when at least one of its URLs matches a hit after
 * normalisation. A URL matching no hit is removed, because a link to nowhere
 * in the gate is worse than no link - but the approach stays, labelled
 * `recalled`: verification is a label the human weighs, not a filter. The
 * result is cited-first with the original order kept within each group.
 */
export function groundApproaches(approaches: ApproachRequest[], hits: SearchHit[]): Approach[] {
  const known = new Set(hits.map((h) => normalizeUrl(h.url)));
  const grounded: Approach[] = approaches.map((a) => {
    const seen = new Set<string>();
    const sources = a.sources.filter((s) => {
      const key = normalizeUrl(s.url);
      if (!known.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...a, sources, grounding: sources.length ? 'cited' : 'recalled' };
  });
  return [
    ...grounded.filter((a) => a.grounding === 'cited'),
    ...grounded.filter((a) => a.grounding === 'recalled'),
  ];
}

/**
 * Builds the brief from the two model replies and the hits.
 *
 * Ids are re-keyed positionally (a1, a2, ...) after sorting, because the
 * model's ids are not trusted to be unique and the gate's radio group needs
 * them to be; the recommendation is carried across by identity. A
 * recommendedId naming no approach is repaired to the first cited approach,
 * else the first approach, and reported so the caller can log it.
 */
export function assembleBrief(
  plan: QueryPlan,
  response: BriefResponse,
  hits: SearchHit[]
): { brief: DesignBrief; repairedRecommendation: boolean } {
  const grounded = groundApproaches(response.approaches, hits);
  const recommendedBefore = grounded.find((a) => a.id === response.recommendedId) ?? null;
  const approaches = grounded.map((a, i) => ({ ...a, id: `a${i + 1}` }));
  const recommended = recommendedBefore
    ? approaches[grounded.indexOf(recommendedBefore)]
    : (approaches.find((a) => a.grounding === 'cited') ?? approaches[0]);
  const brief = DesignBriefSchema.parse({
    partClass: plan.partClass,
    approaches,
    recommendedId: recommended.id,
    searchQueries: plan.queries,
  });
  return { brief, repairedRecommendation: !recommendedBefore };
}

/** The approach for `id`, or the recommendation when `id` is absent or unknown. */
export function chooseApproach(brief: DesignBrief, id: string | null | undefined): Approach {
  return (
    brief.approaches.find((a) => a.id === id) ??
    brief.approaches.find((a) => a.id === brief.recommendedId) ??
    brief.approaches[0]
  );
}

/** The Architect's binding block, rebuilt from the contract on every pass. */
export function approachBlock(chosen: ChosenApproach): string {
  const a = chosen.approach;
  const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '- none');
  return [
    'Design Approach (chosen by the user from prior-art research):',
    `Name: ${a.name}`,
    `Construction: ${a.construction}`,
    `Strengths:\n${list(a.strengths)}`,
    `Weaknesses to design around:\n${list(a.weaknesses)}`,
    `Sources: ${a.sources.length ? a.sources.map((s) => s.url).join(', ') : 'none retrieved'}`,
    'Build this construction: the same bodies and the same joining scheme. If a physical constraint forces a deviation, record it in assumptions[] with its rationale.',
  ].join('\n');
}
