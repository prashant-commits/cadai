import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { RUBRIC_SYSTEM_PROMPT } from './rubric-prompt';

describe('judge v2 rubric prompt hash', () => {
  it('matches the calibrated frozen sha256 hash', () => {
    const hash = createHash('sha256').update(RUBRIC_SYSTEM_PROMPT, 'utf8').digest('hex');
    expect(hash).toBe('b930f802a54f9d48b9602403854ec1bb73dc9668e4757e6f715c7a0baf96c793');
  });
});
