import type { GatePayload } from '@/types';
import { PIPELINE_STEPS } from '@/lib/contract/run-contract';
import { sanitizeText, toApiError } from '@/lib/contract/api-error';
import type { StreamEvent } from './stream-events';
import type { SectionStatus } from './transcript';
import { checkpointTtlMs } from './checkpointer';
import type { AgentStateType } from './designer/state';
import { routeAfterDesignerCheck } from './designer/graph';
import { contentText } from './message-text';

function nextStep(node: string, state: AgentStateType, _model = ''): string | null {
  switch (node) {
    case 'START':
      return 'designerNode';
    case 'designerCheck':
      return routeAfterDesignerCheck(state);
    default:
      return null;
  }
}

/** Human labels for graph nodes. An unlisted node falls back to its own id when it produces output. */
export const NODE_LABELS: Record<string, string> = {
  architectNode: 'Mechanical Architect',
  architectBuild: 'Mechanical Architect · Build',
  brepBuild: 'Mechanical Architect · Build (build123d)',
  brepAgentBuild: 'Mechanical Architect · Build (build123d agent)',
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
const STRUCTURED_NODES = new Set(['architectNode', 'specReviewer', 'visualCritic', 'architectBuild', 'brepBuild', 'brepAgentBuild', 'validateBrep']);

const DECIDERS = new Set(['specReviewer', 'specGate', 'validateCode', 'validateBrep', 'visualCritic', 'acceptGate']);

/** Re-showing a gate is not a retry. Pending retries are for nodes the graph re-enters. */
const GATES = new Set(['specGate', 'acceptGate']);

/** attemptCount on these updates is that node's own visit number. fixCode's is the global counter. */
const BUILD_NODES = new Set(['architectBuild', 'brepBuild', 'brepAgentBuild', 'drafterNode']);

type CustomPayload = StreamEvent & { node?: string };
type CloseStatus = 'ok' | 'failed' | 'retrying' | 'skipped';

interface Section {
  id: string;
  attempt: number;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  emitted: boolean;
  hadOutput: boolean;
  preferSkipped: boolean;
}

interface PendingRetry {
  step: string;
  maxAttempts: number;
  reason: string;
}

export interface BridgeOptions {
  /** Checkpoint `channel_values` for a resumed run. Attempt counts are derived from it. */
  state?: Record<string, unknown>;
}

/**
 * Translates langgraph's [mode, payload] tuples into the client's event union.
 *
 * Shapes verified against langgraph 1.4: `custom` yields the bare payload,
 * `messages` yields [chunk, metadata], an interrupt arrives as
 * ['updates', { __interrupt__: [{ id, value }] }], a node's return value arrives
 * as ['updates', { nodeName: partialState }], and `tasks` yields a create payload
 * `{name, input}` at start and a result payload `{name, result}` at finish.
 */
export async function bridgeGraphStream(
  chunks: AsyncIterable<unknown>,
  runId: string,
  emit: (event: StreamEvent) => void,
  options?: BridgeOptions,
): Promise<void> {
  const box = {
    current: null as Section | null,
    pending: null as PendingRetry | null,
    state: initialRouteState(),
  };
  const runs = new Map<string, number>();
  const starts = new Map<string, number>();
  seedRuns(options?.state, box.state, runs);

  function send(event: StreamEvent) {
    emit(event);
  }

  function emitClose(section: Section, status: CloseStatus, summary?: string) {
    if (!section.emitted) return;
    emit(closeEvent(section, status, summary));
  }

  function statusOf(section: Section): CloseStatus {
    if (section.summary) return 'failed';
    if (section.preferSkipped && !section.hadOutput) return 'skipped';
    return 'ok';
  }

  function closeCurrent(status?: CloseStatus, summary?: string) {
    const section = box.current;
    if (!section) return;
    box.current = null;
    const chosen = status ?? statusOf(section);
    const line = summary ?? section.summary ?? undefined;
    emitClose(section, chosen, line);
  }

  function leaveFor(next: string) {
    const section = box.current;
    if (!section || section.id === next) return;
    if (!section.emitted) {
      box.current = null;
      return;
    }
    // Close now. Nothing later waits on this close: the next section streams live.
    closeCurrent();
  }

  function emitOpen(section: Section) {
    if (section.emitted) return;
    if (!NODE_LABELS[section.id] && !section.hadOutput) return;
    section.emitted = true;
    send({
      t: 'section',
      id: section.id,
      label: NODE_LABELS[section.id] ?? section.id,
      state: 'open',
      index: stepIndex(section.id),
      startedAt: section.startedAt,
      attempt: section.attempt,
    });
  }

  function enter(node: string, opts?: { partial?: Record<string, unknown>; input?: Record<string, unknown>; attempt?: number }) {
    if (box.current?.id === node && opts?.attempt === undefined) {
      // The open already announced this attempt. Keep it on the close; only the visit counter moves.
      if (BUILD_NODES.has(node) && typeof opts?.partial?.attemptCount === 'number') {
        runs.set(node, Math.max(runs.get(node) ?? 0, opts.partial.attemptCount));
      }
      return;
    }
    leaveFor(node);
    const attempt = opts?.attempt ?? attemptNumber(node, opts?.partial, opts?.input, runs);
    runs.set(node, Math.max(runs.get(node) ?? 0, attempt));
    if (box.pending?.step === node) {
      const pending = box.pending;
      box.pending = null;
      if (attempt >= 2) {
        send({ t: 'retry', step: node, attempt, maxAttempts: pending.maxAttempts, reason: pending.reason });
      }
    }
    const stamped = starts.get(node);
    starts.delete(node);
    const section: Section = {
      id: node,
      attempt,
      startedAt: stamped ?? Date.now(),
      endedAt: null,
      summary: null,
      emitted: false,
      hadOutput: false,
      preferSkipped: false,
    };
    box.current = section;
    emitOpen(section);
  }

  function noteEnd(node: string) {
    if (box.current?.id === node) box.current.endedAt = Date.now();
  }

  function finishOpen(summary: string) {
    if (!box.current) return;
    box.current.summary = box.current.summary ?? summary;
    closeCurrent('failed', box.current.summary ?? summary);
  }

  /** A user abort closes whatever is still open as skipped. The run's own cancelled event carries the code. */
  function closeCancelled() {
    closeCurrent('skipped', 'stopped');
  }

  function applyRoute(node: string, partial: Record<string, unknown>) {
    const next = nextStep(node, box.state, '');
    const reason = oneLine(sanitizeText(routeReason(node, partial, box.state)));
    const revisits = Boolean(next && !GATES.has(next) && (runs.get(next) ?? 0) > 0 && next !== node);
    if (next && revisits) {
      box.pending = { step: next, maxAttempts: stepMax(next, box.state), reason };
      return;
    }
    box.pending = null;
  }

  try {
    for await (const chunk of chunks) {
      if (!Array.isArray(chunk) || chunk.length < 2) continue;
      const [mode, payload] = chunk as [string, unknown];

      if (mode === 'tasks') {
        const task = payload as { name?: unknown; input?: unknown; result?: unknown };
        if (typeof task.name !== 'string' || !task.name) continue;
        if ('result' in task) {
          noteEnd(task.name);
          const result = task.result;
          const empty = result == null || (typeof result === 'object' && !Array.isArray(result) && Object.keys(result as object).length === 0);
          if (box.current?.id === task.name) {
            if (empty && !box.current.hadOutput && !box.current.summary) box.current.preferSkipped = true;
            // The node is done. Close it before anything that follows, so those events are not queued.
            closeCurrent();
          }
          continue;
        }
        starts.set(task.name, Date.now());
        const input = task.input && typeof task.input === 'object' ? task.input as Record<string, unknown> : undefined;
        if (input) mergeDefined(box.state, input);
        enter(task.name, { input });
        continue;
      }

      if (mode === 'custom') {
        const event = payload as CustomPayload;
        if (event.t === 'delta') {
          const node = event.node ?? 'agent';
          enter(node);
          if (box.current?.id === node) {
            box.current.hadOutput = true;
            box.current.preferSkipped = false;
            emitOpen(box.current);
          }
          send({ t: 'delta', text: event.text });
        } else if (event.t === 'retry') {
          const reason = oneLine(sanitizeText(event.reason));
          if (event.variantId) {
            // Parallel variants share one section. Its attempt stays the attempt it opened at.
            if (box.current?.id !== event.step) enter(event.step);
            send({
              t: 'retry',
              step: event.step,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              reason,
              variantId: event.variantId,
            });
          } else {
            // One section per attempt. A reviewer re-entry and an in-node self-check must not reuse a number.
            const previous = box.current?.id === event.step ? box.current.attempt : (runs.get(event.step) ?? 0);
            const attempt = Math.max(event.attempt, previous + 1);
            if (box.current?.id === event.step && box.current.emitted) {
              const prev = box.current;
              box.current = null;
              emit(closeEvent(prev, 'retrying', reason));
            } else if (box.current?.emitted) {
              closeCurrent();
            } else {
              box.current = null;
            }
            emit({
              t: 'retry',
              step: event.step,
              attempt,
              maxAttempts: Math.max(event.maxAttempts, attempt),
              reason,
            });
            runs.set(event.step, Math.max(runs.get(event.step) ?? 0, attempt));
            const stamped = starts.get(event.step);
            starts.delete(event.step);
            const section: Section = {
              id: event.step,
              attempt,
              startedAt: stamped ?? Date.now(),
              endedAt: null,
              summary: null,
              emitted: false,
              hadOutput: false,
              preferSkipped: false,
            };
            box.current = section;
            emitOpen(section);
          }
        } else if (event.t === 'result') {
          if (box.current) closeCurrent();
          const { node, ...rest } = event;
          void node;
          emit(rest);
        } else if (event.t === 'error') {
          const apiError = event.apiError ?? toApiError(new Error(event.message));
          try {
            if (apiError.code === 'cancelled') closeCancelled();
            else finishOpen(apiError.message);
          } catch (emitErr) {
            console.error('bridge close failed:', emitErr);
          }
          emit({ t: 'error', message: event.message, apiError });
        }
        continue;
      }

      if (mode === 'messages') {
        const [msg, meta] = payload as [{ content?: unknown }, { langgraph_node?: string }];
        const text = contentText(msg?.content);
        if (!text) continue;
        const node = meta?.langgraph_node ?? 'agent';
        if (STRUCTURED_NODES.has(node)) continue;
        enter(node);
        if (box.current?.id === node) {
          box.current.hadOutput = true;
          box.current.preferSkipped = false;
          emitOpen(box.current);
        }
        send({ t: 'delta', text });
        continue;
      }

      if (mode === 'updates') {
        const upd = payload as Record<string, unknown>;
        const interrupts = upd.__interrupt__ as Array<{ id: string; value: unknown }> | undefined;
        if (interrupts?.length) {
          if (box.current) closeCurrent();
          for (const item of interrupts) {
            emit({
              t: 'gate',
              id: item.id,
              runId,
              payload: item.value as GatePayload,
              expiresAt: Date.now() + checkpointTtlMs(),
            });
          }
          continue;
        }
        for (const [node, partial] of Object.entries(upd)) {
          if (node === '__interrupt__' || !partial || typeof partial !== 'object' || Array.isArray(partial)) continue;
          const record = partial as Record<string, unknown>;
          mergeDefined(box.state, record);
          if (box.current?.id !== node) enter(node, { partial: record });
          else if (BUILD_NODES.has(node) && typeof record.attemptCount === 'number') {
            runs.set(node, Math.max(runs.get(node) ?? 0, record.attemptCount));
          }
          const summary = failureOf(record);
          if (box.current?.id === node) {
            if (record.isValid === true) box.current.summary = null;
            else if (summary) box.current.summary = oneLine(sanitizeText(summary));
            if (Object.keys(record).length === 0 && !box.current.hadOutput) box.current.preferSkipped = true;
          }
          if (DECIDERS.has(node)) applyRoute(node, record);
        }
      }
    }
  } catch (err) {
    try {
      const api = toApiError(err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'failed'));
      // An illustrator throw closes the illustrator. A section that already finished stays as it closed.
      if (api.code === 'cancelled') closeCancelled();
      else finishOpen(api.message);
    } catch (emitErr) {
      console.error('bridge close failed:', emitErr);
    }
    throw err;
  }

  if (box.current) closeCurrent();
}

function stepIndex(id: string): number {
  const index = (PIPELINE_STEPS as readonly string[]).indexOf(id);
  return index < 0 ? -1 : index;
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function oneLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? text.trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

function initialRouteState(): AgentStateType {
  return {
    messages: [],
    attemptCount: 0,
    maxAttempts: positive(process.env.CADAI_MAX_ATTEMPTS, 1),
    failureKind: 'none',
    isValid: false,
    semanticFailures: 0,
    compileFailures: 0,
    pipeline: null,
    kernel: null,
    specRevisionCount: 0,
    acceptRevisionCount: 0,
    gateAction: null,
    stlContent: null,
    specVariants: [],
    specViolations: [],
    assemblySpec: null,
    reviewDeadline: null,
  } as unknown as AgentStateType;
}

function mergeDefined(state: AgentStateType, partial: Record<string, unknown>) {
  const target = state as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) target[key] = value;
  }
}

function seedRuns(initial: Record<string, unknown> | undefined, state: AgentStateType, runs: Map<string, number>) {
  if (!initial) return;
  mergeDefined(state, initial);
  const attempt = typeof initial.attemptCount === 'number' ? initial.attemptCount : 0;
  if (initial.pipeline === 'architect' && attempt > 0) {
    runs.set(initial.kernel === 'brep' ? 'brepBuild' : 'architectBuild', attempt);
  } else if (initial.pipeline && initial.pipeline !== 'architect' && attempt > 0) {
    runs.set('drafterNode', 1);
    if (attempt > 1) runs.set('fixCode', attempt - 1);
  }
  const hasSpec = initial.assemblySpec != null || (Array.isArray(initial.specVariants) && initial.specVariants.length > 0);
  if (hasSpec) {
    const revisions = typeof initial.specRevisionCount === 'number' ? initial.specRevisionCount : 0;
    // specRevisionCount is user gate revisions. Reviewer loops live on variant.retries.
    runs.set('architectNode', revisions + reviewerRetries(initial) + 1);
  }
}

function reviewerRetries(initial: Record<string, unknown>): number {
  if (!Array.isArray(initial.specVariants)) return 0;
  let max = 0;
  for (const variant of initial.specVariants) {
    if (!variant || typeof variant !== 'object') continue;
    const retries = (variant as { retries?: unknown }).retries;
    if (typeof retries === 'number' && Number.isFinite(retries) && retries > max) max = retries;
  }
  return max;
}

function attemptNumber(
  node: string,
  partial: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
  runs: Map<string, number>,
): number {
  if (BUILD_NODES.has(node)) {
    if (typeof partial?.attemptCount === 'number') return partial.attemptCount;
    if (typeof input?.attemptCount === 'number') return input.attemptCount + 1;
  }
  return (runs.get(node) ?? 0) + 1;
}

function stepMax(step: string, state: AgentStateType): number {
  const max = typeof state.maxAttempts === 'number' && state.maxAttempts > 0
    ? state.maxAttempts
    : positive(process.env.CADAI_MAX_ATTEMPTS, 1);
  if (step === 'architectNode') return positive(process.env.CADAI_SPEC_REVIEW_RETRIES, 5) + 1;
  if (step === 'fixCode') return Math.max(1, max - 1);
  return max;
}

function closeEvent(section: Section, status: CloseStatus, summary?: string): StreamEvent {
  const endedAt = section.endedAt ?? Date.now();
  const line = summary ? oneLine(sanitizeText(summary)) : undefined;
  const needsSummary = status === 'failed' || status === 'retrying';
  const text = needsSummary ? (line || (status === 'failed' ? 'failed' : 'retrying')) : line;
  return {
    t: 'section',
    id: section.id,
    state: 'close',
    status: status as SectionStatus,
    endedAt,
    durationMs: Math.max(0, endedAt - section.startedAt),
    attempt: section.attempt,
    ...(text ? { summary: text } : {}),
  };
}

/** Section summaries are the fixed ApiError sentence. Raw text stays in apiError.detail. */

function failureOf(state: Record<string, unknown>): string | null {
  if (state.isValid === true) return null;
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
  if (Array.isArray(state.specVariants)) {
    for (const variant of state.specVariants) {
      if (!variant || typeof variant !== 'object') continue;
      const rec = variant as { needsRevision?: unknown; review?: { findings?: Array<{ severity?: string; issue?: string }> } };
      if (!rec.needsRevision) continue;
      const findings = rec.review?.findings ?? [];
      const finding = findings.find((item) => item.severity === 'major' && item.issue) ?? findings.find((item) => item.issue);
      if (finding?.issue) return finding.issue;
    }
  }
  if (typeof state.gateFeedback === 'string' && state.gateFeedback.trim()) return state.gateFeedback.trim();
  return 'revision required';
}

function routeReason(node: string, partial: Record<string, unknown>, state: AgentStateType): string {
  const fromPartial = failureOf(partial);
  if (fromPartial) return fromPartial;
  if (node === 'specReviewer' || node === 'specGate' || node === 'acceptGate') return reviewReason(partial);
  if (typeof partial.failureKind === 'string' && partial.failureKind !== 'none') return partial.failureKind.replaceAll('_', ' ');
  if (state.isValid === false && typeof state.failureKind === 'string' && state.failureKind !== 'none') {
    return state.failureKind.replaceAll('_', ' ');
  }
  return 'validation failed';
}
