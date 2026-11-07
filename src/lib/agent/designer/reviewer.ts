/**
 * TEMPORARY STUB for task/dz-graph.
 *
 * This file is being written in parallel by the reviewer lane (task/dz-rev).
 * The orchestrator should replace/drop this file when merging task/dz-rev.
 */
import type { ReviewFn, ReviewFlag } from './types';

export function makeReviewer(): ReviewFn {
  return async () => ({
    flags: [],
    costUsd: 0,
  });
}

export function formatFlags(flags: ReviewFlag[]): string {
  if (!flags || flags.length === 0) return '';
  return flags
    .map((f) => `- **[${f.severity.toUpperCase()}]** ${f.issue}: ${f.whyItMatters}`)
    .join('\n');
}
