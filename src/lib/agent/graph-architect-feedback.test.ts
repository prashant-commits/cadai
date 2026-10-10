import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { isInterrupted, INTERRUPT } from '@langchain/langgraph';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import type { GatePayload } from '@/types';

const callMock = vi.fn();

vi.mock('@langchain/openai', () => {
  class FakeChatModel {
    temperature: number | undefined;
    model: string | undefined;
    constructor(params: { temperature?: number; model?: string }) {
      this.temperature = params?.temperature;
      this.model = params?.model;
    }
    invoke = (messages: unknown, config?: unknown) => callMock(messages, config, this.temperature, this.model);
    async *stream(messages: unknown, config?: unknown) {
      yield await callMock(messages, config, this.temperature, this.model);
    }
    withStructuredOutput() {
      return this;
    }
    withConfig() {
      return this;
    }
    bindTools() {
      return this;
    }
  }
  return {
    ChatOpenAI: vi.fn().mockImplementation(function (params: { temperature?: number; model?: string }) {
      return new FakeChatModel(params);
    }),
  };
});

import { createCadAgent } from './graph';

const keys: string[] = [];
let counter = 0;
const newKey = () => {
  const k = runCheckpointKey(`architect-feedback-${Date.now()}`, `run-${counter++}`);
  keys.push(k);
  return k;
};
afterAll(async () => {
  for (const k of keys) await getCheckpointer().deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
});

type Kind = 'planner' | 'variant' | 'revision' | 'reviewer' | 'drafter' | 'other';
function kindOf(messages: unknown): Kind {
  const text = JSON.stringify(messages);
  if (text.includes('Evaluate whether this concept sheet matches the request')) return 'reviewer';
  if (text.includes('Revise this variant (')) return 'revision';
  if (text.includes('Generate the Assembly Spec for Variant')) return 'variant';
  if (text.includes('Implement the Architect Spec below')) return 'drafter';
  if (text.includes('Mechanical Architect Planner')) return 'planner';
  return 'other';
}

const plan = {
  brief: 'Plan', assumptions: [], openQuestions: [],
  variants: [{ id: 'A', name: 'VarA', idea: 'Literal block' }], recommendedId: 'A',
};
// A failing review with no review retries stops the run at the spec gate, where the accepted spec can be read.
const hold = { matchesRequest: false, findings: [{ issue: 'hold the run at the gate', severity: 'major' }] };

/** A 60 x 20 x 10 block. Its spec omits boundingBox unless `extra` adds one. */
const block = (extra: Record<string, unknown> = {}) => ({
  sheet: '## Block\nA block',
  assemblyName: 'block_spec',
  components: [{ name: 'block', description: 'a block', localExtents: [60, 20, 10], position: [0, 0, 0], shape: { kind: 'box' } }],
  assumptions: [],
  openQuestions: [],
  ...extra,
});

function gate(result: unknown) {
  return (result as Record<string | symbol, Array<{ value: Extract<GatePayload, { kind: 'spec' }> }>>)[INTERRUPT][0].value;
}

beforeEach(() => {
  callMock.mockReset();
  process.env.CADAI_SPEC_SHEETS = 'on';
  process.env.CADAI_MAX_VARIANTS = '1';
  process.env.CADAI_SPEC_REVIEW_RETRIES = '0';
  delete process.env.VERCEL;
});

async function run(variantReplies: unknown[]) {
  let v = 0;
  callMock.mockImplementation(async (messages: unknown) => {
    switch (kindOf(messages)) {
      case 'planner': return plan;
      case 'variant': return variantReplies[Math.min(v++, variantReplies.length - 1)];
      case 'reviewer': return hold;
      default: return { matchesRequest: true, findings: [] };
    }
  });
  const result = await createCadAgent('gpt-6-sol').invoke(
    { messages: [new HumanMessage('a 60 x 20 x 10 mm block')] },
    { configurable: { thread_id: newKey() } }
  );
  const calls = callMock.mock.calls.map((c) => ({ messages: c[0] as BaseMessage[], kind: kindOf(c[0]) }));
  return { result, calls };
}

describe('Architect: boundingBox is computed by code', () => {
  it('accepts a spec with no boundingBox on the first attempt, with the computed box', async () => {
    const { result, calls } = await run([block()]);
    expect(calls.filter((c) => c.kind === 'variant')).toHaveLength(1);
    expect(isInterrupted(result)).toBe(true);
    expect(gate(result).variants![0].spec!.boundingBox).toEqual({ width: 60, length: 20, height: 10 });
  });

  it('overwrites a swapped width/length instead of sending it back as a coherence error', async () => {
    const { result, calls } = await run([block({ boundingBox: { width: 20, length: 60, height: 10 } })]);
    expect(calls.filter((c) => c.kind === 'variant')).toHaveLength(1);
    expect(gate(result).variants![0].spec!.boundingBox).toEqual({ width: 60, length: 20, height: 10 });
  });
});

describe('Architect: a spec that fails validation gets every issue back', () => {
  it('names each schema issue and each ignored key in the retry', async () => {
    const bad = {
      skeleton: { note: 'wrapped' },
      sheet: 'x',
      components: [{ name: 'block', description: 'a block', localExtents: [60, 20, 10], position: [0, 0, 0], shape: 'box' }],
    };
    const { calls } = await run([bad, block()]);
    const variants = calls.filter((c) => c.kind === 'variant');
    expect(variants).toHaveLength(2);
    const retry = JSON.stringify(variants[1].messages.at(-1)!.content);
    expect(retry).toContain('assemblyName');
    expect(retry).toContain('components.0.shape');
    expect(retry).toContain('skeleton');
  });
});
