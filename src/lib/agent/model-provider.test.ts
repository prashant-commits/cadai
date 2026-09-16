import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatOpenAI } from '@langchain/openai';
import { getChatModel, getVisionModel } from './model-provider';
import { EXPLABS_BASE_URL, DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL } from './models';

const saved = { ...process.env };

beforeEach(() => {
  process.env.EXPLABS_API_KEY = 'test-explabs-key';
  delete process.env.CADAI_MODEL;
  delete process.env.CADAI_VISION_MODEL;
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

  it('defaults to the model measured to produce valid Assembly Specs', () => {
    expect(getChatModel().model).toBe(DEFAULT_TEXT_MODEL);
    expect(DEFAULT_TEXT_MODEL).toBe('deepseek-v4-flash');
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

describe('getVisionModel', () => {
  // The critic is the only node that sends images. Routing it to a DeepSeek
  // text slug makes the gateway reject the call outright ("The selected model
  // route cannot accept image input"), which is what this fallback prevents.
  it('falls back to a multimodal slug when the selected model cannot see', () => {
    const vision = getVisionModel('deepseek-v4-flash');
    expect(vision).toBeInstanceOf(ChatOpenAI);
    expect(vision.model).toBe(DEFAULT_VISION_MODEL);
  });

  it('reuses the selected model when it is already the multimodal one', () => {
    const vision = getVisionModel(DEFAULT_VISION_MODEL);
    expect(vision.model).toBe(DEFAULT_VISION_MODEL);
  });

  it('honours a CADAI_VISION_MODEL override', () => {
    process.env.CADAI_VISION_MODEL = 'some-other-vision-slug';
    expect(getVisionModel('deepseek-v4-flash').model).toBe('some-other-vision-slug');
  });
});
