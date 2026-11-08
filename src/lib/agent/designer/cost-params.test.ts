import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { applyParameterOverrides, estimateCostUsd, extractReplyUsage } from './cost-params';

const SCRIPT_1 = `from build123d import *
lean_angle = 70  # [64:1:90] backrest lean
lid_open_deg = 0  # [0:5:120] lid angle
base = Box(180, 120, 8, align=(Align.MIN, Align.MIN, Align.MIN))
lid = Pos(10, 70, 38) * Box(160, 40, 4, align=(Align.MIN, Align.MIN, Align.MIN))
base.label = 'base'
lid.label = 'lid'
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;

describe('applyParameterOverrides', () => {
  it('updates parameter lines while keeping comments and ranges', () => {
    const out = applyParameterOverrides(SCRIPT_1, { lid_open_deg: 100 });
    expect(out).toContain('lid_open_deg = 100  # [0:5:120] lid angle');
    expect(out).toContain('lean_angle = 70  # [64:1:90] backrest lean');
  });

  it('ignores invalid or empty overrides', () => {
    expect(applyParameterOverrides(SCRIPT_1)).toBe(SCRIPT_1);
    expect(applyParameterOverrides(SCRIPT_1, {})).toBe(SCRIPT_1);
    expect(applyParameterOverrides(SCRIPT_1, { '123invalid': 50 })).toBe(SCRIPT_1);
  });
});

describe('extractReplyUsage and estimateCostUsd', () => {
  it('extracts usage and estimates cost correctly', () => {
    const reply = new AIMessage({
      content: 'test',
      usage_metadata: {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
      },
    });
    const usage = extractReplyUsage(reply);
    expect(usage.input_tokens).toBe(1000);
    expect(usage.output_tokens).toBe(500);

    const cost = estimateCostUsd('claude-sonnet-5-5', usage);
    expect(cost).toBeGreaterThan(0);
  });
});
