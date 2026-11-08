import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatAnthropic } from '@langchain/anthropic';
import { anthropicModelId, getChatModel, thinkingFor } from './model-provider';
import { DEFAULT_MODEL, MODELS, isOfferedModel, isVisionModel } from './models';
import { cachedSystemMessage } from './system-prompt';

const saved = { ...process.env };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  for (const k of ['CADAI_MODEL', 'CADAI_MAX_TOKENS', 'CADAI_MODEL_TIMEOUT_MS', 'CADAI_THINKING', 'CADAI_EFFORT']) delete process.env[k];
});

afterEach(() => {
  process.env = { ...saved };
});

describe('getChatModel', () => {
  it('builds a native ChatAnthropic under the Anthropic model id', () => {
    const model = getChatModel('claude-sonnet-5.5');
    expect(model).toBeInstanceOf(ChatAnthropic);
    expect(model.model).toBe('claude-sonnet-5-5');
    expect(model.apiUrl).toBeUndefined();
  });

  it('never sends a temperature: Claude 5.5 rejects non-default values', () => {
    expect(getChatModel('claude-haiku-5.5').invocationParams({}).temperature).toBeUndefined();
    expect(getChatModel('claude-opus-5.5', { temperature: 0.6 }).invocationParams({}).temperature).toBeUndefined();
  });

  it('defaults to Sonnet 5.5, and CADAI_MODEL overrides it', () => {
    expect(getChatModel().model).toBe('claude-sonnet-5-5');
    process.env.CADAI_MODEL = 'claude-haiku-5.5';
    expect(getChatModel().model).toBe('claude-haiku-5-5');
  });

  it('CADAI_MODEL is ignored with a warning when not an offered model', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CADAI_MODEL = 'gpt-6-sol';
    expect(getChatModel().model).toBe('claude-sonnet-5-5');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CADAI_MODEL "gpt-6-sol" is not an offered model'));
    warnSpy.mockRestore();
  });

  it('sets maxTokens to 32000 with thinking off, 64000 with thinking on, and CADAI_MAX_TOKENS overrides both', () => {
    expect(getChatModel('claude-haiku-5.5').maxTokens).toBe(32000);
    // Sonnet and Opus think even with CADAI_THINKING=off, so max_tokens covers it.
    expect(getChatModel('claude-sonnet-5.5').maxTokens).toBe(64000);
    expect(getChatModel('claude-opus-5.5').maxTokens).toBe(64000);
    process.env.CADAI_THINKING = 'adaptive';
    expect(getChatModel('claude-haiku-5.5').maxTokens).toBe(64000);
    process.env.CADAI_MAX_TOKENS = '16000';
    expect(getChatModel('claude-haiku-5.5').maxTokens).toBe(16000);
    expect(getChatModel('claude-opus-5.5').maxTokens).toBe(16000);
  });

  it('times out after 240 s by default (CADAI_MODEL_TIMEOUT_MS overrides) and retries once', () => {
    const model = getChatModel('claude-haiku-5.5');
    expect(model.clientOptions.timeout).toBe(240_000);
    expect((model.caller as unknown as { maxRetries: number }).maxRetries).toBe(1);
    process.env.CADAI_MODEL_TIMEOUT_MS = '90000';
    expect(getChatModel('claude-haiku-5.5').clientOptions.timeout).toBe(90_000);
  });

  it('needs only ANTHROPIC_API_KEY, and says so when it is missing', () => {
    expect(() => getChatModel()).not.toThrow();
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getChatModel()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('maps app slugs to Anthropic ids', () => {
    expect(anthropicModelId('claude-opus-5.5')).toBe('claude-opus-5-5');
  });
});

describe('thinking and effort', () => {
  const sent = (slug: string) => {
    const p = getChatModel(slug).invocationParams({});
    return { thinking: p.thinking, effort: p.output_config?.effort };
  };

  it('defaults to thinking disabled at effort high on Haiku 5.5', () => {
    expect(sent('claude-haiku-5.5')).toEqual({ thinking: { type: 'disabled' }, effort: 'high' });
  });

  it('CADAI_EFFORT sets the effort', () => {
    process.env.CADAI_EFFORT = 'low';
    expect(sent('claude-haiku-5.5')).toEqual({ thinking: { type: 'disabled' }, effort: 'low' });
    process.env.CADAI_EFFORT = 'medium';
    expect(sent('claude-haiku-5.5')).toEqual({ thinking: { type: 'disabled' }, effort: 'medium' });
  });

  it('CADAI_THINKING=adaptive turns adaptive thinking on at the configured effort, on every model', () => {
    process.env.CADAI_THINKING = 'adaptive';
    process.env.CADAI_EFFORT = 'medium';
    for (const slug of ['claude-haiku-5.5', 'claude-sonnet-5.5', 'claude-opus-5.5']) {
      expect(sent(slug)).toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' });
    }
  });

  it('Sonnet 5.5 and Opus 5.5 reject disabled thinking, so "off" runs adaptive at effort low there', () => {
    process.env.CADAI_EFFORT = 'high';
    expect(sent('claude-sonnet-5.5')).toEqual({ thinking: { type: 'adaptive' }, effort: 'low' });
    expect(sent('claude-opus-5.5')).toEqual({ thinking: { type: 'adaptive' }, effort: 'low' });
    expect(thinkingFor('claude-haiku-5-5', 'off', 'high')).toEqual({ thinking: { type: 'disabled' }, effort: 'high' });
  });

  it('an unknown CADAI_THINKING or CADAI_EFFORT falls back to the default with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CADAI_THINKING = 'max';
    process.env.CADAI_EFFORT = 'xhigh';
    expect(sent('claude-haiku-5.5')).toEqual({ thinking: { type: 'disabled' }, effort: 'high' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CADAI_THINKING "max"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CADAI_EFFORT "xhigh"'));
    warnSpy.mockRestore();
  });
});

describe('cachedSystemMessage', () => {
  it('returns a SystemMessage with ephemeral cache control', () => {
    const text = 'test prompt';
    const msg = cachedSystemMessage(text);
    expect(msg.content).toEqual([{ type: 'text', text, cache_control: { type: 'ephemeral' } }]);
  });
});

describe('model catalogue', () => {
  it('offers Sonnet (default), Haiku and Opus only', () => {
    expect(MODELS.map((m) => m.slug)).toEqual(['claude-sonnet-5.5', 'claude-haiku-5.5', 'claude-opus-5.5']);
    expect(MODELS[0].label).toBe('Claude Sonnet 5.5 - Recommended');
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5.5');
    for (const m of MODELS) expect(isVisionModel(m.slug)).toBe(true);
  });

  it('no longer offers the old gateway models', () => {
    for (const slug of ['gpt-5.6-luna', 'gpt-6-sol', 'deepseek-v4-flash', 'gemini-3.6-flash']) expect(isOfferedModel(slug)).toBe(false);
  });

  it('isVisionModel accepts any claude- slug in dot or dash form', () => {
    for (const slug of [
      'claude-haiku-5.5',
      'claude-haiku-5-5',
      'claude-sonnet-5.5',
      'claude-sonnet-5-5',
      'claude-opus-5.5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude/sonnet-5',
    ]) {
      expect(isVisionModel(slug)).toBe(true);
    }
    for (const slug of ['gpt-6-sol', 'deepseek-v4-flash', 'random-model', undefined, '']) {
      expect(isVisionModel(slug)).toBe(false);
    }
  });
});
