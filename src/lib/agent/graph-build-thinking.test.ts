import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command, isInterrupted } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';

// Wiring: in a full run under CADAI_KERNEL=brep, only the code-writing nodes (the build
// and its repair visits) call the model built with the build role.

type Opts = { thinking?: { type: string }; outputConfig?: { effort?: string } };
const callMock = vi.fn();
const runBrepMock = vi.fn();

vi.mock('@langchain/anthropic', () => {
  class FakeChatModel {
    constructor(private opts: Opts) {}
    invoke = (messages: unknown) => callMock(messages, this.opts);
    async *stream(messages: unknown) { yield await callMock(messages, this.opts); }
    withStructuredOutput() { return this; }
    withConfig() { return this; }
    bindTools() { return this; }
  }
  return { ChatAnthropic: vi.fn().mockImplementation(function (opts: Opts) { return new FakeChatModel(opts); }) };
});
vi.mock('../engine/brep-runner', () => ({ runBrep: (script: string) => runBrepMock(script) }));

import { createCadAgent } from './graph';

const keys: string[] = [];
const newKey = () => { const k = runCheckpointKey(`bt-${Date.now()}`, 'run'); keys.push(k); return k; };
afterAll(async () => { for (const k of keys) await getCheckpointer().deleteThread(k); });

const spec = {
  sheet: '## Box\nA box', assemblyName: 'box_spec', boundingBox: { width: 40, length: 40, height: 40 },
  components: [{ name: 'box', description: 'a box', localExtents: [40, 40, 40], position: [0, 0, 0], shape: { kind: 'box' } }],
  assumptions: [], openQuestions: [],
};
const plan = { brief: 'Plan', assumptions: [], openQuestions: [], variants: [{ id: 'A', name: 'A', idea: 'box' }], recommendedId: 'A' };
const ASCII_STL = 'solid model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid model\n';
const okRun = {
  ok: true, parts: [{ label: 'box', valid: true, volume: 64000, min: [0, 0, 0], max: [40, 40, 40] }], solids: 1,
  bbox: { min: [0, 0, 0], max: [40, 40, 40] }, stl: Buffer.from(ASCII_STL).toString('base64'),
  step: Buffer.from('ISO-10303-21;\n').toString('base64'), ms: 900,
};
const BODY = '@body box\nreturn Box(40, 40, 40, align=(Align.MIN, Align.MIN, Align.MIN))\n@end';

const saved = { ...process.env };
beforeEach(() => {
  callMock.mockReset(); runBrepMock.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.CADAI_SPEC_SHEETS = 'off'; process.env.CADAI_MAX_VARIANTS = '1'; process.env.CADAI_MAX_ATTEMPTS = '3';
  process.env.CADAI_PIPELINE = 'architect'; process.env.CADAI_KERNEL = 'brep'; delete process.env.VERCEL;
  delete process.env.CADAI_THINKING; delete process.env.CADAI_EFFORT;
  delete process.env.CADAI_BUILD_THINKING; delete process.env.CADAI_BUILD_EFFORT;
});
afterEach(() => { process.env = { ...saved }; });

async function run() {
  callMock.mockImplementation(async (messages: unknown) => {
    const text = JSON.stringify(messages);
    if (text.includes('Evaluate whether this concept sheet matches the request')) return { matchesRequest: true, findings: [] };
    if (text.includes('Generate the Assembly Spec for Variant')) return spec;
    if (text.includes('@body')) return { content: BODY };
    if (text.includes('Mechanical Architect Planner')) return plan;
    return { matchesRequest: true, findings: [] };
  });
  runBrepMock
    .mockResolvedValueOnce({ ok: false, error: 'TypeError: boom', parts: [], solids: 0, ms: 300 })
    .mockResolvedValue(okRun);
  const key = newKey();
  const agent = createCadAgent('claude-haiku-5.5');
  const config = { configurable: { thread_id: key }, recursionLimit: 200 };
  let result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);
  for (let i = 0; i < 10 && isInterrupted(result); i++) result = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
  return callMock.mock.calls as [unknown, Opts][];
}
const isBuild = (messages: unknown) => JSON.stringify(messages).includes('@body');

describe('build role wiring', () => {
  it('CADAI_THINKING=off + CADAI_BUILD_THINKING=adaptive: build visits (first and repair) think, nothing else does', async () => {
    process.env.CADAI_THINKING = 'off';
    process.env.CADAI_BUILD_THINKING = 'adaptive';
    process.env.CADAI_BUILD_EFFORT = 'medium';
    const calls = await run();
    const builds = calls.filter(([m]) => isBuild(m));
    const rest = calls.filter(([m]) => !isBuild(m));
    expect(builds.length).toBe(2); // first visit + the repair visit after the script error
    for (const [, o] of builds) {
      expect(o.thinking).toEqual({ type: 'adaptive' });
      expect(o.outputConfig).toEqual({ effort: 'medium' });
    }
    expect(rest.length).toBeGreaterThan(0);
    for (const [, o] of rest) expect(o.thinking).toEqual({ type: 'disabled' });
  }, 120_000);

  it('without build variables every node uses the global setting', async () => {
    process.env.CADAI_THINKING = 'adaptive';
    process.env.CADAI_EFFORT = 'low';
    const calls = await run();
    for (const [, o] of calls) {
      expect(o.thinking).toEqual({ type: 'adaptive' });
      expect(o.outputConfig).toEqual({ effort: 'low' });
    }
  }, 120_000);
});
