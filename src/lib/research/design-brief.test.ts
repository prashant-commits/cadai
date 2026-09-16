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
