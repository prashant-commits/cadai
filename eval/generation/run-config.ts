import * as fs from 'node:fs';
import * as path from 'node:path';
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


export interface PromptItem { id: string; prompt: string }

/** The prompts file used when --prompts is not given. */
export const DEFAULT_PROMPTS_FILE = path.join(__dirname, 'prompts.json');

export function loadPrompts(file: string = DEFAULT_PROMPTS_FILE): PromptItem[] {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as PromptItem[];
}

/**
 * The prompts a run will execute. An id in `only` that the file does not
 * contain is an error, so a child handed the wrong prompts file fails loudly
 * instead of finishing with zero rows.
 */
export function selectPrompts(prompts: PromptItem[], only: string[], limit: number, source = 'the prompts file'): PromptItem[] {
  const missing = only.filter((id) => !prompts.some((p) => p.id === id));
  if (missing.length) throw new Error(`prompt id(s) not found in ${source}: ${missing.join(', ')} (it has ${prompts.length}: ${prompts.slice(0, 5).map((p) => p.id).join(', ')}${prompts.length > 5 ? ', ...' : ''})`);
  const items = (only.length ? prompts.filter((p) => only.includes(p.id)) : prompts).slice(0, limit);
  if (items.length === 0) throw new Error(`no prompts to run from ${source} (limit ${limit})`);
  return items;
}
