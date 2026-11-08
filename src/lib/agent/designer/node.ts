import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { AgentStateType } from './state';
import type {
  DesignerEvent,
  DesignerInput,
  DesignerResult,
  ReviewFlag,
  ReviewFn,
  RunDesignerFn,
} from './types';
import { firstHumanText, latestHumanText } from './message-utils';
import { escapeMarkers } from '../transcript';
import { UnusableReplyError } from '../llm-schemas';
import { BUILD_FAILED, REFUSAL } from '../../persist/phrases';
import type { UserKind } from '../../persist/types';
import { designerWallBudgetMs } from './budget';

export interface DesignerNodeDeps {
  runDesigner?: RunDesignerFn;
  makeReviewer?: () => ReviewFn;
  formatFlags?: (flags: ReviewFlag[], final: boolean) => string;
  model?: string;
}

async function getDeps(deps: DesignerNodeDeps) {
  let runDesigner = deps.runDesigner;
  let makeReviewer = deps.makeReviewer;
  let formatFlags = deps.formatFlags;

  if (!runDesigner || !makeReviewer || !formatFlags) {
    const [designerMod, reviewerMod] = await Promise.all([
      import('./run-designer'),
      import('./reviewer'),
    ]);
    runDesigner = runDesigner ?? designerMod.runDesigner;
    makeReviewer = makeReviewer ?? reviewerMod.makeReviewer;
    formatFlags = formatFlags ?? reviewerMod.formatFlags;
  }

  return { runDesigner: runDesigner!, makeReviewer: makeReviewer!, formatFlags: formatFlags! };
}

export function createDesignerNode(deps: DesignerNodeDeps = {}) {
  return async function designerNode(
    state: AgentStateType,
    config?: LangGraphRunnableConfig
  ): Promise<Partial<AgentStateType>> {
    if (config?.signal?.aborted) {
      throw Object.assign(new Error('The run was stopped before the designer started.'), {
        name: 'AbortError',
      });
    }

    const startedAt = state.startedAt ?? Date.now();
    const resolved = await getDeps(deps);
    const messages = state.messages ?? [];
    const latestText = latestHumanText(messages);
    const firstText = firstHumanText(messages) || latestText;

    let priorScript: string | undefined;
    let editRequest: string | undefined;
    let request: string = latestText;
    let isCheckRetry = false;

    if (state.designerCheckFailures && (state.designerRetryCount ?? 0) === 1 && !state.designerCheckCompleted) {
      // Check retry (existing retry condition): priorScript = state.currentCode, editRequest = designerCheckFailures,
      // request unchanged from the attempt being retried.
      priorScript = state.currentCode;
      editRequest = state.designerCheckFailures;
      request = state.triageKind === 'edit'
        ? (state.baseRequest ?? firstText)
        : latestText;
      isCheckRetry = true;
    } else if (state.triageKind === 'edit') {
      // Edit (triage edit): request = baseRequest ?? firstHumanText, editRequest = latest human text, priorScript = baseBody.
      priorScript = state.baseBody ?? undefined;
      editRequest = latestText;
      request = state.baseRequest ?? firstText;
    } else {
      // Fresh (new or no base): no priorScript; request = latest human text.
      request = latestText;
    }

    const input: DesignerInput = {
      request,
      ...(priorScript ? { priorScript } : {}),
      ...(editRequest ? { editRequest } : {}),
      ...(state.attachments && state.attachments.length > 0 ? { attachments: state.attachments } : {}),
      buildId: (config?.configurable as { thread_id?: string } | undefined)?.thread_id,
    };

    const onEvent = (e: DesignerEvent) => {
      if (e.kind === 'step' || e.kind === 'note') {
        const text = e.text.endsWith('\n') ? e.text : `${e.text}\n`;
        config?.writer?.({ t: 'delta', node: 'designerNode', text: escapeMarkers(text) });
      } else if (e.kind === 'review') {
        if (e.flags && e.flags.length > 0) {
          const formatted = resolved.formatFlags(e.flags, e.final);
          if (formatted) {
            const text = formatted.endsWith('\n') ? formatted : `${formatted}\n`;
            config?.writer?.({ t: 'delta', node: 'designerNode', text: escapeMarkers(text) });
          }
        }
      } else if (e.kind === 'cost') {
        config?.writer?.({ t: 'cost', usd: e.usd });
      }
    };

    const review = process.env.CADAI_REVIEWER === 'off' ? undefined : resolved.makeReviewer();
    const userKind: UserKind = state.triageKind === 'edit' ? 'edit' : 'request';

    const rawDeadline = (config?.configurable as { deadlineAt?: unknown } | undefined)?.deadlineAt;
    const deadlineAt = typeof rawDeadline === 'number' && Number.isFinite(rawDeadline) ? rawDeadline : undefined;
    const wallMs = designerWallBudgetMs(deadlineAt);

    let result: DesignerResult;
    try {
      result = await resolved.runDesigner(input, {
        review,
        signal: config?.signal,
        onEvent,
        model: deps.model,
        wallMs,
      });

      if (config?.signal?.aborted) {
        throw Object.assign(new Error('The run was stopped during the designer run.'), {
          name: 'AbortError',
        });
      }

      if (result.stop === 'refusal') {
        const totalCost = (state.designerCostUsd ?? 0) + (result.costUsd ?? 0);
        const wallMs = Date.now() - startedAt;
        return {
          outcome: {
            replyKind: 'error',
            replyMarkdown: REFUSAL,
            userKind,
            costUsd: totalCost,
            wallMs,
            turns: (state.designerTurns ?? 0) + (result.turns ?? 1),
          },
          designerCostUsd: totalCost,
          startedAt,
        };
      }

      if ((result.failed || result.stop !== undefined) && (!result.script || result.script.trim() === '')) {
        const totalCost = (state.designerCostUsd ?? 0) + (result.costUsd ?? 0);
        const wallMs = Date.now() - startedAt;
        return {
          outcome: {
            replyKind: 'error',
            replyMarkdown: BUILD_FAILED,
            userKind,
            costUsd: totalCost,
            wallMs,
            turns: (state.designerTurns ?? 0) + (result.turns ?? 1),
          },
          designerCostUsd: totalCost,
          startedAt,
        };
      }
    } catch (err) {
      if (err instanceof UnusableReplyError) {
        const isRefusal = err.stop === 'refusal';
        const totalCost = state.designerCostUsd ?? 0;
        const wallMs = Date.now() - startedAt;
        return {
          outcome: {
            replyKind: 'error',
            replyMarkdown: isRefusal ? REFUSAL : BUILD_FAILED,
            userKind,
            costUsd: totalCost,
            wallMs,
            turns: state.designerTurns ?? 0,
          },
          designerCostUsd: totalCost,
          startedAt,
        };
      }
      throw err;
    }

    const totalCost = (state.designerCostUsd ?? 0) + (result.costUsd ?? 0);
    const turns = (state.designerTurns ?? 0) + (result.turns ?? 1);

    return {
      pipeline: 'designer',
      kernel: 'brep',
      currentCode: result.script,
      designerFacts: result.facts,
      designerFlags: result.reviewerFlags,
      designerCostUsd: totalCost,
      designerSummary: result.summary,
      designerTurns: turns,
      designerCheckFailures: null,
      ...(!isCheckRetry ? { designerRetryCount: 0, designerCheckCompleted: false } : {}),
      attemptCount: (state.attemptCount ?? 0) + 1,
      startedAt,
    };
  };
}

export const designerNode = createDesignerNode();
