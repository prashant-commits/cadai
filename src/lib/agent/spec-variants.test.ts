import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mergeBriefIntoSpec,
  SpecBrief,
  SpecVariant,
  recommendedVariant,
  processPlannerVariants,
  gateVariants,
} from './spec-variants';
import { AssemblySpec } from './assembly-spec';
import { HumanMessage } from '@langchain/core/messages';

const invokeMock = vi.fn();
const configCalls: unknown[] = [];

vi.mock('@langchain/openai', () => {
  class FakeChatModel {
    invoke = invokeMock;
    async *stream(...args: unknown[]) {
      yield await invokeMock(...args);
    }
    withStructuredOutput() {
      return this;
    }
    withConfig(cfg: unknown) {
      configCalls.push(cfg);
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

function baseSpec(overrides: Record<string, unknown> = {}): AssemblySpec {
  return {
    assemblyName: 'test_box',
    boundingBox: { width: 40, length: 40, height: 40 },
    components: [{ name: 'box', description: 'a box' }],
    guides: [],
    stressPoints: [],
    assumptions: [],
    openQuestions: [],
    sheet: '## Sheet markdown',
    ...overrides,
  };
}

describe('spec-variants helpers', () => {
  it('mergeBriefIntoSpec merges assumptions and openQuestions', () => {
    const spec = baseSpec({
      assemblyName: 'test',
      boundingBox: { width: 10, length: 10, height: 10 },
      assumptions: [{ field: 'a', value: '1', rationale: 'r1' }],
      openQuestions: [],
    });
    const brief: SpecBrief = {
      markdown: 'plan',
      assumptions: [{ field: 'b', value: '2', rationale: 'r2' }],
      openQuestions: [{ id: 'q1', question: 'Q?', suggestedAnswer: 'A' }],
      recommendedId: 'A',
    };
    const merged = mergeBriefIntoSpec(spec, brief);
    expect(merged.assumptions).toEqual([
      { field: 'b', value: '2', rationale: 'r2' },
      { field: 'a', value: '1', rationale: 'r1' },
    ]);
    expect(merged.openQuestions).toEqual([{ id: 'q1', question: 'Q?', suggestedAnswer: 'A' }]);
  });

  it('mergeBriefIntoSpec handles null brief gracefully', () => {
    const spec = baseSpec();
    expect(mergeBriefIntoSpec(spec, null)).toEqual(spec);
  });

  it('recommendedVariant fallback', () => {
    const variants: SpecVariant[] = [
      { id: 'A', name: 'A', idea: 'A', spec: null, version: 1, retries: 0, needsRevision: false, sheetSvg: null, review: null },
      { id: 'B', name: 'B', idea: 'B', spec: { assemblyName: 'B' } as unknown as AssemblySpec, version: 1, retries: 0, needsRevision: false, sheetSvg: null, review: null },
    ];

    // Brief recommends A, but A has no spec, so it falls back to B
    const brief: SpecBrief = { markdown: '', assumptions: [], openQuestions: [], recommendedId: 'A' };
    expect(recommendedVariant(variants, brief)?.id).toBe('B');
  });

  it('recommendedVariant returns null when empty or all specs null', () => {
    expect(recommendedVariant([], null)).toBeNull();
    const variants: SpecVariant[] = [
      { id: 'A', name: 'A', idea: 'A', spec: null, version: 1, retries: 0, needsRevision: false, sheetSvg: null, review: null },
    ];
    expect(recommendedVariant(variants, null)).toBeNull();
  });

  describe('processPlannerVariants', () => {
    it('clamps to max variants', () => {
      const input = [
        { id: 'A' as const, name: 'A', idea: 'idea A' },
        { id: 'B' as const, name: 'B', idea: 'idea B' },
        { id: 'C' as const, name: 'C', idea: 'idea C' },
      ];
      const result = processPlannerVariants(input, 'A', 2);
      expect(result.variants).toHaveLength(2);
      expect(result.variants.map((v) => v.id)).toEqual(['A', 'B']);
    });

    it('dedupes variant IDs', () => {
      const input = [
        { id: 'A' as const, name: 'A1', idea: 'idea A1' },
        { id: 'A' as const, name: 'A2', idea: 'idea A2' },
        { id: 'B' as const, name: 'B', idea: 'idea B' },
      ];
      const result = processPlannerVariants(input, 'B', 3);
      expect(result.variants).toHaveLength(2);
      expect(result.variants.map((v) => v.id)).toEqual(['A', 'B']);
      expect(result.recommendedId).toBe('B');
    });

    it('falls back recommendedId if not in planned variants', () => {
      const input = [
        { id: 'A' as const, name: 'A', idea: 'idea A' },
        { id: 'B' as const, name: 'B', idea: 'idea B' },
      ];
      const result = processPlannerVariants(input, 'C', 2);
      expect(result.recommendedId).toBe('A');
    });
  });

  describe('gateVariants', () => {
    it('returns payload.variants when present', () => {
      const variants = [
        {
          id: 'A' as const,
          name: 'Box A',
          idea: 'idea 1',
          spec: null,
          sheetSvg: null,
          review: null,
        },
        {
          id: 'B' as const,
          name: 'Box B',
          idea: 'idea 2',
          spec: null,
          sheetSvg: null,
          review: null,
        },
      ];
      expect(gateVariants({ variants })).toEqual(variants);
    });

    it('returns a single variant A for legacy payload with only spec', () => {
      const spec = baseSpec({ assemblyName: 'legacy_box' });
      const result = gateVariants({ spec });
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'A',
        name: 'legacy_box',
        idea: '',
        spec,
        sheetSvg: null,
        review: null,
      });
    });

    it('returns empty array when neither variants nor spec are present', () => {
      expect(gateVariants({})).toEqual([]);
      expect(gateVariants({ spec: null })).toEqual([]);
    });
  });
});

describe('architect variants graph execution', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    configCalls.length = 0;
    process.env.CADAI_VISUAL_CRITIC = 'off';
  });

  it('tags structured calls with nostream and avoids raw JSON in transcript deltas', async () => {
    const saved = process.env.CADAI_MAX_VARIANTS;
    process.env.CADAI_MAX_VARIANTS = '1';
    try {
      invokeMock.mockResolvedValueOnce({
        brief: 'Planner brief statement',
        assumptions: [],
        openQuestions: [],
        variants: [{ id: 'A', name: 'VarA', idea: 'Idea A' }],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(baseSpec());
      invokeMock.mockResolvedValueOnce({ content: '```openscad\ncube(40);\n```', tool_calls: [] });

      const agent = createCadAgent('m');
      const deltas: string[] = [];
      await agent.invoke(
        { messages: [new HumanMessage('a 40mm box')] },
        {
          configurable: { thread_id: `test-${Date.now()}` },
          writer: (ev: Record<string, unknown>) => {
            if (ev?.node === 'architectNode' && ev?.t === 'delta' && typeof ev.text === 'string') {
              deltas.push(ev.text);
            }
          },
        } as unknown as Parameters<typeof agent.invoke>[1]
      );

      // nostream tag present
      expect(configCalls.some((c) => (c as { tags?: string[] })?.tags?.includes('nostream'))).toBe(true);

      // deltas emitted
      expect(deltas.length).toBeGreaterThan(0);
      const fullDelta = deltas.join('');
      expect(fullDelta).toContain('Planner brief statement');
      expect(fullDelta).toContain('### Variant A - VarA');
      // No raw JSON schema leaked
      expect(fullDelta).not.toContain('"assemblyName"');
      expect(fullDelta).not.toContain('"boundingBox"');
    } finally {
      if (saved !== undefined) process.env.CADAI_MAX_VARIANTS = saved;
      else delete process.env.CADAI_MAX_VARIANTS;
    }
  });

  it('parallel variants where one fails leaves the other intact and labels failure', async () => {
    const saved = process.env.CADAI_MAX_VARIANTS;
    process.env.CADAI_MAX_VARIANTS = '2';
    try {
      invokeMock.mockResolvedValueOnce({
        brief: 'Plan 2 variants',
        assumptions: [],
        openQuestions: [],
        variants: [
          { id: 'A', name: 'VarA', idea: 'Idea A' },
          { id: 'B', name: 'VarB', idea: 'Idea B' },
        ],
        recommendedId: 'A',
      });
      // Variant A succeeds
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'variant_a' }));
      // Variant B fails after 3 attempts (all return invalid spec)
      invokeMock.mockResolvedValueOnce({ invalid: true });
      invokeMock.mockResolvedValueOnce({ invalid: true });
      invokeMock.mockResolvedValueOnce({ invalid: true });
      invokeMock.mockResolvedValueOnce({ content: '```openscad\ncube(40);\n```', tool_calls: [] });

      const agent = createCadAgent('m');
      const config = { configurable: { thread_id: `test-${Date.now()}` } };
      await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

      const state = (await agent.getState(config)).values;
      expect(state.specVariants).toHaveLength(2);
      const varA = (state.specVariants as SpecVariant[]).find((v) => v.id === 'A');
      const varB = (state.specVariants as SpecVariant[]).find((v) => v.id === 'B');

      expect(varA?.spec).not.toBeNull();
      expect(varA?.spec?.assemblyName).toBe('variant_a');
      expect(varA?.error).toBeUndefined();

      expect(varB?.spec).toBeNull();
      expect(varB?.error).toBeTruthy();
    } finally {
      if (saved !== undefined) process.env.CADAI_MAX_VARIANTS = saved;
      else delete process.env.CADAI_MAX_VARIANTS;
    }
  });

  it('revision mode regenerates only needsRevision variants and bumps version', async () => {
    // Initial state with two variants, one needing revision
    const existingVarA: SpecVariant = {
      id: 'A',
      name: 'VarA',
      idea: 'Idea A',
      spec: baseSpec({ assemblyName: 'spec_a_v1' }),
      version: 1,
      sheetSvg: 'svg-a',
      review: { validated: true, findings: [], attempts: 1 },
      retries: 0,
      needsRevision: false,
    };
    const existingVarB: SpecVariant = {
      id: 'B',
      name: 'VarB',
      idea: 'Idea B',
      spec: baseSpec({ assemblyName: 'spec_b_v1' }),
      version: 1,
      sheetSvg: 'svg-b',
      review: {
        validated: false,
        findings: [{ issue: 'wall too thin', severity: 'major' }],
        attempts: 1,
      },
      retries: 1,
      needsRevision: true,
    };

    // Revision mock: only Variant B is generated!
    invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_b_v2' }));

    const agent = createCadAgent('m');
    const config = { configurable: { thread_id: `test-${Date.now()}` } };
    await agent.invoke(
      {
        messages: [new HumanMessage('fix wall')],
        specVariants: [existingVarA, existingVarB],
        specBrief: { markdown: 'brief', assumptions: [], openQuestions: [], recommendedId: 'A' },
        humanSpecNotes: ['note1'],
      },
      config
    );

    const state = (await agent.getState(config)).values;
    const varA = (state.specVariants as SpecVariant[]).find((v) => v.id === 'A');
    const varB = (state.specVariants as SpecVariant[]).find((v) => v.id === 'B');

    // VarA untouched
    expect(varA?.version).toBe(1);
    expect(varA?.spec?.assemblyName).toBe('spec_a_v1');
    expect(varA?.sheetSvg).toBe('svg-a');

    // VarB regenerated with bumped version and cleared flags
    expect(varB?.version).toBe(2);
    expect(varB?.spec?.assemblyName).toBe('spec_b_v2');
    expect(varB?.sheetSvg).toBeNull();
    expect(varB?.review).toBeNull();
    expect(varB?.needsRevision).toBe(false);
    expect(varB?.retries).toBe(1); // kept
  });

  it('planner and variant calls use separate system messages and variant prompt contains brief and other variants', async () => {
    const saved = process.env.CADAI_MAX_VARIANTS;
    process.env.CADAI_MAX_VARIANTS = '2';
    try {
      invokeMock.mockResolvedValueOnce({
        brief: 'Planner brief description',
        assumptions: [{ field: 'wall', value: '2mm', rationale: 'rigidity' }],
        openQuestions: [{ id: 'q1', question: 'Add logo?', suggestedAnswer: 'no' }],
        variants: [
          { id: 'A', name: 'Alpha', idea: 'Idea Alpha' },
          { id: 'B', name: 'Beta', idea: 'Idea Beta' },
        ],
        recommendedId: 'A',
      });
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_alpha' }));
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'spec_beta' }));
      invokeMock.mockResolvedValueOnce({ content: '```openscad\ncube(10);\n```', tool_calls: [] });

      const agent = createCadAgent('m');
      const config = { configurable: { thread_id: `test-prompts-${Date.now()}` } };
      await agent.invoke({ messages: [new HumanMessage('dual variant stand')] }, config);

      expect(invokeMock).toHaveBeenCalled();
      const plannerCallMessages = invokeMock.mock.calls[0][0];
      const variantACallMessages = invokeMock.mock.calls[1][0];
      const variantBCallMessages = invokeMock.mock.calls[2][0];

      // 1. Planner and variant calls use DIFFERENT system messages
      const plannerSysMsg = plannerCallMessages[0];
      const variantSysMsg = variantACallMessages[0];
      expect(plannerSysMsg.content).toContain('Mechanical Architect Planner');
      expect(plannerSysMsg.content).not.toContain('Mechanical Architect Specifier');
      expect(variantSysMsg.content).toContain('Mechanical Architect Specifier');
      expect(variantSysMsg.content).not.toContain('Mechanical Architect Planner');

      // 2. Variant prompt contains planner brief
      const varAHumanMsg = variantACallMessages[variantACallMessages.length - 1];
      expect(varAHumanMsg.content).toContain('Planner brief description');
      expect(varAHumanMsg.content).toContain('Shared Assumptions');
      expect(varAHumanMsg.content).toContain('The user will be asked');
      expect(varAHumanMsg.content).toContain('Add logo?');

      // 3. Variant prompt contains other variants' names and ideas
      expect(varAHumanMsg.content).toContain('Variant B: Beta - Idea Beta');
      const varAOtherSection = varAHumanMsg.content.split('Other variants planned')[1]?.split('Generate the Assembly Spec')[0];
      expect(varAOtherSection).toContain('Variant B: Beta - Idea Beta');
      expect(varAOtherSection).not.toContain('Variant A');

      const varBHumanMsg = variantBCallMessages[variantBCallMessages.length - 1];
      expect(varBHumanMsg.content).toContain('Variant A: Alpha - Idea Alpha');
      const varBOtherSection = varBHumanMsg.content.split('Other variants planned')[1]?.split('Generate the Assembly Spec')[0];
      expect(varBOtherSection).toContain('Variant A: Alpha - Idea Alpha');
      expect(varBOtherSection).not.toContain('Variant B');
    } finally {
      if (saved !== undefined) process.env.CADAI_MAX_VARIANTS = saved;
      else delete process.env.CADAI_MAX_VARIANTS;
    }
  });

  it('planner failing 3 times specs exactly one fallback variant, writes transcript notice, and has no raw error in state or transcript', async () => {
    const saved = process.env.CADAI_MAX_VARIANTS;
    process.env.CADAI_MAX_VARIANTS = '3';
    try {
      // Planner fails 3 times
      invokeMock.mockRejectedValueOnce(new Error('500 Internal Server Error {"details":"giant payload"}'));
      invokeMock.mockRejectedValueOnce(new Error('500 Internal Server Error {"details":"giant payload"}'));
      invokeMock.mockRejectedValueOnce(new Error('500 Internal Server Error {"details":"giant payload"}'));
      // Fallback variant A is specced
      invokeMock.mockResolvedValueOnce(baseSpec({ assemblyName: 'fallback_a' }));
      // Drafter
      invokeMock.mockResolvedValueOnce({ content: '```openscad\ncube(20);\n```', tool_calls: [] });

      const deltas: string[] = [];
      const agent = createCadAgent('m');
      const config = {
        configurable: { thread_id: `test-fallback-${Date.now()}` },
        writer: (ev: Record<string, unknown>) => {
          if (ev?.node === 'architectNode' && ev?.t === 'delta' && typeof ev.text === 'string') {
            deltas.push(ev.text);
          }
        },
      };
      await agent.invoke({ messages: [new HumanMessage('make a clip')] }, config);

      const state = (await agent.getState(config)).values;
      // Exactly one fallback variant was specced
      expect(state.specVariants).toHaveLength(1);
      const varA = (state.specVariants as SpecVariant[])[0];
      expect(varA.id).toBe('A');
      expect(varA.name).toBe('As requested');
      expect(varA.idea).toBe('the design the request describes');
      expect(varA.spec?.assemblyName).toBe('fallback_a');
      expect(varA.error).toBeUndefined();

      // Transcript says planning failed and single variant is being specced
      const fullDelta = deltas.join('');
      expect(fullDelta).toMatch(/planning failed.*single variant/i);
      // No raw error in transcript or state
      expect(fullDelta).not.toContain('500 Internal Server Error');
      expect(fullDelta).not.toContain('giant payload');
    } finally {
      if (saved !== undefined) process.env.CADAI_MAX_VARIANTS = saved;
      else delete process.env.CADAI_MAX_VARIANTS;
    }
  });

  it('variant failing with provider error sets short label error without leaking raw error into state', async () => {
    invokeMock.mockResolvedValueOnce({
      brief: 'Plan brief',
      variants: [{ id: 'A', name: 'VarA', idea: 'Idea A' }],
      recommendedId: 'A',
    });
    // Variant A fails 3 times with provider error
    invokeMock.mockRejectedValueOnce(new Error('400 Bad Request {"error":"invalid token"}'));
    invokeMock.mockRejectedValueOnce(new Error('400 Bad Request {"error":"invalid token"}'));
    invokeMock.mockRejectedValueOnce(new Error('400 Bad Request {"error":"invalid token"}'));
    // Drafter
    invokeMock.mockResolvedValueOnce({ content: '```openscad\ncube(20);\n```', tool_calls: [] });

    const agent = createCadAgent('m');
    const config = { configurable: { thread_id: `test-var-err-${Date.now()}` } };
    await agent.invoke({ messages: [new HumanMessage('make a box')] }, config);

    const state = (await agent.getState(config)).values;
    const varA = (state.specVariants as SpecVariant[])[0];
    expect(varA.spec).toBeNull();
    expect(varA.error).toBe('No valid spec after 3 attempts (provider error).');
    expect(varA.error).not.toContain('400 Bad Request');
    expect(varA.error).not.toContain('invalid token');
  });
});

