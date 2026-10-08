import { describe, it, expect, vi, afterAll } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { isInterrupted } from '@langchain/langgraph';
import { getCheckpointer, runCheckpointKey } from './checkpointer';

/**
 * The "no raw model output in the UI" rule, tested against the channel that
 * would actually leak it. The fake is a REAL chat model (so LangChain callbacks
 * fire and LangGraph's `messages` stream mode sees every call), whose structured
 * replies are JSON text. Calls tagged `nostream` must stay out of that stream;
 * if the tag is dropped, the JSON shows up as a `messages` chunk and this fails.
 */
const replyMock = vi.fn();
const flags = vi.hoisted(() => ({ dropTag: false }));

vi.mock('@langchain/openai', async () => {
  const { BaseChatModel } = await import('@langchain/core/language_models/chat_models');
  const { AIMessage } = await import('@langchain/core/messages');
  const { RunnableLambda } = await import('@langchain/core/runnables');

  class FakeChat extends BaseChatModel {
    _llmType() {
      return 'fake';
    }
    async _generate(messages: unknown[], _opts: unknown, runManager?: { handleLLMNewToken: (t: string) => Promise<void> }) {
      const out = (await replyMock(messages)) as { content?: string } | Record<string, unknown>;
      const content = typeof (out as { content?: unknown }).content === 'string'
        ? (out as { content: string }).content
        : JSON.stringify(out);
      await runManager?.handleLLMNewToken(content);
      return { generations: [{ text: content, message: new AIMessage({ content }) }] };
    }
    withStructuredOutput() {
      const lambda = RunnableLambda.from(async (input: never, config?: unknown) => {
        const msg = await this.invoke(input, config as never);
        return JSON.parse(msg.content as string);
      });
      // A binding that ignores withConfig(tags) models "someone dropped the nostream tag".
      if (flags.dropTag) (lambda as unknown as { withConfig: () => unknown }).withConfig = () => lambda;
      return lambda;
    }
    bindTools() {
      return this;
    }
  }
  return { ChatOpenAI: vi.fn().mockImplementation(function () { return new FakeChat({}); }) };
});

import { createCadAgent } from './graph';

const keys: string[] = [];
afterAll(async () => {
  const cp = getCheckpointer();
  for (const k of keys) await cp.deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
});

const spec = {
  sheet: '## Plate\n40mm box',
  assemblyName: 'box_spec',
  boundingBox: { width: 40, length: 40, height: 40 },
  components: [
    { name: 'box', description: 'a box', localExtents: [40, 40, 40], position: [0, 0, 0], shape: { kind: 'box' } },
  ],
  assumptions: [],
  openQuestions: [],
};

function route(messages: unknown) {
  const text = JSON.stringify(messages);
  if (text.includes('Implement the Architect Spec below')) {
    return { content: '```openscad\ncube([40, 40, 40]);\n```', tool_calls: [] };
  }
  if (text.includes('Evaluate whether this concept sheet matches the request')) {
    return { matchesRequest: true, findings: [] };
  }
  if (text.includes('Generate the Assembly Spec for Variant')) return spec;
  return {
    brief: 'A plain box',
    assumptions: [],
    openQuestions: [],
    variants: [{ id: 'A', name: 'VarA', idea: 'A box' }],
    recommendedId: 'A',
  };
}

const looksLikeJson = (text: string) => {
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null;
  } catch {
    return false;
  }
};

async function runToGate(): Promise<{ messageTexts: string[]; deltas: string[]; interrupted: boolean }> {
  process.env.CADAI_SPEC_SHEETS = 'on';
  process.env.CADAI_MAX_VARIANTS = '1';
  replyMock.mockReset();
  replyMock.mockImplementation(async (messages: unknown) => route(messages));
  const key = runCheckpointKey(`raw-output-${Date.now()}`, `run-${keys.length}`);
  keys.push(key);

  const messageTexts: string[] = [];
  const deltas: string[] = [];
  let interrupted = false;
  const stream = await createCadAgent('gpt-5.6-luna').stream(
    { messages: [new HumanMessage('a 40mm box')] },
    { configurable: { thread_id: key }, streamMode: ['messages', 'custom', 'updates'] }
  );
  for await (const [mode, payload] of stream) {
    if (mode === 'messages') {
      const [chunk] = payload as unknown as [{ content?: unknown }];
      messageTexts.push(typeof chunk.content === 'string' ? chunk.content : JSON.stringify(chunk.content));
    } else if (mode === 'custom') {
      const ev = payload as { t?: string; text?: string };
      if (ev.t === 'delta' && typeof ev.text === 'string') deltas.push(ev.text);
    } else if (mode === 'updates' && isInterrupted(payload)) {
      interrupted = true;
    } else if (mode === 'updates' && (payload as Record<string, unknown>).__interrupt__) {
      interrupted = true;
    }
  }
  return { messageTexts, deltas, interrupted };
}

describe('no raw model output reaches the UI channels', () => {
  it('planner, variant and reviewer replies never appear as JSON in `messages` or `custom`', async () => {
    flags.dropTag = false;
    const { messageTexts, deltas } = await runToGate();
    expect(messageTexts.some((t) => t.includes('cube('))).toBe(true); // the drafter's code does stream
    expect(deltas.join('')).toContain('A plain box'); // the rendered brief did arrive, as markdown
    for (const t of [...messageTexts, ...deltas]) expect(looksLikeJson(t)).toBe(false);
    expect(messageTexts.join('')).not.toContain('"matchesRequest"');
    expect(messageTexts.join('')).not.toContain('"assemblyName"');
  });

  it('control: the same harness DOES leak JSON into `messages` when the nostream tag is lost', async () => {
    flags.dropTag = true;
    try {
      const { messageTexts } = await runToGate();
      expect(messageTexts.some(looksLikeJson)).toBe(true);
    } finally {
      flags.dropTag = false;
    }
  });
});
