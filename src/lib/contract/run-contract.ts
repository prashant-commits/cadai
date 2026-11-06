/**
 * The server <-> client run contract (2026-11-07). Client-safe: types only, no
 * runtime imports. Server lanes R1 (run control), R2 (events and errors) and R3
 * (artifacts by reference) implement it; the UI builds against it.
 *
 * Compatibility: every existing StreamEvent field keeps its meaning. New fields
 * are additive, so a client that ignores them keeps working.
 */

/** Stable machine-readable error codes. Never parse `message`. */
export type ErrorCode =
  | 'bad_request' //        the request body is invalid (missing messages, bad JSON)
  | 'not_found' //          unknown runId / artifactId
  | 'run_expired' //        the paused run's checkpoint is gone (TTL or evicted)
  | 'run_conflict' //       resume of a run that is not paused, or cancel of a finished run
  | 'cancelled' //          the user stopped the run
  | 'model_unavailable' //  the model provider refused or is overloaded (retryable)
  | 'model_error' //        the model call failed or returned unusable output
  | 'timeout' //            a step or the whole run exceeded its time budget
  | 'compile_failed' //     OpenSCAD failed to compile the script
  | 'geometry_failed' //    the B-rep geometry service failed to run the script
  | 'geometry_unavailable' // the geometry service is unreachable (retryable)
  | 'internal';

/** The one error shape, in JSON responses and in the `error` stream event. */
export interface ApiError {
  code: ErrorCode;
  message: string; //           human-readable, safe to show
  detail?: string; //           e.g. the traceback tail; may be long; never secrets
  retryable?: boolean;
}

/** JSON error body of every route (status 4xx/5xx). `error` stays a string for old clients. */
export interface ErrorBody {
  error: string; //             === apiError.message
  apiError: ApiError;
}

export type RunStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

/** GET /api/runs/:runId */
export interface RunInfo {
  runId: string;
  threadId: string;
  status: RunStatus;
  startedAt: number; //         epoch ms
  updatedAt: number;
  lastSeq: number; //           highest event seq stored
  expiresAt?: number; //        paused runs: when the checkpoint may be deleted
  error?: ApiError; //          failed / cancelled
}

/** Fields added to EVERY stream event (R1). */
export interface EventEnvelope {
  seq: number; //               1, 2, 3 ... per run; replay with ?after=seq
  ts: number; //                epoch ms when emitted
}

/** Reference to a large payload served by GET /api/artifacts/:id (R3). */
export interface ArtifactRef {
  id: string;
  kind: 'stl' | 'step' | 'svg' | 'png' | 'scad' | 'py';
  bytes: number;
  sha256: string;
  url: string; //               relative, e.g. /api/artifacts/abc123
}

/** Measurement of one part (R2): from the geometry service, or measured frames on OpenSCAD. */
export interface PartInfo {
  label: string;
  valid: boolean;
  volume: number;
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * New / extended stream events. These EXTEND the existing StreamEvent union in
 * src/lib/agent/stream-events.ts (R2 merges them there):
 *  - `run` is always the first event of a stream (also on resume and replay).
 *  - section open/close gain timing, step index, attempt and a failed status.
 *  - `retry` announces that a step is being re-run and why.
 *  - `error` gains `apiError`; `message` stays for old clients.
 *  - `result` and `gate` gain artifact refs; the inline stl/step/svg fields remain
 *    only while CADAI_INLINE_PAYLOADS=1 (default off after R3).
 */
export type ContractEvent =
  | { t: 'run'; runId: string; threadId: string; status: RunStatus; resumed: boolean }
  | { t: 'section'; id: string; label: string; state: 'open'; index: number; startedAt: number; attempt: number }
  | {
      t: 'section'; id: string; state: 'close';
      status: 'ok' | 'failed' | 'skipped' | 'retrying';
      summary?: string; //    always set when status is failed or retrying
      endedAt: number; durationMs: number; attempt: number;
    }
  | { t: 'retry'; step: string; attempt: number; maxAttempts: number; reason: string }
  | { t: 'error'; message: string; apiError: ApiError }
  | { t: 'cancelled'; at: number };

/** Ordered pipeline steps, for index/total in the UI. Unknown nodes get index -1. */
export const PIPELINE_STEPS = [
  'architectNode', 'specIllustrator', 'specReviewer', 'specGate',
  'architectBuild', 'brepBuild', 'drafterNode', 'validateCode', 'validateBrep',
  'fixCode', 'visualCritic', 'acceptGate', 'respondToUser',
] as const;
