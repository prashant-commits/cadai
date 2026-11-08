import type { AgentStateType } from './graph';
import { shouldGateAccept, shouldGateSpec } from './gate-policy';
import { isVisionModel } from './models';

/**
 * Repair passes granted to a semantic (geometry-vs-spec) failure, counted
 * independently of compile failures. The global `maxAttempts` still caps the
 * run; this only stops one failure class from starving the other.
 */
export const MAX_SEMANTIC_REPAIRS = 1;
export const MAX_SPEC_REVISIONS = 2;
export const MAX_ACCEPT_REVISIONS = 2;

import { firstHumanText, latestHumanText } from './designer/message-utils';
export { firstHumanText, latestHumanText };

/** Failed build: the Architect rewrites the named parts, or Repair does. */
export function repairTarget(state: AgentStateType): 'architectBuild' | 'brepBuild' | 'brepAgentBuild' | 'fixCode' {
  if (state.pipeline !== 'architect') return 'fixCode';
  if (state.kernel === 'brep') {
    return process.env.CADAI_BUILD_MODE === 'agent' ? 'brepAgentBuild' : 'brepBuild';
  }
  return 'architectBuild';
}

/** Finished spec: the Architect writes bodies, or the Drafter does. A null spec has nothing to build. */
export function draftTarget(state: AgentStateType): 'architectBuild' | 'brepBuild' | 'brepAgentBuild' | 'drafterNode' | 'respondToUser' {
  if (state.pipeline === 'architect') {
    if (!state.assemblySpec) return 'respondToUser';
    if (state.kernel === 'brep') {
      return process.env.CADAI_BUILD_MODE === 'agent' ? 'brepAgentBuild' : 'brepBuild';
    }
    return 'architectBuild';
  }
  return 'drafterNode';
}

/** Shared by routeAfterArchitect and routeAfterReviewer. A loop past the soft deadline goes to a human. */
export function checkSpecRoute(state: AgentStateType): 'specGate' | 'architectBuild' | 'brepBuild' | 'brepAgentBuild' | 'drafterNode' | 'respondToUser' {
  const prompt = latestHumanText(state.messages);
  if (state.reviewDeadline !== null && Date.now() >= state.reviewDeadline) return 'specGate';
  if (shouldGateSpec(state, prompt)) return 'specGate';
  return draftTarget(state);
}

export function routeAfterArchitectNode(
  state: AgentStateType,
  model: string,
): 'specIllustrator' | 'specGate' | 'architectBuild' | 'brepBuild' | 'brepAgentBuild' | 'drafterNode' | 'respondToUser' {
  const sheetsEnabled = process.env.CADAI_SPEC_SHEETS !== 'off';
  const hasSpec = (state.specVariants || []).some((variant) => variant.spec !== null);
  if (sheetsEnabled && isVisionModel(model) && hasSpec) return 'specIllustrator';
  return checkSpecRoute(state);
}

export function routeAfterReviewerNode(
  state: AgentStateType,
): 'architectNode' | 'specGate' | 'architectBuild' | 'brepBuild' | 'brepAgentBuild' | 'drafterNode' | 'respondToUser' {
  const needsRevision = (state.specVariants || []).some((variant) => variant.needsRevision);
  if (needsRevision) return 'architectNode';
  return checkSpecRoute(state);
}

export function routeAfterSpecGate(
  state: AgentStateType,
): 'respondToUser' | 'architectNode' | 'architectBuild' | 'brepBuild' | 'brepAgentBuild' | 'drafterNode' {
  if (state.gateAction === 'cancel') return 'respondToUser';
  if (state.gateAction === 'revise' && state.specRevisionCount <= MAX_SPEC_REVISIONS) return 'architectNode';
  return draftTarget(state);
}

export function routeAfterValidation(
  state: AgentStateType,
): 'visualCritic' | 'acceptGate' | 'respondToUser' | 'architectBuild' | 'brepBuild' | 'brepAgentBuild' | 'fixCode' {
  const isDone =
    (state.failureKind === 'none' && state.isValid) ||
    state.attemptCount >= state.maxAttempts ||
    (state.failureKind === 'semantic' && state.semanticFailures > MAX_SEMANTIC_REPAIRS);

  if (isDone) {
    if (state.isValid && state.stlContent) return 'visualCritic';
    if (shouldGateAccept(state)) return 'acceptGate';
    return 'respondToUser';
  }
  return repairTarget(state);
}

export function routeAfterCritic(state: AgentStateType): 'acceptGate' | 'respondToUser' {
  if (shouldGateAccept(state)) return 'acceptGate';
  return 'respondToUser';
}

export function routeStart(state: AgentStateType): 'designerNode' | 'architectNode' {
  const pipeline = state.pipeline ?? (process.env.CADAI_PIPELINE === 'designer' ? 'designer' : 'architect');
  if (pipeline === 'designer') return 'designerNode';
  return 'architectNode';
}

export function routeAfterDesignerCheck(state: AgentStateType): 'designerNode' | 'acceptGate' {
  if (!state.isValid && (state.designerRetryCount ?? 0) === 1 && !state.designerCheckCompleted) {
    return 'designerNode';
  }
  return 'acceptGate';
}

export function routeAfterAccept(state: AgentStateType): 'architectBuild' | 'brepBuild' | 'brepAgentBuild' | 'fixCode' | 'designerNode' | 'respondToUser' {
  if (state.pipeline === 'designer') {
    if (state.gateAction === 'revise' && state.acceptRevisionCount <= MAX_ACCEPT_REVISIONS) return 'designerNode';
    return 'respondToUser';
  }
  if (state.gateAction === 'revise' && state.acceptRevisionCount <= MAX_ACCEPT_REVISIONS) return repairTarget(state);
  return 'respondToUser';
}

/** The node the conditional edge for `node` selects. Fixed edges are not included. */
export function nextStep(node: string, state: AgentStateType, model = ''): string | null {
  switch (node) {
    case 'START':
      return routeStart(state);
    case 'designerCheck':
      return routeAfterDesignerCheck(state);
    case 'architectNode':
      return routeAfterArchitectNode(state, model);
    case 'specReviewer':
      return routeAfterReviewerNode(state);
    case 'specGate':
      return routeAfterSpecGate(state);
    case 'validateCode':
    case 'validateBrep':
      return routeAfterValidation(state);
    case 'visualCritic':
      return routeAfterCritic(state);
    case 'acceptGate':
      return routeAfterAccept(state);
    default:
      return null;
  }
}
