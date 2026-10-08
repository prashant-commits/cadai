import { DEFAULT_MODEL, isVisionModel } from '@/lib/agent/models';

/** Eval default. Sheets are on unless turned off, so the model has to accept images. */
export const EVAL_DEFAULT_MODEL = DEFAULT_MODEL;

/**
 * LangGraph's default recursion limit is 25. One review round is 3 super-steps,
 * and a repair attempt is 2, so the budget has to cover both plus the gate.
 * `retries` is CADAI_SPEC_REVIEW_RETRIES (default 5). `maxAttempts` is
 * CADAI_MAX_ATTEMPTS (default 1).
 */
export function recursionLimitFromEnv(env: Record<string, string | undefined> = process.env): number {
  const retries = readCount(env.CADAI_SPEC_REVIEW_RETRIES, 5);
  const maxAttempts = readCount(env.CADAI_MAX_ATTEMPTS, 1);
  return 3 * (retries + 1) + 2 * maxAttempts + 15;
}

/** Null when this model can run with the effective sheets setting. */
export function sheetsModelError(model: string, sheets: string | undefined): string | null {
  if (sheets === 'off' || isVisionModel(model)) return null;
  return `Sheets are on and ${model} is not a vision model. Pass --sheets off, or use a vision model such as ${DEFAULT_MODEL}.`;
}

function readCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
