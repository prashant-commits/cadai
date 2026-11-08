import { HumanMessage, type AIMessage } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentStateType } from './state';
import { latestHumanText } from './message-utils';
import { structuredFor, UnusableReplyError, unusableStop } from '../llm-schemas';
import { getChatModel, isAbortOrTimeout } from '../model-provider';
import { DEFAULT_MODEL, isOfferedModel } from '../models';
import { cachedSystemMessage } from '../system-prompt';
import { REFUSAL } from '../../persist/phrases';
import { estimateCostUsd, extractReplyUsage } from './cost-params';

export const TriageReplySchema = z.object({
  label: z
    .enum(['edit', 'new', 'question'])
    .describe('Classification: edit (modify existing design), new (start fresh new design), or question (ask a question without modifying design).'),
});

const TRIAGE_SYSTEM_PROMPT = [
  'You are an assistant that classifies incoming CAD user requests.',
  'An existing CAD model design is present in the conversation.',
  'Classify the user\'s latest message into exactly one of three categories:',
  '- edit: The user wants to modify, adjust, add to, cut, delete, resize, or change the existing 3D model (e.g., "make it 20 mm taller", "add a cable hole", "round the corners").',
  '- new: The user wants to start an entirely new, different design from scratch, abandoning or replacing the current one (e.g., "now make a desk lamp", "start over with a cup", "discard this and create a chair").',
  '- question: The user is asking a question about the design, dimensions, CAD, or instructions without requesting geometry changes (e.g., "what is this?", "how tall is it?", "what material is recommended?").',
].join(' ');

export type TriageKind = 'edit' | 'new' | 'question';

export interface DesignerTriageDeps {
  classify?: (
    text: string,
    hasBase: boolean,
    signal?: AbortSignal
  ) => Promise<
    | TriageKind
    | { label: TriageKind; costUsd?: number; raw?: unknown }
  >;
  model?: string;
  getChatModel?: (slug: string) => {
    withStructuredOutput: (...args: unknown[]) => unknown;
  };
}

function triageSlug(deps?: DesignerTriageDeps): string {
  if (deps?.model) return deps.model;
  const envModel = process.env.CADAI_MODEL?.trim();
  if (envModel && isOfferedModel(envModel)) return envModel;
  return DEFAULT_MODEL;
}

function unwrapResult(result: unknown): { parsed: unknown; raw: unknown } {
  if (
    result &&
    typeof result === 'object' &&
    'parsed' in result &&
    'raw' in result
  ) {
    const box = result as { parsed: unknown; raw: unknown };
    return { parsed: box.parsed, raw: box.raw };
  }
  return { parsed: result, raw: undefined };
}

function costOf(slug: string, raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  return estimateCostUsd(slug, extractReplyUsage(raw as AIMessage));
}

export function parseTriageLabel(parsed: unknown): TriageKind | null {
  if (typeof parsed === 'string') {
    const s = parsed.trim().toLowerCase();
    if (s === 'edit' || s === 'new' || s === 'question') return s;
  }
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    const val = p.label ?? p.classification ?? p.triage ?? p.kind;
    if (typeof val === 'string') {
      const s = val.trim().toLowerCase();
      if (s === 'edit' || s === 'new' || s === 'question') return s;
    }
  }
  return null;
}

async function defaultClassify(
  text: string,
  deps: DesignerTriageDeps,
  slug: string,
  signal?: AbortSignal
): Promise<{ label: TriageKind | null; costUsd: number; raw: unknown }> {
  const modelProvider =
    deps.getChatModel ??
    (getChatModel as (s: string) => { withStructuredOutput: (...args: unknown[]) => unknown });
  const model = modelProvider(slug);
  const bound = structuredFor(model as never, slug, TriageReplySchema, {
    name: 'TriageDecision',
    includeRaw: true,
  }) as {
    invoke: (messages: unknown[], config?: { signal?: AbortSignal }) => Promise<unknown>;
    withConfig?: (config: { tags?: string[] }) => {
      invoke: (messages: unknown[], config?: { signal?: AbortSignal }) => Promise<unknown>;
    };
  };
  const runnable = bound.withConfig ? bound.withConfig({ tags: ['nostream'] }) : bound;

  const result = await runnable.invoke(
    [
      cachedSystemMessage(TRIAGE_SYSTEM_PROMPT),
      new HumanMessage({ content: text }),
    ],
    signal ? { signal } : undefined
  );

  const { parsed, raw } = unwrapResult(result);
  const costUsd = costOf(slug, raw);
  const label = parseTriageLabel(parsed);
  return { label, costUsd, raw };
}

export function createDesignerTriage(deps: DesignerTriageDeps = {}) {
  return async function designerTriage(
    state: AgentStateType,
    config?: LangGraphRunnableConfig
  ): Promise<Partial<AgentStateType>> {
    if (config?.signal?.aborted) {
      throw Object.assign(new Error('The run was stopped before triage started.'), {
        name: 'AbortError',
      });
    }

    const startedAt = Date.now();
    const runReset = {
      startedAt,
      designerRetryCount: 0,
      designerCheckCompleted: false,
      designerCheckFailures: null,
      designerCheckSentences: [],
    };

    const hasBase = typeof state.baseBody === 'string' && state.baseBody.trim().length > 0;
    const latestText = latestHumanText(state.messages ?? []);

    // When baseBody is null (no base): no model call; route fresh (new semantics, userKind: 'request').
    if (!hasBase) {
      return {
        outcome: null,
        ...runReset,
        triageKind: 'new',
      };
    }

    const slug = triageSlug(deps);
    const classifyFn = deps.classify
      ? async (text: string, signal?: AbortSignal) => {
          const res = await deps.classify!(text, true, signal);
          if (typeof res === 'string') {
            return { label: parseTriageLabel(res), costUsd: 0, raw: undefined };
          }
          return {
            label: parseTriageLabel(res?.label),
            costUsd: res?.costUsd ?? 0,
            raw: res?.raw,
          };
        }
      : (text: string, signal?: AbortSignal) => defaultClassify(text, deps, slug, signal);

    try {
      const callResult = await classifyFn(latestText, config?.signal);
      if (config?.signal?.aborted) {
        throw Object.assign(new Error('The run was stopped during triage.'), {
          name: 'AbortError',
        });
      }

      const costUsd = callResult.costUsd ?? 0;
      const stop = unusableStop(callResult.raw);
      if (stop === 'refusal') {
        return {
          outcome: {
            replyKind: 'error',
            replyMarkdown: REFUSAL,
            userKind: 'unknown',
            costUsd: (state.designerCostUsd ?? 0) + costUsd,
            wallMs: Date.now() - startedAt,
            turns: 0,
          },
          ...runReset,
          triageKind: null,
          designerCostUsd: (state.designerCostUsd ?? 0) + costUsd,
        };
      }

      const label = callResult.label;
      if (!label) {
        // Unparseable / malformed -> fallback to edit when hasBase
        return {
          outcome: null,
          ...runReset,
          triageKind: 'edit',
          designerCostUsd: (state.designerCostUsd ?? 0) + costUsd,
        };
      }

      return {
        outcome: null,
        ...runReset,
        triageKind: label,
        designerCostUsd: (state.designerCostUsd ?? 0) + costUsd,
      };
    } catch (err) {
      if (isAbortOrTimeout(err) || config?.signal?.aborted) {
        throw err;
      }
      const isRefusal =
        (err instanceof UnusableReplyError && err.stop === 'refusal') ||
        ((err as { name?: string; stop?: string })?.stop === 'refusal');
      if (isRefusal) {
        return {
          outcome: {
            replyKind: 'error',
            replyMarkdown: REFUSAL,
            userKind: 'unknown',
            costUsd: state.designerCostUsd ?? 0,
            wallMs: Date.now() - startedAt,
            turns: 0,
          },
          ...runReset,
          triageKind: null,
        };
      }
      // The classifier throwing (network, malformed, unusable) -> edit when there is a base
      return {
        outcome: null,
        ...runReset,
        triageKind: 'edit',
      };
    }
  };
}

export const designerTriage = createDesignerTriage();
