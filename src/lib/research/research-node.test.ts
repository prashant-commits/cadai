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
