import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { GENERATED_PRELUDE, PRELUDE_SENTINEL } from '../../brep/body-check';
import {
  applyRollingCacheBreakpoint,
  checkRun,
  findPoseParams,
  parseDimensions,
  replyUsage,
  scriptBaseKey,
  shortError,
} from './tools';

const script = (lines: string[]) => `${GENERATED_PRELUDE}\n\n${PRELUDE_SENTINEL}\n\n${lines.join('\n')}\n`;

describe('parseDimensions', () => {
  it('reads top-level name = number lines, not pose parameters, indented lines or prelude lines', () => {
    const s = script([
      'width = 40  # overall width',
      'wall = 2.5',
      'lid_open_deg = 0  # [0:5:90] lid',
      'drawer_travel = 0  # [0:5:50] drawer',
      'name = "x"',
      'if True:',
      '    inner = 3',
      'size = width * 2',
    ]);
    expect(parseDimensions(s)).toEqual([
      { name: 'width', value: 40 },
      { name: 'wall', value: 2.5 },
    ]);
  });
});

describe('findPoseParams', () => {
  it('reads ranges with and without a step, and flags a missing range', () => {
    const s = script([
      'a_deg = 0  # [0:5:120] a',
      'b_travel = 0  # [0:40] b',
      'c_deg = 0  # no range',
      'width = 3  # [1:2:9] not a pose',
    ]);
    expect(findPoseParams(s)).toEqual([
      { name: 'a_deg', value: 0, min: 0, max: 120 },
      { name: 'b_travel', value: 0, min: 0, max: 40 },
      { name: 'c_deg', value: 0, min: undefined, max: undefined },
    ]);
  });
});

describe('scriptBaseKey', () => {
  it('ignores top-level numeric values but not code changes', () => {
    const a = script(['lid_open_deg = 0  # [0:5:90] lid', 'result = Box(1, 1, 1)']);
    const b = script(['lid_open_deg = 90  # [0:5:90] lid', 'result = Box(1, 1, 1)']);
    const c = script(['lid_open_deg = 0  # [0:5:90] lid', 'result = Box(2, 1, 1)']);
    expect(scriptBaseKey(a)).toBe(scriptBaseKey(b));
    expect(scriptBaseKey(a)).not.toBe(scriptBaseKey(c));
  });
});

describe('shortError', () => {
  it('keeps the last line only, without paths', () => {
    expect(shortError('Traceback (most recent call last):\n  File "/srv/geo/run.py", line 3\nValueError: bad /srv/geo/x.py thing')).toBe('ValueError: bad <path> thing');
    expect(shortError(undefined)).toBe('unknown error');
    expect(shortError('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('checkRun', () => {
  const ok = { ok: true, solids: 1, ms: 1, parts: [{ label: 'a', valid: true, volume: 1, min: [0, 0, 0], max: [1, 1, 1] }] } as never;
  it('passes a clean run and fails each hard check', () => {
    expect(checkRun(ok).passing).toBe(true);
    expect(checkRun({ ...(ok as object), parts: [] } as never).passing).toBe(false);
    expect(checkRun({ ...(ok as object), disconnected: ['a'] } as never).passing).toBe(false);
    expect(checkRun({ ...(ok as object), disconnected: 'not checked' } as never).passing).toBe(true);
    expect(checkRun({ ...(ok as object), interferences: [{ a: 'a', b: 'b', volume: 0.5 }] } as never).passing).toBe(true);
    expect(checkRun({ ...(ok as object), interferences: [{ a: 'a', b: 'b', volume: 5 }] } as never).passing).toBe(false);
    expect(checkRun({ ok: false, error: 'boom', parts: [], solids: 0, ms: 1 }).passing).toBe(false);
  });
});

describe('applyRollingCacheBreakpoint', () => {
  it('moves one breakpoint to the newest message and converts string content', () => {
    const a = new HumanMessage('first');
    const b = new HumanMessage('second');
    const conv = [a];
    const c1 = applyRollingCacheBreakpoint(conv, null);
    expect(c1).toBe(a);
    conv.push(b);
    const c2 = applyRollingCacheBreakpoint(conv, c1);
    expect(c2).toBe(b);
    expect(JSON.stringify(a.content)).not.toContain('cache_control');
    expect(JSON.stringify(b.content)).toContain('cache_control');
  });
});

describe('replyUsage', () => {
  it('separates cache reads and writes from plain input', () => {
    const reply = new AIMessage({
      content: 'x',
      usage_metadata: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050, input_token_details: { cache_read: 700, cache_creation: 100 } },
    });
    expect(replyUsage(reply)).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 700,
    });
  });
});
