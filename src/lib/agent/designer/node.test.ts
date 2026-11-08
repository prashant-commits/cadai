import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createDesignerNode } from './node';
import type { AgentStateType } from './state';
import type { DesignerResult, DesignerEvent, ReviewFlag } from './types';

function createMockState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    messages: [new HumanMessage('make a 50mm mounting bracket')],
    designContract: null,
    currentCode: '',
    explanation: '',
    modelInfo: null,
    isValid: false,
    stlContent: null,
    stepContent: null,
    attemptCount: 0,
    maxAttempts: 1,
    failureKind: 'none',
    pipeline: null,
    kernel: null,
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
  };
}

const mockResult: DesignerResult = {
  script: 'def part(): pass',
  facts: {
    ok: true,
    parts: [{ label: 'bracket', size: [50, 20, 10], valid: true }],
    interferences: [],
    disconnected: [],
    dimensions: [{ name: 'length', value: 50 }],
  },
  summary: 'Created a 50mm mounting bracket with 2 holes.',
  reviewerFlags: [
    { severity: 'minor', issue: 'sharp corners', whyItMatters: 'may crack under load', round: 1, final: true },
  ],
  turns: 2,
  costUsd: 0.05,
};

describe('designerNode', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('calls runDesigner with input and default dependencies', async () => {
    const runDesignerMock = vi.fn().mockResolvedValue(mockResult);
    const reviewMock = vi.fn().mockResolvedValue({ flags: [], costUsd: 0 });
    const makeReviewerMock = vi.fn().mockReturnValue(reviewMock);

    const node = createDesignerNode({
      runDesigner: runDesignerMock,
      makeReviewer: makeReviewerMock,
      model: 'test-model',
    });

    const state = createMockState();
    const result = await node(state);

    expect(runDesignerMock).toHaveBeenCalledTimes(1);
    const [input, deps] = runDesignerMock.mock.calls[0];
    expect(input.request).toBe('make a 50mm mounting bracket');
    expect(input.priorScript).toBeUndefined();
    expect(input.editRequest).toBeUndefined();
    expect(deps.review).toBe(reviewMock);
    expect(deps.model).toBe('test-model');

    expect(result.pipeline).toBe('designer');
    expect(result.kernel).toBe('brep');
    expect(result.currentCode).toBe(mockResult.script);
    expect(result.designerFacts).toEqual(mockResult.facts);
    expect(result.designerFlags).toEqual(mockResult.reviewerFlags);
    expect(result.designerCostUsd).toBe(0.05);
    expect(result.designerSummary).toBe(mockResult.summary);
    expect(result.acceptedDesignerScript).toBe(mockResult.script);
  });

  it('disables reviewer when CADAI_REVIEWER=off', async () => {
    process.env.CADAI_REVIEWER = 'off';
    const runDesignerMock = vi.fn().mockResolvedValue(mockResult);
    const makeReviewerMock = vi.fn();

    const node = createDesignerNode({
      runDesigner: runDesignerMock,
      makeReviewer: makeReviewerMock,
    });

    await node(createMockState());
    expect(makeReviewerMock).not.toHaveBeenCalled();
    const [, deps] = runDesignerMock.mock.calls[0];
    expect(deps.review).toBeUndefined();
  });

  it('renders events as delta stream events', async () => {
    let capturedOnEvent: ((e: DesignerEvent) => void) | undefined;
    const runDesignerMock = vi.fn().mockImplementation(async (_input, deps) => {
      capturedOnEvent = deps.onEvent;
      return mockResult;
    });

    const formatFlagsMock = vi.fn().mockReturnValue('- **[BLOCKING]** Hole missing: needed for screw');
    const node = createDesignerNode({
      runDesigner: runDesignerMock,
      formatFlags: formatFlagsMock,
    });

    const writerMock = vi.fn();
    const config = { writer: writerMock } as unknown as import('@langchain/langgraph').LangGraphRunnableConfig;

    await node(createMockState(), config);

    expect(capturedOnEvent).toBeDefined();

    // Test step event
    capturedOnEvent!({ kind: 'step', text: 'Built the model (1 part)' });
    expect(writerMock).toHaveBeenCalledWith(expect.objectContaining({
      t: 'delta',
      node: 'designerNode',
      text: 'Built the model (1 part)\n',
    }));

    // Test note event
    capturedOnEvent!({ kind: 'note', text: 'Approaching turn budget' });
    expect(writerMock).toHaveBeenCalledWith(expect.objectContaining({
      t: 'delta',
      node: 'designerNode',
      text: 'Approaching turn budget\n',
    }));

    // Test review event
    const flags: ReviewFlag[] = [{ severity: 'blocking', issue: 'Hole missing', whyItMatters: 'needed for screw' }];
    capturedOnEvent!({ kind: 'review', flags, final: false });
    expect(formatFlagsMock).toHaveBeenCalledWith(flags, false);
    expect(writerMock).toHaveBeenCalledWith(expect.objectContaining({
      t: 'delta',
      node: 'designerNode',
      text: '- **[BLOCKING]** Hole missing: needed for screw\n',
    }));
  });

  it('routes follow-up user edit with priorScript and editRequest', async () => {
    const runDesignerMock = vi.fn().mockResolvedValue(mockResult);
    const node = createDesignerNode({ runDesigner: runDesignerMock });

    const state = createMockState({
      acceptedDesignerScript: 'def original_bracket(): pass',
      messages: [
        new HumanMessage('make a 50mm mounting bracket'),
        new HumanMessage('make it 60mm instead'),
      ],
    });

    await node(state);

    const [input] = runDesignerMock.mock.calls[0];
    expect(input.request).toBe('make a 50mm mounting bracket');
    expect(input.priorScript).toBe('def original_bracket(): pass');
    expect(input.editRequest).toBe('make it 60mm instead');
  });

  it('routes check failure retry with priorScript and failures text', async () => {
    const runDesignerMock = vi.fn().mockResolvedValue(mockResult);
    const node = createDesignerNode({ runDesigner: runDesignerMock });

    const state = createMockState({
      currentCode: 'def broken(): pass',
      designerCheckFailures: 'disconnected parts: part_b; interferences in closed pose: a collides with b',
      designerRetryCount: 1,
      designerCheckCompleted: false,
    });

    const result = await node(state);

    const [input] = runDesignerMock.mock.calls[0];
    expect(input.priorScript).toBe('def broken(): pass');
    expect(input.editRequest).toBe('disconnected parts: part_b; interferences in closed pose: a collides with b');
    expect(result.designerCheckFailures).toBeNull();
  });

  it('aborts on signal cancellation before and during execution', async () => {
    const runDesignerMock = vi.fn();
    const node = createDesignerNode({ runDesigner: runDesignerMock });

    // Pre-aborted controller
    const controller = new AbortController();
    controller.abort();

    await expect(node(createMockState(), { signal: controller.signal } as never)).rejects.toThrow();
    expect(runDesignerMock).not.toHaveBeenCalled();

    // Aborted during execution
    const liveController = new AbortController();
    runDesignerMock.mockImplementation(async (_input, deps) => {
      liveController.abort();
      if (deps.signal?.aborted) {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      }
      return mockResult;
    });

    await expect(node(createMockState(), { signal: liveController.signal } as never)).rejects.toThrow();
  });
});
