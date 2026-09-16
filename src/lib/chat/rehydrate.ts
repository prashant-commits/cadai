import type { ChatMessage, GatePayload } from '@/types';

export interface ResumableGate {
  messageId: string;
  runId: string;
  gate: GatePayload;
}

/**
 * The gate a reloaded thread can still answer.
 *
 * A gate is where a human walks away from the screen, so it has to survive a
 * reload: the record and runId are persisted with the message, and the server
 * checkpoint is keyed threadId::runId. Without a runId there is no checkpoint
 * to address, so such a gate is not offered rather than posting a request the
 * server will reject.
 */
export function resumableGate(messages: ChatMessage[]): ResumableGate | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.gates || !m.runId) continue;
    for (const record of Object.values(m.gates)) {
      if (record.status === 'open') {
        return { messageId: m.id, runId: m.runId, gate: record.payload };
      }
    }
  }
  return null;
}

/**
 * Freezes any message the page was still streaming when it went away.
 *
 * Rejoining a live generation would need a server-side run registry and replay
 * buffer, which per-instance /tmp checkpoints would undermine anyway. Saying so
 * plainly beats leaving a bubble that looks like it is still thinking.
 */
export function freezeStreamingMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.status === 'streaming'
      ? {
          ...m,
          status: 'interrupted' as const,
          content: m.content?.trim()
            ? m.content
            : '_This run was interrupted before it finished. Send the request again to retry._',
        }
      : m
  );
}
