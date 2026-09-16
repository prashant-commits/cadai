/**
 * The wire protocol between the graph and the chat client.
 *
 * Deliberately client-safe: no provider imports, so a 'use client' component
 * can import these types without dragging ChatOpenAI into the bundle.
 */
import type { GatePayload, DesignContract } from '@/types';
import type { SectionStatus } from './transcript';

export type StreamEvent =
  | { t: 'section'; id: string; label: string; state: 'open' }
  | { t: 'section'; id: string; state: 'close'; status: SectionStatus; summary?: string }
  /** Markdown appended to whichever section is currently open. */
  | { t: 'delta'; text: string }
  | { t: 'gate'; id: string; runId: string; payload: GatePayload }
  /** Terminal for a completed run. `summary` becomes ChatMessage.content. */
  | { t: 'result'; summary: string; code?: string; stl?: string; designContract?: DesignContract }
  | { t: 'error'; message: string };
