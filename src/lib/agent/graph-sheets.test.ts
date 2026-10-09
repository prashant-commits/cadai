import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { isInterrupted, INTERRUPT, Command } from '@langchain/langgraph';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import { GatePayload, VariantId } from '@/types';

const invokeMock = vi.fn();
let lastConfig: { tags?: string[] } | null = null;

vi.mock('@langchain/openai', () => {
  class FakeChatModel {
    // Revision replies are widened so they differ from the previous spec (see revision-fixture.ts).
    invoke = async (...args: unknown[]) => {
      const out = await invokeMock(...args);
      const h = await import('./revision-fixture');
      return h.isRevisionCall(args[0]) ? h.distinctRevision(out) : out;
    };
    async *stream(...args: unknown[]) {
      yield await invokeMock(...args);
    }
    withStructuredOutput() {
      return this;
    }
    withConfig(cfg: { tags?: string[] }) {
      lastConfig = cfg;
      return this;
    }
    bindTools() {
      return this;
    }
  }
  return {
    ChatOpenAI: vi.fn().mockImplementation(function () {
      return new FakeChatModel();
    }),
  };
});

import { createCadAgent } from './graph';

const createdKeys: string[] = [];
let counter = 0;
function newKey() {
  const key = runCheckpointKey(`sheets-test-${Date.now()}`, `run-${counter++}`);
  createdKeys.push(key);
  return key;
}

afterAll(async () => {
  const cp = getCheckpointer();
  for (const k of createdKeys) await cp.deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
  process.env.CADAI_MAX_VARIANTS = '1';
  delete process.env.CADAI_SPEC_SHEETS;
  delete process.env.CADAI_SPEC_REVIEW_RETRIES;
  delete process.env.CADAI_SPEC_REVIEW_BUDGET_MS;
  delete process.env.CADAI_DRAFTER_START;
  delete process.env.CADAI_CRITIC_MODEL;
  delete process.env.VERCEL;
});

function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    sheet: '## Plate\n40mm box',
    assemblyName: 'test_box',
    boundingBox: { width: 40, length: 40, height: 40 },
    components: [
      {
        name: 'box',
        description: 'a box',
        localExtents: [40, 40, 40],
        position: [0, 0, 0],
        shape: { kind: 'box' },
      },
    ],
    assumptions: [],
    openQuestions: [],
    ...overrides,
  };
}

const draftResponse = (code: string) => ({
  content: `\`\`\`openscad\n${code}\n\`\`\``,
  tool_calls: [],
});

function gatePayload(result: unknown): Extract<GatePayload, { kind: 'spec' }> {
  const r = result as Record<string | symbol, Array<{ value: Extract<GatePayload, { kind: 'spec' }> }>>;
  return r[INTERRUPT][0].value;
}

describe('spec sheets and reviewer loop', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    lastConfig = null;
    process.env.CADAI_SPEC_SHEETS = 'on';
    process.env.CADAI_MAX_VARIANTS = '3';
    delete process.env.CADAI_SPEC_REVIEW_RETRIES;
    delete process.env.CADAI_SPEC_REVIEW_BUDGET_MS;
    delete process.env.CADAI_DRAFTER_START;
    delete process.env.VERCEL;
  });

  describe('reviewer loop table', () => {
    it('all pass -> gate', async () => {
      // Planner: 2 variants
      invokeMock.mockResolvedValueOnce({
        brief: 'Plan for box',
        assumptions: [],
        openQuestions: [],
        variants: [
          { id: 'A', name: 'VarA', idea: 'Box A' },
          { id: 'B', name: 'VarB', idea: 'Box B' },
        ],
        recommendedId: 'A',
      });
      // Variant A spec
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'box_a' }));
      // Variant B spec
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'box_b' }));
      // Reviewer call for Variant A
      invokeMock.mockResolvedValueOnce({
        matchesRequest: true,
        findings: [],
      });
      // Reviewer call for Variant B
      invokeMock.mockResolvedValueOnce({
        matchesRequest: true,
        findings: [],
      });

      const agent = createCadAgent('gpt-5.6-luna');
      const result = await agent.invoke(
        { messages: [new HumanMessage('a 40mm box')] },
        { configurable: { thread_id: newKey() } }
      );

      expect(isInterrupted(result)).toBe(true);
      const payload = gatePayload(result);
      expect(payload.kind).toBe('spec');
      expect(payload.variants!).toHaveLength(2);
      expect(payload.variants![0].review?.validated).toBe(true);
      expect(payload.variants![1].review?.validated).toBe(true);
      expect(payload.variants![0].sheetSvg).toContain('<svg');
      expect(payload.variants![1].sheetSvg).toContain('<svg');
    });

    it('one variant major -> only it goes back to architect, version bumps, others untouched', async () => {
      let varAReviewCount = 0;
      invokeMock.mockImplementation((messages: unknown) => {
        const text = JSON.stringify(messages);
        // Reviewer calls
        if (text.includes('Evaluate whether this concept sheet matches the request')) {
          if (text.includes('Variant A')) {
            varAReviewCount++;
            if (varAReviewCount > 1) {
              return Promise.resolve({ matchesRequest: true, findings: [] });
            }
            return Promise.resolve({
              matchesRequest: false,
              findings: [{ issue: 'Missing wall thickness', severity: 'major' }],
            });
          }
          return Promise.resolve({ matchesRequest: true, findings: [] });
        }
        // Revision spec for A
        if (text.includes('Revise this variant (A)')) {
          return Promise.resolve(baseSpec({ assemblyName: 'box_a_v2' }));
        }
        // Initial spec for A
        if (text.includes('Generate the Assembly Spec for Variant A')) {
          return Promise.resolve(baseSpec({ assemblyName: 'box_a' }));
        }
        // Initial spec for B
        if (text.includes('Generate the Assembly Spec for Variant B')) {
          return Promise.resolve(baseSpec({ assemblyName: 'box_b' }));
        }
        // Planner call
        return Promise.resolve({
          brief: 'Plan with 2 variants',
          assumptions: [],
          openQuestions: [],
          variants: [
            { id: 'A', name: 'VarA', idea: 'A' },
            { id: 'B', name: 'VarB', idea: 'B' },
          ],
          recommendedId: 'A',
        });
      });

      const threadKey = newKey();
      const agent = createCadAgent('gpt-5.6-luna');
      const result = await agent.invoke(
        { messages: [new HumanMessage('a 40mm box')] },
        { configurable: { thread_id: threadKey } }
      );

      expect(isInterrupted(result)).toBe(true);
      const payload = gatePayload(result);
      expect(payload.variants!).toHaveLength(2);
      const varA = payload.variants!.find((v) => v.id === 'A')!;
      const varB = payload.variants!.find((v) => v.id === 'B')!;

      // Var A was revised and version bumped
      expect(varA.spec?.assemblyName).toBe('box_a_v2');
      expect(varA.review?.validated).toBe(true);

      // Var B was untouched
      expect(varB.spec?.assemblyName).toBe('box_b');
      expect(varB.review?.validated).toBe(true);

      const state = (await agent.getState({ configurable: { thread_id: threadKey } })).values;
      const stateVarA = (state.specVariants as Array<{ id: string; version: number }>).find((v) => v.id === 'A')!;
      const stateVarB = (state.specVariants as Array<{ id: string; version: number }>).find((v) => v.id === 'B')!;
      expect(stateVarA.version).toBe(2);
      expect(stateVarB.version).toBe(1);
    });

    it('retries exhausted -> forward labelled validated:false and gate is forced', async () => {
      process.env.CADAI_SPEC_REVIEW_RETRIES = '1';

      // Planner
      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [],
        openQuestions: [],
        variants: [{ id: 'A', name: 'VarA', idea: 'A' }],
        recommendedId: 'A',
      });
      // Variant A spec v1
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'box_a' }));
      // Reviewer attempt 1: major issue -> retry 1
      invokeMock.mockResolvedValueOnce({
        matchesRequest: false,
        findings: [{ issue: 'Wrong size', severity: 'major' }],
      });
      // Revision architect v2
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'box_a_v2' }));
      // Reviewer attempt 2: major issue again -> retries exhausted (retries 1 >= max 1)
      invokeMock.mockResolvedValueOnce({
        matchesRequest: false,
        findings: [{ issue: 'Still wrong size', severity: 'major' }],
      });

      const agent = createCadAgent('gpt-5.6-luna');
      const result = await agent.invoke(
        { messages: [new HumanMessage('a 40mm box')] },
        { configurable: { thread_id: newKey() } }
      );

      expect(isInterrupted(result)).toBe(true);
      const payload = gatePayload(result);
      const varA = payload.variants![0];
      expect(varA.review?.validated).toBe(false);
      expect(varA.review?.attempts).toBe(2);
      expect(varA.review?.findings).toHaveLength(1);
    });

    it('Vercel deadline passed -> no retry', async () => {
      process.env.VERCEL = '1';
      process.env.CADAI_SPEC_REVIEW_BUDGET_MS = '-1000'; // deadline in the past

      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [],
        openQuestions: [],
        variants: [{ id: 'A', name: 'VarA', idea: 'A' }],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(baseSpec());
      // Reviewer reports major flaw, but deadline expired
      invokeMock.mockResolvedValueOnce({
        matchesRequest: false,
        findings: [{ issue: 'Flaw', severity: 'major' }],
      });

      const agent = createCadAgent('gpt-5.6-luna');
      const result = await agent.invoke(
        { messages: [new HumanMessage('a 40mm box')] },
        { configurable: { thread_id: newKey() } }
      );

      // Only 3 calls made: planner, variant, reviewer (no retry)
      expect(invokeMock).toHaveBeenCalledTimes(3);
      expect(isInterrupted(result)).toBe(true);
      const payload = gatePayload(result);
      expect(payload.variants![0].review?.validated).toBe(false);
    });

    it('reviewer call throws -> labelled, run continues', async () => {
      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [],
        openQuestions: [],
        variants: [{ id: 'A', name: 'VarA', idea: 'A' }],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(baseSpec());
      // Reviewer call throws
      invokeMock.mockRejectedValueOnce(new Error('Gateway timeout 504'));

      const agent = createCadAgent('gpt-5.6-luna');
      const result = await agent.invoke(
        { messages: [new HumanMessage('a 40mm box')] },
        { configurable: { thread_id: newKey() } }
      );

      expect(isInterrupted(result)).toBe(true);
      const payload = gatePayload(result);
      const varA = payload.variants![0];
      expect(varA.review?.validated).toBe(false);
      expect(varA.review?.note).toBe('review unavailable');
    });
  });

  describe('specGate decisions and revision', () => {
    it('specGate approve with chosenVariantId B -> drafter receives Bs merged spec', async () => {
      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [{ field: 'tolerance', value: '0.2', rationale: 'snug' }],
        openQuestions: [],
        variants: [
          { id: 'A', name: 'VarA', idea: 'A' },
          { id: 'B', name: 'VarB', idea: 'B' },
        ],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_a' }));
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_b' }));
      invokeMock.mockResolvedValueOnce({ matchesRequest: true, findings: [] });
      invokeMock.mockResolvedValueOnce({ matchesRequest: true, findings: [] });

      const key = newKey();
      const config = { configurable: { thread_id: key } };
      const agent = createCadAgent('gpt-5.6-luna');
      await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

      invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

      await agent.invoke(
        new Command({ resume: { action: 'approve', chosenVariantId: 'B' } }),
        config
      );

      // Call 5 is drafter
      const drafterMessages = invokeMock.mock.calls[5][0] as BaseMessage[];
      const drafterHumanText = JSON.stringify(drafterMessages);
      expect(drafterHumanText).toContain('spec_b');
      expect(drafterHumanText).toContain('tolerance');
    });

    it('specGate approve with unknown id -> falls back to recommended', async () => {
      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [],
        openQuestions: [],
        variants: [
          { id: 'A', name: 'VarA', idea: 'A' },
          { id: 'B', name: 'VarB', idea: 'B' },
        ],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_a' }));
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_b' }));
      invokeMock.mockResolvedValueOnce({ matchesRequest: true, findings: [] });
      invokeMock.mockResolvedValueOnce({ matchesRequest: true, findings: [] });

      const key = newKey();
      const config = { configurable: { thread_id: key } };
      const agent = createCadAgent('gpt-5.6-luna');
      await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

      invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

      await agent.invoke(
        new Command({ resume: { action: 'approve', chosenVariantId: 'Z' as VariantId } }),
        config
      );

      const drafterMessages = invokeMock.mock.calls[5][0] as BaseMessage[];
      const drafterHumanText = JSON.stringify(drafterMessages);
      expect(drafterHumanText).toContain('spec_a');
    });

    it('specGate revise carries notes into the chosen variant, resets budget, and notes survive a subsequent reviewer round', async () => {
      process.env.CADAI_SPEC_REVIEW_RETRIES = '3';

      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [],
        openQuestions: [{ id: 'q1', question: 'Bolt size?', options: [], suggestedAnswer: '' }],
        variants: [
          { id: 'A', name: 'VarA', idea: 'A' },
          { id: 'B', name: 'VarB', idea: 'B' },
        ],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_a' }));
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_b' }));
      invokeMock.mockResolvedValueOnce({ matchesRequest: true, findings: [] });
      invokeMock.mockResolvedValueOnce({ matchesRequest: true, findings: [] });

      const key = newKey();
      const config = { configurable: { thread_id: key } };
      const agent = createCadAgent('gpt-5.6-luna');
      await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);
      const callsBeforeRevise = invokeMock.mock.calls.length; // planner, A, B, reviewer x2

      // Revise Variant B: NO planner call. Call 5 revises B from the human comment,
      // call 6 reviews it (major -> another round), call 7 revises again, call 8 passes.
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_b_revised' }));
      invokeMock.mockResolvedValueOnce({
        matchesRequest: false,
        findings: [{ issue: 'Needs gusset', severity: 'major' }],
      });
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_b_revised_v2' }));
      invokeMock.mockResolvedValueOnce({ matchesRequest: true, findings: [] });

      await agent.invoke(
        new Command({
          resume: {
            action: 'revise',
            chosenVariantId: 'B',
            comment: 'make walls 3mm',
            answers: { q1: 'M4' },
          },
        }),
        config
      );

      const afterRevise = invokeMock.mock.calls.slice(callsBeforeRevise).map((c) => JSON.stringify(c[0]));
      // First call after the gate is the human-driven revision of B itself.
      expect(afterRevise[0]).toContain('Revise this variant (B)');
      expect(afterRevise[0]).toContain('make walls 3mm');
      expect(afterRevise[0]).toContain('Bolt size?: M4');
      // No planner call anywhere after the gate.
      expect(afterRevise.some((t) => t.includes('Mechanical Architect Planner'))).toBe(false);
      // The notes survive into the reviewer-driven round (3rd call after the gate).
      expect(afterRevise[2]).toContain('Revise this variant (B)');
      expect(afterRevise[2]).toContain('make walls 3mm');
      expect(afterRevise[2]).toContain('Bolt size?: M4');
      expect(afterRevise[2]).toContain('Needs gusset');
    });
  });

  describe('drafter multimodal and state cleanup', () => {
    it('vision model + sheet gives HumanMessage image_url and blockout script, state cleared after draft', async () => {
      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [{ field: 'tolerance', value: '0.2', rationale: 'snug' }],
        openQuestions: [],
        variants: [{ id: 'A', name: 'VarA', idea: 'A' }],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(
        baseSpec({ assumptions: [{ field: 'tolerance', value: '0.2', rationale: 'snug' }] })
      );
      invokeMock.mockResolvedValueOnce({ matchesRequest: true, findings: [] });

      const key = newKey();
      const config = { configurable: { thread_id: key } };
      const agent = createCadAgent('gpt-5.6-luna');
      await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

      invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

      await agent.invoke(new Command({ resume: { action: 'approve' } }), config);

      // Call 3 is drafter
      const drafterMessages = invokeMock.mock.calls[3][0] as BaseMessage[];
      const drafterHuman = drafterMessages[drafterMessages.length - 1];
      const parts = drafterHuman.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;

      // HumanMessage has image_url
      const imgPart = parts.find((p) => p.type === 'image_url');
      expect(imgPart).toBeDefined();
      expect(imgPart?.image_url?.url).toMatch(/^data:image\/png;base64,/);

      // HumanMessage has starting script blockout
      const textPart = parts.find((p) => p.type === 'text')?.text ?? '';
      expect(textPart).toContain('This starting script has a module for each component');
      expect(textPart).toContain('module box()');

      // State cleanup: specVariants is empty, specBrief is null, messages has no images
      const state = (await agent.getState(config)).values;
      expect(state.specVariants).toEqual([]);
      expect(state.specBrief).toBeNull();
      for (const m of state.messages) {
        if (Array.isArray(m.content)) {
          expect(m.content.some((c: { type?: string }) => c.type === 'image_url')).toBe(false);
        }
      }
    });

    it('CADAI_DRAFTER_START=scratch omits starting script from drafter prompt', async () => {
      process.env.CADAI_DRAFTER_START = 'scratch';

      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [{ field: 'tolerance', value: '0.2', rationale: 'snug' }],
        openQuestions: [],
        variants: [{ id: 'A', name: 'VarA', idea: 'A' }],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(
        baseSpec({ assumptions: [{ field: 'tolerance', value: '0.2', rationale: 'snug' }] })
      );
      invokeMock.mockResolvedValueOnce({ matchesRequest: true, findings: [] });

      const key = newKey();
      const config = { configurable: { thread_id: key } };
      const agent = createCadAgent('gpt-5.6-luna');
      await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

      invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

      await agent.invoke(new Command({ resume: { action: 'approve' } }), config);

      const drafterMessages = invokeMock.mock.calls[3][0] as BaseMessage[];
      const drafterHuman = drafterMessages[drafterMessages.length - 1];
      const parts = drafterHuman.content as Array<{ type: string; text?: string }>;
      const textPart = parts.find((p) => p.type === 'text')?.text ?? '';
      expect(textPart).not.toContain('This starting script has a module for each component');
    });
  });

  describe('non-vision models and streaming', () => {
    it('non-vision model skips illustrator/reviewer with transcript note', async () => {
      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [],
        openQuestions: [],
        variants: [{ id: 'A', name: 'VarA', idea: 'A' }],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(baseSpec());
      invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

      const key = newKey();
      const agent = createCadAgent('deepseek-v4-flash');

      const custom: Array<{ t: string; node?: string; text?: string }> = [];
      for await (const [mode, payload] of await agent.stream(
        { messages: [new HumanMessage('a 40mm box')] },
        { configurable: { thread_id: key }, streamMode: ['updates', 'custom'] }
      )) {
        if (mode === 'custom') custom.push(payload as { t: string; node?: string; text?: string });
      }

      const skippedNotice = custom.find(
        (c) => c.text && c.text.includes('Concept sheets skipped: model does not support vision.')
      );
      expect(skippedNotice).toBeDefined();

      // Only planner, variant, drafter invoked (illustrator and reviewer skipped)
      expect(invokeMock).toHaveBeenCalledTimes(3);
    });

    it('tags the reviewer call with nostream and keeps raw JSON out of reviewer deltas (shallow; graph-no-raw-output.test.ts is the real leak check)', async () => {
      invokeMock.mockResolvedValueOnce({
        brief: 'Plan',
        assumptions: [],
        openQuestions: [],
        variants: [{ id: 'A', name: 'VarA', idea: 'A' }],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(baseSpec());
      invokeMock.mockResolvedValueOnce({
        matchesRequest: false,
        findings: [{ issue: 'Minor gap', severity: 'minor' }],
      });

      const key = newKey();
      const agent = createCadAgent('gpt-5.6-luna');

      const custom: Array<{ t: string; node?: string; text?: string }> = [];
      for await (const [mode, payload] of await agent.stream(
        { messages: [new HumanMessage('a 40mm box')] },
        { configurable: { thread_id: key }, streamMode: ['updates', 'custom'] }
      )) {
        if (mode === 'custom') custom.push(payload as { t: string; node?: string; text?: string });
      }

      expect(lastConfig?.tags).toContain('nostream');

      const reviewerDeltas = custom.filter((c) => c.node === 'specReviewer');
      expect(reviewerDeltas.length).toBeGreaterThan(0);
      for (const d of reviewerDeltas) {
        expect(d.text).not.toContain('{"matchesRequest"');
        expect(d.text).not.toContain('{"findings"');
      }
    });
  });
});
