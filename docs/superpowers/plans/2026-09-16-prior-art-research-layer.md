# Prior-Art Research Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a research node before the Architect that searches the web for how the requested class of part is normally built, pauses at a new gate where the human picks one of 2–3 structured approaches, and binds the Architect to that approach — degrading to today's behaviour whenever research cannot run.

**Architecture:** `START → researchNode → researchGate → architectNode → …`. A new `src/lib/research/` module holds the search seam (Tavily over plain `fetch`, plus a stub), the `DesignBrief` zod schemas with bounded request schemas, the researcher prompts, and a pure `runResearch()` that makes two structured-output calls (query plan, then brief synthesis) around 2–4 parallel searches. Grounding is a label computed by code (`cited` when a source URL matched a real hit, `recalled` otherwise); no approach is ever dropped. The gate stamps the chosen approach into `designContract.researchApproach`, which is the only thing that survives between turns (graph state is per run), and the Architect reads it from the contract on every pass. `AssemblySpecSchema` is untouched.

**Tech Stack:** Next.js 16 (App Router, Node runtime), LangGraph 1.x (`interrupt`/`Command`), `@langchain/openai` through the Experiential Labs gateway, zod 4 (`z.toJSONSchema`), vitest 4, Tavily Search API (free tier) over `fetch`, React 19 + Tailwind 4 for the gate card.

**Spec:** `docs/superpowers/specs/2026-09-16-prior-art-research-layer-design.md`

## Global Constraints

- Work on branch `claude/geometry-layer-web-search-8a44c1` in this worktree (`C:\Users\prashant\.gemini\antigravity-ide\scratch\cadai\.claude\worktrees\geometry-layer-web-search-8a44c1`). It is rebased on `main` at `8d0e4e9`, after the Gemini removal: there is one `ChatOpenAI` client, `createCadAgent(onProgress?, modelName?)` has no `apiKey` parameter, and `getChatModel(modelName?)` takes one argument.
- Commit after every task. The last line of every commit message is `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **No new npm dependency.** Tavily is called with `fetch`; `fetch` is injected into the provider so tests hand it a fake — never `vi.stubGlobal('fetch', …)`.
- **Tests never touch the network or a real model.** `vitest.setup.ts` injects `EXPLABS_API_KEY`; graph suites mock `@langchain/openai` exactly as `src/lib/agent/graph-hil.test.ts` does. The wasm OpenSCAD compiler is real in tests (`cube([40,40,40]);` compiles in well under the 30 s `testTimeout`).
- **Research is opt-out in the app, off in tests.** The graph reads `process.env.CADAI_RESEARCH !== 'off'`. Task 5 sets `CADAI_RESEARCH='off'` in `vitest.setup.ts` so every existing graph suite keeps its exact model-call counts; only `graph-research.test.ts` sets it `'on'`, together with `CADAI_RESEARCH_STUB='1'` so `resolveSearchProvider()` returns the canned stub without a key.
- Structured-output request schemas: `delete json.$schema`, pass through `boundNumbers()` from `src/lib/agent/assembly-spec.ts`, and contain none of `prefixItems`, `oneOf`, `not`, `additionalItems`, `$ref` (the portability test in `assembly-spec.test.ts` explains why). Never use `z.tuple()`.
- Prompt word budgets are enforced by `src/lib/agent/system-prompt.test.ts`. `ARCHITECT_PREAMBLE` is at **519 of 520 words today**; Task 7 adds one instruction and raises its ceiling to 560 in the same commit. `RESEARCHER_PREAMBLE` gets its own ceiling of 120 words in `research-prompts.test.ts`.
- Nothing raw from a model reaches the UI: every progress `message` is one plain sentence; the brief reaches the client only through `GatePayload`.
- **Never drop an approach.** Verification results are labels (`grounding`), never filters. Fabricated source URLs (ones matching no search hit) are pruned; the approach stays.
- No content heuristic decides whether a request "deserves" research. Skip reasons are exactly: `disabled`, `no_provider`, `already_researched`, `query_plan_failed`, `search_failed`, `no_hits`, `brief_failed`.
- `AssemblySpecSchema` is not modified.
- vitest does not typecheck. After every task that touches `.ts`/`.tsx` types run `npx tsc --noEmit` and require zero errors (tsconfig includes tests and `eval/`).
- Never run the generation eval without first printing its call estimate and getting the user's go-ahead: research spends Tavily quota (free tier, 1,000 requests/month) and gateway calls. Never commit `.env*`, `.cadai/` or `eval/results/`.
- Edges stay sharp: no prompt written here may teach or request a fillet, chamfer, round, elephant-foot or lead-in.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/research/search-provider.ts` | create | `SearchHit`, `SearchProvider`, `normalizeUrl`, `tavilyProvider`, `stubProvider`, `STUB_HITS`, `resolveSearchProvider` |
| `src/lib/research/search-provider.test.ts` | create | Task 1 tests |
| `src/lib/research/design-brief.ts` | create | zod schemas, bounded request schemas, `groundApproaches`, `assembleBrief`, `chooseApproach`, `approachBlock`, `ChosenApproach` |
| `src/lib/research/design-brief.test.ts` | create | Task 2 tests |
| `src/lib/research/research-prompts.ts` | create | `RESEARCHER_PREAMBLE`, `queryPlanPrompt`, `briefPrompt` |
| `src/lib/research/research-prompts.test.ts` | create | Task 3 tests |
| `src/lib/research/research-node.ts` | create | `preResearchSkipReason`, `runResearch`, `dedupeHits`, `RESEARCH_SKIP_MESSAGES`, `ResearchSkipReason` |
| `src/lib/research/research-node.test.ts` | create | Task 4 tests |
| `src/types/index.ts` | modify | `DesignContract.researchApproach`, `GatePayload` research variant, `GateDecision.chosenApproachId` |
| `src/store/app-store.ts` | modify | `setThreadContract` keeps `researchApproach` |
| `src/store/app-store.test.ts` | modify | Task 5 test |
| `vitest.setup.ts` | modify | research off in tests |
| `src/components/chat/gate-inline-ui.tsx` | modify | Task 5: `revisionCount` guard; Task 8: research branch |
| `src/lib/agent/graph.ts` | modify | state fields, `researchNode`, `researchGate`, routing, Architect binding, explanation line |
| `src/lib/agent/graph-research.test.ts` | create | Tasks 6–7 tests |
| `src/lib/agent/system-prompt.ts` | modify | DESIGN APPROACH instruction |
| `src/lib/agent/system-prompt.test.ts` | modify | budget 560, new assertion |
| `eval/generation/run.ts` | modify | `--research on|off` |
| `eval/generation/metrics.ts` | modify | `researchRan`, `citedApproachChosen` |
| `eval/generation/metrics.test.ts` | modify | Task 9 tests |
| `README.md` | modify | env documentation |

---

### Task 1: Search provider seam

**Files:**
- Create: `src/lib/research/search-provider.ts`
- Test: `src/lib/research/search-provider.test.ts`

**Interfaces:**
- Produces:
  - `interface SearchHit { title: string; url: string; content: string; score?: number }`
  - `interface SearchProvider { search(query: string, signal?: AbortSignal): Promise<SearchHit[]> }`
  - `MAX_HITS_PER_QUERY = 5`, `MAX_CONTENT_CHARS = 1200`, `TAVILY_URL`
  - `normalizeUrl(raw: string): string`
  - `tavilyProvider(apiKey: string, fetchImpl?: typeof fetch): SearchProvider`
  - `stubProvider(hits: SearchHit[] | ((query: string) => SearchHit[])): SearchProvider`
  - `STUB_HITS: SearchHit[]` (three canned hits, URLs `https://example.com/fdm-brackets`, `https://example.com/hinges-enclosures`, `https://example.com/snap-fit`)
  - `resolveSearchProvider(env?: NodeJS.ProcessEnv): SearchProvider | null` — stub when `CADAI_RESEARCH_STUB === '1'`, Tavily when `TAVILY_API_KEY` is set, else `null`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/research/search-provider.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  normalizeUrl,
  tavilyProvider,
  stubProvider,
  resolveSearchProvider,
  MAX_HITS_PER_QUERY,
  MAX_CONTENT_CHARS,
  TAVILY_URL,
  STUB_HITS,
} from './search-provider';

/** A fetch double that resolves to one canned JSON body. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}
const provider = (key: string, f: ReturnType<typeof fakeFetch>) =>
  tavilyProvider(key, f as unknown as typeof fetch);

describe('normalizeUrl', () => {
  it('lower-cases scheme and host, drops www, fragment and trailing slashes, keeps the query', () => {
    expect(normalizeUrl('HTTPS://www.Example.com/Foo/#frag')).toBe('https://example.com/Foo');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('returns a malformed URL trimmed, so it only ever matches itself', () => {
    expect(normalizeUrl('  not a url ')).toBe('not a url');
  });
});

describe('tavilyProvider', () => {
  const results = Array.from({ length: 7 }, (_, i) => ({
    title: `Page ${i}`,
    url: `https://example.com/p${i}`,
    content: 'x'.repeat(2000),
    score: 0.9 - i / 10,
  }));

  it('posts the query with a bearer token and maps results to hits', async () => {
    const f = fakeFetch({ results });
    const hits = await provider('tvly-key', f).search('l bracket fdm');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(TAVILY_URL);
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tvly-key');
    expect(JSON.parse(init!.body as string)).toEqual({
      query: 'l bracket fdm',
      max_results: MAX_HITS_PER_QUERY,
      search_depth: 'basic',
      include_answer: false,
    });
    expect(hits[0]).toEqual({
      title: 'Page 0',
      url: 'https://example.com/p0',
      content: 'x'.repeat(MAX_CONTENT_CHARS),
      score: 0.9,
    });
  });

  it('caps hits per query and truncates content', async () => {
    const hits = await provider('k', fakeFetch({ results })).search('q');
    expect(hits).toHaveLength(MAX_HITS_PER_QUERY);
    for (const h of hits) expect(h.content.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
  });

  it('drops results without a url and tolerates missing fields', async () => {
    const hits = await provider('k', fakeFetch({ results: [{ title: 'no url' }, { url: 'https://a.com' }] })).search('q');
    expect(hits).toEqual([{ title: 'https://a.com', url: 'https://a.com', content: '', score: undefined }]);
  });

  it('throws on a non-2xx response', async () => {
    await expect(provider('k', fakeFetch({}, 429)).search('q')).rejects.toThrow(/HTTP 429/);
  });

  it('passes the abort signal through to fetch', async () => {
    const f = fakeFetch({ results: [] });
    const controller = new AbortController();
    await provider('k', f).search('q', controller.signal);
    expect(f.mock.calls[0][1]!.signal).toBe(controller.signal);
  });
});

describe('stubProvider', () => {
  it('serves fixed or per-query hits', async () => {
    expect(await stubProvider(STUB_HITS).search('anything')).toBe(STUB_HITS);
    const perQuery = stubProvider((q) => [{ title: q, url: `https://x.com/${q}`, content: '' }]);
    expect((await perQuery.search('hinge'))[0].url).toBe('https://x.com/hinge');
  });
});

describe('resolveSearchProvider', () => {
  it('is null with no key, Tavily with a key, and the stub in stub mode', async () => {
    expect(resolveSearchProvider({})).toBeNull();
    expect(resolveSearchProvider({ TAVILY_API_KEY: 'k' })).not.toBeNull();
    const stub = resolveSearchProvider({ CADAI_RESEARCH_STUB: '1' });
    expect(await stub!.search('q')).toBe(STUB_HITS);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/research/search-provider.test.ts`
Expected: FAIL — `Cannot find module './search-provider'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/research/search-provider.ts`:

```ts
/**
 * Web search behind one seam.
 *
 * The research node needs "a few relevant pages with their text" and nothing
 * else, so the interface is one method. Tavily is the live implementation:
 * free tier, plain fetch, no SDK - and because Nebius is acquiring Tavily,
 * this file is the one place to swap if its terms change. The stub is what
 * every test and the CADAI_RESEARCH_STUB=1 dev mode use, so no test ever
 * touches the network and the gate UI can be exercised without a key.
 */

export interface SearchHit {
  title: string;
  url: string;
  /** Extracted page text, already truncated to MAX_CONTENT_CHARS. */
  content: string;
  score?: number;
}

export interface SearchProvider {
  /** Hits for one query, at most MAX_HITS_PER_QUERY. Throws on failure. */
  search(query: string, signal?: AbortSignal): Promise<SearchHit[]>;
}

/** Per query. Four queries at five hits is more than the synthesis prompt keeps. */
export const MAX_HITS_PER_QUERY = 5;
/** Per hit. Twelve hits at 1,200 characters keeps the synthesis prompt near 4k tokens. */
export const MAX_CONTENT_CHARS = 1200;
export const TAVILY_URL = 'https://api.tavily.com/search';

/**
 * Two URLs name the same page when they agree after this: scheme and host
 * lower-cased, a leading `www.` dropped, the fragment dropped, trailing
 * slashes dropped. The query string is kept because it can select a different
 * page. Anything that does not parse is returned trimmed, so a malformed URL
 * only ever matches itself.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.host.toLowerCase().replace(/^www\./, '');
    const pathname = u.pathname.replace(/\/+$/, '');
    return `${u.protocol.toLowerCase()}//${host}${pathname}${u.search}`;
  } catch {
    return raw.trim();
  }
}

type TavilyResult = { title?: string; url?: string; content?: string; score?: number };

/**
 * Tavily's /search endpoint over plain fetch. `fetchImpl` is injectable so the
 * adapter is tested against a canned response instead of the network.
 */
export function tavilyProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    async search(query, signal) {
      const res = await fetchImpl(TAVILY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          max_results: MAX_HITS_PER_QUERY,
          search_depth: 'basic',
          include_answer: false,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`Tavily search failed: HTTP ${res.status}`);
      const body = (await res.json()) as { results?: TavilyResult[] };
      return (body.results ?? [])
        .filter((r): r is TavilyResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
        .slice(0, MAX_HITS_PER_QUERY)
        .map((r) => ({
          title: r.title || r.url,
          url: r.url,
          content: (r.content ?? '').slice(0, MAX_CONTENT_CHARS),
          score: typeof r.score === 'number' ? r.score : undefined,
        }));
    },
  };
}

/** Canned hits, fixed or computed per query, for tests and stub mode. */
export function stubProvider(hits: SearchHit[] | ((query: string) => SearchHit[])): SearchProvider {
  return {
    async search(query) {
      return typeof hits === 'function' ? hits(query) : hits;
    },
  };
}

/**
 * What CADAI_RESEARCH_STUB=1 serves: enough for the gate to render approaches
 * with sources, without a key and without spending quota.
 */
export const STUB_HITS: SearchHit[] = [
  {
    title: 'Designing brackets and mounts for FDM printing',
    url: 'https://example.com/fdm-brackets',
    content:
      'Wall brackets print strongest flat on the back plate with a triangular gusset between plate and arm. Screw holes get 0.2 mm of extra clearance and a counterbore on the print side.',
  },
  {
    title: 'Print-in-place hinges and two-part enclosures',
    url: 'https://example.com/hinges-enclosures',
    content:
      'A two-part enclosure with a lip-and-groove lid avoids fasteners; a print-in-place hinge needs 0.4 mm of radial clearance and a flat bed face on both leaves.',
  },
  {
    title: 'Snap-fit cantilever design rules',
    url: 'https://example.com/snap-fit',
    content:
      'Cantilever snap arms are printed lying in the XY plane so the bending load stays in-layer; root thickness 1.8 to 2.2 mm with a 0.3 mm undercut.',
  },
];

/**
 * The provider the graph uses, or null when research cannot run - in which
 * case the node degrades to the Architect running exactly as it did before,
 * rather than failing the run.
 */
export function resolveSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider | null {
  if (env.CADAI_RESEARCH_STUB === '1') return stubProvider(STUB_HITS);
  const key = env.TAVILY_API_KEY;
  return key ? tavilyProvider(key) : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/research/search-provider.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/research/search-provider.ts src/lib/research/search-provider.test.ts
git commit -m "feat(research): search provider seam with a Tavily adapter and a stub

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: DesignBrief schemas, grounding and assembly

**Files:**
- Create: `src/lib/research/design-brief.ts`
- Test: `src/lib/research/design-brief.test.ts`

**Interfaces:**
- Consumes: `normalizeUrl`, `SearchHit` from Task 1; `boundNumbers` from `src/lib/agent/assembly-spec.ts`.
- Produces:
  - zod: `GroundingSchema`, `SourceSchema`, `ApproachSchema`, `QueryPlanSchema`, `BriefResponseSchema`, `DesignBriefSchema`; types `Grounding`, `Source`, `ApproachRequest`, `Approach`, `QueryPlan`, `BriefResponse`, `DesignBrief`.
  - `interface ChosenApproach { partClass: string; approach: Approach; chosenAt: number }`
  - `MIN_APPROACHES = 2`, `MAX_APPROACHES = 3`
  - `queryPlanRequestSchema(): Record<string, unknown>`, `briefRequestSchema(): Record<string, unknown>`
  - `groundApproaches(approaches: ApproachRequest[], hits: SearchHit[]): Approach[]`
  - `assembleBrief(plan: QueryPlan, response: BriefResponse, hits: SearchHit[]): { brief: DesignBrief; repairedRecommendation: boolean }`
  - `chooseApproach(brief: DesignBrief, id: string | null | undefined): Approach`
  - `approachBlock(chosen: ChosenApproach): string`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/research/design-brief.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ApproachSchema,
  BriefResponseSchema,
  QueryPlanSchema,
  DesignBriefSchema,
  queryPlanRequestSchema,
  briefRequestSchema,
  groundApproaches,
  assembleBrief,
  chooseApproach,
  approachBlock,
  type ApproachRequest,
  type DesignBrief,
} from './design-brief';
import type { SearchHit } from './search-provider';

const hit = (url: string): SearchHit => ({ title: url, url, content: '' });
const approach = (id: string, urls: string[] = []): ApproachRequest => ({
  id,
  name: `Approach ${id}`,
  construction: 'Two plates joined by a gusset.',
  strengths: ['stiff'],
  weaknesses: ['heavy'],
  sources: urls.map((u) => ({ title: u, url: u })),
});
const plan = { partClass: 'wall bracket', queries: ['wall bracket fdm', 'gusseted bracket 3d print'] };

describe('request schemas', () => {
  const json = () => JSON.stringify(briefRequestSchema()) + JSON.stringify(queryPlanRequestSchema());

  it('never ask the model for the fields code fills in', () => {
    expect(json()).not.toContain('"grounding"');
    expect(json()).not.toContain('"searchQueries"');
    expect(json()).not.toContain('"$schema"');
  });

  it('stay inside the JSON Schema subset a constrained decoder accepts', () => {
    for (const keyword of ['prefixItems', 'oneOf', 'not', 'additionalItems', '$ref']) {
      expect(json(), `schema must not use "${keyword}"`).not.toContain(`"${keyword}"`);
    }
  });

  it('request the same approach fields the brief validates, minus grounding', () => {
    const items = (briefRequestSchema() as any).properties.approaches.items;
    const requested = Object.keys(items.properties).sort();
    const validated = Object.keys((z.toJSONSchema(ApproachSchema) as any).properties)
      .filter((k) => k !== 'grounding')
      .sort();
    expect(requested).toEqual(validated);
  });

  it('bound the number of approaches and queries', () => {
    expect(BriefResponseSchema.safeParse({ approaches: [approach('a')], recommendedId: 'a' }).success).toBe(false);
    expect(QueryPlanSchema.safeParse({ partClass: 'x', queries: ['one'] }).success).toBe(false);
    expect(QueryPlanSchema.safeParse({ partClass: 'x', queries: ['1', '2', '3', '4', '5'] }).success).toBe(false);
  });
});

describe('groundApproaches', () => {
  it('labels cited when a source matches a hit after normalisation, and prunes the rest', () => {
    const out = groundApproaches(
      [approach('a', ['HTTPS://www.Example.com/page/#top', 'https://nowhere.example/x'])],
      [hit('https://example.com/page')]
    );
    expect(out[0].grounding).toBe('cited');
    expect(out[0].sources.map((s) => s.url)).toEqual(['HTTPS://www.Example.com/page/#top']);
  });

  it('labels recalled with no matching source and never drops an approach', () => {
    const out = groundApproaches(
      [approach('a', ['https://nowhere.example/x']), approach('b')],
      [hit('https://example.com/page')]
    );
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.grounding)).toEqual(['recalled', 'recalled']);
    expect(out[0].sources).toEqual([]);
  });

  it('sorts cited first and keeps the original order within each group', () => {
    const hits = [hit('https://a.com'), hit('https://b.com')];
    const out = groundApproaches(
      [approach('r1'), approach('c1', ['https://a.com']), approach('r2'), approach('c2', ['https://b.com'])],
      hits
    );
    expect(out.map((a) => a.id)).toEqual(['c1', 'c2', 'r1', 'r2']);
  });

  it('de-duplicates sources that normalise to the same page', () => {
    const out = groundApproaches([approach('a', ['https://a.com/p', 'https://www.a.com/p/'])], [hit('https://a.com/p')]);
    expect(out[0].sources).toHaveLength(1);
  });
});

describe('assembleBrief', () => {
  const hits = [hit('https://a.com')];

  it('re-keys ids positionally after sorting and carries the recommendation across', () => {
    const { brief, repairedRecommendation } = assembleBrief(
      plan,
      { approaches: [approach('x'), approach('y', ['https://a.com'])], recommendedId: 'x' },
      hits
    );
    expect(brief.approaches.map((a) => [a.id, a.name])).toEqual([
      ['a1', 'Approach y'],
      ['a2', 'Approach x'],
    ]);
    expect(brief.recommendedId).toBe('a2');
    expect(repairedRecommendation).toBe(false);
    expect(brief.searchQueries).toEqual(plan.queries);
    expect(brief.partClass).toBe('wall bracket');
  });

  it('repairs an unknown recommendation to the first cited approach, else the first approach', () => {
    const cited = assembleBrief(
      plan,
      { approaches: [approach('x'), approach('y', ['https://a.com'])], recommendedId: 'zzz' },
      hits
    );
    expect(cited.brief.recommendedId).toBe('a1');
    expect(cited.brief.approaches[0].grounding).toBe('cited');
    expect(cited.repairedRecommendation).toBe(true);

    const none = assembleBrief(plan, { approaches: [approach('x'), approach('y')], recommendedId: 'zzz' }, hits);
    expect(none.brief.recommendedId).toBe('a1');
  });

  it('survives duplicate model ids', () => {
    const { brief } = assembleBrief(plan, { approaches: [approach('dup'), approach('dup')], recommendedId: 'dup' }, hits);
    expect(new Set(brief.approaches.map((a) => a.id)).size).toBe(2);
    expect(DesignBriefSchema.safeParse(brief).success).toBe(true);
  });
});

describe('chooseApproach', () => {
  const brief: DesignBrief = assembleBrief(
    plan,
    { approaches: [approach('x'), approach('y')], recommendedId: 'y' },
    []
  ).brief;

  it('returns the named approach, else the recommendation', () => {
    expect(chooseApproach(brief, 'a1').id).toBe('a1');
    expect(chooseApproach(brief, 'nope').id).toBe(brief.recommendedId);
    expect(chooseApproach(brief, undefined).id).toBe(brief.recommendedId);
  });
});

describe('approachBlock', () => {
  it('renders every field and the binding instruction', () => {
    const [a] = groundApproaches([approach('a', ['https://a.com'])], [hit('https://a.com')]);
    const text = approachBlock({ partClass: 'bracket', approach: a, chosenAt: 1 });
    expect(text).toContain('Design Approach (chosen by the user from prior-art research)');
    expect(text).toContain('Name: Approach a');
    expect(text).toContain('- stiff');
    expect(text).toContain('- heavy');
    expect(text).toContain('Sources: https://a.com');
    expect(text).toContain('record it in assumptions[]');

    const noSources = approachBlock({ partClass: 'bracket', approach: { ...a, sources: [] }, chosenAt: 1 });
    expect(noSources).toContain('Sources: none retrieved');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/research/design-brief.test.ts`
Expected: FAIL — `Cannot find module './design-brief'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/research/design-brief.ts`:

```ts
import { z } from 'zod';
import { boundNumbers } from '../agent/assembly-spec';
import { normalizeUrl, type SearchHit } from './search-provider';

/**
 * The Design Brief: what the research node hands the human, and what the
 * Architect is bound to once one approach is chosen.
 *
 * Structured, not prose, for the same reason stress mitigations became
 * structured gussets: a prose brief gets ignored. Two of its fields are never
 * requested from the model - `grounding` is a verification result code
 * computes, and `searchQueries` is what code actually sent to the provider -
 * so the request schemas below are the zod schemas minus those fields.
 */

export const GroundingSchema = z.enum(['cited', 'recalled']);
export type Grounding = z.infer<typeof GroundingSchema>;

export const SourceSchema = z.object({ title: z.string(), url: z.string() });
export type Source = z.infer<typeof SourceSchema>;

/** An approach as the model emits it: no grounding; code sets that afterwards. */
const ApproachRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 2-4 sentences: what bodies, how they join, how it prints. */
  construction: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  /** May be empty, and is pruned to URLs the search actually returned. */
  sources: z.array(SourceSchema),
});
export type ApproachRequest = z.infer<typeof ApproachRequestSchema>;

export const ApproachSchema = ApproachRequestSchema.extend({ grounding: GroundingSchema });
export type Approach = z.infer<typeof ApproachSchema>;

export const MIN_APPROACHES = 2;
export const MAX_APPROACHES = 3;

/** What the query-plan call returns. */
export const QueryPlanSchema = z.object({
  partClass: z.string(),
  queries: z.array(z.string()).min(2).max(4),
});
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

/** What the brief-synthesis call returns. */
export const BriefResponseSchema = z.object({
  approaches: z.array(ApproachRequestSchema).min(MIN_APPROACHES).max(MAX_APPROACHES),
  recommendedId: z.string(),
});
export type BriefResponse = z.infer<typeof BriefResponseSchema>;

/** Assembled by code from the two replies and the hits; shown at the gate. */
export const DesignBriefSchema = z.object({
  partClass: z.string(),
  approaches: z.array(ApproachSchema).min(MIN_APPROACHES).max(MAX_APPROACHES),
  recommendedId: z.string(),
  searchQueries: z.array(z.string()),
});
export type DesignBrief = z.infer<typeof DesignBriefSchema>;

/**
 * The approach a human picked, as it travels between turns inside the Design
 * Contract. Graph state is per run, so this is the only thing that survives.
 */
export interface ChosenApproach {
  partClass: string;
  approach: Approach;
  chosenAt: number;
}

/** JSON Schema for a structured-output call: no $schema, every number bounded (see boundNumbers). */
function requestSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return boundNumbers(json) as Record<string, unknown>;
}
export function queryPlanRequestSchema(): Record<string, unknown> {
  return requestSchema(QueryPlanSchema);
}
export function briefRequestSchema(): Record<string, unknown> {
  return requestSchema(BriefResponseSchema);
}

/**
 * Labels grounding and prunes sources; never drops an approach.
 *
 * An approach is `cited` when at least one of its URLs matches a hit after
 * normalisation. A URL matching no hit is removed, because a link to nowhere
 * in the gate is worse than no link - but the approach stays, labelled
 * `recalled`: verification is a label the human weighs, not a filter. The
 * result is cited-first with the original order kept within each group.
 */
export function groundApproaches(approaches: ApproachRequest[], hits: SearchHit[]): Approach[] {
  const known = new Set(hits.map((h) => normalizeUrl(h.url)));
  const grounded: Approach[] = approaches.map((a) => {
    const seen = new Set<string>();
    const sources = a.sources.filter((s) => {
      const key = normalizeUrl(s.url);
      if (!known.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...a, sources, grounding: sources.length ? 'cited' : 'recalled' };
  });
  return [
    ...grounded.filter((a) => a.grounding === 'cited'),
    ...grounded.filter((a) => a.grounding === 'recalled'),
  ];
}

/**
 * Builds the brief from the two model replies and the hits.
 *
 * Ids are re-keyed positionally (a1, a2, ...) after sorting, because the
 * model's ids are not trusted to be unique and the gate's radio group needs
 * them to be; the recommendation is carried across by identity. A
 * recommendedId naming no approach is repaired to the first cited approach,
 * else the first approach, and reported so the caller can log it.
 */
export function assembleBrief(
  plan: QueryPlan,
  response: BriefResponse,
  hits: SearchHit[]
): { brief: DesignBrief; repairedRecommendation: boolean } {
  const grounded = groundApproaches(response.approaches, hits);
  const recommendedBefore = grounded.find((a) => a.id === response.recommendedId) ?? null;
  const approaches = grounded.map((a, i) => ({ ...a, id: `a${i + 1}` }));
  const recommended = recommendedBefore
    ? approaches[grounded.indexOf(recommendedBefore)]
    : (approaches.find((a) => a.grounding === 'cited') ?? approaches[0]);
  const brief = DesignBriefSchema.parse({
    partClass: plan.partClass,
    approaches,
    recommendedId: recommended.id,
    searchQueries: plan.queries,
  });
  return { brief, repairedRecommendation: !recommendedBefore };
}

/** The approach for `id`, or the recommendation when `id` is absent or unknown. */
export function chooseApproach(brief: DesignBrief, id: string | null | undefined): Approach {
  return (
    brief.approaches.find((a) => a.id === id) ??
    brief.approaches.find((a) => a.id === brief.recommendedId) ??
    brief.approaches[0]
  );
}

/** The Architect's binding block, rebuilt from the contract on every pass. */
export function approachBlock(chosen: ChosenApproach): string {
  const a = chosen.approach;
  const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '- none');
  return [
    'Design Approach (chosen by the user from prior-art research):',
    `Name: ${a.name}`,
    `Construction: ${a.construction}`,
    `Strengths:\n${list(a.strengths)}`,
    `Weaknesses to design around:\n${list(a.weaknesses)}`,
    `Sources: ${a.sources.length ? a.sources.map((s) => s.url).join(', ') : 'none retrieved'}`,
    'Build this construction: the same bodies and the same joining scheme. If a physical constraint forces a deviation, record it in assumptions[] with its rationale.',
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/research/design-brief.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/research/design-brief.ts src/lib/research/design-brief.test.ts
git commit -m "feat(research): DesignBrief schemas with code-computed grounding

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Researcher prompts

**Files:**
- Create: `src/lib/research/research-prompts.ts`
- Test: `src/lib/research/research-prompts.test.ts`

**Interfaces:**
- Consumes: `SearchHit` from Task 1.
- Produces: `RESEARCHER_PREAMBLE: string`, `queryPlanPrompt(request: string, constraints: string): string`, `briefPrompt(request: string, partClass: string, hits: SearchHit[]): string`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/research/research-prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RESEARCHER_PREAMBLE, queryPlanPrompt, briefPrompt } from './research-prompts';

const words = (s: string) => s.trim().split(/\s+/).length;

describe('research prompts', () => {
  it('keeps the researcher preamble short: it rides on two calls per run', () => {
    expect(words(RESEARCHER_PREAMBLE)).toBeLessThanOrEqual(120);
  });

  it('teaches no edge treatment and never decides dimensions', () => {
    // Same rule as system-prompt.test.ts: the words may only appear in a
    // sentence that prohibits them.
    const withoutProhibitions = RESEARCHER_PREAMBLE.split(/(?<=\.)\s+|\n/)
      .filter((s) => !/\b(never|no|not|sharp)\b/i.test(s))
      .join('\n');
    expect(withoutProhibitions).not.toMatch(/\b(fillets?|chamfers?|rounds?|rounding)\b/i);
    expect(RESEARCHER_PREAMBLE).toMatch(/never decide dimensions/i);
    expect(RESEARCHER_PREAMBLE).toMatch(/never write code/i);
  });

  it('plans queries from the request and the standing constraints', () => {
    const p = queryPlanPrompt('a wall bracket for a 2 kg shelf', 'Material: PETG.');
    expect(p).toContain('a wall bracket for a 2 kg shelf');
    expect(p).toContain('Material: PETG.');
    expect(p).toMatch(/2-4 search queries/);
    expect(queryPlanPrompt('x', '')).not.toContain('Standing constraints');
  });

  it('numbers every hit with its URL and forbids invented URLs', () => {
    const p = briefPrompt('a wall bracket', 'wall bracket', [
      { title: 'A', url: 'https://a.com', content: 'alpha' },
      { title: 'B', url: 'https://b.com', content: 'beta' },
    ]);
    expect(p).toContain('[1] A\nhttps://a.com\nalpha');
    expect(p).toContain('[2] B\nhttps://b.com\nbeta');
    expect(p).toMatch(/Do not invent URLs/);
    expect(p).toMatch(/2-3 approaches/);
    expect(p).toContain('wall bracket');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/research/research-prompts.test.ts`
Expected: FAIL — `Cannot find module './research-prompts'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/research/research-prompts.ts`:

```ts
import type { SearchHit } from './search-provider';

/**
 * Prompts for the Design Researcher, the node that runs before the Architect.
 *
 * Kept out of system-prompt.ts on purpose: the researcher never sees OpenSCAD
 * and never decides a dimension, so it does not need the CAD rules, and the
 * shared CAD_AI_SYSTEM_PROMPT (which rides on every other node's calls) does
 * not grow. research-prompts.test.ts holds this file to a 120-word preamble.
 */
export const RESEARCHER_PREAMBLE = `You are the Design Researcher for a parametric CAD pipeline that produces FDM-printed mechanical parts. You run BEFORE the Mechanical Architect. Your job is to find how the requested class of part is normally built - its construction: which bodies exist, how they join, how it prints - so a human can choose an approach before any dimension is fixed. You never decide dimensions and never write code. Every edge stays sharp: do not propose fillets, chamfers or rounds. Prefer constructions that print without support and keep bending loads in the layer plane.`;

/** The query-plan call: turns the request into a part class and 2-4 searches. */
export function queryPlanPrompt(request: string, constraints: string): string {
  return `Plan web searches for prior art on this request.

Request:
${request}
${constraints ? `\nStanding constraints:\n${constraints}\n` : ''}
Return partClass (a short noun phrase naming the class of part, e.g. "wall-mounted hair dryer holder") and 2-4 search queries that would find how makers and engineers build this class of part for 3D printing: construction styles, joining schemes, print orientation. Queries are plain search-engine phrases, each under 12 words, no quotes.`;
}

/** The brief-synthesis call: compares constructions using only the numbered hits. */
export function briefPrompt(request: string, partClass: string, hits: SearchHit[]): string {
  const sources = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.content}`).join('\n\n');
  return `Compare construction approaches for: ${partClass}

Request:
${request}

Sources:
${sources}

Return 2-3 approaches. For each: id (a1, a2, a3), name, construction (2-4 sentences: what bodies, how they join, how it prints on an FDM bed), strengths, weaknesses, and sources - only URLs copied exactly from the list above that actually support the approach; leave sources empty if none does. Set recommendedId to the approach best suited to FDM printing and to the request. Do not invent URLs.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/research/research-prompts.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/research/research-prompts.ts src/lib/research/research-prompts.test.ts
git commit -m "feat(research): researcher preamble and the two research prompts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `runResearch` — the pure research pass

**Files:**
- Create: `src/lib/research/research-node.ts`
- Test: `src/lib/research/research-node.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `CadChatModel` from `src/lib/agent/model-provider.ts`; `HumanMessage`, `SystemMessage` from `@langchain/core/messages`; `RunnableConfig` type from `@langchain/core/runnables`.
- Produces:
  - `type ResearchSkipReason = 'disabled' | 'no_provider' | 'already_researched' | 'query_plan_failed' | 'search_failed' | 'no_hits' | 'brief_failed'`
  - `RESEARCH_SKIP_MESSAGES: Record<ResearchSkipReason, string>`
  - `MAX_RESEARCH_ATTEMPTS = 2`, `MAX_TOTAL_HITS = 12`, `SEARCH_TIMEOUT_MS = 15_000`
  - `preResearchSkipReason(args: { enabled: boolean; provider: SearchProvider | null; alreadyChosen: boolean }): ResearchSkipReason | null`
  - `dedupeHits(hits: SearchHit[]): SearchHit[]`
  - `runResearch(input: ResearchInput): Promise<ResearchOutput>` where `ResearchInput = { request: string; constraints: string; provider: SearchProvider; model: CadChatModel; onProgress?: (e: { type: 'thinking'; message: string; timestamp: number }) => void; config?: RunnableConfig; timeoutMs?: number }` and `ResearchOutput = { brief: DesignBrief | null; skipReason: ResearchSkipReason | null }`.

The model is used exactly as `architectNode` uses it: `model.withStructuredOutput(jsonSchema, { name }).invoke(messages, config)`, with the reply validated by zod and retried once on failure.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/research/research-node.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { CadChatModel } from '../agent/model-provider';
import { stubProvider, STUB_HITS, type SearchHit, type SearchProvider } from './search-provider';
import {
  runResearch,
  preResearchSkipReason,
  dedupeHits,
  MAX_RESEARCH_ATTEMPTS,
  MAX_TOTAL_HITS,
} from './research-node';

/**
 * A model double: withStructuredOutput() returns an object whose invoke()
 * pops the next canned reply. An Error in the queue is thrown instead.
 */
function fakeModel(replies: unknown[]) {
  const invoke = vi.fn(async () => {
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r;
  });
  const model = { withStructuredOutput: vi.fn(() => ({ invoke })) };
  return { model: model as unknown as CadChatModel, invoke };
}

const plan = { partClass: 'wall bracket', queries: ['wall bracket fdm', 'gusseted bracket 3d print'] };
const briefReply = {
  approaches: [
    {
      id: 'p',
      name: 'Plate and gusset',
      construction: 'A back plate with an arm and a gusset.',
      strengths: ['stiff'],
      weaknesses: ['bulky'],
      sources: [{ title: 'FDM brackets', url: STUB_HITS[0].url }],
    },
    { id: 'q', name: 'Folded channel', construction: 'A U channel.', strengths: ['light'], weaknesses: ['flexes'], sources: [] },
  ],
  recommendedId: 'p',
};

/** The text of the last HumanMessage handed to model call `n`. */
function lastHuman(invoke: ReturnType<typeof vi.fn>, n: number): string {
  const messages = invoke.mock.calls[n][0] as Array<{ content: unknown }>;
  return String(messages[messages.length - 1].content);
}

describe('preResearchSkipReason', () => {
  const provider = stubProvider([]);
  it('checks disabled, then provider, then an existing choice', () => {
    expect(preResearchSkipReason({ enabled: false, provider: null, alreadyChosen: true })).toBe('disabled');
    expect(preResearchSkipReason({ enabled: true, provider: null, alreadyChosen: true })).toBe('no_provider');
    expect(preResearchSkipReason({ enabled: true, provider, alreadyChosen: true })).toBe('already_researched');
    expect(preResearchSkipReason({ enabled: true, provider, alreadyChosen: false })).toBeNull();
  });
});

describe('dedupeHits', () => {
  it('keeps the first of any hits that normalise to the same page', () => {
    const out = dedupeHits([
      { title: 'a', url: 'https://a.com/p/', content: '' },
      { title: 'b', url: 'https://www.a.com/p', content: '' },
      { title: 'c', url: 'https://b.com', content: '' },
    ]);
    expect(out.map((h) => h.title)).toEqual(['a', 'c']);
  });
});

describe('runResearch', () => {
  it('plans, searches, synthesises, and returns a grounded brief', async () => {
    const { model, invoke } = fakeModel([plan, briefReply]);
    const events: string[] = [];
    const { brief, skipReason } = await runResearch({
      request: 'a wall bracket',
      constraints: '',
      provider: stubProvider(STUB_HITS),
      model,
      onProgress: (e) => events.push(e.message),
    });
    expect(skipReason).toBeNull();
    expect(brief!.partClass).toBe('wall bracket');
    expect(brief!.searchQueries).toEqual(plan.queries);
    expect(brief!.approaches.map((a) => [a.id, a.grounding])).toEqual([
      ['a1', 'cited'],
      ['a2', 'recalled'],
    ]);
    expect(brief!.recommendedId).toBe('a1');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(lastHuman(invoke, 0)).toContain('Plan web searches');
    expect(lastHuman(invoke, 1)).toContain('Compare construction approaches for: wall bracket');
    expect(events.some((m) => /planning/i.test(m))).toBe(true);
    expect(events.some((m) => /comparing 3 sources/i.test(m))).toBe(true);
  });

  it('still synthesises when one query fails, and skips only when every query fails', async () => {
    const flaky: SearchProvider = {
      async search(q) {
        if (q === plan.queries[0]) throw new Error('boom');
        return STUB_HITS;
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const one = await runResearch({ request: 'r', constraints: '', provider: flaky, model: fakeModel([plan, briefReply]).model });
    expect(one.brief).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    const dead: SearchProvider = { async search() { throw new Error('down'); } };
    const { model, invoke } = fakeModel([plan, briefReply]);
    const all = await runResearch({ request: 'r', constraints: '', provider: dead, model });
    expect(all).toEqual({ brief: null, skipReason: 'search_failed' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('skips with no_hits when the searches return nothing', async () => {
    const out = await runResearch({ request: 'r', constraints: '', provider: stubProvider([]), model: fakeModel([plan]).model });
    expect(out).toEqual({ brief: null, skipReason: 'no_hits' });
  });

  it('retries an invalid query plan once, then skips', async () => {
    const { model, invoke } = fakeModel([{ nope: true }, new Error('timeout')]);
    const out = await runResearch({ request: 'r', constraints: '', provider: stubProvider(STUB_HITS), model });
    expect(out).toEqual({ brief: null, skipReason: 'query_plan_failed' });
    expect(invoke).toHaveBeenCalledTimes(MAX_RESEARCH_ATTEMPTS);
  });

  it('retries an invalid brief once and uses the valid retry', async () => {
    const { model, invoke } = fakeModel([plan, { approaches: [] }, briefReply]);
    const out = await runResearch({ request: 'r', constraints: '', provider: stubProvider(STUB_HITS), model });
    expect(out.brief).not.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('skips with brief_failed when both brief attempts are invalid', async () => {
    const { model } = fakeModel([plan, { approaches: [] }, { approaches: [] }]);
    const out = await runResearch({ request: 'r', constraints: '', provider: stubProvider(STUB_HITS), model });
    expect(out).toEqual({ brief: null, skipReason: 'brief_failed' });
  });

  it('caps the hits it shows the model at MAX_TOTAL_HITS after de-duplication', async () => {
    let n = 0;
    const many = stubProvider(() =>
      Array.from({ length: 5 }, (): SearchHit => ({ title: `t${n}`, url: `https://h.com/${n++}`, content: '' }))
    );
    const fourQueries = { partClass: 'x', queries: ['a', 'b', 'c', 'd'] };
    const { model, invoke } = fakeModel([fourQueries, briefReply]);
    await runResearch({ request: 'r', constraints: '', provider: many, model });
    const prompt = lastHuman(invoke, 1);
    expect(prompt).toContain(`[${MAX_TOTAL_HITS}]`);
    expect(prompt).not.toContain(`[${MAX_TOTAL_HITS + 1}]`);
  });

  it('times out a hung search instead of hanging the run', async () => {
    const hung: SearchProvider = {
      search: (_q, signal) =>
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    };
    const out = await runResearch({
      request: 'r',
      constraints: '',
      provider: hung,
      model: fakeModel([{ partClass: 'x', queries: ['a', 'b'] }]).model,
      timeoutMs: 20,
    });
    expect(out).toEqual({ brief: null, skipReason: 'search_failed' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/research/research-node.test.ts`
Expected: FAIL — `Cannot find module './research-node'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/research/research-node.ts`:

```ts
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
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

type ProgressFn = (event: { type: 'thinking'; message: string; timestamp: number }) => void;

export interface ResearchInput {
  request: string;
  /** contractLines()-style text, or '' when there is no contract. */
  constraints: string;
  provider: SearchProvider;
  model: CadChatModel;
  onProgress?: ProgressFn;
  config?: RunnableConfig;
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
  config: RunnableConfig | undefined,
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
  const { request, constraints, provider, model, onProgress, config } = input;
  const timeoutMs = input.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const say = (message: string) => onProgress?.({ type: 'thinking', message, timestamp: Date.now() });
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/research/research-node.test.ts`
Expected: PASS, 10 tests. If the timeout test hangs, the `AbortSignal` is not reaching `provider.search` — check `searchWithTimeout`.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/lib/research/research-node.ts src/lib/research/research-node.test.ts
git commit -m "feat(research): runResearch - query plan, parallel search, brief synthesis, skip reasons

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Types, contract carrier, state fields, test setup

**Files:**
- Modify: `src/types/index.ts:39-82`
- Modify: `src/store/app-store.ts:561-585` (`setThreadContract`)
- Modify: `src/store/app-store.test.ts` (inside `describe('Contract and Pins')`, which starts at line 131)
- Modify: `src/components/chat/gate-inline-ui.tsx:43`
- Modify: `src/lib/agent/graph.ts:465-469` (end of `AgentState`)
- Modify: `vitest.setup.ts`

**Interfaces:**
- Consumes: `ChosenApproach`, `DesignBrief` from Task 2; `ResearchSkipReason` from Task 4.
- Produces:
  - `DesignContract.researchApproach?: ChosenApproach`
  - `GatePayload` gains `| { kind: 'research'; brief: DesignBrief }`
  - `GateDecision.chosenApproachId?: string`
  - `AgentState.designBrief: DesignBrief | null`, `AgentState.researchSkipReason: ResearchSkipReason | null`
  - Test env: `CADAI_RESEARCH='off'`, no `TAVILY_API_KEY`, no `CADAI_RESEARCH_STUB` unless a suite sets them.

- [ ] **Step 1: Write the failing store test**

In `src/store/app-store.test.ts`, inside `describe('Contract and Pins', () => { … })` (line 131), add as the last `it`:

```ts
    it('setThreadContract keeps the research approach the server returned, alongside the spec', async () => {
      const store = useAppStore.getState();
      const approach = {
        id: 'a1',
        name: 'Plate and gusset',
        construction: 'A back plate with an arm and a gusset.',
        strengths: ['stiff'],
        weaknesses: ['bulky'],
        sources: [{ title: 'FDM brackets', url: 'https://example.com/fdm-brackets' }],
        grounding: 'cited' as const,
      };
      store.setThreadContract(
        {
          standing: {},
          pinnedParams: {},
          specApprovedAt: 123,
          researchApproach: { partClass: 'wall bracket', approach, chosenAt: 456 },
        },
        'thread-2'
      );
      await flushWrites();
      const t2 = useAppStore.getState().threads.find((t) => t.id === 'thread-2');
      expect(t2?.designContract?.researchApproach?.approach.name).toBe('Plate and gusset');
      // Client-owned pins survive the merge exactly as before.
      expect(t2?.designContract?.pinnedParams['w'].value).toBe(20);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/store/app-store.test.ts -t "research approach"`
Expected: FAIL — `researchApproach` is `undefined` after the merge (and `npx tsc --noEmit` reports it is not a known property of `DesignContract`).

- [ ] **Step 3: Add the types**

In `src/types/index.ts`, add after the existing imports (line 3):

```ts
import type { ChosenApproach, DesignBrief } from '../lib/research/design-brief';
```

Replace the `DesignContract` interface (lines 39–44) with:

```ts
export interface DesignContract {
  standing: StandingConstraints;
  spec?: AssemblySpec;                // approved intent
  specApprovedAt?: number;
  pinnedParams: Record<string, PinnedParam>;
  /**
   * The prior-art approach chosen at the research gate. Graph state is per
   * run, so this is how the choice reaches every later turn: the gate stamps
   * it, respondToUser returns the contract on `ready`, the client merges it
   * and re-POSTs it. Research is skipped while it is present.
   */
  researchApproach?: ChosenApproach;
}
```

Replace the `GatePayload` type (lines 53–68) with:

```ts
// The data a paused graph run sends the client to render a HIL gate.
export type GatePayload =
  | {
      kind: 'spec';
      spec: AssemblySpec | null;
      contract: DesignContract | null;
      revisionCount: number;
    }
  | {
      kind: 'accept';
      modelInfo: ModelInfo | null;
      violations: SpecViolation[];
      code: string;
      stl?: string;
      revisionCount: number;
    }
  | {
      // No revisionCount: a thread gets exactly one research pass.
      kind: 'research';
      brief: DesignBrief;
    };
```

In `GateDecision` (lines 71–82), add after `answers?: Record<string, string>;`:

```ts
  /**
   * The approach picked at the research gate; approve only. Absent or
   * unknown falls back to the brief's recommendation rather than rejecting.
   */
  chosenApproachId?: string;
```

- [ ] **Step 4: Carry the field through the client merge and guard the gate header**

In `src/store/app-store.ts` `setThreadContract` (line 571), change the merged object to:

```ts
    const updatedContract: DesignContract = {
      ...(targetThread.designContract ?? { standing: {}, pinnedParams: {} }),
      spec: contract.spec,
      specApprovedAt: contract.specApprovedAt,
      // Server-authoritative like `spec`: stamped at the research gate.
      researchApproach: contract.researchApproach,
    };
```

In `src/components/chat/gate-inline-ui.tsx` line 43, the research payload has no `revisionCount`, so narrow before reading it:

```tsx
        {gate && 'revisionCount' in gate && gate.revisionCount > 0 && (
```

- [ ] **Step 5: Add the state fields and the test-env defaults**

In `src/lib/agent/graph.ts`, add to the imports (after line 31):

```ts
import type { DesignBrief } from '../research/design-brief';
import type { ResearchSkipReason } from '../research/research-node';
```

At the end of `AgentState` (after `semanticFailures`, before the closing `});` at line 469), add:

```ts
  // Research runs once, before the Architect. The brief is per run; the
  // CHOICE is not state at all - it lives in designContract.researchApproach
  // so it survives to the next turn (see specGate for the same pattern).
  designBrief: Annotation<DesignBrief | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  // null means research ran; a reason means the Architect ran as before.
  researchSkipReason: Annotation<ResearchSkipReason | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
```

Append to `vitest.setup.ts`:

```ts
// Research is opt-out in the app but off in tests: it would add two model
// calls and an interrupt to every graph run and break the exact call counts
// the HIL suites assert. graph-research.test.ts turns it on explicitly, with
// the stub provider, so a developer's own TAVILY_API_KEY never leaks in.
process.env.CADAI_RESEARCH = 'off';
delete process.env.TAVILY_API_KEY;
delete process.env.CADAI_RESEARCH_STUB;
```

- [ ] **Step 6: Run the test, typecheck, and the whole suite**

Run: `npx vitest run src/store/app-store.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS — nothing else changed behaviour.

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/store/app-store.ts src/store/app-store.test.ts src/components/chat/gate-inline-ui.tsx src/lib/agent/graph.ts vitest.setup.ts
git commit -m "feat(research): research gate types, contract carrier for the chosen approach, state fields

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `researchNode`, `researchGate` and routing in the graph

**Files:**
- Modify: `src/lib/agent/graph.ts` — imports; new node functions before `// Node 1: architectNode` (line 496); routing functions before `// Build the graph` (line 1310); the builder (lines 1311–1346)
- Create: `src/lib/agent/graph-research.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5. `firstHumanText(messages)` (graph.ts line 163) and `contractLines(contract)` (line 192) already exist at module scope.
- Produces: graph nodes `researchNode`, `researchGate`; routing `checkResearchRoute`, `checkResearchGateRoute`; `START → researchNode`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/agent/graph-research.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { isInterrupted, INTERRUPT, Command } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import { STUB_HITS } from '../research/search-provider';

// Same double as graph-hil.test.ts: one mocked ChatOpenAI instance, one
// invoke queue, canned replies in the order the graph is expected to call.
// With research on, that order is: query plan, brief, architect, drafter.
const invokeMock = vi.fn();
vi.mock('@langchain/openai', () => {
  class FakeChatModel {
    invoke = invokeMock;
    withStructuredOutput() { return this; }
    bindTools() { return this; }
  }
  return { ChatOpenAI: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

import { createCadAgent, type StreamEventPayload } from './graph';

const plan = { partClass: 'wall bracket', queries: ['wall bracket fdm', 'gusseted bracket 3d print'] };
const briefReply = {
  approaches: [
    {
      id: 'p',
      name: 'Plate and gusset',
      construction: 'A back plate with an arm and a gusset.',
      strengths: ['stiff'],
      weaknesses: ['bulky'],
      sources: [{ title: 'FDM brackets', url: STUB_HITS[0].url }],
    },
    { id: 'q', name: 'Folded channel', construction: 'A U channel.', strengths: ['light'], weaknesses: ['flexes'], sources: [] },
  ],
  recommendedId: 'p',
};

function baseSpec(overrides: Record<string, any> = {}) {
  return {
    assemblyName: 'test_box',
    boundingBox: { width: 40, length: 40, height: 40 },
    components: [{ name: 'box', description: 'a box' }],
    assumptions: [],
    openQuestions: [],
    ...overrides,
  };
}
const gatedSpec = () => baseSpec({ assumptions: [{ field: 'x', value: 'y', rationale: 'z' }] });
const draftResponse = (code: string) => ({ content: `\`\`\`openscad\n${code}\n\`\`\``, tool_calls: [] });

const createdKeys: string[] = [];
let counter = 0;
function newConfig() {
  const key = runCheckpointKey(`research-test-${Date.now()}`, `run-${counter++}`);
  createdKeys.push(key);
  return { configurable: { thread_id: key } };
}
function contentsOf(call: number) {
  return (invokeMock.mock.calls[call][0] as any[]).map((m) => String(m.content));
}
function gatePayload(result: any) {
  return result[INTERRUPT][0].value;
}

afterAll(async () => {
  const checkpointer = getCheckpointer();
  for (const key of createdKeys) await checkpointer.deleteThread(key);
  await new Promise((resolve) => setTimeout(resolve, 200));
  delete process.env.CADAI_RESEARCH;
  delete process.env.CADAI_RESEARCH_STUB;
  delete process.env.CADAI_VISUAL_CRITIC;
  delete process.env.CADAI_MAX_ATTEMPTS;
});

describe('research node and gate', () => {
  beforeEach(() => {
    process.env.CADAI_VISUAL_CRITIC = 'off';
    process.env.CADAI_MAX_ATTEMPTS = '1';
    process.env.CADAI_RESEARCH = 'on';
    process.env.CADAI_RESEARCH_STUB = '1';
    invokeMock.mockReset();
  });

  it('researches first, pauses with a grounded brief, and stamps the choice into the contract', async () => {
    invokeMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(briefReply);
    const agent = createCadAgent(undefined, 'test-model');
    const config = newConfig();

    const paused = await agent.invoke({ messages: [new HumanMessage('a wall bracket')] }, config);

    expect(isInterrupted(paused)).toBe(true);
    const payload = gatePayload(paused);
    expect(payload.kind).toBe('research');
    expect(payload.brief.partClass).toBe('wall bracket');
    expect(payload.brief.approaches.map((a: any) => [a.id, a.grounding])).toEqual([['a1', 'cited'], ['a2', 'recalled']]);
    expect(payload.brief.recommendedId).toBe('a1');
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(contentsOf(0).some((c) => c.includes('Plan web searches'))).toBe(true);
    expect(contentsOf(1).some((c) => c.includes('Compare construction approaches'))).toBe(true);

    // Pick the non-recommended approach; the Architect then gates on an assumption.
    invokeMock.mockResolvedValueOnce(gatedSpec());
    const atSpecGate = await agent.invoke(new Command({ resume: { action: 'approve', chosenApproachId: 'a2' } }), config);
    expect(gatePayload(atSpecGate).kind).toBe('spec');

    const state = (await agent.getState(config)).values;
    expect(state.designContract?.researchApproach?.approach.id).toBe('a2');
    expect(state.designContract?.researchApproach?.approach.name).toBe('Folded channel');
    expect(state.designContract?.researchApproach?.partClass).toBe('wall bracket');
    expect(state.researchSkipReason).toBeNull();
    // Consumed and cleared: nothing from this gate may read as fresh feedback later.
    expect(state.gateAction).toBe('approve');
    expect(state.gateFeedback).toBeNull();
  });

  it('falls back to the recommendation for an unknown id and for a stray revise', async () => {
    for (const decision of [{ action: 'approve', chosenApproachId: 'nope' }, { action: 'revise', comment: 'again' }]) {
      invokeMock.mockReset();
      invokeMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(briefReply).mockResolvedValueOnce(gatedSpec());
      const agent = createCadAgent(undefined, 'test-model');
      const config = newConfig();
      await agent.invoke({ messages: [new HumanMessage('a wall bracket')] }, config);
      const next = await agent.invoke(new Command({ resume: decision }), config);
      expect(gatePayload(next).kind).toBe('spec');
      const state = (await agent.getState(config)).values;
      expect(state.designContract?.researchApproach?.approach.id).toBe('a1');
      // A stray revise must not have re-run research.
      expect(invokeMock).toHaveBeenCalledTimes(3);
    }
  });

  it('cancel at the research gate ends the run', async () => {
    invokeMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(briefReply);
    const agent = createCadAgent(undefined, 'test-model');
    const config = newConfig();
    await agent.invoke({ messages: [new HumanMessage('a wall bracket')] }, config);
    const done = await agent.invoke(new Command({ resume: { action: 'cancel' } }), config);
    expect(isInterrupted(done)).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(done.gateAction).toBe('cancel');
    expect(done.assemblySpec).toBeNull();
  });

  it('skips research when disabled, when there is no provider, and when the contract already carries an approach', async () => {
    const cases: Array<[string, () => void, Record<string, unknown>]> = [
      ['disabled', () => { process.env.CADAI_RESEARCH = 'off'; }, {}],
      ['no_provider', () => { delete process.env.CADAI_RESEARCH_STUB; }, {}],
      [
        'already_researched',
        () => {},
        {
          designContract: {
            standing: {},
            pinnedParams: {},
            researchApproach: {
              partClass: 'wall bracket',
              chosenAt: 1,
              approach: { id: 'a1', name: 'Plate and gusset', construction: 'c', strengths: [], weaknesses: [], sources: [], grounding: 'recalled' },
            },
          },
        },
      ],
    ];
    for (const [reason, arrange, input] of cases) {
      invokeMock.mockReset();
      process.env.CADAI_RESEARCH = 'on';
      process.env.CADAI_RESEARCH_STUB = '1';
      arrange();
      // No research calls: the first model call is the Architect, then the drafter.
      invokeMock.mockResolvedValueOnce(baseSpec()).mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
      const agent = createCadAgent(undefined, 'test-model');
      const config = newConfig();
      const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')], ...input }, config);
      expect(result.researchSkipReason, reason).toBe(reason);
      expect(result.designBrief, reason).toBeNull();
      expect(result.isValid, reason).toBe(true);
      expect(invokeMock, reason).toHaveBeenCalledTimes(2);
      expect(contentsOf(0).some((c) => c.includes('Mechanical Architect')), reason).toBe(true);
    }
  });

  it('degrades to the Architect when the brief cannot be produced, and reports why', async () => {
    const events: StreamEventPayload[] = [];
    // Plan ok, then two invalid briefs, then the run proceeds as before.
    invokeMock
      .mockResolvedValueOnce(plan)
      .mockResolvedValueOnce({ approaches: [] })
      .mockResolvedValueOnce({ approaches: [] })
      .mockResolvedValueOnce(baseSpec())
      .mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    const agent = createCadAgent((e) => events.push(e), 'test-model');
    const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, newConfig());
    expect(result.researchSkipReason).toBe('brief_failed');
    expect(result.isValid).toBe(true);
    expect(events.some((e) => e.type === 'thinking' && /no valid brief/.test(e.message))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/agent/graph-research.test.ts`
Expected: FAIL — the first invoke reaches the Architect (no research node yet), so `payload.kind` is `'spec'`, not `'research'`, and `researchSkipReason` is `null` everywhere.

- [ ] **Step 3: Add the nodes and routing to `graph.ts`**

Extend the imports added in Task 5 to:

```ts
import { resolveSearchProvider } from '../research/search-provider';
import { chooseApproach, type DesignBrief } from '../research/design-brief';
import {
  runResearch,
  preResearchSkipReason,
  RESEARCH_SKIP_MESSAGES,
  type ResearchSkipReason,
} from '../research/research-node';
```

Inside `createCadAgent`, immediately before `// Node 1: architectNode` (line 496), add:

```ts
  // Node 0: researchNode. Runs once per thread, before the Architect, and
  // every failure degrades to the Architect running exactly as it did before.
  async function researchNode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    // Cleared on every path, as architectNode does: a decision left over from
    // an earlier turn's gate must not reach the Architect as fresh feedback.
    const cleared = { gateAction: null, gateFeedback: null } as const;

    const provider = resolveSearchProvider();
    const pre = preResearchSkipReason({
      enabled: process.env.CADAI_RESEARCH !== 'off',
      provider,
      alreadyChosen: !!state.designContract?.researchApproach,
    });
    if (pre) {
      onProgress?.({
        type: 'thinking',
        message:
          pre === 'already_researched'
            ? 'Design Researcher: using the approach chosen earlier in this thread.'
            : `Design Researcher: skipped (${RESEARCH_SKIP_MESSAGES[pre]}).`,
        timestamp: Date.now(),
      });
      return { ...cleared, researchSkipReason: pre };
    }

    const { brief, skipReason } = await runResearch({
      request: firstHumanText(state.messages),
      constraints: contractLines(state.designContract),
      provider: provider!,
      model,
      onProgress,
      config,
    });
    if (!brief) {
      onProgress?.({
        type: 'thinking',
        message: `Design Researcher: skipped (${RESEARCH_SKIP_MESSAGES[skipReason!]}). Proceeding without prior art.`,
        timestamp: Date.now(),
      });
      return { ...cleared, researchSkipReason: skipReason };
    }
    onProgress?.({
      type: 'thinking',
      message: `Design Researcher: found ${brief.approaches.length} approaches for ${brief.partClass}; awaiting your choice.`,
      timestamp: Date.now(),
    });
    return { ...cleared, designBrief: brief, researchSkipReason: null };
  }

  // Node: researchGate. Pauses with the brief; the human picks an approach.
  // Same interrupt()/Command({ resume }) channel as specGate.
  async function researchGate(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const brief = state.designBrief!; // routed here only when set
    const payload: GatePayload = { kind: 'research', brief };
    const decision = interrupt(payload) as GateDecision;

    if (decision.action === 'cancel') {
      return { gateAction: 'cancel' };
    }

    // No revise here: a thread gets one research pass. Anything else,
    // including a stray 'revise', approves - the named approach when the id
    // is known, else the recommendation, rather than rejecting the approval
    // (the same lenience specGate shows a malformed edited spec).
    const approach = chooseApproach(brief, decision.action === 'approve' ? decision.chosenApproachId : undefined);

    // The choice goes into the contract, not state: state is per run, and
    // the contract is what respondToUser returns and the next turn re-POSTs.
    const baseContract: DesignContract = state.designContract ?? { standing: {}, pinnedParams: {} };
    return {
      gateAction: 'approve',
      designContract: {
        ...baseContract,
        researchApproach: { partClass: brief.partClass, approach, chosenAt: Date.now() },
      },
    };
  }
```

Before `// Build the graph` (line 1310), add:

```ts
  // Conditional Edge: route from researchNode
  function checkResearchRoute(state: AgentStateType) {
    if (state.designBrief && !state.researchSkipReason) return 'researchGate';
    return 'architectNode';
  }

  // Conditional Edge: route from researchGate
  function checkResearchGateRoute(state: AgentStateType) {
    if (state.gateAction === 'cancel') return 'respondToUser';
    return 'architectNode';
  }
```

In the builder, replace `.addEdge(START, 'architectNode')` and register the nodes:

```ts
  const workflow = new StateGraph(AgentState)
    .addNode('researchNode', researchNode)
    .addNode('researchGate', researchGate)
    .addNode('architectNode', architectNode)
    .addNode('specGate', specGate)
    .addNode('drafterNode', drafterNode)
    .addNode('validateCode', validateCode)
    .addNode('fixCode', fixCode)
    .addNode('visualCritic', visualCritic)
    .addNode('acceptGate', acceptGate)
    .addNode('respondToUser', respondToUser)
    .addEdge(START, 'researchNode')
    .addConditionalEdges('researchNode', checkResearchRoute, {
      researchGate: 'researchGate',
      architectNode: 'architectNode'
    })
    .addConditionalEdges('researchGate', checkResearchGateRoute, {
      architectNode: 'architectNode',
      respondToUser: 'respondToUser'
    })
    .addConditionalEdges('architectNode', checkSpecRoute, {
```

(everything after that line is unchanged). Update the comment above `workflow.compile` to read `interrupt() calls inside researchGate/specGate/acceptGate`.

- [ ] **Step 4: Run the new suite, then every graph suite**

Run: `npx vitest run src/lib/agent/graph-research.test.ts`
Expected: PASS, 5 tests.

Run: `npx vitest run src/lib/agent`
Expected: PASS — `graph-hil`, `graph-placement` and `graph-critic` keep their exact call counts because `vitest.setup.ts` turns research off.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/lib/agent/graph.ts src/lib/agent/graph-research.test.ts
git commit -m "feat(agent): research node and gate before the Architect, degrading to today's run on any skip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Bind the Architect and name the approach in the answer

**Files:**
- Modify: `src/lib/agent/graph.ts` — `architectNode` after the Design Contract block (line 526), `respondToUser` (lines 1100–1129), a module-scope helper near `summarizeSpec`
- Modify: `src/lib/agent/system-prompt.ts:80` (`ARCHITECT_PREAMBLE`, under DESIGN CONTRACT)
- Modify: `src/lib/agent/system-prompt.test.ts:45` and the "teaches every node" test
- Modify: `src/lib/agent/graph-research.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `approachBlock`, `ChosenApproach` from Task 2; `state.designContract.researchApproach` from Task 6.
- Produces: the Architect prompt carries the block exactly once per pass; `explanation` on `ready`/`error` starts with `Design approach: <name> — sources: …` when the contract carries an approach.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/agent/graph-research.test.ts`:

```ts
describe('Architect binding', () => {
  beforeEach(() => {
    process.env.CADAI_VISUAL_CRITIC = 'off';
    process.env.CADAI_MAX_ATTEMPTS = '1';
    process.env.CADAI_RESEARCH = 'on';
    process.env.CADAI_RESEARCH_STUB = '1';
    invokeMock.mockReset();
  });

  const block = (c: string) => c.includes('Design Approach (chosen by the user from prior-art research)');

  it('hands the Architect the chosen approach exactly once, on every pass, and never in the history', async () => {
    invokeMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(briefReply);
    const agent = createCadAgent(undefined, 'test-model');
    const config = newConfig();
    await agent.invoke({ messages: [new HumanMessage('a 40mm wall bracket')] }, config);

    invokeMock.mockResolvedValueOnce(gatedSpec());
    await agent.invoke(new Command({ resume: { action: 'approve', chosenApproachId: 'a2' } }), config);
    const architect1 = contentsOf(2);
    expect(architect1.filter(block)).toHaveLength(1);
    expect(architect1.some((c) => c.includes('Name: Folded channel'))).toBe(true);
    expect(architect1.some((c) => c.includes('DESIGN APPROACH'))).toBe(true); // the preamble rule

    // A spec-gate revise re-runs the Architect: still exactly one block.
    invokeMock.mockResolvedValueOnce(baseSpec()).mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    await agent.invoke(new Command({ resume: { action: 'revise', comment: 'thinner' } }), config);
    const architect2 = contentsOf(3);
    expect(architect2.filter(block)).toHaveLength(1);
    expect(architect2.some((c) => c.includes('thinner'))).toBe(true);

    const state = (await agent.getState(config)).values;
    expect(state.messages.some((m: any) => block(String(m.content)))).toBe(false);
  });

  it('binds a later turn from the contract alone, with no research calls', async () => {
    invokeMock.mockResolvedValueOnce(baseSpec()).mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    const agent = createCadAgent(undefined, 'test-model');
    const result = await agent.invoke(
      {
        messages: [new HumanMessage('a 40mm box')],
        designContract: {
          standing: {},
          pinnedParams: {},
          researchApproach: {
            partClass: 'box',
            chosenAt: 1,
            approach: { id: 'a1', name: 'Lidded shell', construction: 'c', strengths: [], weaknesses: [], sources: [], grounding: 'recalled' },
          },
        },
      },
      newConfig()
    );
    expect(result.researchSkipReason).toBe('already_researched');
    expect(contentsOf(0).filter(block)).toHaveLength(1);
    expect(contentsOf(0).some((c) => c.includes('Name: Lidded shell'))).toBe(true);
  });

  it('names the approach and its sources at the top of the final explanation', async () => {
    const events: StreamEventPayload[] = [];
    invokeMock
      .mockResolvedValueOnce(plan)
      .mockResolvedValueOnce(briefReply)
      .mockResolvedValueOnce(baseSpec())
      .mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    const agent = createCadAgent((e) => events.push(e), 'test-model');
    const config = newConfig();
    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);
    await agent.invoke(new Command({ resume: { action: 'approve' } }), config);

    const ready = events.find((e) => e.type === 'ready');
    expect(ready?.explanation?.startsWith('Design approach: Plate and gusset')).toBe(true);
    expect(ready?.explanation).toContain(`[FDM brackets](${STUB_HITS[0].url})`);
    expect(ready?.explanation).toContain('Assembly Spec: test_box');
    expect(ready?.designContract?.researchApproach?.approach.id).toBe('a1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/agent/graph-research.test.ts -t "Architect binding"`
Expected: FAIL — no message contains the block, and `explanation` starts with `Assembly Spec:`.

- [ ] **Step 3: Bind the Architect**

In `src/lib/agent/graph.ts`, extend the design-brief import to `import { chooseApproach, approachBlock, type ChosenApproach, type DesignBrief } from '../research/design-brief';`.

In `architectNode`, after the Design Contract block's closing `}` (line 526) and before `// A prior spec was sent back for revision`, add:

```ts
    // The approach chosen at the research gate, rebuilt from the contract on
    // every pass so a spec-gate revise stays bound to it. Never appended to
    // `messages` - see the return below for why that matters.
    if (state.designContract?.researchApproach) {
      messages.push(new HumanMessage(approachBlock(state.designContract.researchApproach)));
    }
```

Add at module scope, after `summarizeSpec` (line 314):

```ts
/**
 * One markdown line naming the chosen prior-art approach and its sources,
 * ahead of the explanation. Server-rendered like everything else the chat
 * shows; the client never sees the brief object outside the gate.
 */
function withApproachLine(explanation: string, chosen: ChosenApproach | undefined): string {
  if (!chosen) return explanation;
  const sources = chosen.approach.sources.map((s) => `[${s.title}](${s.url})`).join(', ');
  const line = `Design approach: ${chosen.approach.name}${sources ? ` — sources: ${sources}` : ''}`;
  return explanation ? `${line}\n\n${explanation}` : line;
}
```

In `respondToUser`, compute once at the top of the function:

```ts
    const explanation = withApproachLine(state.explanation, state.designContract?.researchApproach);
```

and use `explanation` instead of `state.explanation` in both the `ready` and the `error` events.

- [ ] **Step 4: Add the preamble rule and lift its ceiling**

In `src/lib/agent/system-prompt.ts`, directly after the `DESIGN CONTRACT.` line (line 80) of `ARCHITECT_PREAMBLE`, add a paragraph:

```text
DESIGN APPROACH. When a chosen approach is given, its construction is the topology you build: the same bodies and the same joining scheme. Deviate only for a physical constraint and record every deviation in assumptions[].
```

In `src/lib/agent/system-prompt.test.ts`:
- change `ARCHITECT_PREAMBLE: 520,` to `ARCHITECT_PREAMBLE: 560,` and add above the table's comment: `// ARCHITECT_PREAMBLE was 519/520 before the DESIGN APPROACH rule; raised once for it.`
- in the test `'teaches every node the spec fields for flat faces and stress points, and no edge treatments'`, add after `expect(ARCHITECT_PREAMBLE).toContain('stressPoints[].gusset');`:

```ts
    // The research layer binds the Architect by prompt, not by schema.
    expect(ARCHITECT_PREAMBLE).toContain('DESIGN APPROACH');
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/agent/graph-research.test.ts src/lib/agent/system-prompt.test.ts`
Expected: PASS (8 + 4 tests).

Run: `npx vitest run src/lib/agent`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/lib/agent/graph.ts src/lib/agent/graph-research.test.ts src/lib/agent/system-prompt.ts src/lib/agent/system-prompt.test.ts
git commit -m "feat(agent): bind the Architect to the chosen approach and name it in the answer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The research gate card

**Files:**
- Modify: `src/components/chat/gate-inline-ui.tsx`

**Interfaces:**
- Consumes: `GatePayload` research variant and `GateDecision.chosenApproachId` from Task 5.
- Produces: a `kind === 'research'` branch titled "Choose a Design Approach": one card per approach with name, `cited`/`recalled` chip, "recommended" tag, construction, strengths and weaknesses, source links; a radio group preselected on `recommendedId`; footer with **Approve** (sends `chosenApproachId`) and **Cancel** only — no comment box, no Revise.

There is no React test harness in this repo (vitest runs in the `node` environment with no DOM), so this task is verified by typecheck, lint and a browser check against the stub provider.

- [ ] **Step 1: Add the selection state and the title**

In `src/components/chat/gate-inline-ui.tsx`, change the React import to `import React, { useEffect, useState } from 'react';`. After the `answers` state (line 15) add:

```tsx
  // The radio selection at the research gate. Reset whenever a new gate
  // arrives so a choice made on one brief cannot carry over to another.
  const [chosenId, setChosenId] = useState<string | null>(null);
  useEffect(() => setChosenId(null), [gate]);
  const isResearch = gate?.kind === 'research';
```

Replace the `title` line (30) with:

```tsx
  const title =
    gate?.kind === 'research' ? 'Choose a Design Approach'
    : gate?.kind === 'accept' ? 'Review Compiled Model'
    : 'Approval Required';
```

- [ ] **Step 2: Add the research branch**

Immediately before the accept fallback — the line `) : (` at 206 that precedes `<div className="space-y-2">` / "Measured Geometry" — insert:

```tsx
        ) : gate.kind === 'research' ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-cyan-400">
              <Target className="w-3.5 h-3.5" />
              <h4 className="text-[11px] font-semibold uppercase tracking-wider">Prior art: {gate.brief.partClass}</h4>
            </div>
            <p className="text-[10px] text-slate-500">Searched: {gate.brief.searchQueries.join(' · ')}</p>
            <div role="radiogroup" aria-label="Design approach" className="space-y-2">
              {gate.brief.approaches.map((a) => {
                const selected = (chosenId ?? gate.brief.recommendedId) === a.id;
                return (
                  <label
                    key={a.id}
                    className={`block rounded-lg border p-2 cursor-pointer transition-colors ${
                      selected ? 'border-emerald-500/60 bg-emerald-900/10' : 'border-slate-700 bg-slate-950/40 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="radio"
                        name="approach"
                        value={a.id}
                        checked={selected}
                        onChange={() => setChosenId(a.id)}
                        className="accent-emerald-500"
                      />
                      <span className="text-xs font-semibold text-slate-100">{a.name}</span>
                      {/* Grounding is a label the human weighs, never a filter:
                          a recalled approach is shown, just marked as unsourced. */}
                      <span
                        className={`px-1 py-0.5 rounded text-[10px] font-mono ${
                          a.grounding === 'cited' ? 'bg-emerald-900/40 text-emerald-200' : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {a.grounding}
                      </span>
                      {a.id === gate.brief.recommendedId && (
                        <span className="text-[10px] text-indigo-300">recommended</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-slate-300">{a.construction}</p>
                    <div className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
                      <ul className="list-disc list-inside text-emerald-200/80">
                        {a.strengths.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                      <ul className="list-disc list-inside text-amber-200/80">
                        {a.weaknesses.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                    {a.sources.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {a.sources.map((s) => (
                          <a
                            key={s.url}
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-[10px] text-cyan-300 hover:underline"
                          >
                            {s.title} ↗
                          </a>
                        ))}
                      </div>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        ) : (
```

- [ ] **Step 3: Adapt the footer**

Replace the footer block (lines 252–286, from `<div className="p-3 bg-slate-950 border-t border-slate-800 space-y-2">` to its closing `</div>`) with:

```tsx
      <div className="p-3 bg-slate-950 border-t border-slate-800 space-y-2">
        {/* One research pass per thread: no comment box and no Revise here. */}
        {!isResearch && (
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add comments or request changes (optional)..."
            className="w-full h-16 bg-slate-900 border border-slate-700 rounded p-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
          />
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => onResume({ action: 'cancel' })}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
          >
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
          {!isResearch && (
            <button
              onClick={() => onResume({ action: 'revise', comment, answers: collectedAnswers() })}
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 text-xs transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Revise
            </button>
          )}
          <button
            onClick={() =>
              onResume({
                action: 'approve',
                comment: isResearch ? undefined : comment || undefined,
                answers: collectedAnswers(),
                spec: gate?.kind === 'spec' ? gate.spec ?? undefined : undefined,
                chosenApproachId: gate?.kind === 'research' ? chosenId ?? gate.brief.recommendedId : undefined,
              })
            }
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow transition-colors"
          >
            <Check className="w-3.5 h-3.5" /> {isResearch ? 'Use this approach' : 'Approve'}
          </button>
        </div>
      </div>
```

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: no errors (unused-import warnings mean an icon import should be removed).

- [ ] **Step 5: Check the gate in the browser against the stub**

Add to `.env.local` (never committed): `CADAI_RESEARCH_STUB=1`. `EXPLABS_API_KEY` must be present because the two research calls go to the gateway. Start the dev server with the `cadai-dev` configuration in `.claude/launch.json`, send **"a wall-mounted hair dryer holder"**, and confirm: the progress list shows "Design Researcher: planning…" then "comparing N sources…"; a card titled "Choose a Design Approach" renders 2–3 approaches with grounding chips (the model may cite the stub URLs, giving `cited`), source links open in a new tab, the recommended card is preselected; picking another card and pressing "Use this approach" continues to the spec gate, whose card is unchanged. Take a screenshot of the research card.

If the run reaches the spec gate with no research card, check the server log for `Design Researcher: skipped (…)` — the reason names what is missing.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/gate-inline-ui.tsx
git commit -m "feat(ui): research gate card - pick one of the researched approaches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Eval flag, metrics and documentation

**Files:**
- Modify: `eval/generation/run.ts:33-46,104-119`
- Modify: `eval/generation/metrics.ts`
- Modify: `eval/generation/metrics.test.ts`
- Modify: `README.md` (after the "Evaluating generation quality" section)

**Interfaces:**
- Consumes: `state.researchSkipReason`, `state.designBrief`, `state.designContract.researchApproach`.
- Produces: `--research on|off` (default `off`); `GenerationMetrics.researchRan: boolean`, `GenerationMetrics.citedApproachChosen: boolean | null`; summary rows `researchRan`, `citedApproachChosen`; Langfuse scores `research_ran`, `cited_approach_chosen`.

- [ ] **Step 1: Write the failing metrics tests**

In `eval/generation/metrics.test.ts`, add `researchRan: false, citedApproachChosen: null,` to every literal `GenerationMetrics` row in the `summarize` and `scoresFor` tests (three rows), change the expected `scoresFor` names to `['spec_ok', 'composed', 'compile_ok', 'local_frame_ok', 'shells_ok', 'research_ran', 'wall_ms']`, and add to `describe('metricsFromState')`:

```ts
  it('records whether research ran and whether the chosen approach was cited', () => {
    const chosen = (grounding: 'cited' | 'recalled') => ({
      partClass: 'x',
      chosenAt: 1,
      approach: { id: 'a1', name: 'n', construction: 'c', strengths: [], weaknesses: [], sources: [], grounding },
    });
    const ran = metricsFromState('p3', 'm', {
      researchSkipReason: null,
      designBrief: { partClass: 'x', approaches: [], recommendedId: 'a1', searchQueries: [] } as any,
      designContract: { standing: {}, pinnedParams: {}, researchApproach: chosen('cited') },
      specViolations: [],
    }, 1);
    expect(ran.researchRan).toBe(true);
    expect(ran.citedApproachChosen).toBe(true);

    const skipped = metricsFromState('p4', 'm', { researchSkipReason: 'no_provider', designBrief: null, specViolations: [] }, 1);
    expect(skipped.researchRan).toBe(false);
    expect(skipped.citedApproachChosen).toBeNull();

    const recalled = metricsFromState('p5', 'm', {
      researchSkipReason: null,
      designBrief: { partClass: 'x', approaches: [], recommendedId: 'a1', searchQueries: [] } as any,
      designContract: { standing: {}, pinnedParams: {}, researchApproach: chosen('recalled') },
      specViolations: [],
    }, 1);
    expect(recalled.citedApproachChosen).toBe(false);
  });
```

And to `describe('summarize')`, extend the existing assertions with `expect(s.researchRan).toBe('0/2'); expect(s.citedApproachChosen).toBe('0/0');`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run eval/generation/metrics.test.ts`
Expected: FAIL — `researchRan` is `undefined`.

- [ ] **Step 3: Extend the metrics**

In `eval/generation/metrics.ts`, add to `GenerationMetrics` after `attempts: number;`:

```ts
  /** Research produced a brief this run (false on any skip reason). */
  researchRan: boolean;
  /** Whether the approach the Architect was bound to had a real source; null when research did not run. */
  citedApproachChosen: boolean | null;
```

In `metricsFromState`, before the `return`, add:

```ts
  const researchRan = !state.researchSkipReason && !!state.designBrief;
  const chosen = state.designContract?.researchApproach;
```

and in the returned object, after `attempts: state.attemptCount ?? 0,`:

```ts
    researchRan,
    citedApproachChosen: researchRan && chosen ? chosen.approach.grounding === 'cited' : null,
```

In `summarize`, add before `meanWallMs`:

```ts
    researchRan: rate(rows, (m) => m.researchRan),
    citedApproachChosen: rate(rows, (m) => m.citedApproachChosen),
```

In `scoresFor`, add before `out.push({ name: 'wall_ms', …})`:

```ts
  bool('research_ran', m.researchRan);
  bool('cited_approach_chosen', m.citedApproachChosen);
```

- [ ] **Step 4: Add the flag to the runner**

In `eval/generation/run.ts`:
- `interface Args` gains `research: 'on' | 'off'`; the default object gains `research: 'off'`; `parseArgs` gains `else if (v === '--research') a.research = argv[++i] === 'on' ? 'on' : 'off';`.
- In `main()`, right after `const args = parseArgs(process.argv.slice(2));`, add:

```ts
  // Opt-in for the eval: research spends Tavily quota as well as model calls.
  // The graph reads this at run time, so setting it here is early enough.
  process.env.CADAI_RESEARCH = args.research;
```

- Extend the estimate `console.log` so the second sentence reads:

```ts
    `Expect roughly ${items.length * 2}-${items.length * 5} model calls (architect retries + drafter tool round)` +
    (args.research === 'on' ? `, plus 2 model calls and 2-4 searches per prompt for research` : '') +
    `. Starting in 5 s, Ctrl+C to abort.`
```

- In `runOne`'s per-prompt log line, append `` research=${m.researchRan}${m.citedApproachChosen === null ? '' : ` cited=${m.citedApproachChosen}`} ``.
- In the header comment (lines 5-7), add a usage line and a note:

```ts
 *   npm run eval:generation -- --research on --tag research   # + 2 model calls and 2-4 searches per prompt
 *
 * The auto-approve loop in runOne() covers the research gate too: resumed
 * with no chosenApproachId, the gate binds the brief's recommendation.
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run eval/generation/metrics.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Document the environment**

In `README.md`, after the "Evaluating generation quality" section, add:

```markdown
## Prior-art research (optional)

Before the Architect commits to a construction, a research node can search the web for how
the requested class of part is normally built and pause at a gate where you pick one of 2–3
approaches; the Architect is then bound to it. Set `TAVILY_API_KEY` to enable it (Tavily's
free tier is 1,000 requests/month; a design run uses 2–4). Without a key the pipeline runs
exactly as before. `CADAI_RESEARCH=off` disables the node, and `CADAI_RESEARCH_STUB=1`
serves canned results so the gate can be tried without a key or quota. The eval opts in
with `--research on` and reports `researchRan` and `citedApproachChosen` alongside the
other rates.
```

- [ ] **Step 7: Commit**

```bash
git add eval/generation/run.ts eval/generation/metrics.ts eval/generation/metrics.test.ts README.md
git commit -m "feat(eval): --research flag, researchRan and citedApproachChosen rates, env docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 8: Full suite, then stop before the eval**

Run: `npm test`
Expected: PASS.

Run: `npm run build`
Expected: builds (this is the only full Next.js typecheck of the client components).

**Do not run the generation eval yet.** Report to the user with the exact command and estimate — `npm run eval:generation -- --research on --tag research` is 10 prompts, roughly 20–50 model calls plus 20–40 Tavily requests (of the 1,000/month free tier), and needs `TAVILY_API_KEY` in `.env.local` — and wait for a go-ahead. When it runs, run the matching `--research off --tag baseline` on the same commit, and record both summaries at the end of this plan file the way `docs/superpowers/plans/2026-09-14-deterministic-placement-generation-eval.md` records its before/after rates.

---

## Self-review against the spec

- **Decisions 1–2** (node before the Architect; prior-art construction) — Tasks 3, 4, 6.
- **Decision 3** (Tavily behind a seam, plain fetch) — Task 1.
- **Decisions 4–5** (structured brief; never drop, label grounding; prune fabricated URLs) — Task 2 (`groundApproaches`, `assembleBrief`).
- **Decision 6** (human picks; cancel; stray revise = approve) — Task 6 `researchGate`.
- **Decision 7** (bound by prompt; `AssemblySpecSchema` untouched) — Task 7; no task edits `assembly-spec.ts`.
- **Decision 8** (same model; two bounded structured calls) — Task 4 (`structured()`, `requestSchema()` with `boundNumbers`).
- **Decision 9** (degrade, never fail; `CADAI_RESEARCH=off`; skip reasons) — Tasks 4 and 6, tested in both.
- **Decision 10** (once per thread via `designContract.researchApproach`) — Tasks 5, 6, 7 (`already_researched` binding test).
- **Decisions 11–12** (gate card; store merge; explanation line) — Tasks 5, 7, 8.
- **Decision 13** (`--research on|off`, two rates) — Task 9.
- **Module layout** — matches the file map; `gate-policy.ts` untouched.
- **Data** — `SearchHit` caps (5 per query, 1,200 chars, 12 total) in Tasks 1 and 4; `DesignBrief` shape and re-keyed ids in Task 2; state fields in Task 5.
- **Tests table** — every listed suite has a task; `app-store.test.ts` in Task 5, `system-prompt.test.ts` in Task 7, `metrics.test.ts` in Task 9.

Type consistency: `preResearchSkipReason({ enabled, provider, alreadyChosen })` (Task 4) is what Task 6 calls; `chooseApproach(brief, id)` (Task 2) is what Task 6 calls; `approachBlock(chosen)` (Task 2) is what Task 7 calls; `ChosenApproach = { partClass, approach, chosenAt }` is used identically in Tasks 5, 6, 7, 9; `GateDecision.chosenApproachId` is read in Task 6 and sent in Task 8.
