import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLangfuseCallbackHandler } from './langfuse';

describe('getLangfuseCallbackHandler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns null when Langfuse keys are missing', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const handler = getLangfuseCallbackHandler();
    expect(handler).toBeNull();
  });

  it('creates handler when Langfuse keys are configured', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';

    const handler = getLangfuseCallbackHandler({
      sessionId: 'test-thread-123',
      tags: ['test'],
    });

    expect(handler).toBeDefined();
    expect(handler).not.toBeNull();
  });
});
