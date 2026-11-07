import { describe, it, expect, vi, afterEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createDesignerCheck } from './check';
import type { AgentStateType } from '../graph';
import type { BrepResult } from '../../engine/brep-runner';

function createMockState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    messages: [new HumanMessage('make a box')],
    currentCode: 'a = 10\n_cadai_parts = [box]',
    attemptCount: 1,
    maxAttempts: 1,
    failureKind: 'none',
    isValid: false,
    semanticFailures: 0,
    compileFailures: 0,
    pipeline: 'designer',
    kernel: 'brep',
    specRevisionCount: 0,
    acceptRevisionCount: 0,
    gateAction: null,
    stlContent: null,
    stepContent: null,
    specVariants: [],
    specViolations: [],
    assemblySpec: null,
    reviewDeadline: null,
    runDeadline: null,
    chosenVariantId: null,
    humanSpecNotes: [],
    variantsMs: null,
    roundStartedAt: null,
    lastRoundMs: null,
    designContract: null,
    explanation: '',
    modelInfo: null,
    validation: null,
    placementReport: null,
    attemptHistory: [],
    gateFeedback: null,
    buildFallbacks: 0,
    buildNotes: [],
    buildWallMs: 0,
    buildCostUsd: 0,
    specBrief: null,
    designerFacts: null,
    designerFlags: [],
    designerCostUsd: 0,
    designerRetryCount: 0,
    designerCheckFailures: null,
    designerCheckCompleted: false,
    acceptedDesignerScript: null,
    designerSummary: '',
    designerTurns: 0,
    ...overrides,
  } as AgentStateType;
}

const validBrepResult: BrepResult = {
  ok: true,
  parts: [
    { label: 'box', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] },
  ],
  solids: 1,
  stl: Buffer.from('solid model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid model').toString('base64'),
  step: 'STEP-CONTENT',
  ms: 100,
  disconnected: [],
  interferences: [],
};

describe('designerCheck', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes and produces STL and STEP when script passes all checks', async () => {
    const runBrepMock = vi.fn().mockResolvedValue(validBrepResult);
    const checkPythonScriptMock = vi.fn().mockReturnValue({ ok: true });

    const check = createDesignerCheck({
      runBrep: runBrepMock,
      checkPythonScript: checkPythonScriptMock,
    });

    const state = createMockState();
    const result = await check(state);

    expect(checkPythonScriptMock).toHaveBeenCalledWith(state.currentCode);
    expect(runBrepMock).toHaveBeenCalledWith(state.currentCode, expect.objectContaining({
      interferences: true,
      connectivity: true,
    }));

    expect(result.isValid).toBe(true);
    expect(result.stlContent).toContain('solid model');
    expect(result.stepContent).toBe('STEP-CONTENT');
    expect(result.modelInfo).toBeDefined();
    expect(result.acceptedDesignerScript).toBe(state.currentCode);
    expect(result.designerCheckCompleted).toBe(true);
    expect(result.designerCheckFailures).toBeNull();
  });

  it('on first failure, records plain-words failure and sets retry count to 1', async () => {
    const failBrepResult: BrepResult = {
      ok: true,
      parts: [
        { label: 'box', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] },
        { label: 'lid', valid: false, volume: 200, min: [0, 0, 10], max: [10, 10, 12] },
      ],
      solids: 2,
      ms: 100,
      disconnected: ['lid'],
      interferences: [{ a: 'box', b: 'lid', volume: 5.5 }],
    };

    const runBrepMock = vi.fn().mockResolvedValue(failBrepResult);
    const check = createDesignerCheck({
      runBrep: runBrepMock,
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    const state = createMockState({ designerRetryCount: 0 });
    const result = await check(state);

    expect(result.isValid).toBe(false);
    expect(result.designerRetryCount).toBe(1);
    expect(result.designerCheckCompleted).toBe(false);
    expect(result.designerCheckFailures).toContain('invalid part: lid');
    expect(result.designerCheckFailures).toContain('disconnected parts: lid');
    expect(result.designerCheckFailures).toContain('interferences in closed pose: box collides with lid');
  });

  it('on second failure with compilation error, outputs "The script did not compile: ..."', async () => {
    const compileFailResult: BrepResult = {
      ok: false,
      error: 'SyntaxError: unexpected token',
      parts: [],
      solids: 0,
      ms: 50,
    };

    const runBrepMock = vi.fn().mockResolvedValue(compileFailResult);
    const check = createDesignerCheck({
      runBrep: runBrepMock,
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    const state = createMockState({ designerRetryCount: 1 });
    const result = await check(state);

    expect(result.isValid).toBe(false);
    expect(result.designerRetryCount).toBe(2);
    expect(result.designerCheckCompleted).toBe(true);
    expect(result.explanation).toMatch(/The script did not compile: SyntaxError/);
    expect(result.explanation).not.toContain('Built, but failed checks:');
  });

  it('on second failure with geometric check errors, outputs "Built, but failed checks: ..."', async () => {
    const failBrepResult: BrepResult = {
      ok: true,
      parts: [
        { label: 'box', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] },
      ],
      solids: 1,
      ms: 100,
      disconnected: ['isolated_pin'],
    };

    const runBrepMock = vi.fn().mockResolvedValue(failBrepResult);
    const check = createDesignerCheck({
      runBrep: runBrepMock,
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    const state = createMockState({ designerRetryCount: 1 });
    const result = await check(state);

    expect(result.isValid).toBe(false);
    expect(result.designerRetryCount).toBe(2);
    expect(result.designerCheckCompleted).toBe(true);
    expect(result.explanation).toMatch(/^Built, but failed checks: disconnected parts: isolated_pin/);
    expect(result.explanation).not.toContain('did not compile');
  });

  it('catches guardrail check failure before running brep', async () => {
    const runBrepMock = vi.fn();
    const checkPythonScriptMock = vi.fn().mockReturnValue({ ok: false, reason: 'banned import of os' });

    const check = createDesignerCheck({
      runBrep: runBrepMock,
      checkPythonScript: checkPythonScriptMock,
    });

    const state = createMockState({ designerRetryCount: 1 });
    const result = await check(state);

    expect(runBrepMock).not.toHaveBeenCalled();
    expect(result.isValid).toBe(false);
    expect(result.explanation).toContain('The script did not compile: banned import of os');
  });

  it('aborts on signal cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const check = createDesignerCheck({
      runBrep: vi.fn(),
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    await expect(check(createMockState(), { signal: controller.signal } as never)).rejects.toThrow();
  });
});
