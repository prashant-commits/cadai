import { describe, it, expect } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createDesignerTriage } from './triage';
import type { AgentStateType } from './state';

function createMockState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    messages: [new HumanMessage('make a 10mm cube')],
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
    baseBody: 'box = Box(10, 10, 10)\n_cadai_parts = [box]',
    baseRequest: 'make a 10mm cube',
    attachments: [],
    outcome: null,
    triageKind: null,
    startedAt: null,
    designerCheckSentences: [],
    ...overrides,
  };
}

function createFakeModel(returnLabel: 'edit' | 'new' | 'question', shouldThrow?: Error) {
  const recorded = {
    schema: null as unknown,
    opts: null as unknown,
    tags: [] as string[],
    invokedWith: null as unknown,
  };

  const fakeModel = {
    withStructuredOutput(schema: unknown, opts: unknown) {
      recorded.schema = schema;
      recorded.opts = opts;
      return {
        withConfig(cfg: { tags?: string[] }) {
          if (cfg.tags) recorded.tags.push(...cfg.tags);
          return {
            async invoke(messages: unknown) {
              recorded.invokedWith = messages;
              if (shouldThrow) throw shouldThrow;
              return {
                parsed: { label: returnLabel },
                raw: {
                  response_metadata: { stop_reason: 'end_turn' },
                },
              };
            },
          };
        },
      };
    },
  };

  return { fakeModel, recorded };
}

describe('designerTriage', () => {
  it('classifier: "make it 20 mm taller" → edit', async () => {
    const { fakeModel, recorded } = createFakeModel('edit');
    const triage = createDesignerTriage({
      getChatModel: () => fakeModel as never,
    });
    const state = createMockState({
      messages: [
        new HumanMessage('make a 10mm cube'),
        new HumanMessage('make it 20 mm taller'),
      ],
    });

    const res = await triage(state);
    expect(res.triageKind).toBe('edit');

    // Assert structured call has no temperature, no forced tool_choice, and is tagged nostream
    const opts = (recorded.opts ?? {}) as Record<string, unknown>;
    expect(opts.temperature).toBeUndefined();
    expect(opts.tool_choice).toBeUndefined();
    expect(recorded.tags).toContain('nostream');
  });

  it('classifier: "add a cable hole" → edit', async () => {
    const { fakeModel, recorded } = createFakeModel('edit');
    const triage = createDesignerTriage({
      getChatModel: () => fakeModel as never,
    });
    const state = createMockState({
      messages: [
        new HumanMessage('make a 10mm cube'),
        new HumanMessage('add a cable hole'),
      ],
    });

    const res = await triage(state);
    expect(res.triageKind).toBe('edit');

    const opts = (recorded.opts ?? {}) as Record<string, unknown>;
    expect(opts.temperature).toBeUndefined();
    expect(opts.tool_choice).toBeUndefined();
    expect(recorded.tags).toContain('nostream');
  });

  it('classifier: "what is this?" → question', async () => {
    const { fakeModel, recorded } = createFakeModel('question');
    const triage = createDesignerTriage({
      getChatModel: () => fakeModel as never,
    });
    const state = createMockState({
      messages: [
        new HumanMessage('make a 10mm cube'),
        new HumanMessage('what is this?'),
      ],
    });

    const res = await triage(state);
    expect(res.triageKind).toBe('question');

    const opts = (recorded.opts ?? {}) as Record<string, unknown>;
    expect(opts.temperature).toBeUndefined();
    expect(opts.tool_choice).toBeUndefined();
    expect(recorded.tags).toContain('nostream');
  });

  it('classifier: "now make a desk lamp" → new', async () => {
    const { fakeModel, recorded } = createFakeModel('new');
    const triage = createDesignerTriage({
      getChatModel: () => fakeModel as never,
    });
    const state = createMockState({
      messages: [
        new HumanMessage('make a 10mm cube'),
        new HumanMessage('now make a desk lamp'),
      ],
    });

    const res = await triage(state);
    expect(res.triageKind).toBe('new');

    const opts = (recorded.opts ?? {}) as Record<string, unknown>;
    expect(opts.temperature).toBeUndefined();
    expect(opts.tool_choice).toBeUndefined();
    expect(recorded.tags).toContain('nostream');
  });

  it('the classifier throwing → an edit of the base, or a fresh build when there is none', async () => {
    const { fakeModel } = createFakeModel('new', new Error('Network timeout'));
    const triage = createDesignerTriage({
      getChatModel: () => fakeModel as never,
    });

    // With base: throws -> fallback to edit
    const stateWithBase = createMockState({
      messages: [new HumanMessage('change something')],
      baseBody: 'box = Box(10, 10, 10)',
    });
    const resWithBase = await triage(stateWithBase);
    expect(resWithBase.triageKind).toBe('edit');

    // Without base: no call, fresh build (new)
    const stateWithoutBase = createMockState({
      messages: [new HumanMessage('change something')],
      baseBody: null,
    });
    const resWithoutBase = await triage(stateWithoutBase);
    expect(resWithoutBase.triageKind).toBe('new');
  });

  it('no base → a fresh build', async () => {
    // Fake model should NOT be called when there is no base
    const fakeGetChatModel = () => {
      throw new Error('Should not be called');
    };
    const triage = createDesignerTriage({
      getChatModel: fakeGetChatModel as never,
    });

    const state = createMockState({
      messages: [new HumanMessage('make a 10mm cube')],
      baseBody: null,
      baseVersion: null,
    });

    const res = await triage(state);
    expect(res.triageKind).toBe('new');
  });
});
