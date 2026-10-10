import { describe, it, expect } from 'vitest';
import type { GatePayload, GateVariant } from '@/types';
import { evalGateDecision } from './gate-policy';

const variant = (id: string, validated: boolean, findings: { severity: 'major' | 'minor'; issue: string }[] = []): GateVariant =>
  ({ id, name: id, idea: id, spec: null, sheetSvg: null, review: { validated, findings, attempts: 1 } }) as unknown as GateVariant;
const specGate = (variants: GateVariant[], recommendedId = 'A') =>
  ({ kind: 'spec', variants, recommendedId, contract: null, revisionCount: 0 }) as unknown as GatePayload;

describe('evalGateDecision', () => {
  it('approves a validated variant, preferring the recommended one', () => {
    expect(evalGateDecision(specGate([variant('A', true), variant('B', true)]), 0)).toEqual({
      decision: { action: 'approve', chosenVariantId: 'A' },
      approvedUnvalidated: false,
    });
    const onlyB = specGate([variant('A', false, [{ severity: 'major', issue: 'x' }]), variant('B', true)]);
    expect(evalGateDecision(onlyB, 0).decision).toEqual({ action: 'approve', chosenVariantId: 'B' });
  });

  it('with no validated variant, revises the recommended one with its reviewer findings', () => {
    const none = specGate([variant('A', false, [{ severity: 'major', issue: 'wheels sit inside the body' }, { severity: 'minor', issue: 'thin plate' }])]);
    const d = evalGateDecision(none, 0);
    expect(d.decision.action).toBe('revise');
    expect(d.decision.chosenVariantId).toBe('A');
    expect(d.decision.comment).toContain('wheels sit inside the body');
    expect(d.approvedUnvalidated).toBe(false);
  });

  it('once the revision budget is spent, approves the recommended variant and flags it', () => {
    const none = specGate([variant('A', false, [{ severity: 'major', issue: 'x' }])]);
    expect(evalGateDecision(none, 1)).toEqual({ decision: { action: 'approve', chosenVariantId: 'A' }, approvedUnvalidated: true });
  });

  it('approves accept gates unchanged', () => {
    const accept = { kind: 'accept', modelInfo: null, violations: [], code: '', revisionCount: 0 } as unknown as GatePayload;
    expect(evalGateDecision(accept, 0)).toEqual({ decision: { action: 'approve' }, approvedUnvalidated: false });
  });
});
