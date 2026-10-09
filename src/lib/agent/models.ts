/**
 * The model catalogue, with no provider imports.
 *
 * This is deliberately separate from model-provider.ts: the browser needs the
 * slug list for the picker and for coercing stale persisted slugs, and
 * importing model-provider would drag ChatOpenAI into the client bundle.
 *
 * Every model runs through the Experiential Labs gateway over the OpenAI wire
 * format and authenticates server-side with EXPLABS_API_KEY, which is never
 * sent to the browser.
 */

export const EXPLABS_BASE_URL = 'https://api.experientiallabs.ai/v1';

/** Multimodal model used for all nodes (architect, drafter, critic). */
export const DEFAULT_MODEL = 'gpt-5.6-luna';

/**
 * What the model picker offers, and the set a persisted thread's slug is
 * validated against.
 *
 * This is NOT an allow-list for getChatModel: CADAI_MODEL may name any slug the
 * gateway serves, so that a new model can be tried without a code change. The
 * list exists so the UI has one source of truth and so a thread saved under a
 * slug we no longer serve loads on the default instead of erroring.
 *
 * gpt-6-sol: probed on the gateway on 2026-10-08. It accepts images and returned
 * a valid strict variant spec with 0 audit errors in 66 s. It costs $2/$10 per M
 * tokens, about 10x gpt-5.6-luna, hence the "(paid)" label and the unchanged default.
 */
export const GATEWAY_MODELS = [
  { slug: 'gpt-5.6-luna', label: 'GPT-5.6 Luna - Recommended' },
  { slug: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { slug: 'gpt-6-sol', label: 'GPT-6 Sol - higher quality (paid)' },
  // Vision verified on 2026-10-08; its route only accepts temperature 1 (see FIXED_TEMPERATURE).
  { slug: 'claude-opus-5.5', label: 'Claude Opus 5.5 - highest quality (paid)' },
] as const;

export function isGatewayModel(slug: string | undefined): boolean {
  return GATEWAY_MODELS.some((m) => m.slug === slug);
}

export function isVisionModel(slug: string | undefined): boolean {
  return isGatewayModel(slug);
}
