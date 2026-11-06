/**
 * The wire protocol between the graph and the chat client.
 *
 * Deliberately client-safe: no provider imports, so a 'use client' component
 * can import these types without dragging ChatOpenAI into the bundle.
 *
 * Contract fields (R2) are additive. A client that ignores `index`, `attempt`,
 * `apiError`, and the `retry` event keeps working. Close `status` stays
 * `SectionStatus` so the existing stream reader can store it. The bridge also
 * writes the contract statuses `failed` and `retrying` on that field.
 */
import type { GatePayload, DesignContract } from '@/types';
import type { ApiError, RunStatus } from '@/lib/contract/run-contract';
import type { SectionStatus } from './transcript';

export type StreamEvent =
  | {
      t: 'section';
      id: string;
      label: string;
      state: 'open';
      /** PIPELINE_STEPS position, or -1 when the node is not in the pipeline. */
      index?: number;
      startedAt?: number;
      attempt?: number;
    }
  | {
      t: 'section';
      id: string;
      state: 'close';
      status: SectionStatus;
      summary?: string;
      endedAt?: number;
      durationMs?: number;
      attempt?: number;
    }
  /** Markdown appended to whichever section is currently open. */
  | { t: 'delta'; text: string }
  | { t: 'gate'; id: string; runId: string; payload: GatePayload; /** epoch ms after which the server may delete the paused run (now + CADAI_CHECKPOINT_TTL_MS) */ expiresAt?: number }
  /** Terminal for a completed run. `summary` becomes ChatMessage.content. */
  | { t: 'result'; summary: string; code?: string; stl?: string; /** base64 STEP, B-rep kernel only */ step?: string; /** language of `code`; absent means OpenSCAD */ language?: 'build123d'; designContract?: DesignContract }
  | { t: 'error'; message: string; apiError?: ApiError }
  /** A step is being re-run. `attempt` is the attempt that is starting. */
  | { t: 'retry'; step: string; attempt: number; maxAttempts: number; reason: string }
  /** R1 emits this. The variant is here so the unions merge. */
  | { t: 'run'; runId: string; threadId: string; status: RunStatus; resumed: boolean }
  | { t: 'cancelled'; at: number };
