import { describe, expect, it } from 'vitest';
import type { AgentStateType } from './graph';
import { nextStep } from './graph-route';

function state(partial: Partial<AgentStateType>): AgentStateType {
  return {
    messages: [],
    attemptCount: 0,
    maxAttempts: 1,
    failureKind: 'none',
    isValid: false,
    semanticFailures: 0,
    compileFailures: 0,
    pipeline: 'architect',
    kernel: 'brep',
    specRevisionCount: 0,
    acceptRevisionCount: 0,
    gateAction: null,
    stlContent: null,
    specVariants: [],
    specViolations: [],
    assemblySpec: null,
    reviewDeadline: null,
    ...partial,
  } as AgentStateType;
}

describe('nextStep', () => {
  it('sends an exhausted brep audit to the accept gate', () => {
    const next = nextStep('validateBrep', state({
      attemptCount: 1,
      maxAttempts: 1,
      isValid: false,
      failureKind: 'semantic',
      semanticFailures: 1,
      specViolations: [{ kind: 'bbox', severity: 'error', message: 'too thin', field: 'wall', expected: 2, measured: 0.4 }],
    }));
    expect(next).toBe('acceptGate');
  });

  it('re-enters brepBuild while attempts and the semantic budget remain', () => {
    const next = nextStep('validateBrep', state({
      attemptCount: 1,
      maxAttempts: 3,
      isValid: false,
      failureKind: 'semantic',
      semanticFailures: 1,
      specViolations: [{ kind: 'bbox', severity: 'error', message: 'too thin', field: 'wall', expected: 2, measured: 0.4 }],
    }));
    expect(next).toBe('brepBuild');
  });

  it('repairs an invalid result that carries no violation text', () => {
    const next = nextStep('validateBrep', state({
      attemptCount: 1,
      maxAttempts: 3,
      isValid: false,
      failureKind: 'semantic',
      semanticFailures: 1,
      specViolations: [],
    }));
    expect(next).toBe('brepBuild');
  });

  it('repairs a drafter pipeline through fixCode', () => {
    const next = nextStep('validateCode', state({
      pipeline: 'drafter',
      kernel: 'openscad',
      attemptCount: 1,
      maxAttempts: 3,
      isValid: false,
      failureKind: 'compile',
      compileFailures: 1,
    }));
    expect(next).toBe('fixCode');
  });

  it('sends an accept-gate revise back to the brep build', () => {
    const next = nextStep('acceptGate', state({
      gateAction: 'revise',
      acceptRevisionCount: 1,
      maxAttempts: 2,
      kernel: 'brep',
      pipeline: 'architect',
    }));
    expect(next).toBe('brepBuild');
  });

  it('sends a reviewer rejection back to the architect', () => {
    const next = nextStep('specReviewer', state({
      specVariants: [{ id: 'A', needsRevision: true }] as unknown as AgentStateType['specVariants'],
    }));
    expect(next).toBe('architectNode');
  });

  it('routes START to designerNode when CADAI_PIPELINE=designer or state.pipeline=designer', () => {
    process.env.CADAI_PIPELINE = 'designer';
    expect(nextStep('START', state({ pipeline: null }))).toBe('designerNode');
    delete process.env.CADAI_PIPELINE;
    expect(nextStep('START', state({ pipeline: 'designer' }))).toBe('designerNode');
    expect(nextStep('START', state({ pipeline: 'architect' }))).toBe('architectNode');
    expect(nextStep('START', state({ pipeline: null }))).toBe('architectNode');
  });

  it('routes designerCheck to designerNode on first failure, and acceptGate otherwise', () => {
    // First failure with retryCount=1 and failures present
    const retry = nextStep('designerCheck', state({
      isValid: false,
      designerRetryCount: 1,
      designerCheckFailures: 'disconnected: lid',
      designerCheckCompleted: false,
    }));
    expect(retry).toBe('designerNode');

    // Second failure (completed)
    const secondFail = nextStep('designerCheck', state({
      isValid: false,
      designerRetryCount: 2,
      designerCheckFailures: 'Built, but failed checks',
      designerCheckCompleted: true,
    }));
    expect(secondFail).toBe('acceptGate');

    // Success
    const success = nextStep('designerCheck', state({
      isValid: true,
      designerCheckCompleted: true,
    }));
    expect(success).toBe('acceptGate');
  });

  it('sends an accept-gate revise to designerNode in designer mode', () => {
    const next = nextStep('acceptGate', state({
      pipeline: 'designer',
      gateAction: 'revise',
      acceptRevisionCount: 1,
    }));
    expect(next).toBe('designerNode');
  });

  it('sends an accept-gate approve to respondToUser in designer mode', () => {
    const next = nextStep('acceptGate', state({
      pipeline: 'designer',
      gateAction: 'approve',
    }));
    expect(next).toBe('respondToUser');
  });
});
