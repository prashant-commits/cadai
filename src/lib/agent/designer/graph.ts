import { StateGraph, START, END } from '@langchain/langgraph';
import { AgentState, type AgentStateType } from './state';
import { createDesignerNode, type DesignerNodeDeps } from './node';
import { createDesignerCheck, type DesignerCheckDeps } from './check';
import { createDesignerTriage, type DesignerTriageDeps } from './triage';
import { createDesignerAnswer, type DesignerAnswerDeps } from './answer';
import type { ReviewFlag } from './types';
import { DEFAULT_MODEL, isOfferedModel } from '../models';

export function routeAfterDesignerTriage(
  state: AgentStateType
): 'designerAnswer' | 'designerNode' | typeof END {
  if (state.outcome) {
    return END;
  }
  if (state.triageKind === 'question') {
    return 'designerAnswer';
  }
  return 'designerNode';
}

export function routeAfterDesignerNode(
  state: AgentStateType
): 'designerCheck' | typeof END {
  if (state.outcome) {
    return END;
  }
  return 'designerCheck';
}

export function routeAfterDesignerCheck(
  state: AgentStateType
): 'designerNode' | typeof END {
  if (!state.isValid && (state.designerRetryCount ?? 0) === 1 && !state.designerCheckCompleted) {
    return 'designerNode';
  }
  return END;
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

  const workflow = new StateGraph(AgentState)
    .addNode('designerTriage', designerTriage)
    .addNode('designerAnswer', designerAnswer)
    .addNode('designerNode', designerNode)
    .addNode('designerCheck', designerCheck)
    .addEdge(START, 'designerTriage')
    .addConditionalEdges('designerTriage', routeAfterDesignerTriage, {
      designerAnswer: 'designerAnswer',
      designerNode: 'designerNode',
      [END]: END,
    })
    .addEdge('designerAnswer', END)
    .addConditionalEdges('designerNode', routeAfterDesignerNode, {
      designerCheck: 'designerCheck',
      [END]: END,
    })
    .addConditionalEdges('designerCheck', routeAfterDesignerCheck, {
      designerNode: 'designerNode',
      [END]: END,
    });

  return workflow.compile();
}
