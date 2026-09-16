import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Command, isInterrupted } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';

const invokeMock = vi.fn();

// Every node talks to the Experiential Labs gateway over the OpenAI wire
// format, so faking ChatOpenAI is enough to keep these suites off the network.
// Arrow functions have no [[Construct]] slot, so `new ChatOpenAI(...)` needs a
// real constructible mock, not vi.fn(() => ...).
vi.mock('@langchain/openai', () => {
  class FakeChatModel {
    invoke = invokeMock;
    // architectNode reads its structured output with .stream() so the spec
    // renders as it arrives. Delegating to the same mock keeps ONE queue and
    // one call index, so every ordering assertion in this file still holds.
    async *stream(...args: unknown[]) { yield await invokeMock(...args); }
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
  delete process.env.CADAI_MAX_ATTEMPTS;
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
    // Several tests here exercise a repair; the loop is parked by default.
    process.env.CADAI_MAX_ATTEMPTS = '3';
    invokeMock.mockReset();
  });

  it('does not repair automatically by default (repair loop is parked)', async () => {
    const saved = process.env.CADAI_MAX_ATTEMPTS;
    delete process.env.CADAI_MAX_ATTEMPTS;
    try {
      invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
      invokeMock.mockResolvedValueOnce(draft('module base_plate() { cube([40,40,5); }'));
      invokeMock.mockResolvedValue(draft(MODULES_ONLY));

      const agent = createCadAgent(undefined, 'm');
      const config = { configurable: { thread_id: newKey() } };
      const result = await runApproved(agent, config, 'a 40mm bracket');

      // One draft, no repair: the run pauses at the accept gate for a human.
      const state = (await agent.getState(config)).values;
      expect(state.attemptCount).toBe(1);
      expect(isInterrupted(result)).toBe(true);
    } finally {
      if (saved !== undefined) process.env.CADAI_MAX_ATTEMPTS = saved;
    }
  });

  it('compiles placed geometry that the model never positioned itself', async () => {
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent(undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;

    // The generated block exists and carries the spec's coordinates.
    expect(state.currentCode).toContain('Assembly placement (generated');
    expect(state.currentCode).toContain('base_plate();');
    expect(state.currentCode).toContain('translate([0, 0, upright_pos_z]) upright();');
    expect(state.currentCode).toContain('upright_pos_z = 5;');

    // The payoff: this actually compiled, and the measured solid reflects the
    // placement. Without it both parts would sit at the origin and Z would
    // measure 30 (the taller single part) rather than 35.
    expect(state.isValid).toBe(true);
    expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
    expect(state.modelInfo.dimensions.x).toBeCloseTo(40, 1);
  });

  it('imposes the placement contract whenever the spec has components', async () => {
    invokeMock.mockResolvedValueOnce({
      ...TWO_PART_SPEC,
      components: [{ name: 'base_plate', description: 'base' }, { name: 'upright', description: 'arm' }],
    });
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));
    // Both parts land at the origin, so the bbox audit fails and a repair runs.
    invokeMock.mockResolvedValue(draft(MODULES_ONLY));

    const agent = createCadAgent(undefined, 'm');
    await runApproved(agent, { configurable: { thread_id: newKey() } }, 'a 40mm bracket');

    const drafterSystem = String((invokeMock.mock.calls[1][0] as any[])[0].content);
    expect(drafterSystem).toContain('PLACEMENT CONTRACT');
  });

  it('replaces a model-authored assembly with the spec placement', async () => {
    // The drafter ignored the contract and put the upright 99mm up.
    const authored = `${MODULES_ONLY}\nunion() { base_plate(); translate([0,0,99]) upright(); }`;
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    invokeMock.mockResolvedValueOnce(draft(authored));

    const agent = createCadAgent(undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    expect(state.currentCode).toContain('Assembly placement (generated');
    expect(state.currentCode).not.toContain('translate([0,0,99])');
    expect(state.placementReport.removedStatements).toBe(1);
    expect(state.isValid).toBe(true);
    expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
  });

  it('corrects a module authored off its origin so the part lands where the spec says', async () => {
    const hanging = `
module base_plate() { cube([40, 40, 5]); }
module upright() { translate([-2.5, 0, -30]) cube([5, 40, 30]); }
`;
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    invokeMock.mockResolvedValueOnce(draft(hanging));

    const agent = createCadAgent(undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    expect(state.currentCode).toContain('translate([2.5, 0, 30]) upright();');
    expect(state.modelInfo.boundingBox.min[2]).toBeCloseTo(0, 2);
    expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
    expect(state.specViolations.some((v: any) => v.kind === 'floor')).toBe(false);
    expect(state.specViolations.some((v: any) => v.kind === 'floating')).toBe(false);
    expect(state.specViolations.some((v: any) => v.kind === 'local_frame')).toBe(true);
  });

  it('reports a part the spec leaves hovering', async () => {
    invokeMock.mockResolvedValueOnce({
      ...TWO_PART_SPEC,
      boundingBox: { width: 40, length: 40, height: 45 },
      components: [
        { name: 'base_plate', description: 'base', position: [0, 0, 0] },
        { name: 'upright', description: 'arm', position: [0, 0, 15] },
      ],
    });
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));
    // A floating part is an error, so a repair runs; it returns the same modules.
    invokeMock.mockResolvedValue(draft(MODULES_ONLY));

    const agent = createCadAgent(undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    const floating = state.specViolations.filter((v: any) => v.kind === 'floating');
    expect(floating).toHaveLength(1);
    expect(floating[0].message).toContain("'upright'");
    expect(floating[0].deltaMm).toBeCloseTo(10, 1);
  });

  it('generates the spec\'s gussets so the drafter never models one', async () => {
    invokeMock.mockResolvedValueOnce({
      ...TWO_PART_SPEC,
      stressPoints: [{
        component: 'base_plate', location: 'upright root', loadCase: '20 N bending', risk: 'high', mitigation: '1 gusset',
        gusset: { corner: [5, 0, 5], along: 'y', floorDir: '+', legMm: 10, thicknessMm: 2, at: [20] },
      }],
    });
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));
    invokeMock.mockResolvedValue(draft(MODULES_ONLY));

    const agent = createCadAgent(undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    expect(state.currentCode).toContain('module base_plate__braced()');
    expect(state.currentCode).toContain('// gusset: upright root');
    expect(state.placementReport.components[0].gussets).toBe(1);
    expect(state.isValid).toBe(true);
    expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
  });

  it('normalises free-text component names before drafting', async () => {
    invokeMock.mockResolvedValueOnce({
      ...TWO_PART_SPEC,
      components: [
        { name: 'Base Plate', description: 'base', position: [0, 0, 0] },
        { name: 'Upright', description: 'arm', position: [0, 0, 5] },
      ],
    });
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent(undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    expect(state.assemblySpec.components.map((c: any) => c.name)).toEqual(['base_plate', 'upright']);
    expect(state.currentCode).toContain('translate([0, 0, upright_pos_z]) upright();');
  });

  it('keeps placement spec-driven across a repair', async () => {
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    // Draft: modules are broken, so a repair is forced.
    invokeMock.mockResolvedValueOnce(draft('module base_plate() { cube([40,40,5); }'));
    // Repair: valid modules, again with no top-level placement.
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent(undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    // Re-composed after the repair, not left as bare modules with no assembly.
    expect(state.currentCode).toContain('translate([0, 0, upright_pos_z]) upright();');
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

      const agent = createCadAgent(undefined, 'm');
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

      const agent = createCadAgent(undefined, 'm');
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

    const agent = createCadAgent(undefined, 'm');
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

  describe('placement measurement (phase 0)', () => {
    it('records each module frame and flags a part hanging below the floor', async () => {
      // Drafter placed the parts itself AND authored the upright hanging downward.
      const authored = `
module base_plate() { cube([40, 40, 5]); }
module upright() { translate([0, 0, -30]) cube([5, 40, 30]); }
base_plate();
translate([0, 0, 5]) upright();
`;
      invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
      invokeMock.mockResolvedValueOnce(draft(authored));
      invokeMock.mockResolvedValue(draft(authored));

      const agent = createCadAgent(undefined, 'm');
      const config = { configurable: { thread_id: newKey() } };
      await runApproved(agent, config, 'a 40mm bracket');

      const state = (await agent.getState(config)).values;
      const report = state.placementReport;
      expect(report).not.toBeNull();
      const upright = report.components.find((c: any) => c.name === 'upright');
      expect(upright.measured).toBe(true);
      expect(upright.localMin[2]).toBeCloseTo(-30, 2);

      // The model-written placement is stripped and the hanging upright is
      // corrected, so the assembly sits on the floor and measures 35mm.
      const kinds = state.specViolations.map((v: any) => v.kind);
      expect(kinds).not.toContain('floor');
      expect(kinds).toContain('local_frame');
      expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
    });

    it('does not report a phantom interference when the drafter placed parts itself', async () => {
      // Parts genuinely clear each other; the model's own top-level union used
      // to be unioned into the probe's intersection() and read as overlap.
      const authored = `
module base() { cube([40, 40, 10]); }
module peg() { cube([10, 10, 10]); }
union() { base(); translate([10, 10, 15]) peg(); }
`;
      invokeMock.mockResolvedValueOnce({
        assemblyName: 'fit', boundingBox: { width: 40, length: 40, height: 25 },
        components: [
          { name: 'base', description: 'base', position: [0, 0, 0] },
          { name: 'peg', description: 'peg', position: [10, 10, 15] },
        ],
        jointContracts: [{ type: 'dowel_stack', clearance: 0.2, partA: 'base', partB: 'peg' }],
        assumptions: [], openQuestions: [],
      });
      invokeMock.mockResolvedValueOnce(draft(authored));
      invokeMock.mockResolvedValue(draft(authored));

      const agent = createCadAgent(undefined, 'm');
      const config = { configurable: { thread_id: newKey() } };
      await runApproved(agent, config, 'a 40mm stack');

      const state = (await agent.getState(config)).values;
      expect(state.specViolations.some((v: any) => v.kind === 'interference')).toBe(false);
    });
  });
});
