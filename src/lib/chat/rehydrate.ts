import type { ChatMessage, GateDecision, GatePayload, GateRecord } from '@/types';

/** Matches the server checkpoint default. The browser cannot read CADAI_CHECKPOINT_TTL_MS. */
export const GATE_TTL_MS = 24 * 60 * 60 * 1000;

export const EXPIRED_GATE_MESSAGE = 'This paused run expired - send the request again';

export interface ResumableGate {
  messageId: string;
  runId: string;
  gate: GatePayload;
  /** True when the open gate is older than 24 h. Deny can still close it. */
  expired: boolean;
}

/** `openedAt` lives on the record even though GateRecord does not declare it. */
export function readOpenedAt(record: GateRecord): number | undefined {
  const raw = (record as { openedAt?: unknown }).openedAt;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

export function withOpenedAt(record: GateRecord, openedAt: number): GateRecord {
  if (readOpenedAt(record) === openedAt) return record;
  return Object.assign({}, record, { openedAt });
}

/** Stamp a missing openedAt from the message timestamp. A present stamp is left alone. */
export function ensureGateOpenedAt(message: ChatMessage): ChatMessage {
  if (!message.gates) return message;
  let changed = false;
  const gates: Record<string, GateRecord> = {};
  for (const [id, record] of Object.entries(message.gates)) {
    if (readOpenedAt(record) === undefined) {
      gates[id] = withOpenedAt(record, message.timestamp);
      changed = true;
    } else {
      gates[id] = record;
    }
  }
  return changed ? { ...message, gates } : message;
}

/**
 * The gate a reloaded thread can still answer.
 *
 * A gate is where a human walks away from the screen, so it has to survive a
 * reload: the record and runId are persisted with the message, and the server
 * checkpoint is keyed threadId::runId. Without a runId there is no checkpoint
 * to address, so such a gate is not offered rather than posting a request the
 * server will reject. An open gate older than 24 h is still returned, with
 * `expired` set, so the dock can explain that and offer Deny.
 */
export function resumableGate(messages: ChatMessage[], now = Date.now()): ResumableGate | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.gates || !m.runId) continue;
    for (const record of Object.values(m.gates)) {
      if (record.status !== 'open') continue;
      const openedAt = readOpenedAt(record) ?? m.timestamp;
      return {
        messageId: m.id,
        runId: m.runId,
        gate: record.payload,
        expired: now - openedAt > GATE_TTL_MS,
      };
    }
  }
  return null;
}

/**
 * Close an expired gate locally. The checkpoint is already gone, so Deny must
 * not resume it. A blank message gets the expiry note so the bubble stays readable.
 */
export function closedExpiredGateUpdate(message: ChatMessage, now = Date.now()): Partial<ChatMessage> {
  const gates = { ...(message.gates ?? {}) };
  const openId = Object.keys(gates).find((id) => gates[id].status === 'open');
  if (openId) {
    gates[openId] = {
      ...gates[openId],
      decision: { action: 'cancel' },
      decidedAt: now,
      status: 'denied',
    };
  }
  const content = message.content?.trim() ? message.content : EXPIRED_GATE_MESSAGE;
  return { gates, status: 'complete', content };
}

/**
 * IndexedDB keeps the chosen sheet only. Every other variant's `sheetSvg`
 * becomes null. A legacy payload has no `variants` array, so it is returned
 * unchanged. Open gates are not passed through here: a reload must still
 * show every sheet.
 */
export function stripUnchosenSheets(payload: GatePayload, decision: GateDecision): GatePayload {
  if (payload.kind !== 'spec' || !payload.variants || payload.variants.length === 0) return payload;
  const keep = decision.chosenVariantId ?? payload.recommendedId;
  return {
    ...payload,
    variants: payload.variants.map((variant) =>
      variant.id === keep ? variant : { ...variant, sheetSvg: null },
    ),
  };
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
