import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { AgentStateType } from '../graph';
import type {
  DesignerEvent,
  DesignerInput,
  DesignerResult,
  ReviewFlag,
  ReviewFn,
  RunDesignerFn,
} from './types';
import { firstHumanText, latestHumanText } from '../graph-route';
import { escapeMarkers } from '../transcript';

export interface DesignerNodeDeps {
  runDesigner?: RunDesignerFn;
  makeReviewer?: () => ReviewFn;
  formatFlags?: (flags: ReviewFlag[]) => string;
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

  return { runDesigner, makeReviewer, formatFlags };
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

    const resolved = await getDeps(deps);
    const messages = state.messages ?? [];
    const latestText = latestHumanText(messages);
    const firstText = firstHumanText(messages) || latestText;

    let priorScript: string | undefined;
    let editRequest: string | undefined;
    let request: string = firstText;
    let isCheckRetry = false;

    if (state.designerCheckFailures && (state.designerRetryCount ?? 0) === 1 && !state.designerCheckCompleted) {
      // Check failure retry
      priorScript = state.currentCode;
      editRequest = state.designerCheckFailures;
      request = firstText;
      isCheckRetry = true;
    } else if (state.gateAction === 'revise' && state.gateFeedback) {
      // Human revision from acceptGate
      priorScript = state.currentCode;
      editRequest = state.gateFeedback;
      request = firstText;
    } else if (state.acceptedDesignerScript) {
      // Follow-up edit from user
      priorScript = state.acceptedDesignerScript;
      editRequest = latestText;
      request = firstText;
    } else {
      // Fresh new design
      request = latestText;
    }

    const input: DesignerInput = {
      request,
      ...(priorScript ? { priorScript } : {}),
      ...(editRequest ? { editRequest } : {}),
      buildId: (config?.configurable as { thread_id?: string } | undefined)?.thread_id,
    };

    const onEvent = (e: DesignerEvent) => {
      if (e.kind === 'step' || e.kind === 'note') {
        const text = e.text.endsWith('\n') ? e.text : `${e.text}\n`;
        config?.writer?.({ t: 'delta', node: 'designerNode', text: escapeMarkers(text) });
      } else if (e.kind === 'review') {
        if (e.flags && e.flags.length > 0) {
          const formatted = resolved.formatFlags(e.flags);
          if (formatted) {
            const text = formatted.endsWith('\n') ? formatted : `${formatted}\n`;
            config?.writer?.({ t: 'delta', node: 'designerNode', text: escapeMarkers(text) });
          }
        }
      }
    };

    const review = process.env.CADAI_REVIEWER === 'off' ? undefined : resolved.makeReviewer();
    const result: DesignerResult = await resolved.runDesigner(input, {
      review,
      signal: config?.signal,
      onEvent,
      model: deps.model,
    });

    if (config?.signal?.aborted) {
      throw Object.assign(new Error('The run was stopped during the designer run.'), {
        name: 'AbortError',
      });
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
      acceptedDesignerScript: state.acceptedDesignerScript ?? (result.failed ? null : result.script),
      designerCheckFailures: null,
      ...(!isCheckRetry ? { designerRetryCount: 0, designerCheckCompleted: false } : {}),
      attemptCount: (state.attemptCount ?? 0) + 1,
    };
  };
}

export const designerNode = createDesignerNode();
