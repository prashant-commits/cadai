/**
 * LangGraph's default recursion limit is 25 super-steps. A sheet-review round is
 * 3 of them (architect, illustrator, reviewer), so the default retry budget
 * alone uses most of it. The limit is computed from the same env vars the graph
 * reads, so raising the retry budget can never trip the cap.
 */
export function graphRecursionLimit(): number {
  const retries = Math.max(0, Number(process.env.CADAI_SPEC_REVIEW_RETRIES ?? 5)) || 0; // 5: default review retries, as in the reviewer
  const attempts = Math.max(1, Number(process.env.CADAI_MAX_ATTEMPTS ?? 1)) || 1; // 1: default repair attempts, as in the state default
  // 3 steps per review round; 2 per repair attempt (validate + fix); 15 for the
  // fixed nodes (planner pass, gates, drafter, critic, respond) and revise rounds.
  return 3 * (retries + 1) + 2 * attempts + 15;
}

/** A short label for a graph failure; raw framework text never reaches the UI. */
export function describeGraphError(err: unknown, prefix: string): string {
  const name = err instanceof Error ? err.name : '';
  const text = err instanceof Error ? err.message : String(err);
  if (name === 'GraphRecursionError' || /Recursion limit/i.test(text)) {
    return `${prefix}: the run took more steps than allowed and was stopped.`;
  }
  return `${prefix}: ${text}`;
}
