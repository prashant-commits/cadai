import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatOpenAI } from '@langchain/openai';
import { ANTHROPIC_OPENAI_BASE_URL, anthropicModelId, getChatModel } from './model-provider';
import { DEFAULT_MODEL, MODELS, isOfferedModel, isVisionModel } from './models';

const saved = { ...process.env };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  delete process.env.EXPLABS_API_KEY;
  delete process.env.CADAI_MODEL;
});

afterEach(() => {
  process.env = { ...saved };
});

describe('getChatModel', () => {
  it('sends every model to the Anthropic API under its Anthropic model id', () => {
    const model = getChatModel('claude-sonnet-5.5');
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(model.clientConfig.baseURL).toBe(ANTHROPIC_OPENAI_BASE_URL);
    expect(model.model).toBe('claude-sonnet-5-5');
  });

  it('never sends a temperature: Claude 5.5 rejects it on this endpoint', () => {
    expect(getChatModel('claude-haiku-5.5').temperature).toBeUndefined();
    expect(getChatModel('claude-opus-5.5', { temperature: 0.6 }).temperature).toBeUndefined();
  });

  it('defaults to Haiku 5.5, and CADAI_MODEL overrides it', () => {
    expect(getChatModel().model).toBe('claude-haiku-5-5');
    process.env.CADAI_MODEL = 'claude-sonnet-5.5';
    expect(getChatModel().model).toBe('claude-sonnet-5-5');
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

describe('model catalogue', () => {
  it('offers Haiku (default), Sonnet and Opus only', () => {
    expect(MODELS.map((m) => m.slug)).toEqual(['claude-haiku-5.5', 'claude-sonnet-5.5', 'claude-opus-5.5']);
    expect(MODELS[0].label).toBe('Claude Haiku 5.5 - Recommended');
    expect(DEFAULT_MODEL).toBe('claude-haiku-5.5');
    for (const m of MODELS) expect(isVisionModel(m.slug)).toBe(true);
  });

  it('no longer offers the old gateway models', () => {
    for (const slug of ['gpt-5.6-luna', 'gpt-6-sol', 'deepseek-v4-flash', 'gemini-3.6-flash']) expect(isOfferedModel(slug)).toBe(false);
  });
});
