import { DEFAULT_MODEL, isVisionModel } from '@/lib/agent/models';
import { graphRecursionLimit } from '@/lib/agent/run-limits';

/** Eval default. Sheets are on unless turned off, so the model has to accept images. */
export const EVAL_DEFAULT_MODEL = DEFAULT_MODEL;

/** Same budget the chat routes pass. The formula lives in `graphRecursionLimit`. */
export function recursionLimitFromEnv(): number {
  return graphRecursionLimit();
}

/** Null when this model can run with the effective sheets setting. */
export function sheetsModelError(model: string, sheets: string | undefined): string | null {
  if (sheets === 'off' || isVisionModel(model)) return null;
  return `Sheets are on and ${model} is not a vision model. Pass --sheets off, or use a vision model such as ${DEFAULT_MODEL}.`;
}

