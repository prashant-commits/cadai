import { describe, expect, it } from 'vitest';
import { costUsd, summarize, type VariantScore } from './score';

const v = (over: Partial<VariantScore>): VariantScore => ({
  promptId: 'p', sample: 0, variantId: 'A', failure: null, firstAttemptClean: true, selfCheckErrors: [],
  blockoutSkipped: 0, compiled: true, auditErrors: [], bbox: '1 x 1 x 1', signature: 's1', usd: 0.01, ...over,
});

describe('costUsd', () => {
  it('prices cache writes at 1.25x, reads at 0.1x, and halves for batch', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    // Sonnet 5.5: input (1 + 1.25 + 0.1) * $2 + output $10 = $14.70
    expect(costUsd('claude-sonnet-5-5', usage, false)).toBeCloseTo(14.7);
    expect(costUsd('claude-sonnet-5-5', usage, true)).toBeCloseTo(7.35);
  });

  it('returns null for an unpriced model instead of guessing', () => {
    expect(costUsd('claude-unknown', { input_tokens: 1, output_tokens: 1 }, true)).toBeNull();
  });
});

describe('summarize', () => {
  it('counts failed variants in every rate denominator', () => {
    const s = summarize(
      [{ promptId: 'p', sample: 0, plannerOk: true, plannerFailure: null, variantsPlanned: 2, usd: 0.01 }],
      [v({}), v({ variantId: 'B', failure: 'schema: bad', compiled: false, usd: 0.01 })]
    );
    expect(s.specOkRate).toBe(0.5);
    expect(s.compiledRate).toBe(0.5);
    expect(s.failures).toEqual({ schema: 1 });
  });

  it('counts distinct skeletons per prompt and sample', () => {
    const s = summarize([], [v({}), v({ variantId: 'B', signature: 's1' }), v({ sample: 1, signature: 's2' }), v({ sample: 1, variantId: 'B', signature: 's3' })]);
    expect(s.distinctSkeletons).toBe(1.5);
  });

  it('separates audit-clean from compiled', () => {
    const s = summarize([], [v({ auditErrors: ['buildplate'] }), v({ variantId: 'B' })]);
    expect(s.compiledRate).toBe(1);
    expect(s.auditCleanRate).toBe(0.5);
    expect(s.auditErrorKinds).toEqual({ buildplate: 1 });
  });

  it('reports unknown total cost as null', () => {
    expect(summarize([], [v({ usd: null })]).usd).toBeNull();
  });
});
