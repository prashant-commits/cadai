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

const VALIDATION_REPORT_PREFIX = '[Validation Report]';

/**
 * The user's current request, from the latest human message they wrote.
 * Accepts LangChain messages (`_getType`) and checkpoint JSON (`type` / `kwargs`).
 */
export function latestHumanText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (const msg of [...messages].reverse()) {
    if (messageRole(msg) !== 'human') continue;
    const text = messageText(msg);
    if (text && !text.startsWith(VALIDATION_REPORT_PREFIX)) return text;
  }
  return '';
}

function messageRole(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const rec = msg as {
    _getType?: () => string;
    getType?: () => string;
    type?: string;
    id?: unknown;
  };
  if (typeof rec._getType === 'function') return rec._getType();
  if (typeof rec.getType === 'function') return rec.getType();
  if (typeof rec.type === 'string' && rec.type !== 'constructor') return rec.type;
  if (Array.isArray(rec.id) && rec.id.length > 0) {
    const last = rec.id[rec.id.length - 1];
    if (typeof last === 'string' && last.endsWith('Message')) return last.slice(0, -'Message'.length).toLowerCase();
  }
  return '';
}

function messageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const rec = msg as { content?: unknown; kwargs?: { content?: unknown } };
  const content = rec.content ?? rec.kwargs?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const part = content.find((item) => item && typeof item === 'object' && (item as { type?: string }).type === 'text') as
    | { text?: string }
    | undefined;
  return part?.text ?? '';
}

/** Failed build: the Architect rewrites the named parts, or Repair does. */
export function repairTarget(state: AgentStateType): 'architectBuild' | 'brepBuild' | 'fixCode' {
  if (state.pipeline !== 'architect') return 'fixCode';
  return state.kernel === 'brep' ? 'brepBuild' : 'architectBuild';
}

/** Finished spec: the Architect writes bodies, or the Drafter does. A null spec has nothing to build. */
export function draftTarget(state: AgentStateType): 'architectBuild' | 'brepBuild' | 'drafterNode' | 'respondToUser' {
  if (state.pipeline === 'architect') {
    if (!state.assemblySpec) return 'respondToUser';
    return state.kernel === 'brep' ? 'brepBuild' : 'architectBuild';
  }
  return 'drafterNode';
}

/** Shared by routeAfterArchitect and routeAfterReviewer. A loop past the soft deadline goes to a human. */
export function checkSpecRoute(state: AgentStateType): 'specGate' | 'architectBuild' | 'brepBuild' | 'drafterNode' | 'respondToUser' {
  const prompt = latestHumanText(state.messages);
  if (state.reviewDeadline !== null && Date.now() >= state.reviewDeadline) return 'specGate';
  if (shouldGateSpec(state, prompt)) return 'specGate';
  return draftTarget(state);
}

export function routeAfterArchitectNode(
  state: AgentStateType,
  model: string,
): 'specIllustrator' | 'specGate' | 'architectBuild' | 'brepBuild' | 'drafterNode' | 'respondToUser' {
  const sheetsEnabled = process.env.CADAI_SPEC_SHEETS !== 'off';
  const hasSpec = (state.specVariants || []).some((variant) => variant.spec !== null);
  if (sheetsEnabled && isVisionModel(model) && hasSpec) return 'specIllustrator';
  return checkSpecRoute(state);
}

export function routeAfterReviewerNode(
  state: AgentStateType,
): 'architectNode' | 'specGate' | 'architectBuild' | 'brepBuild' | 'drafterNode' | 'respondToUser' {
  const needsRevision = (state.specVariants || []).some((variant) => variant.needsRevision);
  if (needsRevision) return 'architectNode';
  return checkSpecRoute(state);
}

export function routeAfterSpecGate(
  state: AgentStateType,
): 'respondToUser' | 'architectNode' | 'architectBuild' | 'brepBuild' | 'drafterNode' {
  if (state.gateAction === 'cancel') return 'respondToUser';
  if (state.gateAction === 'revise' && state.specRevisionCount <= MAX_SPEC_REVISIONS) return 'architectNode';
  return draftTarget(state);
}

export function routeAfterValidation(
  state: AgentStateType,
): 'visualCritic' | 'acceptGate' | 'respondToUser' | 'architectBuild' | 'brepBuild' | 'fixCode' {
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

export function routeAfterAccept(state: AgentStateType): 'architectBuild' | 'brepBuild' | 'fixCode' | 'respondToUser' {
  if (state.gateAction === 'revise' && state.acceptRevisionCount <= MAX_ACCEPT_REVISIONS) return repairTarget(state);
  return 'respondToUser';
}

/** The node the conditional edge for `node` selects. Fixed edges are not included. */
export function nextStep(node: string, state: AgentStateType, model = ''): string | null {
  switch (node) {
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
