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
 * claude-sonnet-5.5 since 2026-11-07 (feat/brep, B-rep kernel): on the hard
 * eval set (12 prompts x 2, intent judge) Sonnet was 22/22 workable with a
 * mean intent score of 8.2 and a 43 s median run, against Haiku 14/22 (thinking
 * off) and 20/21 (thinking in the build step), at about 5x Haiku's cost per run.
 * Haiku 5.5 was the default from 2026-11-05.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5.5';

/**
 * What the model picker offers, and the set a persisted thread's slug is
 * validated against. A thread saved under a slug no longer offered (an old
 * gateway model) loads on the default instead of erroring.
 *
 * CADAI_MODEL may still name another Claude slug for a trial without a code change.
 */
export const MODELS = [
  { slug: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5 - Recommended' },
  { slug: 'claude-haiku-5.5', label: 'Claude Haiku 5.5 - faster, lower cost' },
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
