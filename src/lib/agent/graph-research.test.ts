import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { isInterrupted, INTERRUPT, Command } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import { STUB_HITS } from '../research/search-provider';

// Same double as graph-hil.test.ts: one mocked ChatOpenAI instance, one
// invoke queue, canned replies in the order the graph is expected to call.
// With research on, that order is: query plan, brief, architect, drafter.
const invokeMock = vi.fn();
vi.mock('@langchain/openai', () => {
  class FakeChatModel {
    invoke = invokeMock;
    withStructuredOutput() { return this; }
    bindTools() { return this; }
  }
  return { ChatOpenAI: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

import { createCadAgent, type StreamEventPayload } from './graph';

const plan = { partClass: 'wall bracket', queries: ['wall bracket fdm', 'gusseted bracket 3d print'] };
const briefReply = {
  approaches: [
    {
      id: 'p',
      name: 'Plate and gusset',
      construction: 'A back plate with an arm and a gusset.',
      strengths: ['stiff'],
      weaknesses: ['bulky'],
      sources: [{ title: 'FDM brackets', url: STUB_HITS[0].url }],
    },
    { id: 'q', name: 'Folded channel', construction: 'A U channel.', strengths: ['light'], weaknesses: ['flexes'], sources: [] },
  ],
  recommendedId: 'p',
};

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
const gatedSpec = () => baseSpec({ assumptions: [{ field: 'x', value: 'y', rationale: 'z' }] });
const draftResponse = (code: string) => ({ content: `\`\`\`openscad\n${code}\n\`\`\``, tool_calls: [] });

const createdKeys: string[] = [];
let counter = 0;
function newConfig() {
  const key = runCheckpointKey(`research-test-${Date.now()}`, `run-${counter++}`);
  createdKeys.push(key);
  return { configurable: { thread_id: key } };
}
function contentsOf(call: number) {
  return (invokeMock.mock.calls[call][0] as any[]).map((m) => String(m.content));
}
function gatePayload(result: any) {
  return result[INTERRUPT][0].value;
}

afterAll(async () => {
  const checkpointer = getCheckpointer();
  for (const key of createdKeys) await checkpointer.deleteThread(key);
  await new Promise((resolve) => setTimeout(resolve, 200));
  delete process.env.CADAI_RESEARCH;
  delete process.env.CADAI_RESEARCH_STUB;
  delete process.env.CADAI_VISUAL_CRITIC;
  delete process.env.CADAI_MAX_ATTEMPTS;
});

describe('research node and gate', () => {
  beforeEach(() => {
    process.env.CADAI_VISUAL_CRITIC = 'off';
    process.env.CADAI_MAX_ATTEMPTS = '1';
    process.env.CADAI_RESEARCH = 'on';
    process.env.CADAI_RESEARCH_STUB = '1';
    invokeMock.mockReset();
  });

  it('researches first, pauses with a grounded brief, and stamps the choice into the contract', async () => {
    invokeMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(briefReply);
    const agent = createCadAgent(undefined, 'test-model');
    const config = newConfig();

    const paused = await agent.invoke({ messages: [new HumanMessage('a wall bracket')] }, config);

    expect(isInterrupted(paused)).toBe(true);
    const payload = gatePayload(paused);
    expect(payload.kind).toBe('research');
    expect(payload.brief.partClass).toBe('wall bracket');
    expect(payload.brief.approaches.map((a: any) => [a.id, a.grounding])).toEqual([['a1', 'cited'], ['a2', 'recalled']]);
    expect(payload.brief.recommendedId).toBe('a1');
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(contentsOf(0).some((c) => c.includes('Plan web searches'))).toBe(true);
    expect(contentsOf(1).some((c) => c.includes('Compare construction approaches'))).toBe(true);

    // Pick the non-recommended approach; the Architect then gates on an assumption.
    invokeMock.mockResolvedValueOnce(gatedSpec());
    const atSpecGate = await agent.invoke(new Command({ resume: { action: 'approve', chosenApproachId: 'a2' } }), config);
    expect(gatePayload(atSpecGate).kind).toBe('spec');

    const state = (await agent.getState(config)).values;
    expect(state.designContract?.researchApproach?.approach.id).toBe('a2');
    expect(state.designContract?.researchApproach?.approach.name).toBe('Folded channel');
    expect(state.designContract?.researchApproach?.partClass).toBe('wall bracket');
    expect(state.researchSkipReason).toBeNull();
    // Consumed and cleared: nothing from this gate may read as fresh feedback later.
    expect(state.gateAction).toBeNull();
    expect(state.gateFeedback).toBeNull();
  });

  it('falls back to the recommendation for an unknown id and for a stray revise', async () => {
    for (const decision of [{ action: 'approve', chosenApproachId: 'nope' }, { action: 'revise', comment: 'again' }]) {
      invokeMock.mockReset();
      invokeMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(briefReply).mockResolvedValueOnce(gatedSpec());
      const agent = createCadAgent(undefined, 'test-model');
      const config = newConfig();
      await agent.invoke({ messages: [new HumanMessage('a wall bracket')] }, config);
      const next = await agent.invoke(new Command({ resume: decision }), config);
      expect(gatePayload(next).kind).toBe('spec');
      const state = (await agent.getState(config)).values;
      expect(state.designContract?.researchApproach?.approach.id).toBe('a1');
      // A stray revise must not have re-run research.
      expect(invokeMock).toHaveBeenCalledTimes(3);
    }
  });

  it('cancel at the research gate ends the run', async () => {
    invokeMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(briefReply);
    const agent = createCadAgent(undefined, 'test-model');
    const config = newConfig();
    await agent.invoke({ messages: [new HumanMessage('a wall bracket')] }, config);
    const done = await agent.invoke(new Command({ resume: { action: 'cancel' } }), config);
    expect(isInterrupted(done)).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(done.gateAction).toBe('cancel');
    expect(done.assemblySpec).toBeNull();
  });

  it('skips research when disabled, when there is no provider, and when the contract already carries an approach', async () => {
    const cases: Array<[string, () => void, Record<string, unknown>]> = [
      ['disabled', () => { process.env.CADAI_RESEARCH = 'off'; }, {}],
      ['no_provider', () => { delete process.env.CADAI_RESEARCH_STUB; }, {}],
      [
        'already_researched',
        () => {},
        {
          designContract: {
            standing: {},
            pinnedParams: {},
            researchApproach: {
              partClass: 'wall bracket',
              chosenAt: 1,
              approach: { id: 'a1', name: 'Plate and gusset', construction: 'c', strengths: [], weaknesses: [], sources: [], grounding: 'recalled' },
            },
          },
        },
      ],
    ];
    for (const [reason, arrange, input] of cases) {
      invokeMock.mockReset();
      process.env.CADAI_RESEARCH = 'on';
      process.env.CADAI_RESEARCH_STUB = '1';
      arrange();
      // No research calls: the first model call is the Architect, then the drafter.
      invokeMock.mockResolvedValueOnce(baseSpec()).mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
      const agent = createCadAgent(undefined, 'test-model');
      const config = newConfig();
      const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')], ...input }, config);
      expect(result.researchSkipReason, reason).toBe(reason);
      expect(result.designBrief, reason).toBeNull();
      expect(result.isValid, reason).toBe(true);
      expect(invokeMock, reason).toHaveBeenCalledTimes(2);
      expect(contentsOf(0).some((c) => c.includes('Mechanical Architect')), reason).toBe(true);
    }
  });

  it('degrades to the Architect when the brief cannot be produced, and reports why', async () => {
    const events: StreamEventPayload[] = [];
    // Plan ok, then two invalid briefs, then the run proceeds as before.
    invokeMock
      .mockResolvedValueOnce(plan)
      .mockResolvedValueOnce({ approaches: [] })
      .mockResolvedValueOnce({ approaches: [] })
      .mockResolvedValueOnce(baseSpec())
      .mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    const agent = createCadAgent((e) => events.push(e), 'test-model');
    const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, newConfig());
    expect(result.researchSkipReason).toBe('brief_failed');
    expect(result.isValid).toBe(true);
    expect(events.some((e) => e.type === 'thinking' && /no valid brief/.test(e.message))).toBe(true);
  });
});

describe('Architect binding', () => {
  beforeEach(() => {
    process.env.CADAI_VISUAL_CRITIC = 'off';
    process.env.CADAI_MAX_ATTEMPTS = '1';
    process.env.CADAI_RESEARCH = 'on';
    process.env.CADAI_RESEARCH_STUB = '1';
    invokeMock.mockReset();
  });

  const block = (c: string) => c.includes('Design Approach (chosen by the user from prior-art research)');

  it('hands the Architect the chosen approach exactly once, on every pass, and never in the history', async () => {
    invokeMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(briefReply);
    const agent = createCadAgent(undefined, 'test-model');
    const config = newConfig();
    await agent.invoke({ messages: [new HumanMessage('a 40mm wall bracket')] }, config);

    invokeMock.mockResolvedValueOnce(gatedSpec());
    await agent.invoke(new Command({ resume: { action: 'approve', chosenApproachId: 'a2' } }), config);
    const architect1 = contentsOf(2);
    expect(architect1.filter(block)).toHaveLength(1);
    expect(architect1.some((c) => c.includes('Name: Folded channel'))).toBe(true);
    expect(architect1.some((c) => c.includes('DESIGN APPROACH'))).toBe(true); // the preamble rule

    // A spec-gate revise re-runs the Architect: still exactly one block.
    invokeMock.mockResolvedValueOnce(baseSpec()).mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    await agent.invoke(new Command({ resume: { action: 'revise', comment: 'thinner' } }), config);
    const architect2 = contentsOf(3);
    expect(architect2.filter(block)).toHaveLength(1);
    expect(architect2.some((c) => c.includes('thinner'))).toBe(true);

    const state = (await agent.getState(config)).values;
    expect(state.messages.some((m: any) => block(String(m.content)))).toBe(false);
  });

  it('binds a later turn from the contract alone, with no research calls', async () => {
    invokeMock.mockResolvedValueOnce(baseSpec()).mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    const agent = createCadAgent(undefined, 'test-model');
    const result = await agent.invoke(
      {
        messages: [new HumanMessage('a 40mm box')],
        designContract: {
          standing: {},
          pinnedParams: {},
          researchApproach: {
            partClass: 'box',
            chosenAt: 1,
            approach: { id: 'a1', name: 'Lidded shell', construction: 'c', strengths: [], weaknesses: [], sources: [], grounding: 'recalled' },
          },
        },
      },
      newConfig()
    );
    expect(result.researchSkipReason).toBe('already_researched');
    expect(contentsOf(0).filter(block)).toHaveLength(1);
    expect(contentsOf(0).some((c) => c.includes('Name: Lidded shell'))).toBe(true);
  });

  it('names the approach and its sources at the top of the final explanation', async () => {
    const events: StreamEventPayload[] = [];
    invokeMock
      .mockResolvedValueOnce(plan)
      .mockResolvedValueOnce(briefReply)
      .mockResolvedValueOnce(baseSpec())
      .mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    const agent = createCadAgent((e) => events.push(e), 'test-model');
    const config = newConfig();
    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);
    await agent.invoke(new Command({ resume: { action: 'approve' } }), config);

    const ready = events.find((e) => e.type === 'ready');
    expect(ready?.explanation?.startsWith('Design approach: Plate and gusset')).toBe(true);
    expect(ready?.explanation).toContain(`[FDM brackets](${STUB_HITS[0].url})`);
    expect(ready?.explanation).toContain('Assembly Spec: test_box');
    expect(ready?.designContract?.researchApproach?.approach.id).toBe('a1');
  });
});
