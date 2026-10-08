import { AgentStateType } from './graph';

export function shouldGateSpec(state: AgentStateType, prompt: string): boolean {
  const variants = state.specVariants ?? [];
  if (variants.length > 1) return true;
  // A spec accepted with unresolved errors always goes to a human, sheets or not.
  if (variants.some((v) => (v.specErrors?.length ?? 0) > 0)) return true;
  const sheetsActive = process.env.CADAI_SPEC_SHEETS !== 'off' && variants.some((v) => v.review !== null);
  if (sheetsActive) {
    if (variants.some((v) => v.review && !v.review.validated)) return true;
    if ((state.specRevisionCount ?? 0) > 0) return true;
  }

  const targetSpec = state.assemblySpec ?? (variants.length > 0 ? variants[0]?.spec : null);
  if (!targetSpec) return true;

  if (targetSpec.components && targetSpec.components.length > 1) return true;
  if (targetSpec.jointContracts && targetSpec.jointContracts.length > 0) return true;
  if (targetSpec.assumptions && targetSpec.assumptions.length > 0) return true;
  if (targetSpec.openQuestions && targetSpec.openQuestions.length > 0) return true;

  const hasNumericDimension = /\d+\s*(mm|cm)\b/i.test(prompt);
  if (!hasNumericDimension) return true;

  return false;
}

export function shouldGateAccept(state: AgentStateType): boolean {
  if (state.attemptCount > 1) return true;
  if (state.specViolations && state.specViolations.length > 0) return true;
  return false;
}
