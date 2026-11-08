/**
 * Shared contract for the designer-mode eval tooling (see
 * docs/superpowers/plans/2026-11-08-designer-evals.md).
 *
 * Ownership (parallel lanes; do not edit another lane's files):
 *   - sets + dimension metrics (Gemini): eval/designer/sets/**, eval/designer/metrics/dimensions.ts, eval/designer/baselines/**
 *   - runner + fidelity metrics (Sonnet): eval/designer/runner.ts, eval/designer/metrics/fidelity.ts
 *   - report + blind page      (Grok):   eval/designer/report.ts, eval/designer/blind.ts
 * Change this file only by agreement (the orchestrator merges).
 */
import type { DesignerFacts, ReviewFlag } from '../../src/lib/agent/designer/types';

export type SetName = 'open' | 'prescriptive' | 'mechanism' | 'edits' | 'iterative' | 'adversarial';
export type Arm = 'designer' | 'reviewer'; // reviewer = designer + live reviewer

/** How to check that a follow-up feature landed, from measured facts (before vs after). */
export interface FeatureProbe {
  kind:
    | 'newPart'          // a part whose label matches `label` (regex, case-insensitive) appears
    | 'partCountUp'      // total part count increases by at least `min` (default 1)
    | 'dimensionChange'  // named dimension `dimension` (regex) changes by about `deltaMm` (± tolerance) or by `ratio`
    | 'spanChange'       // assembly span on `axis` changes by about `deltaMm` (± tolerance) or by `ratio`
    | 'moves'            // a pose parameter (`*_deg` / `*_travel`) exists afterwards
    | 'reviewer';        // no geometric probe possible: ask the reviewer on renders with `question`
  label?: string;
  dimension?: string;
  axis?: 'x' | 'y' | 'z';
  deltaMm?: number;
  ratio?: number;
  min?: number;
  tolerance?: number; // mm, default 2
  question?: string;
}

export type FollowUpKind = 'cut' | 'part' | 'mechanism' | 'global' | 'conflict' | 'edit';

export interface FollowUp {
  text: string;
  kind: FollowUpKind;
  probe: FeatureProbe;
}

/** A dimension the request states, for conformance checks. */
export interface StatedDim {
  what: string;            // human label, e.g. "box height"
  mm: number;
  axis?: 'x' | 'y' | 'z';  // when the request fixes an axis
  part?: string;           // label regex of the part it applies to, when known
}

export interface EvalPrompt {
  id: string;
  set: SetName;
  request: string;
  /** edits / iterative sets: sent one at a time as chat follow-ups on the same thread. */
  followUps?: FollowUp[];
  /** Filled by the dimension parser (or by hand) for prescriptive prompts. */
  statedDims?: StatedDim[];
  /** adversarial set: the build must not run unsafe code; an honest refusal or a safe design both pass. */
  adversarial?: { attack: string };
}

export interface StepRecord {
  step: number;               // 0 = the initial request, 1.. = follow-ups
  text: string;               // the message sent
  script: string;             // final accepted script after this step ('' when none)
  facts: DesignerFacts | null;
  stlPath?: string;           // relative to the run dir
  stepPath?: string;
  costUsd: number;
  wallMs: number;
  turns: number;
  capped?: 'turns' | 'wall' | 'cost';
  failed?: boolean;
  checkFailures?: string | null;
  reviewerFlags: Array<ReviewFlag & { round: number; final: boolean }>;
  /** Rendered user-visible stream text (no raw model output), for audit. */
  transcript?: string;
  /** sha256 (hex) of input.priorScript on the step's first designer call; null when that call had no prior script. */
  priorScriptSha?: string | null;
}

export interface RunRecord {
  tag: string;
  arm: Arm;
  promptId: string;
  set: SetName;
  sample: number;
  model: string;
  startedAt: string;
  steps: StepRecord[];
  error?: string;
}

/** One row of computed metrics per run (report.ts aggregates them). */
export interface MetricRow {
  tag: string;
  arm: Arm;
  promptId: string;
  set: SetName;
  sample: number;
  hardChecksPass: boolean;             // final step: ok, valid, no disconnected, no interference
  costUsd: number;                     // all steps
  wallMs: number;                      // all steps
  capped: boolean;                     // any step capped
  namedDimCoverage?: number | null;    // 0..1 (dimensions.ts)
  statedDimConformance?: number | null;// 0..1 (dimensions.ts)
  featureLanded?: number | null;       // 0..1 over follow-up steps (fidelity.ts)
  earlierKept?: number | null;         // 0..1 over follow-up steps (fidelity.ts)
  locality?: number | null;            // 0..1 share of untouched named dimensions unchanged (fidelity.ts)
  reviewerFlagsFixed?: number | null;  // 0..1 blocking/major flags not repeated at the final review (report.ts)
  safe?: boolean | null;               // adversarial: no guardrail bypass, no unsafe run
}

export const SEED = 20261108;
