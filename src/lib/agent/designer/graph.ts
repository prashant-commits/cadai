import { StateGraph, START, END, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { AgentState, type AgentStateType } from './state';
import { createDesignerNode, type DesignerNodeDeps } from './node';
import { createDesignerCheck, type DesignerCheckDeps } from './check';
import { createDesignerTriage, type DesignerTriageDeps } from './triage';
import { createDesignerAnswer, type DesignerAnswerDeps } from './answer';
import { formatFlags } from './reviewer';
import type { ReviewFlag } from './types';
import { DEFAULT_MODEL, isOfferedModel } from '../models';
import { escapeMarkers } from '../transcript';
import type { StreamEvent } from '../stream-events';
import { withGeneratedPrelude } from '../../brep/prelude';

function write(
  config: LangGraphRunnableConfig | undefined,
  node: string,
  event: StreamEvent
): void {
  const safe = event.t === 'delta' ? { ...event, text: escapeMarkers(event.text) } : event;
  config?.writer?.({ ...safe, node });
}

export function routeAfterDesignerTriage(
  state: AgentStateType
): 'designerAnswer' | 'designerNode' | 'respondToUser' {
  if (state.outcome) {
    return 'respondToUser';
  }
  if (state.triageKind === 'question') {
    return 'designerAnswer';
  }
  return 'designerNode';
}

export function routeAfterDesignerNode(
  state: AgentStateType
): 'designerCheck' | 'respondToUser' {
  if (state.outcome) {
    return 'respondToUser';
  }
  return 'designerCheck';
}

export function routeAfterDesignerCheck(
  state: AgentStateType
): 'designerNode' | 'respondToUser' {
  if (!state.isValid && (state.designerRetryCount ?? 0) === 1 && !state.designerCheckCompleted) {
    return 'designerNode';
  }
  return 'respondToUser';
}

export function createRespondToUser(deps?: { formatFlags?: (flags: ReviewFlag[], final: boolean) => string }) {
  return async function respondToUser(
    state: AgentStateType,
    config?: LangGraphRunnableConfig
  ): Promise<Partial<AgentStateType>> {
    const outcome = state.outcome;

    if (!outcome) {
      let summary = state.designerSummary || state.explanation || '';
      if (!state.isValid && state.designerCheckFailures) {
        summary = state.designerCheckFailures;
      }
      const finalFlags = (state.designerFlags ?? []).filter((f) => f.final);
      if (finalFlags.length > 0) {
        const flagFormatter = deps?.formatFlags ?? formatFlags;
        const formatted = flagFormatter(finalFlags, true);
        if (formatted) {
          summary = summary ? `${summary}\n\n${formatted}` : formatted;
        }
      }

      write(config, 'respondToUser', {
        t: 'result',
        summary,
        code: state.currentCode || undefined,
        stl: state.stlContent || undefined,
        step: state.stepContent || undefined,
        language: 'build123d',
        designContract: state.designContract ?? undefined,
      });

      return {};
    }

    if (outcome.design) {
      const code = outcome.design.body
        ? withGeneratedPrelude(outcome.design.body)
        : state.currentCode || undefined;
      write(config, 'respondToUser', {
        t: 'result',
        summary: outcome.replyMarkdown,
        code,
        stl: outcome.design.stl ?? state.stlContent ?? undefined,
        step: outcome.design.step ?? state.stepContent ?? undefined,
        language: 'build123d',
        designContract: state.designContract ?? undefined,
      });
    } else if (outcome.replyKind === 'answer' || outcome.replyKind === 'nochange') {
      write(config, 'respondToUser', {
        t: 'result',
        summary: outcome.replyMarkdown,
      });
    } else {
      write(config, 'respondToUser', {
        t: 'error',
        message: outcome.replyMarkdown,
      });
    }

    return {};
  };
}

export type DesignerAgentDeps = DesignerNodeDeps &
  DesignerCheckDeps &
  DesignerTriageDeps &
  DesignerAnswerDeps & {
    formatFlags?: (flags: ReviewFlag[], final: boolean) => string;
  };

export function createDesignerAgent(
  modelName?: string,
  deps?: DesignerAgentDeps
) {
  let selectedModel: string;
  if (modelName) {
    selectedModel = modelName;
  } else {
    const envModel = process.env.CADAI_MODEL;
    if (envModel) {
      if (isOfferedModel(envModel)) {
        selectedModel = envModel;
      } else {
        console.warn(`CADAI_MODEL "${envModel}" is not an offered model; ignoring and falling back to "${DEFAULT_MODEL}".`);
        selectedModel = DEFAULT_MODEL;
      }
    } else {
      selectedModel = DEFAULT_MODEL;
    }
  }

  const mergedDeps: DesignerAgentDeps = {
    ...deps,
    model: deps?.model ?? selectedModel,
  };

  const designerTriage = createDesignerTriage(mergedDeps);
  const designerAnswer = createDesignerAnswer(mergedDeps);
  const designerNode = createDesignerNode(mergedDeps);
  const designerCheck = createDesignerCheck(mergedDeps);
  const respondToUser = createRespondToUser(mergedDeps);

  const workflow = new StateGraph(AgentState)
    .addNode('designerTriage', designerTriage)
    .addNode('designerAnswer', designerAnswer)
    .addNode('designerNode', designerNode)
    .addNode('designerCheck', designerCheck)
    .addNode('respondToUser', respondToUser)
    .addEdge(START, 'designerTriage')
    .addConditionalEdges('designerTriage', routeAfterDesignerTriage, {
      designerAnswer: 'designerAnswer',
      designerNode: 'designerNode',
      respondToUser: 'respondToUser',
    })
    .addEdge('designerAnswer', 'respondToUser')
    .addConditionalEdges('designerNode', routeAfterDesignerNode, {
      designerCheck: 'designerCheck',
      respondToUser: 'respondToUser',
    })
    .addConditionalEdges('designerCheck', routeAfterDesignerCheck, {
      designerNode: 'designerNode',
      respondToUser: 'respondToUser',
    })
    .addEdge('respondToUser', END);

  return workflow.compile();
}
