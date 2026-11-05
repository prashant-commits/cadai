/**
 * The Architect eval's Experiential Labs gateway path: any model the gateway
 * serves (Gemini, GLM, DeepSeek, GPT, Grok, Kimi, Qwen, MiniMax, Mistral, ...),
 * called exactly the way the app calls it - getChatModel + structuredFor - so a
 * failure here is a failure the product would show, not an eval artefact.
 *
 * Calls run synchronously with bounded concurrency; there is no batch discount
 * on the gateway. Cost is computed from the gateway's own per-model pricing.
 *
 * The 'google' route sends the same calls to Google's OpenAI-compatible
 * endpoint with GOOGLE_API_KEY (AI Studio) instead of the gateway. Its cost is
 * estimated from the gateway's listed price for the same Gemini model.
 */

export type Route = 'gateway' | 'google';

const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000];

const GOOGLE_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/** The app's client for the gateway; the same client settings pointed at Google for the 'google' route. */
function chatModelFor(route: Route, slug: string): ChatOpenAI {
  if (route === 'gateway') return getChatModel(slug);
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is missing: the google route needs an AI Studio key');
  return new ChatOpenAI({
    apiKey,
    model: slug,
    temperature: DEFAULT_TEMPERATURE,
    timeout: Number(process.env.CADAI_MODEL_TIMEOUT_MS ?? 240_000),
    maxRetries: 1,
    configuration: { baseURL: GOOGLE_OPENAI_BASE_URL },
  });
}
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { DEFAULT_TEMPERATURE, getChatModel } from '@/lib/agent/model-provider';
import { structuredFor, ArchitectPlanSchema } from '@/lib/agent/llm-schemas';
import { variantSpecRequestSchema } from '@/lib/agent/assembly-spec';
import { EXPLABS_BASE_URL } from '@/lib/agent/models';
import type { Outcome } from './parse';

export interface GatewayJob {
  id: string;
  node: 'planner' | 'variant';
  /** The node's system prompt, arm block included. */
  system: string;
  /** The user request, then (variants only) the fresh variant prompt - the graph's message order. */
  prompt: string;
  variantText?: string;
}

interface Pricing {
  input: number;
  cachedInput: number;
  output: number;
}

/** USD per token, from the gateway's catalogue (nano-USD per million tokens). Null when the gateway lists none. */
export async function gatewayPricing(slug: string): Promise<Pricing | null> {
  const r = await fetch(`${EXPLABS_BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` } });
  const j = (await r.json()) as { data?: { id: string; pricing?: Record<string, number | null> }[] };
  const p = j.data?.find((m) => m.id === slug)?.pricing;
  if (!p || p.input_nano_usd_per_million_tokens == null || p.output_nano_usd_per_million_tokens == null) return null;
  const perToken = (nano: number) => nano / 1e9 / 1e6;
  return {
    input: perToken(p.input_nano_usd_per_million_tokens),
    cachedInput: perToken(p.cached_input_nano_usd_per_million_tokens ?? p.input_nano_usd_per_million_tokens),
    output: perToken(p.output_nano_usd_per_million_tokens),
  };
}

interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number };
}

function usdFor(pricing: Pricing | null, usage: UsageMetadata | undefined): number | null {
  if (!pricing || !usage) return null;
  const cached = usage.input_token_details?.cache_read ?? 0;
  const fresh = Math.max(0, (usage.input_tokens ?? 0) - cached);
  return fresh * pricing.input + cached * pricing.cachedInput + (usage.output_tokens ?? 0) * pricing.output;
}

function messagesFor(job: GatewayJob): BaseMessage[] {
  const msgs: BaseMessage[] = [new SystemMessage(job.system), new HumanMessage(job.prompt)];
  if (job.variantText) msgs.push(new HumanMessage(job.variantText));
  return msgs;
}

/** One call, shaped as in architectNode: planner and variant schemas through structuredFor, raw kept for usage. */
async function callOnce(route: Route, slug: string, job: GatewayJob, pricing: Pricing | null): Promise<Outcome> {
  const model = chatModelFor(route, slug);
  const bound = job.node === 'planner'
    ? structuredFor(model, slug, ArchitectPlanSchema, { name: 'ArchitectPlan', strict: true, includeRaw: true })
    : structuredFor(model, slug, variantSpecRequestSchema(), { name: 'AssemblySpec', strict: true, includeRaw: true });
  // A temporary overload (503, or a rate-limit 429) is retried with backoff; a 429 for
  // missing credits is not, since waiting does not fix it.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = (await bound.invoke(messagesFor(job))) as { raw?: { usage_metadata?: UsageMetadata }; parsed?: unknown };
      return { value: res?.parsed ?? null, usd: usdFor(pricing, res?.raw?.usage_metadata) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const transient = /\b(503|429)\b/.test(message) && !/insufficient_credits/.test(message);
      if (!transient || attempt >= RETRY_DELAYS_MS.length) return { error: `provider: ${message}` };
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

export async function runGatewayRound(route: Route, slug: string, jobs: GatewayJob[], pricing: Pricing | null, concurrency: number): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      out.set(job.id, await callOnce(route, slug, job, pricing));
      process.stdout.write('error' in out.get(job.id)! ? 'x' : '.');
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  process.stdout.write('\n');
  return out;
}
