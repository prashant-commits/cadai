import { describe, it, expect } from 'vitest';
import { UsageHandler } from './usage';

describe('UsageHandler', () => {
  it('sums usage_metadata over calls and prices it', async () => {
    const h = new UsageHandler();
    const gen = (i: number, o: number) => ({ generations: [[{ text: '', message: { usage_metadata: { input_tokens: i, output_tokens: o } } }]] });
    await h.handleLLMEnd(gen(1_000_000, 100_000) as never);
    await h.handleLLMEnd(gen(0, 400_000) as never);
    await h.handleLLMEnd({ generations: [[{ text: '' }]] } as never);
    expect(h).toMatchObject({ inputTokens: 1_000_000, outputTokens: 500_000, calls: 2 });
    // Haiku 5.5: $0.10 in + $0.50 out per million.
    expect(h.cost('claude-haiku-5.5')).toBeCloseTo(0.1 + 0.25, 6);
    expect(h.cost('some-other-model')).toBeNull();
  });
});
