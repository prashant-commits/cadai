/**
 * In-process handles for runs this instance is streaming: the AbortController
 * that stops the graph. Cross-instance cancel goes through RunStore.requestCancel;
 * the owning instance polls isCancelled() (see streamRun) and aborts from there.
 */
const controllers = new Map<string, AbortController>();

export function registerRun(runId: string): AbortController {
  const c = new AbortController();
  controllers.set(runId, c);
  return c;
}

export function unregisterRun(runId: string): void {
  controllers.delete(runId);
}

/** Aborts the run if this instance is streaming it. Returns whether it was. */
export function abortRun(runId: string): boolean {
  const c = controllers.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}
