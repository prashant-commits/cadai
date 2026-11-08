import { StateGraph, START, END, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { AgentState, type AgentStateType } from './state';
import { createDesignerNode, type DesignerNodeDeps } from './node';
import { createDesignerCheck, type DesignerCheckDeps } from './check';
import { formatFlags } from './reviewer';
import type { ReviewFlag } from './types';
import { DEFAULT_MODEL, isOfferedModel } from '../models';
import { escapeMarkers } from '../transcript';
import type { StreamEvent } from '../stream-events';

function write(
  config: LangGraphRunnableConfig | undefined,
  node: string,
  event: StreamEvent
): void {
  const safe = event.t === 'delta' ? { ...event, text: escapeMarkers(event.text) } : event;
  config?.writer?.({ ...safe, node });
}

export function routeAfterDesignerCheck(state: AgentStateType): 'designerNode' | 'respondToUser' {
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
  };
}

export function createDesignerAgent(
  modelName?: string,
  deps?: DesignerNodeDeps & DesignerCheckDeps
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

  const nodeDeps: DesignerNodeDeps = {
    ...deps,
    model: deps?.model ?? selectedModel,
  };

  const designerNode = createDesignerNode(nodeDeps);
  const designerCheck = createDesignerCheck(deps);
  const respondToUser = createRespondToUser(deps);

  const workflow = new StateGraph(AgentState)
    .addNode('designerNode', designerNode)
    .addNode('designerCheck', designerCheck)
    .addNode('respondToUser', respondToUser)
    .addEdge(START, 'designerNode')
    .addEdge('designerNode', 'designerCheck')
    .addConditionalEdges('designerCheck', routeAfterDesignerCheck, {
      designerNode: 'designerNode',
      respondToUser: 'respondToUser',
    })
    .addEdge('respondToUser', END);

  return workflow.compile();
}
