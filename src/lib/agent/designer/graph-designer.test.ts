import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createDesignerAgent } from './graph';
import type { AgentStateType } from './state';
import type { DesignerResult, RunDesignerFn } from './types';
import type { BrepResult } from '../../engine/brep-runner';
import { BUILD_FAILED, COMPILE_FAILED, FAILED_CHECKS, REFUSAL } from '../../persist/phrases';
import type { RunOutcome } from '../../persist/types';
import { PRELUDE_VERSION } from '../../brep/prelude';
import { UnusableReplyError } from '../llm-schemas';

const callMock = vi.fn();

vi.mock('@langchain/anthropic', () => {
  class FakeChatModel {
    invoke = (messages: unknown) => callMock(messages);
    async *stream(messages: unknown) { yield await callMock(messages); }
    withStructuredOutput() { return this; }
    withConfig() { return this; }
    bindTools() { return this; }
  }
  return { ChatAnthropic: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

const mockStlAscii = 'solid model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid model';
const mockStlBase64 = Buffer.from(mockStlAscii).toString('base64');

const mockSuccessBrep: BrepResult = {
  ok: true,
  parts: [{ label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
  solids: 1,
  stl: mockStlBase64,
  step: 'STEP-DATA-SUCCESS',
  ms: 80,
  disconnected: [],
  interferences: [],
};

const mockSuccessDesignerResult: DesignerResult = {
  script: 'base = Box(10, 10, 10)\n_cadai_parts = [base]',
  facts: {
    ok: true,
    parts: [{ label: 'base', size: [10, 10, 10], valid: true }],
    interferences: [],
    disconnected: [],
    dimensions: [{ name: 'size', value: 10 }],
  },
  summary: '10mm cube base',
  reviewerFlags: [
    { severity: 'minor', issue: 'check wall clearance', whyItMatters: 'for assembly', round: 1, final: true },
  ],
  turns: 1,
  costUsd: 0.02,
};

describe('designer mode graph wiring', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    callMock.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('routes to designer pipeline when CADAI_PIPELINE=designer and produces STL/STEP on success', async () => {
    process.env.CADAI_PIPELINE = 'designer';

    const runDesignerMock = vi.fn<RunDesignerFn>().mockImplementation(async (_input, deps) => {
      deps.onEvent?.({ kind: 'step', text: 'Modeling 10mm cube' });
      return mockSuccessDesignerResult;
    });
    const runBrepMock = vi.fn().mockResolvedValue(mockSuccessBrep);

    const agent = createDesignerAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
    });

    const state = (await agent.invoke({ messages: [new HumanMessage('make a 10mm cube')] })) as AgentStateType;

    expect(state.pipeline).toBe('designer');
    expect(state.kernel).toBe('brep');
    expect(runDesignerMock).toHaveBeenCalledTimes(1);
    expect(runBrepMock).toHaveBeenCalledTimes(1);
    expect(state.isValid).toBe(true);
    expect(state.stlContent).toContain('solid model');
    expect(state.stepContent).toBe('STEP-DATA-SUCCESS');
    expect(state.currentCode).toBe(mockSuccessDesignerResult.script);
    expect(state.outcome?.replyKind).toBe('result');
    expect(state.outcome?.design).toBeDefined();
  });

  it('routes follow-up message to designerNode as an edit with priorScript and editRequest', async () => {
    process.env.CADAI_PIPELINE = 'designer';

    let turn = 1;
    const runDesignerMock = vi.fn<RunDesignerFn>().mockImplementation(async () => {
      if (turn === 1) {
        return mockSuccessDesignerResult;
      }
      return {
        ...mockSuccessDesignerResult,
        script: 'base = Box(20, 20, 20)\n_cadai_parts = [base]',
        summary: '20mm cube base',
      };
    });
    const runBrepMock = vi.fn().mockResolvedValue(mockSuccessBrep);

    const agent = createDesignerAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
      classify: async () => (turn === 1 ? 'new' : 'edit'),
    });

    // Turn 1
    const res1 = (await agent.invoke({ messages: [new HumanMessage('make a 10mm cube')] })) as AgentStateType;

    expect(runDesignerMock).toHaveBeenCalledTimes(1);
    expect(runDesignerMock.mock.calls[0][0].priorScript).toBeUndefined();

    // Turn 2: Follow-up
    turn = 2;
    await agent.invoke({
      messages: [...(res1.messages ?? []), new HumanMessage('make it 20mm')],
      baseVersion: 1,
      baseBody: res1.outcome?.design?.body ?? res1.currentCode,
      baseRequest: 'make a 10mm cube',
    });

    expect(runDesignerMock).toHaveBeenCalledTimes(2);
    const [secondInput] = runDesignerMock.mock.calls[1];
    expect(secondInput.request).toBe('make a 10mm cube');
    expect(secondInput.priorScript).toBe(mockSuccessDesignerResult.script);
    expect(secondInput.editRequest).toBe('make it 20mm');
  });

  it('retries once on check failure, then presents honest message on second failure', async () => {
    process.env.CADAI_PIPELINE = 'designer';

    let designerCallCount = 0;
    const runDesignerMock = vi.fn<RunDesignerFn>().mockImplementation(async () => {
      designerCallCount++;
      return {
        ...mockSuccessDesignerResult,
        script: `script_v${designerCallCount}`,
      };
    });

    // Both check runs fail
    const failingBrep: BrepResult = {
      ok: true,
      parts: [{ label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
      solids: 1,
      ms: 50,
      disconnected: ['floating_boss'],
      interferences: [],
    };
    const runBrepMock = vi.fn().mockResolvedValue(failingBrep);

    const agent = createDesignerAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
    });

    const state = (await agent.invoke({ messages: [new HumanMessage('make a part')] })) as AgentStateType;

    expect(runDesignerMock).toHaveBeenCalledTimes(2);
    expect(runBrepMock).toHaveBeenCalledTimes(2);

    const [secondInput] = runDesignerMock.mock.calls[1];
    expect(secondInput.priorScript).toBe('script_v1');
    expect(secondInput.editRequest).toContain('disconnected parts: floating_boss');

    expect(state.isValid).toBe(false);
    expect(state.explanation).toContain(FAILED_CHECKS);
    expect(state.explanation).toContain('`floating_boss`');
    expect(state.explanation).not.toContain('did not compile');
    expect(state.outcome?.replyKind).toBe('error');
  });

  it('outputs "The script did not compile: ..." ONLY when it did not compile', async () => {
    process.env.CADAI_PIPELINE = 'designer';

    const runDesignerMock = vi.fn<RunDesignerFn>().mockResolvedValue(mockSuccessDesignerResult);
    const compileFailBrep: BrepResult = {
      ok: false,
      error: 'NameError: name Box is not defined',
      parts: [],
      solids: 0,
      ms: 20,
    };
    const runBrepMock = vi.fn().mockResolvedValue(compileFailBrep);

    const agent = createDesignerAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
    });

    const state = (await agent.invoke({ messages: [new HumanMessage('make a part')] })) as AgentStateType;

    expect(state.isValid).toBe(false);
    expect(state.explanation).toBe(COMPILE_FAILED);
    expect(state.explanation).not.toContain('Built, but failed checks:');
    expect(state.explanation).not.toContain('NameError');
    expect(state.outcome?.replyKind).toBe('error');
    expect(state.outcome?.replyMarkdown).toContain(COMPILE_FAILED);
  });

  it('cancellation via AbortSignal halts execution', async () => {
    process.env.CADAI_PIPELINE = 'designer';

    const controller = new AbortController();
    const runDesignerMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('The run was stopped.'), { name: 'AbortError' });
    });

    const agent = createDesignerAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: vi.fn(),
    });

    await expect(
      agent.invoke(
        { messages: [new HumanMessage('make a part')] },
        { signal: controller.signal }
      )
    ).rejects.toThrow();
  });

  it('a question goes to designerAnswer and never through designerCheck', async () => {
    const runDesignerMock = vi.fn();
    const runBrepMock = vi.fn();
    const answerMock = vi.fn().mockResolvedValue('The cube is 10mm.');

    const agent = createDesignerAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
      classify: async () => 'question',
      answer: answerMock,
    });

    const state = (await agent.invoke({
      messages: [new HumanMessage('what is this?')],
      baseBody: 'box = Box(10, 10, 10)',
      baseVersion: 1,
    })) as AgentStateType;

    expect(answerMock).toHaveBeenCalledTimes(1);
    expect(runDesignerMock).not.toHaveBeenCalled();
    expect(runBrepMock).not.toHaveBeenCalled();
    expect(state.outcome?.replyKind).toBe('answer');
    expect(state.outcome?.replyMarkdown).toBe('The cube is 10mm.');
    expect(state.outcome?.design).toBeUndefined();
  });

  it('new → parent_version null', async () => {
    const runDesignerMock = vi.fn<RunDesignerFn>().mockResolvedValue(mockSuccessDesignerResult);
    const runBrepMock = vi.fn().mockResolvedValue(mockSuccessBrep);

    const agent = createDesignerAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
      classify: async () => 'new',
    });

    const state = (await agent.invoke({
      messages: [new HumanMessage('now make a desk lamp')],
      baseBody: 'box = Box(10, 10, 10)',
      baseVersion: 5,
    })) as AgentStateType;

    expect(state.outcome?.design?.parentVersion).toBeNull();
  });

  it('a second edit builds on the first', async () => {
    let callCount = 0;
    const runDesignerMock = vi.fn<RunDesignerFn>().mockImplementation(async () => {
      callCount++;
      return {
        ...mockSuccessDesignerResult,
        script: `box = Box(${callCount * 10}, 10, 10)\n_cadai_parts = [box]`,
      };
    });
    const runBrepMock = vi.fn().mockResolvedValue(mockSuccessBrep);

    const agent = createDesignerAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
      classify: async () => 'edit',
    });

    // Run 1: fresh build
    const state1 = (await agent.invoke({
      messages: [new HumanMessage('make a 10mm box')],
    })) as AgentStateType;

    expect(state1.outcome?.design?.body).toBeDefined();

    // Run 2: second edit seeded from run 1
    await agent.invoke({
      messages: [new HumanMessage('make a 10mm box'), new HumanMessage('make it 20mm')],
      baseBody: state1.outcome?.design?.body,
      baseVersion: 1,
    });

    expect(runDesignerMock).toHaveBeenCalledTimes(2);
    const secondCall = runDesignerMock.mock.calls[1][0];
    expect(secondCall.priorScript).toBe(state1.outcome?.design?.body);
  });

  it('the graph ends at END with outcome for each outcome kind', async () => {
    // 1. result with design
    const agentPass = createDesignerAgent('gpt-6-sol', {
      runDesigner: vi.fn<RunDesignerFn>().mockResolvedValue(mockSuccessDesignerResult),
      runBrep: vi.fn().mockResolvedValue(mockSuccessBrep),
    });
    const s1 = (await agentPass.invoke({ messages: [new HumanMessage('make a box')] })) as AgentStateType;
    expect(s1.outcome).toBeDefined();
    expect(s1.outcome?.replyKind).toBe('result');
    expect(s1.outcome?.replyMarkdown).toContain('**Designer**');
    expect(s1.outcome?.design).toBeDefined();
    expect(s1.outcome?.design?.body).toBe(mockSuccessDesignerResult.script);

    // 2. answer
    const agentAnswer = createDesignerAgent('gpt-6-sol', {
      classify: vi.fn().mockResolvedValue({ label: 'question', costUsd: 0 }),
      answer: vi.fn().mockResolvedValue({ answer: 'It is a 10mm cube.', costUsd: 0 }),
    });
    const s2 = (await agentAnswer.invoke({
      messages: [new HumanMessage('how tall is it?')],
      baseBody: 'box = Box(10, 10, 10)',
    })) as AgentStateType;
    expect(s2.outcome).toBeDefined();
    expect(s2.outcome?.replyKind).toBe('answer');
    expect(s2.outcome?.replyMarkdown).toBe('It is a 10mm cube.');

    // 3. nochange
    const agentNoChange = createDesignerAgent('gpt-6-sol', {
      classify: vi.fn().mockResolvedValue({ label: 'edit', costUsd: 0 }),
      runDesigner: vi.fn<RunDesignerFn>().mockResolvedValue({
        script: 'box = Box(10, 10, 10)',
        facts: mockSuccessDesignerResult.facts,
        summary: 'No change',
        reviewerFlags: [],
        turns: 1,
        costUsd: 0.05,
      }),
      runBrep: vi.fn().mockResolvedValue(mockSuccessBrep),
    });
    const s3 = (await agentNoChange.invoke({
      messages: [new HumanMessage('leave it alone')],
      baseBody: 'box = Box(10, 10, 10)',
    })) as AgentStateType;
    expect(s3.outcome).toBeDefined();
    expect(s3.outcome?.replyKind).toBe('nochange');
    expect(s3.outcome?.replyMarkdown).toBe(
      '**Designer**\n\nNo change\n\nThe design is unchanged (still vnull).'
    );

    // 4. error
    const agentRefusal = createDesignerAgent('gpt-6-sol', {
      classify: vi.fn().mockRejectedValue(new UnusableReplyError('refusal')),
    });
    const s4 = (await agentRefusal.invoke({
      messages: [new HumanMessage('bad request')],
      baseBody: 'box = Box(10, 10, 10)',
    })) as AgentStateType;
    expect(s4.outcome).toBeDefined();
    expect(s4.outcome?.replyKind).toBe('error');
    expect(s4.outcome?.replyMarkdown).toBe(REFUSAL);
  });

  it("an edit's design edits accumulate baseEdits", async () => {
    const agent = createDesignerAgent('gpt-6-sol', {
      classify: vi.fn().mockResolvedValue({ label: 'edit', costUsd: 0 }),
      runDesigner: vi.fn<RunDesignerFn>().mockResolvedValue(mockSuccessDesignerResult),
      runBrep: vi.fn().mockResolvedValue(mockSuccessBrep),
    });
    const state = (await agent.invoke({
      messages: [new HumanMessage('b')],
      baseBody: 'box = Box(10, 10, 10)',
      baseRequest: 'make a box',
      baseEdits: ['a'],
    })) as AgentStateType;
    expect(state.outcome).toBeDefined();
    expect(state.outcome?.design?.edits).toEqual(['a', 'b']);
  });

  it('every path that reaches END sets outcome', async () => {
    // We test each of the distinct paths in the graph to confirm outcome is set on all:
    // Path 1: fresh build succeeds
    const agentPass = createDesignerAgent('gpt-6-sol', {
      runDesigner: vi.fn<RunDesignerFn>().mockResolvedValue(mockSuccessDesignerResult),
      runBrep: vi.fn().mockResolvedValue(mockSuccessBrep),
    });
    const s1 = (await agentPass.invoke({ messages: [new HumanMessage('make a box')] })) as AgentStateType;
    expect(s1.outcome).toBeDefined();
    expect(s1.outcome?.replyKind).toBe('result');

    // Path 2: question
    const agentQuestion = createDesignerAgent('gpt-6-sol', {
      classify: async () => 'question',
      answer: async () => 'answered',
    });
    const s2 = (await agentQuestion.invoke({
      messages: [new HumanMessage('what is this?')],
      baseBody: 'box = Box(10, 10, 10)',
    })) as AgentStateType;
    expect(s2.outcome).toBeDefined();
    expect(s2.outcome?.replyKind).toBe('answer');

    // Path 3: triage refusal
    const agentTriageRefusal = createDesignerAgent('gpt-6-sol', {
      classify: async () => {
        throw new UnusableReplyError('refusal');
      },
    });
    const s3 = (await agentTriageRefusal.invoke({
      messages: [new HumanMessage('bad request')],
      baseBody: 'box = Box(10, 10, 10)',
    })) as AgentStateType;
    expect(s3.outcome).toBeDefined();
    expect(s3.outcome?.replyKind).toBe('error');
    expect(s3.outcome?.replyMarkdown).toBe(REFUSAL);

    // Path 4: designer refusal
    const agentDesignerRefusal = createDesignerAgent('gpt-6-sol', {
      runDesigner: vi.fn().mockRejectedValue(new UnusableReplyError('refusal')),
    });
    const s4 = (await agentDesignerRefusal.invoke({
      messages: [new HumanMessage('bad request')],
    })) as AgentStateType;
    expect(s4.outcome).toBeDefined();
    expect(s4.outcome?.replyKind).toBe('error');
    expect(s4.outcome?.replyMarkdown).toBe(REFUSAL);

    // Path 5: designer unusable output
    const agentDesignerUnusable = createDesignerAgent('gpt-6-sol', {
      runDesigner: vi.fn().mockRejectedValue(new UnusableReplyError('max_tokens')),
    });
    const s5 = (await agentDesignerUnusable.invoke({
      messages: [new HumanMessage('make a complex part')],
    })) as AgentStateType;
    expect(s5.outcome).toBeDefined();
    expect(s5.outcome?.replyKind).toBe('error');
    expect(s5.outcome?.replyMarkdown).toBe(BUILD_FAILED);

    // Path 6: check fail twice with mesh
    const failBrepWithMesh: BrepResult = {
      ok: true,
      parts: [
        { label: 'box', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] },
        { label: 'isolated', valid: true, volume: 100, min: [20, 0, 0], max: [30, 10, 10] },
      ],
      solids: 2,
      disconnected: ['isolated'],
      interferences: [],
      stl: Buffer.from('solid ...\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid').toString('base64'),
      ms: 50,
    };
    const agentFailMesh = createDesignerAgent('gpt-6-sol', {
      runDesigner: vi.fn<RunDesignerFn>().mockResolvedValue(mockSuccessDesignerResult),
      runBrep: vi.fn().mockResolvedValue(failBrepWithMesh),
    });
    const s6 = (await agentFailMesh.invoke({ messages: [new HumanMessage('make a box')] })) as AgentStateType;
    expect(s6.outcome).toBeDefined();
    expect(s6.outcome?.replyKind).toBe('error');
    expect(s6.outcome?.design?.flags).toContain('failed_checks');

    // Path 7: check fail twice without mesh
    const agentFailNoMesh = createDesignerAgent('gpt-6-sol', {
      runDesigner: vi.fn<RunDesignerFn>().mockResolvedValue(mockSuccessDesignerResult),
      runBrep: vi.fn().mockResolvedValue({ ok: false, error: 'compile error', ms: 20, parts: [], solids: 0 }),
    });
    const s7 = (await agentFailNoMesh.invoke({ messages: [new HumanMessage('make a box')] })) as AgentStateType;
    expect(s7.outcome).toBeDefined();
    expect(s7.outcome?.replyKind).toBe('error');
    expect(s7.outcome?.design).toBeUndefined();

    // Path 8: edit unchanged body
    const body = 'box = Box(10, 10, 10)\n_cadai_parts = [box]';
    const agentNoChange = createDesignerAgent('gpt-6-sol', {
      runDesigner: vi.fn<RunDesignerFn>().mockResolvedValue({
        ...mockSuccessDesignerResult,
        script: body,
      }),
      runBrep: vi.fn().mockResolvedValue(mockSuccessBrep),
      classify: async () => 'edit',
    });
    const s8 = (await agentNoChange.invoke({
      messages: [new HumanMessage('make a box'), new HumanMessage('keep it same')],
      baseBody: body,
      baseVersion: 1,
    })) as AgentStateType;
    expect(s8.outcome).toBeDefined();
    expect(s8.outcome?.replyKind).toBe('nochange');
  });

  it('a stale outcome in the input does not short-circuit the next run', async () => {
    const runDesignerMock = vi.fn().mockResolvedValue({
      script: 'def box(): pass\n_cadai_parts = [box]',
      summary: 'New fresh design summary',
      facts: { ok: true, parts: [{ label: 'box', valid: true, size: [10, 10, 10] }], interferences: [], disconnected: [], dimensions: [] },
      reviewerFlags: [],
      turns: 1,
      costUsd: 0.02,
      failed: false,
    });

    const agent = createDesignerAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: vi.fn().mockResolvedValue(mockSuccessBrep),
      classify: async () => 'edit',
    });

    const staleOutcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: '**Designer**\n\nStale old summary',
      userKind: 'request',
      costUsd: 0.05,
      wallMs: 2000,
      turns: 2,
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'make a box',
        edits: [],
        body: 'def old_box(): pass',
        preludeVersion: PRELUDE_VERSION,
        summary: 'Stale old summary',
        facts: null,
        flags: [],
      },
    };

    const finalState = (await agent.invoke({
      messages: [new HumanMessage('make a box'), new HumanMessage('make it taller')],
      baseBody: 'def old_box(): pass',
      baseVersion: 1,
      outcome: staleOutcome,
    })) as AgentStateType;

    expect(runDesignerMock).toHaveBeenCalled();
    expect(finalState.outcome).toBeDefined();
    expect(finalState.outcome?.replyMarkdown).not.toContain('Stale old summary');
    expect(finalState.outcome?.replyMarkdown).toContain('New fresh design summary');
    expect(finalState.outcome).not.toEqual(staleOutcome);
  });
});
