/**
 * The wire protocol between the graph and the chat client.
 *
 * Deliberately client-safe: no provider imports, so a 'use client' component
 * can import these types without dragging ChatAnthropic into the bundle.
 */
import type { GatePayload, DesignContract } from '@/types';
import type { SectionStatus } from './transcript';
import type { GateArtifacts, ResultArtifacts } from '@/lib/contract/run-contract';

export type StreamEvent =
  | { t: 'section'; id: string; label: string; state: 'open' }
  | { t: 'section'; id: string; state: 'close'; status: SectionStatus; summary?: string }
  /** Markdown appended to whichever section is currently open. */
  | { t: 'delta'; text: string }
  | { t: 'gate'; id: string; runId: string; payload: GatePayload; /** epoch ms after which the server may delete the paused run (now + CADAI_CHECKPOINT_TTL_MS) */ expiresAt?: number; /** refs to the payload's large fields (R3) */ artifacts?: GateArtifacts }
  /** Terminal for a completed run. `summary` becomes ChatMessage.content. */
  | { t: 'result'; summary: string; code?: string; stl?: string; /** base64 STEP, B-rep kernel only */ step?: string; /** language of `code`; absent means OpenSCAD */ language?: 'build123d'; designContract?: DesignContract; /** refs to stl / step (R3); the inline fields above exist only while CADAI_INLINE_PAYLOADS=1 */ artifacts?: ResultArtifacts }
  | { t: 'error'; message: string };
