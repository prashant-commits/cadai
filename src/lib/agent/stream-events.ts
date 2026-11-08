/**
 * The wire protocol between the graph and the chat client.
 *
 * Deliberately client-safe: no provider imports, so a 'use client' component
 * can import these types without dragging ChatAnthropic into the bundle.
 *
 * Contract fields (R2) are additive. A client that ignores `index`, `attempt`,
 * `apiError`, and the `retry` event keeps working. Close `status` stays
 * `SectionStatus` so the existing stream reader can store it. The bridge also
 * writes the contract statuses `failed`, `retrying`, and `skipped` on that field.
 */
import type { EndEvent, RunStatus } from '@/lib/persist/types';
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
  /** A step is being re-run. `attempt` is the attempt that is starting. */
  | { t: 'retry'; step: string; attempt: number; maxAttempts: number; reason: string }
  /** R1 emits this. The variant is here so the unions merge. */
  | { t: 'run'; runId: string; threadId: string; status: RunStatus; resumed: boolean }
  | EndEvent
  | { t: 'cost'; usd: number };
