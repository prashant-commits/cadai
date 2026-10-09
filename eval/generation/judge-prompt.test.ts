import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JUDGE_SYSTEM_PROMPT } from './judge-prompt';

describe('frozen eval judge prompt', () => {
  it('is byte-identical to the prompt that judged armC4 (267f928)', () => {
    expect(JUDGE_SYSTEM_PROMPT.length).toBe(8553);
    expect(createHash('sha256').update(JUDGE_SYSTEM_PROMPT, 'utf8').digest('hex')).toBe(
      'd021fb247a42018c302873661dc4dc324e9a9a9346aa6e67c6fe7a92704fc560'
    );
  });

  it('is what the judge sends, independent of the product prompts', () => {
    const src = readFileSync(new URL('./judge.ts', import.meta.url), 'utf8');
    expect(src).toContain('new SystemMessage(JUDGE_SYSTEM_PROMPT)');
    expect(src).not.toMatch(/CAD_AI_SYSTEM_PROMPT|CRITIC_PREAMBLE|system-prompt/);
  });
});
