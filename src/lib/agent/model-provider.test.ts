import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import {
  getChatModel,
  getVisionModel,
  supportsVision,
  EXPLABS_BASE_URL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
} from './model-provider';

const saved = { ...process.env };

beforeEach(() => {
  process.env.GOOGLE_API_KEY = 'test-google-key';
  process.env.EXPLABS_API_KEY = 'test-explabs-key';
  delete process.env.CADAI_MODEL;
  delete process.env.CADAI_VISION_MODEL;
});

afterEach(() => {
  process.env = { ...saved };
});

describe('getChatModel', () => {
  it('sends gemini-* slugs to Google so existing behaviour is untouched', () => {
    const model = getChatModel(undefined, 'gemini-3.6-flash');
    expect(model).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it('sends every other slug to the Experiential Labs gateway', () => {
    const model = getChatModel(undefined, 'deepseek-v4-flash');
    expect(model).toBeInstanceOf(ChatOpenAI);
    // The baseURL is the whole point of this lane: without it the client would
    // talk to api.openai.com with a gateway key and 401.
    expect((model as ChatOpenAI).clientConfig.baseURL).toBe(EXPLABS_BASE_URL);
  });

  it('defaults to the model measured to produce valid Assembly Specs', () => {
    expect(getChatModel()).toBeInstanceOf(ChatOpenAI);
    expect(DEFAULT_TEXT_MODEL).toBe('deepseek-v4-flash');
  });

  it('lets CADAI_MODEL override the default without touching the picker', () => {
    process.env.CADAI_MODEL = 'gemini-3.5-flash-lite';
    expect(getChatModel()).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it('explains which key is missing rather than failing at request time', () => {
    delete process.env.EXPLABS_API_KEY;
    expect(() => getChatModel(undefined, 'deepseek-v4-flash')).toThrow(/EXPLABS_API_KEY/);

    delete process.env.GOOGLE_API_KEY;
    expect(() => getChatModel(undefined, 'gemini-3.6-flash')).toThrow(/Gemini API Key/);
  });

  it('prefers the user-supplied Gemini key over the environment', () => {
    delete process.env.GOOGLE_API_KEY;
    expect(() => getChatModel('user-key', 'gemini-3.6-flash')).not.toThrow();
  });
});

describe('getVisionModel', () => {
  // The critic is the only node that sends images. Routing it to a DeepSeek
  // text slug makes the gateway reject the call outright ("The selected model
  // route cannot accept image input"), which is what this fallback prevents.
  it('falls back to a multimodal slug when the selected model cannot see', () => {
    const vision = getVisionModel(undefined, 'deepseek-v4-flash');
    expect(vision).toBeInstanceOf(ChatOpenAI);
    expect((vision as ChatOpenAI).model).toBe(DEFAULT_VISION_MODEL);
  });

  it('reuses the selected model when it is already multimodal', () => {
    const vision = getVisionModel(undefined, 'gemini-3.6-flash');
    expect(vision).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it('honours a CADAI_VISION_MODEL override', () => {
    process.env.CADAI_VISION_MODEL = 'gemini-3.6-flash';
    expect(getVisionModel(undefined, 'deepseek-v4-flash')).toBeInstanceOf(ChatGoogleGenerativeAI);
  });
});

describe('supportsVision', () => {
  it('knows which slugs accept image input', () => {
    expect(supportsVision('gemini-3.6-flash')).toBe(true);
    expect(supportsVision(DEFAULT_VISION_MODEL)).toBe(true);
    expect(supportsVision('deepseek-v4-flash')).toBe(false);
    expect(supportsVision('deepseek-v4-pro')).toBe(false);
  });
});
