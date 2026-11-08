/**
 * Shared contract for the designer pipeline.
 *
 * One agent (the designer) writes a whole build123d script, runs it, looks at
 * renders and revises; an independent reviewer (separate model instance) sees
 * only the request, the renders and the measured facts, and returns flags.
 *
 * Ownership (parallel lanes; do not edit another lane's files):
 *   - designer loop  (Sonnet lane): designer/run-designer.ts, designer/prompt.ts, designer/tools.ts
 *   - reviewer       (Grok lane):   designer/reviewer.ts
 *   - graph wiring   (Gemini lane): graph.ts routing, designer/node.ts, designer/check.ts
 * This file is the contract all three build against. Change it only by agreement
 * (the orchestrator merges changes).
 */

/** Measured facts about one run of a designer script (from runBrep). */
export interface DesignerFacts {
  ok: boolean;
  /** Short, redacted error text when ok is false. Never raw tracebacks. */
  error?: string;
  parts: Array<{ label: string; size: [number, number, number]; valid: boolean }>;
  /** Closed-pose (default parameter values) pairwise interferences. */
  interferences: Array<{ a: string; b: string; volume: number }>;
  /** Labels of parts not touching any other part; 'not checked' above the part cap. */
  disconnected: string[] | 'not checked';
  /** Top-level named dimensions found in the script (`name = number` lines). */
  dimensions: Array<{ name: string; value: number }>;
  /** Assembly bounding-box span in mm. */
  span?: [number, number, number];
}

export interface RenderImage {
  /** e.g. 'iso', 'front', 'right', 'top', 'back_iso', or 'open:<param>=<value>' for a pose. */
  view: string;
  /** data:image/png;base64,... */
  dataUrl: string;
}

export type FlagSeverity = 'blocking' | 'major' | 'minor';

export interface ReviewFlag {
  severity: FlagSeverity;
  /** Concrete, use-level problem ("tablet tips forward: its centre of mass is in front of the base"). */
  issue: string;
  whyItMatters: string;
}

export interface ReviewInput {
  request: string;
  images: RenderImage[];
  facts: DesignerFacts;
  /** true at finish: blocking flags then reject the finish. */
  final: boolean;
  signal?: AbortSignal;
  buildId?: string;
}

export interface ReviewOutput {
  /** At most 3, most severe first. Empty when nothing is wrong. */
  flags: ReviewFlag[];
  costUsd: number;
}

export type ReviewFn = (input: ReviewInput) => Promise<ReviewOutput>;

export interface DesignerInput {
  /** The user's request (first turn) — always present. */
  request: string;
  /** For a follow-up edit: the current accepted script and the user's edit message. */
  priorScript?: string;
  editRequest?: string;
  buildId?: string;
}

/** Progress lines for the UI. Fixed, rendered phrases only — never raw model text, code or tool JSON. */
export type DesignerEvent =
  | { kind: 'step'; text: string }              // "Built the model (3 parts)", "Rendered 4 views", "Revising: …"
  | { kind: 'review'; flags: ReviewFlag[]; final: boolean }
  | { kind: 'note'; text: string };             // budget/cap notes

export interface DesignerDeps {
  /** Omit to run without a reviewer. */
  review?: ReviewFn;
  signal?: AbortSignal;
  onEvent?: (e: DesignerEvent) => void;
  /** Model id; default is the app default (Sonnet 5.5 on feat/brep). */
  model?: string;
}

export interface DesignerResult {
  /** Final accepted script (guardrail-checked), or the last good one when capped. */
  script: string;
  facts: DesignerFacts;
  /** The designer's own short summary for the user (rendered as markdown by the graph). */
  summary: string;
  reviewerFlags: Array<ReviewFlag & { round: number; final: boolean }>;
  turns: number;
  costUsd: number;
  /** Set when a budget cap ended the loop: 'turns' | 'wall' | 'cost'. */
  capped?: 'turns' | 'wall' | 'cost';
  /** True when no script ever passed the hard checks. */
  failed?: boolean;
}

export type RunDesignerFn = (input: DesignerInput, deps: DesignerDeps) => Promise<DesignerResult>;
