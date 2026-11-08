import { PIPELINE_STEPS } from '@/lib/contract/run-contract';
import { sanitizeText, toApiError } from '@/lib/contract/api-error';
import type { StreamEvent } from './stream-events';
import type { SectionStatus } from './transcript';
import type { AgentStateType } from './designer/state';
import { contentText } from './message-text';

/** Human labels for graph nodes. An unlisted node falls back to its own id when it produces output. */
export const NODE_LABELS: Record<string, string> = {
  designerNode: 'Designer',
  designerCheck: 'Checks',
};

/**
 * Nodes whose `messages`-mode chunks must never reach the UI.
 * Structured nodes render their own markdown or status events over `custom`.
 */
const STRUCTURED_NODES = new Set(['designerNode', 'designerCheck', 'designerTriage', 'designerAnswer']);

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

/**
 * Translates langgraph's [mode, payload] tuples into the client's event union.
 *
 * Shapes verified against langgraph 1.4: `custom` yields the bare payload,
 * `messages` yields [chunk, metadata], a node's return value arrives
 * as ['updates', { nodeName: partialState }], and `tasks` yields a create payload
 * `{name, input}` at start and a result payload `{name, result}` at finish.
 */
export async function bridgeGraphStream(
  chunks: AsyncIterable<unknown>,
  runId: string,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  const box = {
    current: null as Section | null,
    state: initialRouteState(),
  };
  const runs = new Map<string, number>();
  const starts = new Map<string, number>();

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

  function enter(node: string, attemptOverride?: number) {
    if (box.current?.id === node && attemptOverride === undefined) {
      return;
    }
    leaveFor(node);
    const attempt = attemptOverride ?? attemptNumber(node, runs);
    runs.set(node, Math.max(runs.get(node) ?? 0, attempt));
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
        enter(task.name);
        continue;
      }

      if (mode === 'custom') {
        const event = payload as CustomPayload;
        if (event.t === 'cost') {
          const usd = (event as { usd?: unknown }).usd;
          if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) {
            send({ t: 'cost', usd });
          }
        } else if (event.t === 'delta') {
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
          // One section per attempt.
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
        for (const [node, partial] of Object.entries(upd)) {
          if (node === '__interrupt__' || !partial || typeof partial !== 'object' || Array.isArray(partial)) continue;
          const record = partial as Record<string, unknown>;
          mergeDefined(box.state, record);
          if (box.current?.id !== node) enter(node);
          const summary = failureOf(record);
          if (box.current?.id === node) {
            if (record.isValid === true) box.current.summary = null;
            else if (summary) box.current.summary = oneLine(sanitizeText(summary));
            if (Object.keys(record).length === 0 && !box.current.hadOutput) box.current.preferSkipped = true;
          }
        }
      }
    }
  } catch (err) {
    try {
      const api = toApiError(err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'failed'));
      // A section that already finished stays as it closed.
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
    pipeline: null,
    kernel: null,
    stlContent: null,
  } as unknown as AgentStateType;
}

function mergeDefined(state: AgentStateType, partial: Record<string, unknown>) {
  const target = state as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) target[key] = value;
  }
}

function attemptNumber(node: string, runs: Map<string, number>): number {
  return (runs.get(node) ?? 0) + 1;
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
  if (typeof state.error === 'string' && state.error.trim()) return state.error.trim();
  if (state.isValid === false && typeof state.failureKind === 'string' && state.failureKind !== 'none') {
    return state.failureKind.replaceAll('_', ' ');
  }
  return null;
}
