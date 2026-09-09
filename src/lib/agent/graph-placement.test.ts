import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Command, isInterrupted } from '@langchain/langgraph';
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
  const key = runCheckpointKey(`place-test-${Date.now()}`, `run-${counter++}`);
  createdKeys.push(key);
  return key;
}

afterAll(async () => {
  const cp = getCheckpointer();
  for (const k of createdKeys) await cp.deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
  delete process.env.CADAI_VISUAL_CRITIC;
});

/**
 * A two-part assembly. The upright sits ON TOP of the base plate, so the
 * assembly is 35mm tall while the tallest single component is only 30mm - the
 * measured height therefore proves whether placement was actually applied.
 */
const TWO_PART_SPEC = {
  assemblyName: 'bracket',
  boundingBox: { width: 40, length: 40, height: 35 },
  components: [
    { name: 'base_plate', description: 'base', position: [0, 0, 0] },
    { name: 'upright', description: 'arm', position: [0, 0, 5] },
  ],
  assumptions: [],
  openQuestions: [],
};

/** Modules authored at the origin, with no top-level instantiation. */
const MODULES_ONLY = `
module base_plate() {
    cube([40, 40, 5]);
}

module upright() {
    cube([5, 40, 30]);
}
`;

const draft = (code: string) => ({ content: `\`\`\`openscad\n${code}\n\`\`\``, tool_calls: [] });

/**
 * Runs a prompt through to completion, approving the spec gate on the way.
 *
 * A multi-component spec always trips shouldGateSpec (components.length > 1),
 * and every assembly worth placing has more than one component - so any
 * placement test necessarily passes through the gate.
 */
async function runApproved(agent: any, config: any, prompt: string) {
  const first = await agent.invoke({ messages: [new HumanMessage(prompt)] }, config);
  if (!isInterrupted(first)) return first;
  return agent.invoke(new Command({ resume: { action: 'approve' } }), config);
}

describe('deterministic assembly placement', () => {
  beforeEach(() => {
    // Exact call counts; vision is covered by its own suite.
    process.env.CADAI_VISUAL_CRITIC = 'off';
    invokeMock.mockReset();
  });

  it('compiles placed geometry that the model never positioned itself', async () => {
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;

    // The generated block exists and carries the spec's coordinates.
    expect(state.currentCode).toContain('Assembly placement (generated');
    expect(state.currentCode).toContain('base_plate();');
    expect(state.currentCode).toContain('translate([0, 0, 5]) upright();');

    // The payoff: this actually compiled, and the measured solid reflects the
    // placement. Without it both parts would sit at the origin and Z would
    // measure 30 (the taller single part) rather than 35.
    expect(state.isValid).toBe(true);
    expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
    expect(state.modelInfo.dimensions.x).toBeCloseTo(40, 1);
  });

  it('tells the drafter to stop placing parts, but only when the spec has coordinates', async () => {
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent('k', undefined, 'm');
    await runApproved(agent, { configurable: { thread_id: newKey() } }, 'a 40mm bracket');

    const drafterSystem = String((invokeMock.mock.calls[1][0] as any[])[0].content);
    expect(drafterSystem).toContain('PLACEMENT CONTRACT');

    // A spec with no coordinates must not impose the contract - the drafter
    // has to assemble the part itself in that case.
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce({
      ...TWO_PART_SPEC,
      boundingBox: { width: 40, length: 40, height: 5 },
      components: [{ name: 'base_plate', description: 'base' }],
    });
    invokeMock.mockResolvedValueOnce(draft('cube([40,40,5]);'));

    await runApproved(agent, { configurable: { thread_id: newKey() } }, 'a 40mm plate');

    const plainSystem = String((invokeMock.mock.calls[1][0] as any[])[0].content);
    expect(plainSystem).not.toContain('PLACEMENT CONTRACT');
  });

  it('leaves a model-authored assembly alone rather than doubling it', async () => {
    // The drafter ignored the contract and placed the parts itself.
    const authored = `${MODULES_ONLY}\nunion() { base_plate(); translate([0,0,5]) upright(); }`;
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    invokeMock.mockResolvedValueOnce(draft(authored));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    // No second assembly block appended.
    expect(state.currentCode).not.toContain('Assembly placement (generated');
    // And the geometry is still correct, not doubled.
    expect(state.isValid).toBe(true);
    expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
  });

  it('keeps placement spec-driven across a repair', async () => {
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    // Draft: modules are broken, so a repair is forced.
    invokeMock.mockResolvedValueOnce(draft('module base_plate() { cube([40,40,5); }'));
    // Repair: valid modules, again with no top-level placement.
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    // Re-composed after the repair, not left as bare modules with no assembly.
    expect(state.currentCode).toContain('translate([0, 0, 5]) upright();');
    expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
  });

  // Assembly fit. Only reachable now that jointContracts name their components
  // and those components carry placements.
  describe('interference', () => {
    const FIT_MODULES = `
module base() {
    cube([40, 40, 10]);
}

module peg() {
    cube([10, 10, 10]);
}
`;

    function fitSpec(pegZ: number, height: number) {
      return {
        assemblyName: 'fit',
        boundingBox: { width: 40, length: 40, height },
        components: [
          { name: 'base', description: 'base', position: [0, 0, 0] },
          { name: 'peg', description: 'peg', position: [10, 10, pegZ] },
        ],
        jointContracts: [
          { type: 'dowel_stack', clearance: 0.2, partA: 'base', partB: 'peg' },
        ],
        assumptions: [],
        openQuestions: [],
      };
    }

    it('flags parts that interpenetrate despite a declared clearance', async () => {
      // Peg starts at z=5, inside a base that runs to z=10: 10x10x5 of overlap.
      invokeMock.mockResolvedValueOnce(fitSpec(5, 15));
      invokeMock.mockResolvedValueOnce(draft(FIT_MODULES));
      // An interference violation is an error, so a repair is attempted.
      invokeMock.mockResolvedValue(draft(FIT_MODULES));

      const agent = createCadAgent('k', undefined, 'm');
      const config = { configurable: { thread_id: newKey() } };
      await runApproved(agent, config, 'a 40mm stack');

      const state = (await agent.getState(config)).values;
      const hits = state.specViolations.filter((v: any) => v.kind === 'interference');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].message).toContain('base');
      expect(hits[0].message).toContain('peg');
      // 10 x 10 x 5 of shared solid.
      expect(hits[0].message).toContain('500');
      expect(hits[0].severity).toBe('error');
    });

    it('stays silent when the parts genuinely clear each other', async () => {
      // Peg floats above the base with a real gap.
      invokeMock.mockResolvedValueOnce(fitSpec(15, 25));
      invokeMock.mockResolvedValueOnce(draft(FIT_MODULES));
      invokeMock.mockResolvedValue(draft(FIT_MODULES));

      const agent = createCadAgent('k', undefined, 'm');
      const config = { configurable: { thread_id: newKey() } };
      await runApproved(agent, config, 'a 40mm stack');

      const state = (await agent.getState(config)).values;
      expect(state.specViolations.some((v: any) => v.kind === 'interference')).toBe(false);
    });
  });

  it('shows the repair model the modules without the generated block', async () => {
    // A spec that declares 99mm tall while the parts build to 35mm: the draft
    // composes and compiles, then fails the bbox audit, forcing a real repair.
    invokeMock.mockResolvedValueOnce({
      ...TWO_PART_SPEC,
      boundingBox: { width: 40, length: 40, height: 99 },
    });
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    // Call 2 is the repair.
    const repairPrompt = (invokeMock.mock.calls[2][0] as any[])
      .map((m) => String(m.content))
      .join('\n');

    // It must see the modules it has to fix...
    expect(repairPrompt).toContain('module base_plate()');
    // ...but NOT the generated placement block. Leaving it in would make the
    // repair's output look like a model-authored assembly, and composition
    // would decline from then on - placement would silently stop being
    // spec-driven after the first repair.
    expect(repairPrompt).not.toContain('Assembly placement (generated');
  });
});
