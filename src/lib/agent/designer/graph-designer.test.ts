import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command, isInterrupted } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from '../checkpointer';
import { createCadAgent, resolvePipeline } from '../graph';
import type { AgentStateType } from '../graph';
import type { DesignerResult, RunDesignerFn } from './types';
import type { BrepResult } from '../../engine/brep-runner';

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

const keys: string[] = [];
let counter = 0;
const newKey = () => {
  const k = runCheckpointKey(`dz-${Date.now()}`, `run-${counter++}`);
  keys.push(k);
  return k;
};

afterAll(async () => {
  for (const k of keys) {
    await getCheckpointer().deleteThread(k);
  }
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

    const agent = createCadAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
    });

    const key = newKey();
    const config = { configurable: { thread_id: key } };

    let result = await agent.invoke({ messages: [new HumanMessage('make a 10mm cube')] }, config);

    // Accept gate interrupt
    if (isInterrupted(result)) {
      result = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    }

    const state = (await agent.getState(config)).values as AgentStateType;

    expect(state.pipeline).toBe('designer');
    expect(state.kernel).toBe('brep');
    expect(runDesignerMock).toHaveBeenCalledTimes(1);
    expect(runBrepMock).toHaveBeenCalledTimes(1);
    expect(state.isValid).toBe(true);
    expect(state.stlContent).toContain('solid model');
    expect(state.stepContent).toBe('STEP-DATA-SUCCESS');
    expect(state.currentCode).toBe(mockSuccessDesignerResult.script);
    expect(state.acceptedDesignerScript).toBe(mockSuccessDesignerResult.script);
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

    const agent = createCadAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
    });

    const key = newKey();
    const config = { configurable: { thread_id: key } };

    // Turn 1
    let res1 = await agent.invoke({ messages: [new HumanMessage('make a 10mm cube')] }, config);
    if (isInterrupted(res1)) {
      res1 = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    }

    expect(runDesignerMock).toHaveBeenCalledTimes(1);
    expect(runDesignerMock.mock.calls[0][0].priorScript).toBeUndefined();

    // Turn 2: Follow-up
    turn = 2;
    let res2 = await agent.invoke({ messages: [new HumanMessage('make it 20mm')] }, config);
    if (isInterrupted(res2)) {
      res2 = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    }

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

    const agent = createCadAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
    });

    const key = newKey();
    const config = { configurable: { thread_id: key } };

    let res = await agent.invoke({ messages: [new HumanMessage('make a part')] }, config);
    if (isInterrupted(res)) {
      res = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    }

    // Check failed on v1, retried with v2, failed on v2, ended with honest message
    expect(runDesignerMock).toHaveBeenCalledTimes(2);
    expect(runBrepMock).toHaveBeenCalledTimes(2);

    // Verify retry input on second call
    const [secondInput] = runDesignerMock.mock.calls[1];
    expect(secondInput.priorScript).toBe('script_v1');
    expect(secondInput.editRequest).toContain('disconnected parts: floating_boss');

    const state = (await agent.getState(config)).values as AgentStateType;
    expect(state.isValid).toBe(false);
    expect(state.explanation).toMatch(/^Built, but failed checks: disconnected parts: floating_boss/);
    expect(state.explanation).not.toContain('did not compile');
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

    const agent = createCadAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: runBrepMock,
    });

    const key = newKey();
    const config = { configurable: { thread_id: key } };

    let res = await agent.invoke({ messages: [new HumanMessage('make a part')] }, config);
    if (isInterrupted(res)) {
      res = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    }

    const state = (await agent.getState(config)).values as AgentStateType;
    expect(state.isValid).toBe(false);
    expect(state.explanation).toContain('The script did not compile: NameError: name Box is not defined');
    expect(state.explanation).not.toContain('Built, but failed checks:');
  });

  it('cancellation via AbortSignal halts execution', async () => {
    process.env.CADAI_PIPELINE = 'designer';

    const controller = new AbortController();
    const runDesignerMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('The run was stopped.'), { name: 'AbortError' });
    });

    const agent = createCadAgent('gpt-6-sol', {
      runDesigner: runDesignerMock,
      runBrep: vi.fn(),
    });

    const key = newKey();
    await expect(
      agent.invoke(
        { messages: [new HumanMessage('make a part')] },
        { configurable: { thread_id: key }, signal: controller.signal }
      )
    ).rejects.toThrow();
  });

  it('leaves the architect and drafter pipelines unchanged when CADAI_PIPELINE is unset or drafter', () => {
    expect(resolvePipeline({})).toBe('architect');
    expect(resolvePipeline({ CADAI_PIPELINE: 'drafter' })).toBe('drafter');
    expect(resolvePipeline({ CADAI_PIPELINE: 'designer' })).toBe('designer');
  });
});
