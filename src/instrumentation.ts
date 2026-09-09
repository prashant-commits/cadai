// Registers Langfuse's OpenTelemetry span processor once when the server
// instance starts, so it's ready before the first request needs it. See
// src/lib/tracing/langfuse.ts for why this exists (v5 moved tracing onto
// OpenTelemetry) and why it's also safe to skip: it lazily self-inits there
// too for anything that bypasses this hook (Vitest, scripts).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initLangfuseTracing } = await import('@/lib/tracing/langfuse');
    initLangfuseTracing();
  }
}
