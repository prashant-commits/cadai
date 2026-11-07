import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { getChatModel } from './model-provider';
import { extractReplyCode, invokeWithToolRound } from './tool-round';
import { contentText } from './message-text';
import { structuredFor, SheetReviewSchema, parseVisualCritique, unusableStop, isCutOff, UnusableReplyError } from './llm-schemas';
import { reply, withFakeClient } from './__fixtures__/fake-anthropic';

// The Lows from the re-review of the native Messages API switch (n1-rereview.md).

const saved = { ...process.env };
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  for (const k of ['CADAI_MODEL', 'CADAI_MAX_TOKENS', 'CADAI_THINKING', 'CADAI_EFFORT']) delete process.env[k];
});
afterEach(() => {
  process.env = { ...saved };
});

const SCRIPT = 'Here it is.\n```openscad\ncube(10);\n```';
const withStop = (stop: string) => new AIMessage({ content: SCRIPT, response_metadata: { stop_reason: stop } });

describe('L1. a critic finding without view is kept', () => {
  it('defaults a missing or non-string view to "" (all views) instead of dropping the critique', () => {
    expect(parseVisualCritique({ matchesIntent: false, findings: [{ issue: 'a', severity: 'major' }] })).toEqual({
      matchesIntent: false,
      findings: [{ issue: 'a', severity: 'major', view: '' }],
    });
    expect(parseVisualCritique({ matchesIntent: true, findings: [{ issue: 'b', severity: 'minor', view: null }, { issue: 'c', severity: 'minor', view: 'top' }] })?.findings).toEqual([
      { issue: 'b', severity: 'minor', view: '' },
      { issue: 'c', severity: 'minor', view: 'top' },
    ]);
  });

  it('a finding without an issue still makes the critique unusable', () => {
    expect(parseVisualCritique({ matchesIntent: false, findings: [{ severity: 'major' }] })).toBeNull();
  });
});

describe('L2. pause_turn and model_context_window_exceeded are unusable, like max_tokens', () => {
  it('unusableStop and isCutOff', () => {
    for (const stop of ['max_tokens', 'pause_turn', 'model_context_window_exceeded']) {
      expect(unusableStop(withStop(stop)), stop).toBe(stop);
      expect(isCutOff(unusableStop(withStop(stop))), stop).toBe(true);
      // Streamed replies carry it in additional_kwargs.
      expect(unusableStop(new AIMessage({ content: '', additional_kwargs: { stop_reason: stop } })), stop).toBe(stop);
    }
    expect(unusableStop(withStop('refusal'))).toBe('refusal');
    expect(isCutOff('refusal')).toBe(false);
    for (const stop of ['end_turn', 'tool_use', 'stop_sequence']) expect(unusableStop(withStop(stop)), stop).toBeNull();
  });

  it('json_schema routes throw UnusableReplyError for both', async () => {
    for (const stop of ['pause_turn', 'model_context_window_exceeded']) {
      const model = getChatModel('claude-haiku-5.5');
      withFakeClient(model, () => reply([{ type: 'text', text: JSON.stringify({ matchesRequest: true, findings: [] }) }], stop));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = await (structuredFor(model, 'claude-haiku-5.5', SheetReviewSchema) as any).invoke([new HumanMessage('x')]).catch((e: unknown) => e);
      expect(err, stop).toBeInstanceOf(UnusableReplyError);
      expect((err as UnusableReplyError).stop).toBe(stop);
    }
  });
});

describe('L3. drafter and repair script replies are stop-checked', () => {
  it('a cut-off reply is truncated even when its fences balance; a refusal is no_code; a normal stop extracts the script', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const stop of ['max_tokens', 'model_context_window_exceeded', 'pause_turn']) {
      expect(extractReplyCode(withStop(stop), SCRIPT), stop).toEqual({ code: null, error: 'truncated' });
    }
    expect(extractReplyCode(withStop('refusal'), SCRIPT)).toEqual({ code: null, error: 'no_code' });
    expect(extractReplyCode(withStop('end_turn'), SCRIPT)).toEqual({ code: 'cube(10);' });
    warn.mockRestore();
  });

  it('end to end through the tool round: a max_tokens follow-up reply is truncated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = getChatModel('claude-haiku-5.5');
    withFakeClient(model, (_b, call) =>
      call === 0
        ? reply([{ type: 'tool_use', id: 'toolu_1', name: 'get_functional_cad_module', input: { moduleKey: 'fastener_hardware' } }])
        : reply([{ type: 'text', text: SCRIPT }], 'max_tokens')
    );
    const res = await invokeWithToolRound(model, [new HumanMessage('draft it')]);
    expect(extractReplyCode(res, contentText(res.content))).toEqual({ code: null, error: 'truncated' });
    warn.mockRestore();
  });
});
