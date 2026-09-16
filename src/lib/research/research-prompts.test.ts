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
