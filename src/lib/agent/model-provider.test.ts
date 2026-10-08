import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatOpenAI } from '@langchain/openai';
import { getChatModel } from './model-provider';
import { EXPLABS_BASE_URL, DEFAULT_MODEL } from './models';

const saved = { ...process.env };

beforeEach(() => {
  process.env.EXPLABS_API_KEY = 'test-explabs-key';
  delete process.env.CADAI_MODEL;
});

afterEach(() => {
  process.env = { ...saved };
});

describe('getChatModel', () => {
  it('sends every slug to the Experiential Labs gateway', () => {
    const model = getChatModel('deepseek-v4-flash');
    expect(model).toBeInstanceOf(ChatOpenAI);
    // The baseURL is the whole point of this lane: without it the client would
    // talk to api.openai.com with a gateway key and 401.
    expect(model.clientConfig.baseURL).toBe(EXPLABS_BASE_URL);
  });

  it('uses 0.2 by default and the requested temperature otherwise', () => {
    expect(getChatModel('gpt-5.6-luna').temperature).toBe(0.2);
    expect(getChatModel('gpt-5.6-luna', { temperature: 0.6 }).temperature).toBe(0.6);
  });

  it('claude-opus-5.5 is pinned to temperature 1, overriding both the default and the revision temperature', () => {
    expect(getChatModel('claude-opus-5.5').temperature).toBe(1);
    expect(getChatModel('claude-opus-5.5', { temperature: 0.6 }).temperature).toBe(1);
  });

  it('defaults to the multimodal model', () => {
    expect(getChatModel().model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('gpt-5.6-luna');
  });

  it('lets CADAI_MODEL override the default without touching the picker', () => {
    process.env.CADAI_MODEL = 'deepseek-v3.2';
    expect(getChatModel().model).toBe('deepseek-v3.2');
  });

  // CADAI_MODEL is deliberately not validated against GATEWAY_MODELS, so a new
  // gateway slug can be tried without a code change.
  it('accepts a slug the picker does not list', () => {
    const model = getChatModel('some-new-gateway-slug');
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(model.model).toBe('some-new-gateway-slug');
  });

  it('explains which key is missing rather than failing at request time', () => {
    delete process.env.EXPLABS_API_KEY;
    expect(() => getChatModel('deepseek-v4-flash')).toThrow(/EXPLABS_API_KEY/);
  });
});

describe('model catalogue', () => {
  it('offers gpt-6-sol as a vision model while the default stays gpt-5.6-luna', async () => {
    const { GATEWAY_MODELS, isVisionModel, DEFAULT_MODEL } = await import('./models');
    expect(GATEWAY_MODELS.map((m) => m.slug)).toEqual(['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol', 'claude-opus-5.5']);
    expect(GATEWAY_MODELS[2].label).toBe('GPT-6 Sol - higher quality (paid)');
    expect(GATEWAY_MODELS[3].label).toBe('Claude Opus 5.5 - highest quality (paid)');
    expect(isVisionModel('claude-opus-5.5')).toBe(true);
    expect(isVisionModel('gpt-6-sol')).toBe(true);
    expect(DEFAULT_MODEL).toBe('gpt-5.6-luna');
  });
});
