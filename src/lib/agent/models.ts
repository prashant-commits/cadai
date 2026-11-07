/**
 * The model catalogue, with no provider imports.
 *
 * This is deliberately separate from model-provider.ts: the browser needs the
 * slug list for the picker and for coercing stale persisted slugs, and
 * importing model-provider would drag ChatAnthropic into the client bundle.
 *
 * Every model runs on the Anthropic Messages API and
 * authenticates server-side with ANTHROPIC_API_KEY, which is never sent to the
 * browser. Slugs use dots ("claude-haiku-5.5"); model-provider.ts maps them to
 * Anthropic model ids ("claude-haiku-5-5").
 */

/**
 * Multimodal model used for all nodes (architect, builder, reviewer).
 *
 * claude-haiku-5.5 since 2026-11-05: in the Architect eval (24 prompts x 5
 * samples) it was 95-98% audit-clean, at a fraction of Sonnet's and Opus's cost.
 */
export const DEFAULT_MODEL = 'claude-haiku-5.5';

/**
 * What the model picker offers, and the set a persisted thread's slug is
 * validated against. A thread saved under a slug no longer offered (an old
 * gateway model) loads on the default instead of erroring.
 *
 * CADAI_MODEL may still name another Claude slug for a trial without a code change.
 */
export const MODELS = [
  { slug: 'claude-haiku-5.5', label: 'Claude Haiku 5.5 - Recommended' },
  { slug: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5 - higher quality' },
  { slug: 'claude-opus-5.5', label: 'Claude Opus 5.5 - highest quality' },
] as const;

export function isOfferedModel(slug: string | undefined): boolean {
  return MODELS.some((m) => m.slug === slug);
}

export function isVisionModel(slug: string | undefined): boolean {
  if (!slug || typeof slug !== 'string') return false;
  return isOfferedModel(slug) || slug.startsWith('claude-') || slug.startsWith('claude/');
}

/**
 * Coerces a client-supplied model slug in chat routes:
 * offered -> as is; otherwise DEFAULT_MODEL (CADAI_MODEL may still override
 * only when it is itself an offered slug).
 */
export function coerceRouteModel(model: string | undefined): string {
  if (model && isOfferedModel(model)) return model;
  if (process.env.CADAI_MODEL && isOfferedModel(process.env.CADAI_MODEL)) {
    return process.env.CADAI_MODEL;
  }
  return DEFAULT_MODEL;
}
