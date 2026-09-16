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
