import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const registerMock = vi.fn();
const forceFlushMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@langfuse/otel', () => {
  return {
    LangfuseSpanProcessor: vi.fn().mockImplementation(function (this: Record<string, unknown>, params: unknown) {
      this.__params = params;
      this.forceFlush = forceFlushMock;
      this.shutdown = vi.fn().mockResolvedValue(undefined);
    }),
  };
});

vi.mock('@opentelemetry/sdk-trace-node', () => {
  return {
    NodeTracerProvider: vi.fn().mockImplementation(function (this: Record<string, unknown>, params: unknown) {
      this.__params = params;
      this.register = registerMock;
    }),
  };
});

describe('langfuse tracing', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    // Module-level singleton state (the registered span processor) must not
    // leak between tests, so reload the module fresh each time.
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getLangfuseCallbackHandler', () => {
    it('returns null when Langfuse keys are missing', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;

      const { getLangfuseCallbackHandler } = await import('./langfuse');
      const handler = getLangfuseCallbackHandler();

      expect(handler).toBeNull();
      expect(registerMock).not.toHaveBeenCalled();
    });

    it('creates handler and registers tracing when Langfuse keys are configured', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';

      const { getLangfuseCallbackHandler } = await import('./langfuse');
      const handler = getLangfuseCallbackHandler({
        sessionId: 'test-thread-123',
        tags: ['test'],
        metadata: { model: 'test-model' },
      });

      expect(handler).toBeDefined();
      expect(handler).not.toBeNull();
      expect(registerMock).toHaveBeenCalledTimes(1);
    });

    it('maps the metadata option onto traceMetadata (renamed in v5)', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';

      const { getLangfuseCallbackHandler } = await import('./langfuse');
      const handler = getLangfuseCallbackHandler({
        metadata: { model: 'test-model' },
      }) as unknown as { traceMetadata?: Record<string, unknown> };

      expect(handler?.traceMetadata).toEqual({ model: 'test-model' });
    });

    it('only registers the tracer provider once across repeated calls', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';

      const { getLangfuseCallbackHandler } = await import('./langfuse');
      getLangfuseCallbackHandler();
      getLangfuseCallbackHandler();
      getLangfuseCallbackHandler();

      expect(registerMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getLangfuseSpanProcessor', () => {
    it('returns null when Langfuse keys are missing', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;

      const { getLangfuseSpanProcessor } = await import('./langfuse');
      expect(getLangfuseSpanProcessor()).toBeNull();
    });

    it('returns a processor whose forceFlush() can be awaited before a serverless instance freezes', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';

      const { getLangfuseSpanProcessor } = await import('./langfuse');
      const processor = getLangfuseSpanProcessor();

      await expect(processor?.forceFlush()).resolves.toBeUndefined();
      expect(forceFlushMock).toHaveBeenCalledTimes(1);
    });

    it('requests immediate export mode, since both API routes run on the serverless Node.js runtime', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';

      const { getLangfuseSpanProcessor } = await import('./langfuse');
      const processor = getLangfuseSpanProcessor() as unknown as {
        __params: { exportMode: string };
      };

      expect(processor.__params.exportMode).toBe('immediate');
    });
  });
});
