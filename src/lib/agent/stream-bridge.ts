import type { GatePayload } from '@/types';
import { PIPELINE_STEPS } from '@/lib/contract/run-contract';
import { toApiError } from '@/lib/contract/api-error';
import type { StreamEvent } from './stream-events';
import type { SectionStatus } from './transcript';
import { checkpointTtlMs } from './checkpointer';

/** Human labels for graph nodes. An unlisted node falls back to its own id. */
export const NODE_LABELS: Record<string, string> = {
  architectNode: 'Mechanical Architect',
  architectBuild: 'Mechanical Architect · Build',
  brepBuild: 'Mechanical Architect · Build (build123d)',
  specIllustrator: 'Concept Sheets',
  specReviewer: 'Sheet Reviewer',
  specGate: 'Spec Review',
  drafterNode: 'Parametric Drafter',
  validateCode: 'Physical Validator',
  validateBrep: 'Physical Validator (build123d)',
  fixCode: 'Repair',
  visualCritic: 'Design Inspector',
  acceptGate: 'Model Review',
  respondToUser: 'Result',
};

/**
 * Nodes whose `messages`-mode chunks must never reach the UI: structured-output
 * JSON, and the Architect's raw `@body` build reply (OpenSCAD or build123d), and the
 * B-rep validator's `[Validation Report]` message. The structured nodes render
 * their own markdown over `custom`.
 */
const STRUCTURED_NODES = new Set(['architectNode', 'specReviewer', 'visualCritic', 'architectBuild', 'brepBuild', 'validateBrep']);

type CustomPayload = StreamEvent & { node?: string };
type CloseStatus = 'ok' | 'failed' | 'retrying' | 'skipped';

interface OpenSection {
  id: string;
  attempt: number;
  startedAt: number;
  failed: string | null;
}

interface PendingRetry {
  step: string;
  maxAttempts: number;
  reason: string;
}

/**
 * Translates langgraph's [mode, payload] tuples into the client's event union.
 *
 * Shapes verified by spike against langgraph 1.4.12: `custom` yields the bare
 * payload, `messages` yields [chunk, metadata] with metadata.langgraph_node,
 * and an interrupt arrives as ['updates', { __interrupt__: [{ id, value }] }].
 * A node's return value arrives as ['updates', { nodeName: partialState }].
 */
export async function bridgeGraphStream(
  chunks: AsyncIterable<unknown>,
  runId: string,
  emit: (event: StreamEvent) => void
): Promise<void> {
  // A property, not a `let`: closures assign it, and control-flow analysis then
  // narrows the binding to `never` at the loop.
  const slot = { open: null as OpenSection | null };
  const attempts = new Map<string, number>();
  let pendingRetry: PendingRetry | null = null;
  let pipeline: 'drafter' | 'architect' | null = null;
  let kernel: 'openscad' | 'brep' | null = null;
  let rememberedMax = positive(process.env.CADAI_MAX_ATTEMPTS, 1);

  function stepIndex(id: string): number {
    const index = (PIPELINE_STEPS as readonly string[]).indexOf(id);
    return index < 0 ? -1 : index;
  }

  function finish(status: CloseStatus, summary?: string) {
    if (!slot.open) return;
    const endedAt = Date.now();
    const needsSummary = status === 'failed' || status === 'retrying';
    const line = needsSummary ? oneLine(summary || (status === 'failed' ? 'failed' : 'retrying')) : summary ? oneLine(summary) : undefined;
    emit({
      t: 'section',
      id: slot.open.id,
      state: 'close',
      // `failed` and `retrying` are contract statuses. SectionStatus is what the
      // stream reader stores; the wire value is the string we pass here.
      status: status as SectionStatus,
      endedAt,
      durationMs: Math.max(0, endedAt - slot.open.startedAt),
      attempt: slot.open.attempt,
      ...(line ? { summary: line } : {}),
    });
    slot.open = null;
  }

  function openFor(node: string, attempt?: number) {
    const next = attempt ?? (attempts.get(node) ?? 0) + 1;
    if (attempt === undefined && slot.open?.id === node) return;
    if (slot.open) {
      const failed = slot.open.failed;
      finish(failed ? 'failed' : 'ok', failed ?? undefined);
    }
    attempts.set(node, next);
    const startedAt = Date.now();
    slot.open = { id: node, attempt: next, startedAt, failed: null };
    emit({
      t: 'section',
      id: node,
      label: NODE_LABELS[node] ?? node,
      state: 'open',
      index: stepIndex(node),
      startedAt,
      attempt: next,
    });
  }

  function begin(node: string) {
    if (pendingRetry?.step === node) {
      const pending = pendingRetry;
      pendingRetry = null;
      const attempt = (attempts.get(node) ?? 0) + 1;
      if (slot.open) {
        const failed = slot.open.failed;
        const same = slot.open.id === node;
        finish(same ? 'retrying' : failed ? 'failed' : 'ok', same ? pending.reason : failed ?? undefined);
      }
      emit({ t: 'retry', step: node, attempt, maxAttempts: pending.maxAttempts, reason: pending.reason });
      openFor(node, attempt);
      return;
    }
    openFor(node);
  }

  function remember(state: Record<string, unknown>) {
    if (state.pipeline === 'architect' || state.pipeline === 'drafter') pipeline = state.pipeline;
    if (state.kernel === 'brep' || state.kernel === 'openscad') kernel = state.kernel;
    if (typeof state.maxAttempts === 'number' && state.maxAttempts > 0) rememberedMax = state.maxAttempts;
  }

  function repairTarget(): string {
    if (pipeline === 'architect') return kernel === 'brep' ? 'brepBuild' : 'architectBuild';
    return 'fixCode';
  }

  function maxFor(target: string, state: Record<string, unknown>): number {
    if (target === 'architectNode') return positive(process.env.CADAI_SPEC_REVIEW_RETRIES, 5) + 1;
    if (typeof state.maxAttempts === 'number' && state.maxAttempts > 0) return state.maxAttempts;
    return rememberedMax;
  }

  function onNodeUpdate(node: string, state: Record<string, unknown>) {
    remember(state);
    const summary = errorSummary(state);
    const back = routeBackTo(node, state, repairTarget);

    if (pendingRetry?.step === node) {
      begin(node);
      if (slot.open && summary) slot.open.failed = oneLine(summary);
      return;
    }

    if (back && slot.open?.id === back && node !== back) {
      const reason = oneLine(summary ?? 'retrying');
      finish('retrying', reason);
      pendingRetry = { step: back, maxAttempts: maxFor(back, state), reason };
      openFor(node);
      finish('failed', oneLine(summary ?? 'failed'));
      return;
    }

    if (back) {
      pendingRetry = { step: back, maxAttempts: maxFor(back, state), reason: oneLine(summary ?? reviewReason(state)) };
    }

    if (!slot.open || slot.open.id !== node) begin(node);
    if (slot.open && summary) slot.open.failed = oneLine(summary);
  }

  try {
    for await (const chunk of chunks) {
      if (!Array.isArray(chunk) || chunk.length < 2) continue;
      const [mode, payload] = chunk as [string, unknown];

      if (mode === 'custom') {
        const p = payload as CustomPayload;
        if (p.t === 'delta') {
          begin(p.node ?? 'agent');
          emit({ t: 'delta', text: p.text });
        } else if (p.t === 'retry') {
          const reason = oneLine(p.reason);
          if (slot.open?.id === p.step) finish('retrying', reason);
          else if (slot.open) finish(slot.open.failed ? 'failed' : 'ok', slot.open.failed ?? undefined);
          emit({ t: 'retry', step: p.step, attempt: p.attempt, maxAttempts: p.maxAttempts, reason });
          openFor(p.step, p.attempt);
        } else if (p.t === 'result') {
          if (slot.open) finish(slot.open.failed ? 'failed' : 'ok', slot.open.failed ?? undefined);
          const { node: _node, ...rest } = p;
          emit(rest as StreamEvent);
        } else if (p.t === 'error') {
          const apiError = p.apiError ?? toApiError(new Error(p.message));
          if (slot.open) finish('failed', failureSummary(p.message));
          emit({ t: 'error', message: p.message, apiError });
        }
        continue;
      }

      if (mode === 'messages') {
        const [msg, meta] = payload as [{ content?: unknown }, { langgraph_node?: string }];
        const text = typeof msg?.content === 'string' ? msg.content : '';
        if (!text) continue;
        if (STRUCTURED_NODES.has(meta?.langgraph_node ?? '')) continue;
        begin(meta?.langgraph_node ?? 'agent');
        emit({ t: 'delta', text });
        continue;
      }

      if (mode === 'updates') {
        const upd = payload as Record<string, unknown>;
        const interrupts = upd.__interrupt__ as Array<{ id: string; value: unknown }> | undefined;
        if (interrupts?.length) {
          if (slot.open) finish(slot.open.failed ? 'failed' : 'ok', slot.open.failed ?? undefined);
          for (const i of interrupts) {
            emit({ t: 'gate', id: i.id, runId, payload: i.value as GatePayload, expiresAt: Date.now() + checkpointTtlMs() });
          }
          continue;
        }
        for (const [node, partial] of Object.entries(upd)) {
          if (node === '__interrupt__' || !partial || typeof partial !== 'object') continue;
          onNodeUpdate(node, partial as Record<string, unknown>);
        }
      }
    }
  } catch (err) {
    if (slot.open) finish('failed', failureSummary(err));
    throw err;
  }

  if (slot.open) finish(slot.open.failed ? 'failed' : 'ok', slot.open.failed ?? undefined);
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function oneLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? text.trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

function failureSummary(err: unknown): string {
  const api = toApiError(err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'failed'));
  if (api.code === 'model_unavailable' || api.code === 'model_error' || api.code === 'timeout') return api.message;
  return oneLine(api.message || 'failed');
}

function errorSummary(state: Record<string, unknown>): string | null {
  if (Array.isArray(state.specViolations)) {
    for (const violation of state.specViolations) {
      if (!violation || typeof violation !== 'object') continue;
      const rec = violation as { severity?: unknown; message?: unknown };
      if (rec.severity === 'error' && typeof rec.message === 'string' && rec.message.trim()) return rec.message.trim();
    }
  }
  if (state.validation && typeof state.validation === 'object') {
    const validation = state.validation as { errors?: unknown; valid?: unknown; error?: unknown };
    if (Array.isArray(validation.errors)) {
      for (const diagnostic of validation.errors) {
        if (!diagnostic || typeof diagnostic !== 'object') continue;
        const rec = diagnostic as { severity?: unknown; message?: unknown };
        if (rec.severity === 'error' && typeof rec.message === 'string' && rec.message.trim()) return rec.message.trim();
      }
    }
    if (validation.valid === false && typeof validation.error === 'string' && validation.error.trim()) return validation.error.trim();
  }
  if (typeof state.error === 'string' && state.error.trim()) return state.error.trim();
  if (state.isValid === false && typeof state.failureKind === 'string' && state.failureKind !== 'none') {
    return state.failureKind.replaceAll('_', ' ');
  }
  return null;
}

function reviewReason(state: Record<string, unknown>): string {
  if (!Array.isArray(state.specVariants)) {
    if (typeof state.gateFeedback === 'string' && state.gateFeedback.trim()) return state.gateFeedback.trim();
    return 'revision required';
  }
  for (const variant of state.specVariants) {
    if (!variant || typeof variant !== 'object') continue;
    const rec = variant as { needsRevision?: unknown; review?: { findings?: Array<{ severity?: string; issue?: string }> } };
    if (!rec.needsRevision) continue;
    const findings = rec.review?.findings ?? [];
    const finding = findings.find((item) => item.severity === 'major' && item.issue) ?? findings.find((item) => item.issue);
    if (finding?.issue) return finding.issue;
  }
  if (typeof state.gateFeedback === 'string' && state.gateFeedback.trim()) return state.gateFeedback.trim();
  return 'revision required';
}

/** The node a finished step will route back to, or null when the run moves on. */
function routeBackTo(
  node: string,
  state: Record<string, unknown>,
  repairTarget: () => string,
): string | null {
  if (node === 'specReviewer') {
    const variants = Array.isArray(state.specVariants) ? state.specVariants : [];
    return variants.some((variant) => Boolean(variant && typeof variant === 'object' && (variant as { needsRevision?: unknown }).needsRevision))
      ? 'architectNode'
      : null;
  }
  if (node === 'specGate' && state.gateAction === 'revise') return 'architectNode';
  if ((node === 'validateCode' || node === 'validateBrep') && willRepair(state)) return repairTarget();
  if (node === 'acceptGate' && state.gateAction === 'revise') return repairTarget();
  return null;
}

/** Mirrors checkValidationRoute's budget: an error with attempts left goes back to the builder. */
function willRepair(state: Record<string, unknown>): boolean {
  if (!errorSummary(state)) return false;
  const failureKind = typeof state.failureKind === 'string' ? state.failureKind : 'none';
  const isValid = state.isValid === true;
  const attemptCount = typeof state.attemptCount === 'number' ? state.attemptCount : 0;
  const maxAttempts = typeof state.maxAttempts === 'number' ? state.maxAttempts : 1;
  const semanticFailures = typeof state.semanticFailures === 'number' ? state.semanticFailures : 0;
  const isDone =
    (failureKind === 'none' && isValid) ||
    attemptCount >= maxAttempts ||
    (failureKind === 'semantic' && semanticFailures > 1);
  return !isDone;
}
