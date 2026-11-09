import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createDesignerNode } from './node';
import type { AgentStateType } from './state';
import type { DesignerResult, DesignerEvent, ReviewFlag } from './types';
import { BUILD_FAILED, REFUSAL } from '../../persist/phrases';
import { UnusableReplyError } from '../llm-schemas';

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
    designerSummary: '',
    designerTurns: 0,
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

  it('a follow-up edit gets priorScript from baseBody', async () => {
    const runDesignerMock = vi.fn().mockResolvedValue(mockResult);
    const node = createDesignerNode({ runDesigner: runDesignerMock });

    const state = createMockState({
      triageKind: 'edit',
      baseBody: 'def original_bracket(): pass',
      baseRequest: 'make a 50mm mounting bracket',
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

  it('an edit carries the earlier edits with the base request', async () => {
    const runDesignerMock = vi.fn().mockResolvedValue(mockResult);
    const node = createDesignerNode({ runDesigner: runDesignerMock });

    const state = createMockState({
      triageKind: 'edit',
      baseBody: 'L = 234',
      baseRequest: 'A desk organizer tray 180 x 100 x 35 mm.',
      baseEdits: ['Make it 30% wider along the X axis.'],
      messages: [
        new HumanMessage('A desk organizer tray 180 x 100 x 35 mm.'),
        new HumanMessage('Make it 30% wider along the X axis.'),
        new HumanMessage('Round the outside vertical corners.'),
      ],
    });

    await node(state);

    const [input] = runDesignerMock.mock.calls[0];
    expect(input.request).toBe(
      'A desk organizer tray 180 x 100 x 35 mm.\n\n' +
        'Earlier edits, already applied to the current design (where they conflict with the request above, the edits win):\n' +
        '1. Make it 30% wider along the X axis.'
    );
    expect(input.editRequest).toBe('Round the outside vertical corners.');
    expect(input.priorScript).toBe('L = 234');
  });

  it('a check retry of an edit keeps the earlier edits in the request', async () => {
    const runDesignerMock = vi.fn().mockResolvedValue(mockResult);
    const node = createDesignerNode({ runDesigner: runDesignerMock });

    const state = createMockState({
      triageKind: 'edit',
      currentCode: 'L = 234  # broken',
      baseRequest: 'a tray 180 mm long',
      baseEdits: ['make it 234 mm long', '  ', 'add a lid'],
      designerCheckFailures: 'disconnected parts: lid',
      designerRetryCount: 1,
      designerCheckCompleted: false,
      messages: [new HumanMessage('a tray 180 mm long'), new HumanMessage('add a divider')],
    });

    await node(state);

    const [input] = runDesignerMock.mock.calls[0];
    expect(input.request).toContain('a tray 180 mm long\n\nEarlier edits');
    expect(input.request).toContain('\n1. make it 234 mm long\n2. add a lid');
    expect(input.editRequest).toBe('disconnected parts: lid');
  });

  it('an attachment in graph input reaches runDesigner', async () => {
    const runDesignerMock = vi.fn().mockResolvedValue(mockResult);
    const node = createDesignerNode({ runDesigner: runDesignerMock });

    const state = createMockState({
      attachments: [{ mediaType: 'image/png', base64: 'PNG-DATA' }],
      messages: [new HumanMessage('make this image as CAD')],
    });

    await node(state);

    const [input] = runDesignerMock.mock.calls[0];
    expect(input.attachments).toEqual([{ mediaType: 'image/png', base64: 'PNG-DATA' }]);
  });

  it('a refusal → REFUSAL', async () => {
    // Case 1: runDesigner result with failed, no script, and stop refusal
    const runDesignerMock1 = vi.fn().mockResolvedValue({
      failed: true,
      script: '',
      stop: 'refusal',
      facts: { ok: false, parts: [], interferences: [], disconnected: [], dimensions: [] },
      summary: '',
      reviewerFlags: [],
      turns: 1,
      costUsd: 0.01,
    });
    const node1 = createDesignerNode({ runDesigner: runDesignerMock1 });
    const res1 = await node1(createMockState({ triageKind: 'new' }));
    expect(res1.outcome?.replyKind).toBe('error');
    expect(res1.outcome?.replyMarkdown).toBe(REFUSAL);
    expect(res1.outcome?.design).toBeUndefined();

    // Case 2: UnusableReplyError with stop refusal
    const runDesignerMock2 = vi.fn().mockRejectedValue(new UnusableReplyError('refusal'));
    const node2 = createDesignerNode({ runDesigner: runDesignerMock2 });
    const res2 = await node2(createMockState({ triageKind: 'edit' }));
    expect(res2.outcome?.replyKind).toBe('error');
    expect(res2.outcome?.replyMarkdown).toBe(REFUSAL);
    expect(res2.outcome?.design).toBeUndefined();
  });

  it('unusable output → BUILD_FAILED', async () => {
    // Case 1: failed with empty script and no stop
    const runDesignerMock1 = vi.fn().mockResolvedValue({
      failed: true,
      script: '',
      facts: { ok: false, parts: [], interferences: [], disconnected: [], dimensions: [] },
      summary: '',
      reviewerFlags: [],
      turns: 1,
      costUsd: 0.01,
    });
    const node1 = createDesignerNode({ runDesigner: runDesignerMock1 });
    const res1 = await node1(createMockState());
    expect(res1.outcome?.replyKind).toBe('error');
    expect(res1.outcome?.replyMarkdown).toBe(BUILD_FAILED);
    expect(res1.outcome?.design).toBeUndefined();

    // Case 2: thrown UnusableReplyError with other stop reason
    const runDesignerMock2 = vi.fn().mockRejectedValue(new UnusableReplyError('max_tokens'));
    const node2 = createDesignerNode({ runDesigner: runDesignerMock2 });
    const res2 = await node2(createMockState());
    expect(res2.outcome?.replyKind).toBe('error');
    expect(res2.outcome?.replyMarkdown).toBe(BUILD_FAILED);
    expect(res2.outcome?.design).toBeUndefined();
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

  it("the designer node forwards cost events as custom {t:'cost'}", async () => {
    const runDesignerMock = vi.fn().mockImplementation(async (_input, deps) => {
      deps.onEvent?.({ kind: 'cost', usd: 0.042 });
      return mockResult;
    });

    const node = createDesignerNode({
      runDesigner: runDesignerMock,
      makeReviewer: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ flags: [], costUsd: 0 })),
    });

    const writerMock = vi.fn();
    const state = createMockState();
    await node(state, { writer: writerMock });

    expect(writerMock).toHaveBeenCalledWith({ t: 'cost', usd: 0.042 });
  });

  it('the designer node passes a wall budget from deadlineAt', async () => {
    const runDesignerMock = vi.fn().mockResolvedValue(mockResult);

    const node = createDesignerNode({
      runDesigner: runDesignerMock,
      makeReviewer: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ flags: [], costUsd: 0 })),
    });

    const now = Date.now();
    const state = createMockState();
    // deadlineAt is now + 400_000 -> remaining - 150_000 = 250_000
    await node(state, { configurable: { deadlineAt: now + 400_000 } });

    expect(runDesignerMock).toHaveBeenCalledTimes(1);
    const [, deps] = runDesignerMock.mock.calls[0];
    expect(deps.wallMs).toBeGreaterThanOrEqual(249_000);
    expect(deps.wallMs).toBeLessThanOrEqual(250_000);
  });
});
