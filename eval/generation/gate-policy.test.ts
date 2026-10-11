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
    const recommended = variant('A', false, [{ severity: 'major', issue: 'wheels sit inside the body' }, { severity: 'minor', issue: 'thin plate' }]);
    const none = specGate([{ ...recommended, spec: { assemblyName: 'A' } } as GateVariant]);
    const d = evalGateDecision(none, 0);
    expect(d.decision.action).toBe('revise');
    expect(d.decision.chosenVariantId).toBe('A');
    expect(d.decision.comment).toContain('wheels sit inside the body');
    expect(d.approvedUnvalidated).toBe(false);
  });

  it('once the revision budget is spent, approves the recommended variant and flags it', () => {
    const recommended = variant('A', false, [{ severity: 'major', issue: 'x' }]);
    const none = specGate([{ ...recommended, spec: { assemblyName: 'A' } } as GateVariant]);
    expect(evalGateDecision(none, 1)).toEqual({ decision: { action: 'approve', chosenVariantId: 'A' }, approvedUnvalidated: true });
  });

  it('approves when no variant was reviewed, and does not flag it', () => {
    const sheetsOff = specGate([
      { ...variant('A', false), review: null, spec: { assemblyName: 'A' } },
      { ...variant('B', false), review: null, spec: { assemblyName: 'B' } },
    ] as GateVariant[]);
    expect(evalGateDecision(sheetsOff, 0)).toEqual({
      decision: { action: 'approve', chosenVariantId: 'A' },
      approvedUnvalidated: false,
    });
  });

  it('approves an unvalidated variant with no findings, and flags it', () => {
    const none = specGate([{ ...variant('A', false), spec: { assemblyName: 'A' } } as GateVariant]);
    expect(evalGateDecision(none, 0)).toEqual({
      decision: { action: 'approve', chosenVariantId: 'A' },
      approvedUnvalidated: true,
    });
  });

  it('approves a recommended variant with no spec, flagged only when its review failed', () => {
    const failed = specGate([variant('A', false, [{ severity: 'major', issue: 'missing' }])]);
    expect(evalGateDecision(failed, 0)).toEqual({
      decision: { action: 'approve', chosenVariantId: 'A' },
      approvedUnvalidated: true,
    });
    const unreviewed = specGate([{ ...variant('A', false), spec: null, review: null } as GateVariant]);
    expect(evalGateDecision(unreviewed, 0)).toEqual({
      decision: { action: 'approve', chosenVariantId: 'A' },
      approvedUnvalidated: false,
    });
  });

  it('approves when variants are missing, and does not flag it', () => {
    const payload = { kind: 'spec', recommendedId: 'A', contract: null, revisionCount: 0 } as unknown as GatePayload;
    expect(evalGateDecision(payload, 0)).toEqual({
      decision: { action: 'approve', chosenVariantId: 'A' },
      approvedUnvalidated: false,
    });
  });

  it('approves accept gates unchanged', () => {
    const accept = { kind: 'accept', modelInfo: null, violations: [], code: '', revisionCount: 0 } as unknown as GatePayload;
    expect(evalGateDecision(accept, 0)).toEqual({ decision: { action: 'approve' }, approvedUnvalidated: false });
  });
});
