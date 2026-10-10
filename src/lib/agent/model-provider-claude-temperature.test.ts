import { describe, it, expect, beforeAll } from 'vitest';
import { getChatModel } from './model-provider';

beforeAll(() => {
  process.env.EXPLABS_API_KEY ??= 'test-key';
});

describe('Claude routes on the gateway accept only temperature 1', () => {
  it('uses 1 for every claude-* slug, whatever temperature is asked for', () => {
    expect(getChatModel('claude-haiku-5.5').temperature).toBe(1);
    expect(getChatModel('claude-sonnet-5.5', { temperature: 0.6 }).temperature).toBe(1);
    expect(getChatModel('claude-opus-5.5').temperature).toBe(1);
  });

  it('leaves other slugs on the default or requested temperature', () => {
    expect(getChatModel('gpt-6-sol').temperature).toBe(0.2);
    expect(getChatModel('gpt-6-sol', { temperature: 0.6 }).temperature).toBe(0.6);
  });
});
