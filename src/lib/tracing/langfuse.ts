import { CallbackHandler } from '@langfuse/langchain';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

let spanProcessor: LangfuseSpanProcessor | null = null;

function resolveLangfuseCredentials() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !secretKey) {
    return null;
  }

  const baseUrl =
    process.env.LANGFUSE_BASE_URL ||
    process.env.LANGFUSE_HOST ||
    'https://cloud.langfuse.com';

  return { publicKey, secretKey, baseUrl };
}

/**
 * Registers the process-wide OpenTelemetry tracer provider with Langfuse's
 * span processor. v5 rebuilt tracing on OpenTelemetry: CallbackHandler no
 * longer carries its own credentials or transport, it just annotates
 * whatever span is active, and this processor is what actually ships spans
 * to Langfuse. Must run once before any handler is used; safe to call
 * repeatedly - a no-op once already registered, and a no-op when Langfuse
 * isn't configured. Next.js triggers this from instrumentation.ts at server
 * startup; it also runs lazily from getLangfuseCallbackHandler so paths that
 * bypass that hook (Vitest, scripts) still get tracing wired up.
 */
export function initLangfuseTracing() {
  const credentials = resolveLangfuseCredentials();
  if (!credentials) {
    return null;
  }

  if (!spanProcessor) {
    try {
      spanProcessor = new LangfuseSpanProcessor({
        ...credentials,
        // Both API routes run on the Node.js serverless runtime, which can
        // freeze or terminate the instance right after the response is
        // sent. Batched export would lose whatever hadn't shipped yet by
        // then, so spans go out immediately and the routes still call
        // forceFlush() in their `finally` blocks before closing the stream.
        exportMode: 'immediate',
      });

      new NodeTracerProvider({ spanProcessors: [spanProcessor] }).register();
    } catch (err) {
      console.warn('Langfuse tracing initialization warning:', err);
      spanProcessor = null;
    }
  }

  return spanProcessor;
}

/**
 * The registered span processor, for flushing before a serverless instance
 * freezes (see the route handlers' `finally` blocks). Null when Langfuse
 * isn't configured.
 */
export function getLangfuseSpanProcessor() {
  return initLangfuseTracing();
}

export function getLangfuseCallbackHandler(options?: {
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}) {
  if (!initLangfuseTracing()) {
    return null;
  }

  try {
    return new CallbackHandler({
      userId: options?.userId,
      sessionId: options?.sessionId,
      tags: options?.tags || ['cadai', 'langgraph', 'gemini'],
      // Renamed from `metadata` in v3/v4 to `traceMetadata` in v5.
      traceMetadata: options?.metadata,
    });
  } catch (err) {
    console.warn('Langfuse CallbackHandler initialization warning:', err);
    return null;
  }
}
