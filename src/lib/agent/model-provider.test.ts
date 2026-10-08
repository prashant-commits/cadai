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
    expect(GATEWAY_MODELS.map((m) => m.slug)).toEqual(['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol']);
    expect(GATEWAY_MODELS[2].label).toBe('GPT-6 Sol - higher quality (paid)');
    expect(isVisionModel('gpt-6-sol')).toBe(true);
    expect(DEFAULT_MODEL).toBe('gpt-5.6-luna');
  });
});
