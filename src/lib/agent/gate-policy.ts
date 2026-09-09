import { AgentStateType } from './graph';

export function shouldGateSpec(state: AgentStateType, prompt: string): boolean {
  if (!state.assemblySpec) return true;

  if (state.assemblySpec.components && state.assemblySpec.components.length > 1) return true;
  if (state.assemblySpec.jointContracts && state.assemblySpec.jointContracts.length > 0) return true;
  if (state.assemblySpec.assumptions && state.assemblySpec.assumptions.length > 0) return true;
  if (state.assemblySpec.openQuestions && state.assemblySpec.openQuestions.length > 0) return true;

  const hasNumericDimension = /\d+\s*(mm|cm)\b/i.test(prompt);
  if (!hasNumericDimension) return true;

  return false;
}

export function shouldGateAccept(state: AgentStateType): boolean {
  if (state.attemptCount > 1) return true;
  if (state.specViolations && state.specViolations.length > 0) return true;
  return false;
}
