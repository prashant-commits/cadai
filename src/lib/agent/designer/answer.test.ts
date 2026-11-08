import { describe, it, expect } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createDesignerAnswer, makeFence } from './answer';
import type { AgentStateType } from './state';
import { BUILD_FAILED, REFUSAL } from '../../persist/phrases';

function createMockState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    messages: [
      new HumanMessage('make a 10mm cube'),
      new HumanMessage('how tall is this model?'),
    ],
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
    baseVersion: 1,
    baseBody: 'box = Box(10, 10, 25)\n_cadai_parts = [box]',
    baseRequest: 'make a 10mm cube',
    baseEdits: [],
    attachments: [],
    outcome: null,
    triageKind: 'question',
    startedAt: 1000,
    designerCheckSentences: [],
    ...overrides,
  };
}

describe('designerAnswer', () => {
  it("a question's outcome has no design", async () => {
    const answerNode = createDesignerAnswer({
      answer: async (question, baseBody) => {
        expect(question).toBe('how tall is this model?');
        expect(baseBody).toContain('Box(10, 10, 25)');
        return 'The model is 25 mm tall.';
      },
    });

    const state = createMockState();
    const res = await answerNode(state);

    expect(res.outcome).toBeDefined();
    expect(res.outcome?.replyKind).toBe('answer');
    expect(res.outcome?.userKind).toBe('question');
    expect(res.outcome?.replyMarkdown).toBe('The model is 25 mm tall.');
    expect(res.outcome?.design).toBeUndefined();
  });

  it('answer refusal → REFUSAL error', async () => {
    const answerNode = createDesignerAnswer({
      answer: async () => {
        return { answer: '', raw: { response_metadata: { stop_reason: 'refusal' } } };
      },
    });

    const state = createMockState();
    const res = await answerNode(state);

    expect(res.outcome).toBeDefined();
    expect(res.outcome?.replyKind).toBe('error');
    expect(res.outcome?.replyMarkdown).toBe(REFUSAL);
    expect(res.outcome?.userKind).toBe('question');
    expect(res.outcome?.design).toBeUndefined();
  });

  it('answer throw → BUILD_FAILED error', async () => {
    const answerNode = createDesignerAnswer({
      answer: async () => {
        throw new Error('LLM call failed');
      },
    });

    const state = createMockState();
    const res = await answerNode(state);

    expect(res.outcome).toBeDefined();
    expect(res.outcome?.replyKind).toBe('error');
    expect(res.outcome?.replyMarkdown).toBe(BUILD_FAILED);
    expect(res.outcome?.userKind).toBe('question');
    expect(res.outcome?.design).toBeUndefined();
  });

  it('makeFence safely handles scripts with triple backticks or more', () => {
    expect(makeFence('no backticks')).toBe('```');
    expect(makeFence('code with ```python docstring```')).toBe('````');
    expect(makeFence('code with ````nested````')).toBe('`````');
  });

  it('invokes the model with nostream tag', async () => {
    let capturedConfig: { tags?: string[] } | undefined;
    const fakeChatModel = {
      withStructuredOutput: () => ({
        withConfig: (config: { tags?: string[] }) => {
          capturedConfig = config;
          return {
            invoke: async () => ({
              parsed: { answer: 'Safe answer' },
              raw: { response_metadata: { stop_reason: 'stop' } },
            }),
          };
        },
      }),
    };

    const answerNode = createDesignerAnswer({
      getChatModel: () => fakeChatModel,
    });

    const state = createMockState();
    await answerNode(state);
    expect(capturedConfig?.tags).toEqual(['nostream']);
  });

  it('defaultAnswer frames base body with longer fences when body has backticks', async () => {
    let capturedMessage = '';
    const fakeChatModel = {
      withStructuredOutput: () => ({
        withConfig: () => ({
          invoke: async (messages: unknown[]) => {
            const humanMsg = (messages as Array<{ content: string }>)[1];
            capturedMessage = humanMsg.content;
            return {
              parsed: { answer: 'Safe answer' },
              raw: { response_metadata: { stop_reason: 'stop' } },
            };
          },
        }),
      }),
    };

    const answerNode = createDesignerAnswer({
      getChatModel: () => fakeChatModel,
    });

    const state = createMockState({
      baseBody: '"""```python\nhello\n```"""',
    });
    const res = await answerNode(state);
    expect(res.outcome?.replyKind).toBe('answer');
    expect(capturedMessage).toContain('````python\n"""```python\nhello\n```"""\n````');
  });
});
