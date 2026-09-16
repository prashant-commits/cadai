import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { z } from 'zod';
import type { CadChatModel } from '../agent/model-provider';
import { normalizeUrl, type SearchHit, type SearchProvider } from './search-provider';
import {
  QueryPlanSchema,
  BriefResponseSchema,
  queryPlanRequestSchema,
  briefRequestSchema,
  assembleBrief,
  type DesignBrief,
} from './design-brief';
import { RESEARCHER_PREAMBLE, queryPlanPrompt, briefPrompt } from './research-prompts';

/**
 * The research pass, kept pure with respect to graph state so it is tested
 * without LangGraph: two structured-output calls (query plan, then brief
 * synthesis) around parallel searches, every failure reported as a skip
 * reason. The graph node turns a skip into "the Architect runs as before".
 */

export type ResearchSkipReason =
  | 'disabled'
  | 'no_provider'
  | 'already_researched'
  | 'query_plan_failed'
  | 'search_failed'
  | 'no_hits'
  | 'brief_failed';

/** One plain sentence per reason; these reach the UI as progress messages. */
export const RESEARCH_SKIP_MESSAGES: Record<ResearchSkipReason, string> = {
  disabled: 'CADAI_RESEARCH is off',
  no_provider: 'no search provider is configured (set TAVILY_API_KEY)',
  already_researched: 'an approach was already chosen in this thread',
  query_plan_failed: 'the researcher produced no search plan',
  search_failed: 'every search failed',
  no_hits: 'the searches returned nothing usable',
  brief_failed: 'the researcher produced no valid brief',
};

/** Two, not three: a failure here degrades gracefully, unlike an empty spec gate. */
export const MAX_RESEARCH_ATTEMPTS = 2;
/** Across all queries after de-duplication; bounds the synthesis prompt. */
export const MAX_TOTAL_HITS = 12;
export const SEARCH_TIMEOUT_MS = 15_000;

/** The three checks that happen before any model call, in this order. */
export function preResearchSkipReason(args: {
  enabled: boolean;
  provider: SearchProvider | null;
  alreadyChosen: boolean;
}): ResearchSkipReason | null {
  if (!args.enabled) return 'disabled';
  if (!args.provider) return 'no_provider';
  if (args.alreadyChosen) return 'already_researched';
  return null;
}

/** Keeps the first hit for each page (by normalised URL). */
export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = normalizeUrl(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export interface ResearchInput {
  request: string;
  /** contractLines()-style text, or '' when there is no contract. */
  constraints: string;
  provider: SearchProvider;
  model: CadChatModel;
  config?: LangGraphRunnableConfig;
  timeoutMs?: number;
}

export interface ResearchOutput {
  brief: DesignBrief | null;
  skipReason: ResearchSkipReason | null;
}

/**
 * One structured-output call with bounded retry, the way architectNode does
 * it: the model is handed the bounded JSON Schema and zod decides whether the
 * reply counts. A reply that satisfied the decoder but not the contract is a
 * failure that retries, never something that flows onward half-formed.
 */
async function structured<T>(
  model: CadChatModel,
  jsonSchema: Record<string, unknown>,
  name: string,
  schema: z.ZodType<T>,
  messages: BaseMessage[],
  config: LangGraphRunnableConfig | undefined,
  label: string
): Promise<T | null> {
  const bound = model.withStructuredOutput(jsonSchema, { name });
  for (let attempt = 0; attempt < MAX_RESEARCH_ATTEMPTS; attempt++) {
    const attemptMessages =
      attempt === 0
        ? messages
        : [...messages, new HumanMessage('Your previous reply was not valid. Emit the structured object now.')];
    try {
      const raw = await bound.invoke(attemptMessages, config);
      const parsed = schema.safeParse(raw);
      if (parsed.success) return parsed.data;
      console.error(
        `researchNode: ${label} rejected (attempt ${attempt + 1}/${MAX_RESEARCH_ATTEMPTS}):`,
        parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')
      );
    } catch (err) {
      console.error(
        `researchNode: ${label} failed (attempt ${attempt + 1}/${MAX_RESEARCH_ATTEMPTS}):`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return null;
}

async function searchWithTimeout(provider: SearchProvider, query: string, timeoutMs: number): Promise<SearchHit[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await provider.search(query, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function runResearch(input: ResearchInput): Promise<ResearchOutput> {
  const { request, constraints, provider, model, config } = input;
  const timeoutMs = input.timeoutMs ?? SEARCH_TIMEOUT_MS;
  // Research spends real time on web search and two model calls. These lines
  // are the only thing standing between the user and a silent gap, so they go
  // on the graph's custom channel - the same one every other node writes to.
  const say = (message: string) =>
    config?.writer?.({ t: 'delta', text: `${message}
`, node: 'researchNode' });
  const system = new SystemMessage(RESEARCHER_PREAMBLE);

  say('Design Researcher: planning prior-art searches...');
  const plan = await structured(
    model,
    queryPlanRequestSchema(),
    'query_plan',
    QueryPlanSchema,
    [system, new HumanMessage(queryPlanPrompt(request, constraints))],
    config,
    'query plan'
  );
  if (!plan) return { brief: null, skipReason: 'query_plan_failed' };

  // Every query in parallel; one dead query costs nothing but its hits.
  const settled = await Promise.allSettled(plan.queries.map((q) => searchWithTimeout(provider, q, timeoutMs)));
  for (const s of settled) {
    if (s.status === 'rejected') console.warn('researchNode: search failed:', s.reason);
  }
  if (settled.every((s) => s.status === 'rejected')) return { brief: null, skipReason: 'search_failed' };

  const hits = dedupeHits(settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))).slice(0, MAX_TOTAL_HITS);
  if (hits.length === 0) return { brief: null, skipReason: 'no_hits' };

  say(`Design Researcher: comparing ${hits.length} sources on ${plan.partClass}...`);
  const response = await structured(
    model,
    briefRequestSchema(),
    'design_brief',
    BriefResponseSchema,
    [system, new HumanMessage(briefPrompt(request, plan.partClass, hits))],
    config,
    'brief'
  );
  if (!response) return { brief: null, skipReason: 'brief_failed' };

  const { brief, repairedRecommendation } = assembleBrief(plan, response, hits);
  if (repairedRecommendation) {
    console.warn(`researchNode: recommendedId "${response.recommendedId}" named no approach; using ${brief.recommendedId}`);
  }
  return { brief, skipReason: null };
}
