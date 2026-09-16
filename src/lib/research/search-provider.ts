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
