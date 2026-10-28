/**
 * Pure scoring for the Architect eval: token cost and the run summary.
 * No model calls and no compile, so it is unit-tested directly.
 */

/** USD per million tokens, first-party list prices (claude-api skill, cached 2026-10-06). */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 }, // prompts up to 100K tokens
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

/** Cache writes (5-minute TTL) bill at 1.25x input, cache reads at 0.1x. Batch halves everything. */
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;
const BATCH = 0.5;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costUsd(model: string, usage: Usage, batch: boolean): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const input =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) * CACHE_WRITE +
    (usage.cache_read_input_tokens ?? 0) * CACHE_READ;
  const usd = (input * p.input + usage.output_tokens * p.output) / 1_000_000;
  return batch ? usd * BATCH : usd;
}

export interface VariantScore {
  promptId: string;
  sample: number;
  variantId: string;
  /** Provider error, refusal, missing tool call or zod rejection; null when the spec parsed. */
  failure: string | null;
  /** No coherence, shape or ground error on the first attempt - what the graph would accept without a retry. */
  firstAttemptClean: boolean;
  selfCheckErrors: string[];
  /** Components the blockout could not draw and left to the Drafter. */
  blockoutSkipped: number;
  compiled: boolean;
  /** Error-severity violation kinds from the full audit of the composed blockout. */
  auditErrors: string[];
  bbox: string;
  signature: string;
  usd: number | null;
}

export interface PromptScore {
  promptId: string;
  sample: number;
  plannerOk: boolean;
  plannerFailure: string | null;
  variantsPlanned: number;
  usd: number | null;
}

export interface Summary {
  prompts: number;
  plannerOkRate: number;
  variants: number;
  specOkRate: number;
  firstAttemptCleanRate: number;
  compiledRate: number;
  /** Variants whose composed blockout compiled with zero error-severity audit violations. */
  auditCleanRate: number;
  /** Mean count of distinct skeletons per (prompt, sample); planned variants that collapse to one shape lower it. */
  distinctSkeletons: number;
  auditErrorKinds: Record<string, number>;
  selfCheckErrorKinds: Record<string, number>;
  failures: Record<string, number>;
  usd: number | null;
}

const rate = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000);

function tally(lists: string[][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of lists.flat()) out[k] = (out[k] ?? 0) + 1;
  return out;
}

function sumUsd(values: (number | null)[]): number | null {
  if (values.some((v) => v === null)) return null;
  return Math.round((values as number[]).reduce((a, b) => a + b, 0) * 10000) / 10000;
}

export function summarize(prompts: PromptScore[], variants: VariantScore[]): Summary {
  const parsed = variants.filter((v) => v.failure === null);
  const groups = new Map<string, Set<string>>();
  for (const v of parsed) {
    const key = `${v.promptId}#${v.sample}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(v.signature);
  }
  const distinct = [...groups.values()].map((s) => s.size);
  return {
    prompts: prompts.length,
    plannerOkRate: rate(prompts.filter((p) => p.plannerOk).length, prompts.length),
    variants: variants.length,
    specOkRate: rate(parsed.length, variants.length),
    firstAttemptCleanRate: rate(parsed.filter((v) => v.firstAttemptClean).length, variants.length),
    compiledRate: rate(parsed.filter((v) => v.compiled).length, variants.length),
    auditCleanRate: rate(parsed.filter((v) => v.compiled && v.auditErrors.length === 0).length, variants.length),
    distinctSkeletons: distinct.length ? Math.round((distinct.reduce((a, b) => a + b, 0) / distinct.length) * 100) / 100 : 0,
    auditErrorKinds: tally(parsed.map((v) => v.auditErrors)),
    selfCheckErrorKinds: tally(parsed.map((v) => v.selfCheckErrors)),
    failures: tally(variants.filter((v) => v.failure !== null).map((v) => [v.failure!.split(':')[0]])),
    usd: sumUsd([...prompts.map((p) => p.usd), ...variants.map((v) => v.usd)]),
  };
}
