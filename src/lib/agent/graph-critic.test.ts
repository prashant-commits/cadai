import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { isInterrupted, INTERRUPT } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';

const invokeMock = vi.fn();

vi.mock('@langchain/google-genai', () => {
  class FakeChatModel {
    invoke = invokeMock;
    withStructuredOutput() { return this; }
    bindTools() { return this; }
  }
  return { ChatGoogleGenerativeAI: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

// The agent now picks its provider by model slug: gemini-* goes to Google, every
// other slug to the Experiential Labs gateway over the OpenAI wire format. Both
// lanes are faked so these suites keep exercising whichever one the default
// selects, instead of silently making real calls when the default changes.
vi.mock('@langchain/openai', () => {
  class FakeChatModel {
    invoke = invokeMock;
    withStructuredOutput() { return this; }
    bindTools() { return this; }
  }
  return { ChatOpenAI: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

import { createCadAgent } from './graph';

const createdKeys: string[] = [];
let counter = 0;
function newKey() {
  const key = runCheckpointKey(`critic-test-${Date.now()}`, `run-${counter++}`);
  createdKeys.push(key);
  return key;
}

afterAll(async () => {
  const cp = getCheckpointer();
  for (const k of createdKeys) await cp.deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
});

function baseSpec(overrides: Record<string, any> = {}) {
  return {
    assemblyName: 'test_box',
    boundingBox: { width: 40, length: 40, height: 40 },
    components: [{ name: 'box', description: 'a box' }],
    assumptions: [],
    openQuestions: [],
    ...overrides,
  };
}
const draftResponse = (code: string) => ({ content: `\`\`\`openscad\n${code}\n\`\`\``, tool_calls: [] });

// `__interrupt__` is bolted on by LangGraph's runtime, not part of AgentState.
function gatePayload(result: any) {
  return result[INTERRUPT][0].value;
}

/** A clean run: architect, then a drafter whose code compiles and matches. */
function queueCleanRun() {
  invokeMock.mockResolvedValueOnce(baseSpec());
  invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
}

describe('visual critic', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    delete process.env.CADAI_VISUAL_CRITIC;
  });

  it('shows the model real rendered images of the compiled part', async () => {
    queueCleanRun();
    invokeMock.mockResolvedValueOnce({ matchesIntent: true, findings: [] });

    const agent = createCadAgent('k', undefined, 'm');
    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, { configurable: { thread_id: newKey() } });

    // Call 2 is the critic.
    const criticMessages = invokeMock.mock.calls[2][0] as any[];
    const human = criticMessages[criticMessages.length - 1];
    const parts = human.content as Array<Record<string, any>>;

    // Four views, each preceded by a label, plus the leading text block.
    const images = parts.filter((p) => p.type === 'image_url');
    expect(images).toHaveLength(4);
    for (const img of images) {
      expect(img.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
      // A real render, not a stub.
      expect(img.image_url.url.length).toBeGreaterThan(500);
    }

    // The request itself must reach the critic, or it has no intent to judge.
    expect(JSON.stringify(parts)).toContain('a 40mm box');
  });

  it('turns findings into warnings and routes them to the human', async () => {
    queueCleanRun();
    invokeMock.mockResolvedValueOnce({
      matchesIntent: false,
      findings: [
        { issue: 'The mounting arm points down instead of up', severity: 'major', view: 'front' },
      ],
    });

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    const state = (await agent.getState(config)).values;
    const visual = state.specViolations.filter((v: any) => v.kind === 'visual');
    expect(visual).toHaveLength(1);
    expect(visual[0].message).toContain('points down instead of up');
    expect(visual[0].message).toContain('front');

    // Advisory only: a critique must never invalidate geometry that passed
    // every deterministic check.
    expect(visual[0].severity).toBe('warning');
    expect(state.isValid).toBe(true);

    // But it does reach a human, via the accept gate.
    expect(isInterrupted(result)).toBe(true);
    expect(gatePayload(result).kind).toBe('accept');
  });

  it('stays out of the way when the part looks right', async () => {
    queueCleanRun();
    invokeMock.mockResolvedValueOnce({ matchesIntent: true, findings: [] });

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    const state = (await agent.getState(config)).values;
    expect(state.specViolations).toHaveLength(0);
    // A clean first draft with nothing to report still ships without a gate.
    expect(isInterrupted(result)).toBe(false);
    expect(state.isValid).toBe(true);
  });

  it('does not critique code that failed to compile', async () => {
    // Broken syntax on every attempt: the run exhausts its budget and ends
    // without ever producing geometry worth looking at.
    invokeMock.mockResolvedValueOnce(baseSpec());
    invokeMock.mockResolvedValue(draftResponse('cube([40,40,40);'));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    const state = (await agent.getState(config)).values;
    expect(state.isValid).toBe(false);
    expect(state.specViolations.some((v: any) => v.kind === 'visual')).toBe(false);
  });

  it('survives a critic that throws', async () => {
    queueCleanRun();
    invokeMock.mockRejectedValueOnce(new Error('vision endpoint exploded'));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    // The part is fine; an advisory step failing must not fail the run.
    const state = (await agent.getState(config)).values;
    expect(state.isValid).toBe(true);
    expect(isInterrupted(result)).toBe(false);
  });

  it('can be switched off entirely', async () => {
    process.env.CADAI_VISUAL_CRITIC = 'off';
    queueCleanRun();

    const agent = createCadAgent('k', undefined, 'm');
    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, { configurable: { thread_id: newKey() } });

    // Architect + drafter only - no third call was made.
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
