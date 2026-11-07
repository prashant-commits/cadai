/**
 * The Architect eval's synchronous path. The 'gateway' route (name kept for the
 * --provider flag) calls the model exactly the way the app does - getChatModel
 * (Anthropic) + structuredFor - so a failure here is a failure the product would
 * show. The 'google' route sends the same calls to Google's OpenAI-compatible
 * endpoint with GOOGLE_API_KEY (AI Studio). Calls run with bounded concurrency.
 */

import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { getChatModel, type CadChatModel } from '@/lib/agent/model-provider';
import { structuredFor, ArchitectPlanSchema } from '@/lib/agent/llm-schemas';
import { variantSpecRequestSchema } from '@/lib/agent/assembly-spec';
import type { Outcome } from './parse';

export type Route = 'gateway' | 'google';

const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000];

const GOOGLE_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/** The app's client (Anthropic); the same client settings pointed at Google for the 'google' route. */
function chatModelFor(route: Route, slug: string): CadChatModel | ChatOpenAI {
  if (route === 'gateway') return getChatModel(slug);
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is missing: the google route needs an AI Studio key');
  return new ChatOpenAI({
    apiKey,
    model: slug,
    temperature: 0.2,
    timeout: Number(process.env.CADAI_MODEL_TIMEOUT_MS ?? 240_000),
    maxRetries: 1,
    configuration: { baseURL: GOOGLE_OPENAI_BASE_URL },
  });
}

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

/** Per-token pricing for the sync route. Returned as null so cost is reported as unknown. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function gatewayPricing(_slug: string): Promise<Pricing | null> {
  return null;
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
  if (job.variantText) {
    msgs.push(new HumanMessage(`${job.variantText}\n\nReply by calling the AssemblySpec tool.`));
  }
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
      // 529 is Anthropic's overloaded status.
      const transient = (/\b(503|429|529)\b/.test(message) || /overloaded/i.test(message)) && !/insufficient_credits/.test(message);
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
