import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, isVisionModel } from '@/lib/agent/models';
import { EVAL_DEFAULT_MODEL, loadPrompts, recursionLimitFromEnv, selectPrompts, sheetsModelError } from './run-config';

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
    expect(sheetsModelError('claude-haiku-5-5', 'on')).toBeNull();
    expect(sheetsModelError('claude-sonnet-5.5', 'on')).toBeNull();
  });
});

describe('custom prompts files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-'));
  const file = path.join(dir, 'round2.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'hair_dryer_nocup', prompt: 'A holder with no cup.' }, { id: 'other', prompt: 'x' }]));

  it('selects a prompt that exists only in the custom file', () => {
    const items = selectPrompts(loadPrompts(file), ['hair_dryer_nocup'], Infinity, file);
    expect(items).toEqual([{ id: 'hair_dryer_nocup', prompt: 'A holder with no cup.' }]);
    expect(loadPrompts().some((p) => p.id === 'hair_dryer_nocup')).toBe(false);
  });

  it('fails loudly, naming the file, when the id is not in the file the child was given', () => {
    expect(() => selectPrompts(loadPrompts(), ['hair_dryer_nocup'], Infinity, 'prompts.json')).toThrow(/not found in prompts\.json: hair_dryer_nocup/);
  });

  it('fails when nothing is left to run', () => {
    expect(() => selectPrompts([], [], Infinity)).toThrow(/no prompts to run/);
    expect(() => selectPrompts(loadPrompts(file), [], 0, file)).toThrow(/no prompts to run/);
  });
});
