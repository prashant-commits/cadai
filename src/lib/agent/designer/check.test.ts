import { describe, it, expect, vi, afterEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createDesignerCheck, codeLabel } from './check';
import type { AgentStateType } from './state';
import type { BrepResult } from '../../engine/brep-runner';
import { COMPILE_FAILED, FAILED_CHECKS, NO_CHANGE } from '../../persist/phrases';
import { toBody } from '../../brep/prelude';

function createMockState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    messages: [new HumanMessage('make a box')],
    designContract: null,
    currentCode: 'a = 10\n_cadai_parts = [box]',
    explanation: '',
    modelInfo: null,
    isValid: false,
    stlContent: null,
    stepContent: null,
    attemptCount: 1,
    maxAttempts: 1,
    failureKind: 'none',
    pipeline: 'designer',
    kernel: 'brep',
    designerFacts: null,
    designerFlags: [],
    designerCostUsd: 0,
    designerRetryCount: 0,
    designerCheckFailures: null,
    designerCheckCompleted: false,
    designerSummary: 'A simple box',
    designerTurns: 1,
    baseVersion: null,
    baseBody: null,
    baseRequest: null,
    baseEdits: [],
    attachments: [],
    outcome: null,
    triageKind: null,
    startedAt: null,
    designerCheckSentences: [],
    ...overrides,
  };
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
    expect(result.outcome?.replyKind).toBe('result');
    expect(result.outcome?.design?.body).toBe(toBody(state.currentCode));
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

  it('on second failure with compilation error, outputs COMPILE_FAILED', async () => {
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
    expect(result.explanation).toBe(COMPILE_FAILED);
    expect(result.explanation).not.toContain('Built, but failed checks:');
    expect(result.explanation).not.toContain('SyntaxError');
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
    expect(result.explanation).toContain(FAILED_CHECKS);
    expect(result.explanation).toContain('`isolated_pin`');
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
    expect(result.explanation).toBe(COMPILE_FAILED);
    expect(result.explanation).not.toContain('banned import of os');
  });

  it('check fails twice with a mesh → failed_checks version and error reply', async () => {
    const failWithMesh: BrepResult = {
      ok: true,
      parts: [
        { label: 'box', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] },
        { label: 'isolated', valid: true, volume: 100, min: [20, 0, 0], max: [30, 10, 10] },
      ],
      solids: 2,
      disconnected: ['isolated'],
      interferences: [],
      stl: Buffer.from('solid model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid model').toString('base64'),
      step: 'STEP-DATA',
      ms: 50,
    };

    const check = createDesignerCheck({
      runBrep: vi.fn().mockResolvedValue(failWithMesh),
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    const state = createMockState({ designerRetryCount: 1 });
    const result = await check(state);

    expect(result.isValid).toBe(false);
    expect(result.outcome).toBeDefined();
    expect(result.outcome?.replyKind).toBe('error');
    expect(result.outcome?.replyMarkdown.startsWith(FAILED_CHECKS)).toBe(true);
    expect(result.outcome?.design).toBeDefined();
    expect(result.outcome?.design?.flags).toContain('failed_checks');
  });

  it('check fails twice without a mesh → error reply, no version', async () => {
    const failNoMesh: BrepResult = {
      ok: false,
      error: 'SyntaxError: bad syntax',
      parts: [],
      solids: 0,
      ms: 20,
    };

    const check = createDesignerCheck({
      runBrep: vi.fn().mockResolvedValue(failNoMesh),
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    const state = createMockState({ designerRetryCount: 1 });
    const result = await check(state);

    expect(result.isValid).toBe(false);
    expect(result.outcome).toBeDefined();
    expect(result.outcome?.replyKind).toBe('error');
    expect(result.outcome?.replyMarkdown.startsWith(FAILED_CHECKS)).toBe(true);
    expect(result.outcome?.design).toBeUndefined();
  });

  it('a compile error lists COMPILE_FAILED, never the raw error', async () => {
    const secretError = 'Traceback (most recent call last):\nFile "SECRET_PATH/model.py", line 12\nZeroDivisionError: division by zero';
    const failWithSecret: BrepResult = {
      ok: false,
      error: secretError,
      parts: [],
      solids: 0,
      ms: 20,
    };

    const check = createDesignerCheck({
      runBrep: vi.fn().mockResolvedValue(failWithSecret),
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    const state = createMockState({ designerRetryCount: 1 });
    const result = await check(state);

    expect(result.outcome?.replyMarkdown).toContain(COMPILE_FAILED);
    expect(result.outcome?.replyMarkdown).not.toContain('SECRET_PATH');
    expect(result.explanation).toContain(COMPILE_FAILED);
    expect(result.explanation).not.toContain('SECRET_PATH');
    expect(result.designerCheckFailures).toContain(COMPILE_FAILED);
    expect(result.designerCheckFailures).not.toContain('SECRET_PATH');
    expect(result.designerCheckSentences).toContain(`- ${COMPILE_FAILED}`);
    expect(result.designerCheckSentences?.some((s) => s.includes('SECRET_PATH'))).toBe(false);
  });

  it('check sentences escape labels and cap them at 40 chars', async () => {
    const nastyLabel = '`long_part_\nname_with_backticks_' + 'x'.repeat(40) + '`';
    expect(codeLabel(nastyLabel)).toBe('`long_part_name_with_backticks_xxxxxxxxxx`');
    expect(codeLabel(nastyLabel).length).toBe(42); // 40 chars + 2 backticks

    const failResult: BrepResult = {
      ok: true,
      parts: [
        { label: nastyLabel, valid: false, volume: 100, min: [0, 0, 0], max: [10, 10, 10] },
      ],
      solids: 1,
      ms: 20,
    };

    const check = createDesignerCheck({
      runBrep: vi.fn().mockResolvedValue(failResult),
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    const state = createMockState({ designerRetryCount: 0 });
    const result = await check(state);

    expect(result.designerCheckSentences).toBeDefined();
    const sentence = result.designerCheckSentences![0];
    expect(sentence).toContain('`long_part_name_with_backticks_xxxxxxxxxx`');
    expect(sentence).not.toContain('\n');
  });

  it('an unchanged body → nochange, no version', async () => {
    const check = createDesignerCheck({
      runBrep: vi.fn().mockResolvedValue(validBrepResult),
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    const body = 'box = Box(10, 10, 10)\n_cadai_parts = [box]';
    const state = createMockState({
      triageKind: 'edit',
      baseBody: body,
      currentCode: body,
      designerRetryCount: 0,
    });

    const result = await check(state);

    expect(result.isValid).toBe(true);
    expect(result.outcome?.replyKind).toBe('nochange');
    expect(result.outcome?.replyMarkdown).toBe(NO_CHANGE);
    expect(result.outcome?.design).toBeUndefined();
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

  it('a retry never starts with under 60 s left', async () => {
    const failBrep: BrepResult = {
      ok: false,
      error: 'SyntaxError: bad syntax',
      parts: [],
      solids: 0,
      ms: 20,
    };

    const check = createDesignerCheck({
      runBrep: vi.fn().mockResolvedValue(failBrep),
      checkPythonScript: vi.fn().mockReturnValue({ ok: true }),
    });

    const now = Date.now();

    // With deadlineAt = now + 59_000: does not retry, takes final-failure path
    const state0 = createMockState({ designerRetryCount: 0 });
    const result0 = await check(state0, {
      configurable: { deadlineAt: now + 59_000 },
    });
    expect(result0.designerCheckCompleted).toBe(true);
    expect(result0.outcome).toBeDefined();
    expect(result0.outcome?.replyKind).toBe('error');

    // With deadlineAt = now + 61_000: does retry
    const state1 = createMockState({ designerRetryCount: 0 });
    const result1 = await check(state1, {
      configurable: { deadlineAt: now + 61_000 },
    });
    expect(result1.designerCheckCompleted).toBe(false);
    expect(result1.designerRetryCount).toBe(1);
    expect(result1.outcome).toBeUndefined();
  });
});
