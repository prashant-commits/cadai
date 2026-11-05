import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command, isInterrupted } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import type { AgentStateType } from './graph';

const callMock = vi.fn();

vi.mock('@langchain/openai', () => {
  class FakeChatModel {
    invoke = (messages: unknown) => callMock(messages);
    async *stream(messages: unknown) { yield await callMock(messages); }
    withStructuredOutput() { return this; }
    withConfig() { return this; }
    bindTools() { return this; }
  }
  return { ChatOpenAI: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

import { createCadAgent } from './graph';

const keys: string[] = [];
let counter = 0;
const newKey = () => { const k = runCheckpointKey(`pipeline-${Date.now()}`, `run-${counter++}`); keys.push(k); return k; };
afterAll(async () => { for (const k of keys) await getCheckpointer().deleteThread(k); });

const spec = {
  sheet: '## Box\nA box', assemblyName: 'box_spec', boundingBox: { width: 40, length: 40, height: 40 },
  components: [{ name: 'box', description: 'a box', localExtents: [40, 40, 40], position: [0, 0, 0], shape: { kind: 'box' } }],
  assumptions: [], openQuestions: [],
};
const plan = (n: number) => ({
  brief: 'Plan', assumptions: [], openQuestions: [],
  variants: [{ id: 'A', name: 'A', idea: 'box' }, { id: 'B', name: 'B', idea: 'other box' }].slice(0, n), recommendedId: 'A',
});

type Kind = 'planner' | 'variant' | 'reviewer' | 'drafter' | 'build' | 'other';
function kindOf(messages: unknown): Kind {
  const text = JSON.stringify(messages);
  if (text.includes('Evaluate whether this concept sheet matches the request')) return 'reviewer';
  if (text.includes('Generate the Assembly Spec for Variant')) return 'variant';
  if (text.includes('Implement the Architect Spec below')) return 'drafter';
  if (text.includes('@body')) return 'build';
  if (text.includes('Mechanical Architect Planner')) return 'planner';
  return 'other';
}

function script(builds: string[], variants = 1) {
  let b = 0;
  callMock.mockImplementation(async (messages: unknown) => {
    switch (kindOf(messages)) {
      case 'planner': return plan(variants);
      case 'variant': return spec;
      case 'reviewer': return { matchesRequest: true, findings: [] };
      case 'drafter': return { content: '```openscad\nmodule box() { cube([40, 40, 40]); }\n```', tool_calls: [] };
      case 'build': return { content: builds[Math.min(b++, builds.length - 1)] };
      default: return { matchesRequest: true, findings: [] };
    }
  });
}

async function drive(key: string, before?: () => void) {
  const agent = createCadAgent('gpt-6-sol');
  const config = { configurable: { thread_id: key }, recursionLimit: 200 };
  let result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);
  before?.();
  for (let i = 0; i < 10 && isInterrupted(result); i++) result = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
  const state = (await agent.getState(config)).values as AgentStateType;
  const kinds = callMock.mock.calls.map((c) => kindOf(c[0]));
  return { state, kinds, calls: callMock.mock.calls };
}

beforeEach(() => {
  callMock.mockReset();
  process.env.CADAI_SPEC_SHEETS = 'off';
  process.env.CADAI_MAX_VARIANTS = '1';
  process.env.CADAI_MAX_ATTEMPTS = '3';
  delete process.env.VERCEL;
});
afterEach(() => { delete process.env.CADAI_PIPELINE; });

describe('CADAI_PIPELINE=architect', () => {
  it('builds through architectBuild and never calls the Drafter', async () => {
    process.env.CADAI_PIPELINE = 'architect';
    script(['@body box\ncube([40, 40, 40]);\n@end']);
    const { state, kinds } = await drive(newKey());
    expect(kinds).not.toContain('drafter');
    expect(kinds).toContain('build');
    expect(state.pipeline).toBe('architect');
    expect(state.currentCode).toMatch(/module box\(\)/);
  }, 120_000);

  it('sends an audit error back to architectBuild, not to Repair', async () => {
    process.env.CADAI_PIPELINE = 'architect';
    script(['@body box\ncube([30, 30, 30]);\n@end', '@body box\ncube([40, 40, 40]);\n@end']);
    const { kinds, calls } = await drive(newKey());
    const builds = calls.filter((c) => kindOf(c[0]) === 'build');
    expect(builds.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(builds[1][0])).toContain('REQUIRED CHANGES');
    expect(kinds).not.toContain('drafter');
    expect(kinds.filter((k) => k === 'other').length).toBe(0); // no Repair call
  }, 120_000);
});

describe('the pipeline is pinned per thread', () => {
  it('a thread started on the Drafter stays on it when the flag flips mid-run', async () => {
    script(['@body box\ncube([40, 40, 40]);\n@end'], 2); // two variants -> a spec gate pause
    const { state, kinds } = await drive(newKey(), () => { process.env.CADAI_PIPELINE = 'architect'; });
    expect(state.pipeline).toBe('drafter');
    expect(kinds).toContain('drafter');
    expect(kinds).not.toContain('build');
  }, 120_000);

  it('defaults to the Drafter when the flag is unset', async () => {
    script(['unused']);
    const { kinds } = await drive(newKey());
    expect(kinds).toContain('drafter');
    expect(kinds).not.toContain('build');
  }, 120_000);
});
