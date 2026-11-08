/**
 * LangGraph's default recursion limit is 25 super-steps. The limit is computed
 * from the same env vars the graph reads, so raising the retry budget can never trip the cap.
 */
export function graphRecursionLimit(): number {
  const retries = Math.max(0, Number(process.env.CADAI_SPEC_REVIEW_RETRIES ?? 5)) || 0;
  const attempts = Math.max(1, Number(process.env.CADAI_MAX_ATTEMPTS ?? 1)) || 1;
  // Steps per review round and repair attempt, with headroom for fixed nodes.
  return 3 * (retries + 1) + 2 * attempts + 15;
}

/** A short label for a graph failure. Raw error text goes to the server log only, never to the UI. */
export function describeGraphError(err: unknown, prefix: string): string {
  const name = err instanceof Error ? err.name : '';
  const text = err instanceof Error ? err.message : String(err);
  console.error(`${prefix}:`, err); // every error is logged server-side before it is labelled
  if (name === 'GraphRecursionError' || /Recursion limit/i.test(text)) {
    return `${prefix}: the run took more steps than allowed and was stopped.`;
  }
  return `${prefix}; see server logs.`;
}
