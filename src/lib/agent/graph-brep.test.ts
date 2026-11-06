import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command, isInterrupted } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import type { AgentStateType } from './graph';

// P2 acceptance: with CADAI_KERNEL=brep (and the Architect pipeline) the build
// writes build123d bodies, code emits the script, runBrep runs it, and the run
// ends with the build123d script, an ASCII STL and a STEP file in state.

const callMock = vi.fn();
const runBrepMock = vi.fn();

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
vi.mock('../engine/brep-runner', () => ({ runBrep: (script: string) => runBrepMock(script) }));

import { createCadAgent } from './graph';

const keys: string[] = [];
let counter = 0;
const newKey = () => { const k = runCheckpointKey(`brep-${Date.now()}`, `run-${counter++}`); keys.push(k); return k; };
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

type Kind = 'planner' | 'variant' | 'reviewer' | 'build' | 'other';
function kindOf(messages: unknown): Kind {
  const text = JSON.stringify(messages);
  if (text.includes('Evaluate whether this concept sheet matches the request')) return 'reviewer';
  if (text.includes('Generate the Assembly Spec for Variant')) return 'variant';
  if (text.includes('@body')) return 'build';
  if (text.includes('Mechanical Architect Planner')) return 'planner';
  return 'other';
}
function script(builds: string[]) {
  let b = 0;
  callMock.mockImplementation(async (messages: unknown) => {
    switch (kindOf(messages)) {
      case 'planner': return plan;
      case 'variant': return spec;
      case 'reviewer': return { matchesRequest: true, findings: [] };
      case 'build': return { content: builds[Math.min(b++, builds.length - 1)] };
      default: return { matchesRequest: true, findings: [] };
    }
  });
}
async function drive(key: string) {
  const agent = createCadAgent('claude-haiku-5.5');
  const config = { configurable: { thread_id: key }, recursionLimit: 200 };
  let result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);
  for (let i = 0; i < 10 && isInterrupted(result); i++) result = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
  return { state: (await agent.getState(config)).values as AgentStateType, calls: callMock.mock.calls };
}

const BODY = '@body box\nreturn Box(40, 40, 40, align=(Align.MIN, Align.MIN, Align.MIN))\n@end';

beforeEach(() => {
  callMock.mockReset(); runBrepMock.mockReset();
  process.env.CADAI_SPEC_SHEETS = 'off'; process.env.CADAI_MAX_VARIANTS = '1'; process.env.CADAI_MAX_ATTEMPTS = '3';
  process.env.CADAI_PIPELINE = 'architect'; delete process.env.VERCEL;
});
afterEach(() => { delete process.env.CADAI_KERNEL; delete process.env.CADAI_PIPELINE; });

describe('CADAI_KERNEL=brep', () => {
  it('ends with the build123d script, an ASCII STL and a STEP file', async () => {
    process.env.CADAI_KERNEL = 'brep';
    script([BODY]);
    runBrepMock.mockResolvedValue(okRun);
    const { state, calls } = await drive(newKey());
    expect(state.kernel).toBe('brep');
    expect(state.currentCode).toMatch(/^from build123d import \*/m);
    expect(state.currentCode).toMatch(/def box\(/);
    expect(runBrepMock).toHaveBeenCalled();
    expect(state.stlContent).toContain('facet normal');
    expect(state.stepContent).toBe(okRun.step);
    expect(state.isValid).toBe(true);
    const build = calls.find((c) => kindOf(c[0]) === 'build');
    expect(JSON.stringify(build?.[0])).toMatch(/build123d/); // the build prompt is the B-rep one, with the cheat sheet
    expect(JSON.stringify(build?.[0])).not.toMatch(/module box\(\)/);
  }, 120_000);

  it('sends a script error back to the build step with the traceback, then succeeds', async () => {
    process.env.CADAI_KERNEL = 'brep';
    script(['@body box\nreturn Cylinder(3, 10, axis=(1, 0, 0))\n@end', BODY]);
    runBrepMock
      .mockResolvedValueOnce({ ok: false, error: "File \"model.py\", line 12, in box\nTypeError: Cylinder.__init__() got an unexpected keyword argument 'axis'", parts: [], solids: 0, ms: 300 })
      .mockResolvedValue(okRun);
    const { state, calls } = await drive(newKey());
    const builds = calls.filter((c) => kindOf(c[0]) === 'build');
    expect(builds.length).toBe(2);
    expect(JSON.stringify(builds[1][0])).toContain('REQUIRED CHANGES');
    expect(JSON.stringify(builds[1][0])).toContain('TypeError');
    expect(state.isValid).toBe(true);
  }, 120_000);

  it('a part whose measured size differs from its spec is an extents error routed back to the build step', async () => {
    process.env.CADAI_KERNEL = 'brep';
    script([BODY, BODY]);
    runBrepMock
      .mockResolvedValueOnce({ ...okRun, parts: [{ label: 'box', valid: true, volume: 1, min: [0, 0, 0], max: [30, 40, 40] }], bbox: { min: [0, 0, 0], max: [30, 40, 40] } })
      .mockResolvedValue(okRun);
    const { calls } = await drive(newKey());
    const builds = calls.filter((c) => kindOf(c[0]) === 'build');
    expect(builds.length).toBe(2);
    expect(JSON.stringify(builds[1][0])).toMatch(/box/);
  }, 120_000);
});

describe('default kernel is unchanged', () => {
  it('without CADAI_KERNEL the Architect still writes OpenSCAD and runBrep is never called', async () => {
    script(['@body box\ncube([40, 40, 40]);\n@end']);
    const { state } = await drive(newKey());
    expect(state.kernel ?? 'openscad').toBe('openscad');
    expect(state.currentCode).toMatch(/module box\(\)/);
    expect(runBrepMock).not.toHaveBeenCalled();
  }, 120_000);
});
