import { HumanMessage, type AIMessage } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentStateType } from './state';
import { latestHumanText } from './message-utils';
import { structuredFor, UnusableReplyError, unusableStop } from '../llm-schemas';
import { getChatModel, isAbortOrTimeout } from '../model-provider';
import { DEFAULT_MODEL, isOfferedModel } from '../models';
import { cachedSystemMessage } from '../system-prompt';
import { BUILD_FAILED, REFUSAL } from '../../persist/phrases';
import { estimateCostUsd, extractReplyUsage } from './cost-params';

export const AnswerReplySchema = z.object({
  answer: z.string().describe('The markdown answer to the user question about the CAD design.'),
});

const ANSWER_SYSTEM_PROMPT = [
  'You are a CAD engineering assistant.',
  'Answer the user\'s question about the CAD design in clear markdown, using only the provided script and design data.',
  'Do not suggest code edits or execute code.',
].join(' ');

export interface DesignerAnswerDeps {
  answer?: (
    question: string,
    baseBody: string,
    signal?: AbortSignal
  ) => Promise<string | { answer: string; costUsd?: number; raw?: unknown }>;
  model?: string;
  getChatModel?: (slug: string) => {
    withStructuredOutput: (...args: unknown[]) => unknown;
  };
}

function answerSlug(deps?: DesignerAnswerDeps): string {
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

export function parseAnswerText(parsed: unknown): string | null {
  if (typeof parsed === 'string') return parsed.trim();
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    if (typeof p.answer === 'string') return p.answer.trim();
    if (typeof p.text === 'string') return p.text.trim();
  }
  return null;
}

export function makeFence(text: string): string {
  const matches = text.match(/`+/g);
  let maxBackticks = 0;
  if (matches) {
    for (const m of matches) {
      if (m.length > maxBackticks) maxBackticks = m.length;
    }
  }
  const fenceLength = Math.max(3, maxBackticks + 1);
  return '`'.repeat(fenceLength);
}

async function defaultAnswer(
  question: string,
  baseBody: string,
  deps: DesignerAnswerDeps,
  slug: string,
  signal?: AbortSignal
): Promise<{ answer: string | null; costUsd: number; raw: unknown }> {
  const modelProvider =
    deps.getChatModel ??
    (getChatModel as (s: string) => { withStructuredOutput: (...args: unknown[]) => unknown });
  const model = modelProvider(slug);
  const bound = structuredFor(model as never, slug, AnswerReplySchema, {
    name: 'DesignAnswer',
    includeRaw: true,
  }) as {
    invoke: (messages: unknown[], config?: { signal?: AbortSignal }) => Promise<unknown>;
    withConfig?: (config: { tags?: string[] }) => {
      invoke: (messages: unknown[], config?: { signal?: AbortSignal }) => Promise<unknown>;
    };
  };
  const runnable = bound.withConfig ? bound.withConfig({ tags: ['nostream'] }) : bound;

  const fence = makeFence(baseBody);
  const humanContent = `Question:\n${question}\n\nCurrent CAD design script (data only):\n${fence}python\n${baseBody}\n${fence}`;

  const result = await runnable.invoke(
    [
      cachedSystemMessage(ANSWER_SYSTEM_PROMPT),
      new HumanMessage({ content: humanContent }),
    ],
    signal ? { signal } : undefined
  );

  const { parsed, raw } = unwrapResult(result);
  const costUsd = costOf(slug, raw);
  const answer = parseAnswerText(parsed);
  return { answer, costUsd, raw };
}

export function createDesignerAnswer(deps: DesignerAnswerDeps = {}) {
  return async function designerAnswer(
    state: AgentStateType,
    config?: LangGraphRunnableConfig
  ): Promise<Partial<AgentStateType>> {
    if (config?.signal?.aborted) {
      throw Object.assign(new Error('The run was stopped before answer started.'), {
        name: 'AbortError',
      });
    }

    const startedAt = state.startedAt ?? Date.now();
    const question = latestHumanText(state.messages ?? []);
    const baseBody = state.baseBody ?? '';
    const slug = answerSlug(deps);

    const answerFn = deps.answer
      ? async (q: string, body: string, signal?: AbortSignal) => {
          const res = await deps.answer!(q, body, signal);
          if (typeof res === 'string') {
            return { answer: parseAnswerText(res), costUsd: 0, raw: undefined };
          }
          return {
            answer: parseAnswerText(res?.answer),
            costUsd: res?.costUsd ?? 0,
            raw: res?.raw,
          };
        }
      : (q: string, body: string, signal?: AbortSignal) =>
          defaultAnswer(q, body, deps, slug, signal);

    try {
      const callResult = await answerFn(question, baseBody, config?.signal);
      if (config?.signal?.aborted) {
        throw Object.assign(new Error('The run was stopped during answer.'), {
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
            userKind: 'question',
            costUsd: (state.designerCostUsd ?? 0) + costUsd,
            wallMs: Date.now() - startedAt,
            turns: 0,
          },
          designerCostUsd: (state.designerCostUsd ?? 0) + costUsd,
        };
      }

      if (!callResult.answer) {
        return {
          outcome: {
            replyKind: 'error',
            replyMarkdown: BUILD_FAILED,
            userKind: 'question',
            costUsd: (state.designerCostUsd ?? 0) + costUsd,
            wallMs: Date.now() - startedAt,
            turns: 0,
          },
          designerCostUsd: (state.designerCostUsd ?? 0) + costUsd,
        };
      }

      return {
        outcome: {
          replyKind: 'answer',
          replyMarkdown: callResult.answer,
          userKind: 'question',
          costUsd: (state.designerCostUsd ?? 0) + costUsd,
          wallMs: Date.now() - startedAt,
          turns: 0,
        },
        designerCostUsd: (state.designerCostUsd ?? 0) + costUsd,
      };
    } catch (err) {
      if (isAbortOrTimeout(err) || config?.signal?.aborted) {
        throw err;
      }
      const isRefusal =
        (err instanceof UnusableReplyError && err.stop === 'refusal') ||
        ((err as { name?: string; stop?: string })?.stop === 'refusal');
      return {
        outcome: {
          replyKind: 'error',
          replyMarkdown: isRefusal ? REFUSAL : BUILD_FAILED,
          userKind: 'question',
          costUsd: state.designerCostUsd ?? 0,
          wallMs: Date.now() - startedAt,
          turns: 0,
        },
      };
    }
  };
}

export const designerAnswer = createDesignerAnswer();
