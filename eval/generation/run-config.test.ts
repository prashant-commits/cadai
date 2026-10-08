import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, isVisionModel } from '@/lib/agent/models';
import { EVAL_DEFAULT_MODEL, recursionLimitFromEnv, sheetsModelError } from './run-config';

afterEach(() => {
  delete process.env.CADAI_SPEC_REVIEW_RETRIES;
  delete process.env.CADAI_MAX_ATTEMPTS;
});

describe('eval run config', () => {
  it('defaults to the vision model', () => {
    expect(EVAL_DEFAULT_MODEL).toBe(DEFAULT_MODEL);
    expect(isVisionModel(EVAL_DEFAULT_MODEL)).toBe(true);
  });

  it('sizes the recursion limit from the review and repair budgets', () => {
    delete process.env.CADAI_SPEC_REVIEW_RETRIES;
    delete process.env.CADAI_MAX_ATTEMPTS;
    expect(recursionLimitFromEnv()).toBe(3 * (5 + 1) + 2 * 1 + 15);
    process.env.CADAI_SPEC_REVIEW_RETRIES = '8';
    process.env.CADAI_MAX_ATTEMPTS = '3';
    expect(recursionLimitFromEnv()).toBe(3 * (8 + 1) + 2 * 3 + 15);
    process.env.CADAI_SPEC_REVIEW_RETRIES = 'nope';
    delete process.env.CADAI_MAX_ATTEMPTS;
    expect(recursionLimitFromEnv()).toBe(3 * (0 + 1) + 2 * 1 + 15);
  });

  it('stops when sheets are on and the model cannot see images', () => {
    expect(sheetsModelError('deepseek-v4-flash', 'on')).toMatch(/not a vision model/);
    expect(sheetsModelError('deepseek-v4-flash', 'off')).toBeNull();
    expect(sheetsModelError(DEFAULT_MODEL, 'on')).toBeNull();
  });
});
