/**
 * TEMPORARY STUB for task/dz-graph.
 *
 * This file is being written in parallel by the core lane (task/dz-core).
 * The orchestrator should replace/drop this file when merging task/dz-core.
 */
import type { RunDesignerFn } from './types';

export const runDesigner: RunDesignerFn = async (input) => {
  return {
    script: input.priorScript ?? '',
    facts: {
      ok: true,
      parts: [],
      interferences: [],
      disconnected: [],
      dimensions: [],
    },
    summary: 'Model built successfully.',
    reviewerFlags: [],
    turns: 1,
    costUsd: 0,
  };
};
