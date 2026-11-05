import { describe, expect, it } from 'vitest';
import type { AgentStateType } from './graph';
import type { SpecViolation } from './spec-audit';
import { shouldGateAccept } from './gate-policy';

const state = (violations: Partial<SpecViolation>[], attemptCount = 1) =>
  ({ attemptCount, specViolations: violations }) as unknown as AgentStateType;

describe('shouldGateAccept and the liveness warnings', () => {
  it('does not stop a clean first attempt for liveness warnings alone', () => {
    for (const kind of ['dead_parameter', 'sweep_failure', 'literal_param'] as const) {
      expect(shouldGateAccept(state([{ kind, severity: 'warning', message: 'x' }])), kind).toBe(false);
    }
  });

  it('still gates on any other violation', () => {
    expect(shouldGateAccept(state([{ kind: 'bbox', severity: 'warning', message: 'x' }]))).toBe(true);
    expect(shouldGateAccept(state([{ kind: 'dead_parameter', severity: 'warning', message: 'x' }], 2))).toBe(true);
  });
});
