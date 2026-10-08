import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { isInterrupted, INTERRUPT, Command } from '@langchain/langgraph';
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import type { GatePayload } from '@/types';

const invokeMock = vi.fn();
const flags = vi.hoisted(() => ({ drawFails: false }));

vi.mock('@langchain/openai', () => {
  class FakeChatModel {
    invoke = (...args: unknown[]) => invokeMock(...args);
    async *stream(...args: unknown[]) {
      yield await invokeMock(...args);
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
    ChatOpenAI: vi.fn().mockImplementation(function () {
      return new FakeChatModel();
    }),
  };
});

// Lets one test make the sheet renderer fail (illustrator failure row).
vi.mock('../spec-sheet/sheet-svg', async (importOriginal) => {
  const real = await importOriginal<typeof import('../spec-sheet/sheet-svg')>();
  return {
    ...real,
    renderVariantSheet: (...args: Parameters<typeof real.renderVariantSheet>) => {
      if (flags.drawFails) throw new Error('draw boom');
      return real.renderVariantSheet(...args);
    },
  };
});

import { createCadAgent, sheetNotes } from './graph';
import { graphRecursionLimit } from './run-limits';

const createdKeys: string[] = [];
let counter = 0;
function newKey() {
  const key = runCheckpointKey(`review-fixes-${Date.now()}`, `run-${counter++}`);
  createdKeys.push(key);
  return key;
}

afterAll(async () => {
  const cp = getCheckpointer();
  for (const k of createdKeys) await cp.deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
});

/** A 40 mm cube. */
function boxSpec(overrides: Record<string, unknown> = {}) {
  return {
    sheet: '## Plate\n40mm box',
    assemblyName: 'box_spec',
    boundingBox: { width: 40, length: 40, height: 40 },
    components: [
      { name: 'box', description: 'a box', localExtents: [40, 40, 40], position: [0, 0, 0], shape: { kind: 'box' } },
    ],
    assumptions: [],
    openQuestions: [],
    ...overrides,
  };
}

/** A 20 x 20 x 60 upright cylinder: visibly different from boxSpec on a sheet. */
function postSpec(overrides: Record<string, unknown> = {}) {
  return {
    sheet: '## Post\nB sheet marker',
    assemblyName: 'post_spec',
    boundingBox: { width: 20, length: 20, height: 60 },
    components: [
      {
        name: 'post',
        description: 'a post',
        localExtents: [20, 20, 60],
        position: [0, 0, 0],
        shape: { kind: 'cylinder', axis: 'z' },
      },
    ],
    assumptions: [],
    openQuestions: [],
    ...overrides,
  };
}

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
const variantOf = (messages: unknown): string => {
  const text = JSON.stringify(messages);
  return (
    /Generate the Assembly Spec for Variant ([ABC])\b/.exec(text)?.[1] ??
    /Revise this variant \(([ABC])\)/.exec(text)?.[1] ??
    /\\nVariant ([ABC]): /.exec(text)?.[1] ?? // the reviewer prompt's own header
    '?'
  );
};
const lastContent = (messages: unknown) => (messages as BaseMessage[]).at(-1)!.content;
const imageOf = (messages: unknown): string | undefined =>
  (lastContent(messages) as Array<{ type: string; image_url?: { url: string } }>)
    .find?.((p) => p.type === 'image_url')?.image_url?.url;

const plan = (ids: string[], recommendedId = 'A', extra: Record<string, unknown> = {}) => ({
  brief: 'Plan',
  assumptions: [],
  openQuestions: [],
  variants: ids.map((id) => ({ id, name: `Var${id}`, idea: id })),
  recommendedId,
  ...extra,
});
const pass = { matchesRequest: true, findings: [] };
const draft = { content: '```openscad\ncube([40,40,40]);\n```', tool_calls: [] };

function gatePayload(result: unknown): Extract<GatePayload, { kind: 'spec' }> {
  return (result as Record<string | symbol, Array<{ value: Extract<GatePayload, { kind: 'spec' }> }>>)[INTERRUPT][0].value;
}

const ENV_KEYS = [
  'CADAI_SPEC_SHEETS', 'CADAI_MAX_VARIANTS', 'CADAI_SPEC_REVIEW_RETRIES',
  'CADAI_SPEC_REVIEW_BUDGET_MS', 'CADAI_DRAFTER_START', 'VERCEL',
] as const;

beforeEach(() => {
  invokeMock.mockReset();
  flags.drawFails = false;
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CADAI_SPEC_SHEETS = 'on';
  process.env.CADAI_MAX_VARIANTS = '3';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('H1: the drafter gets the CHOSEN variant, not the recommended one', () => {
  it('approve B while A is recommended and carries an A-only finding -> B sheet image, no A finding', async () => {
    const reviewImages: Record<string, string> = {};
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A', 'B'], 'A');
        case 'variant': return variantOf(messages) === 'A' ? boxSpec({ assemblyName: 'stand_a' }) : postSpec({ assemblyName: 'stand_b' });
        case 'reviewer': {
          const id = variantOf(messages);
          reviewImages[id] = imageOf(messages)!;
          return id === 'A'
            ? { matchesRequest: false, findings: [{ issue: 'A-only finding', severity: 'minor' }] }
            : pass;
        }
        case 'drafter': return draft;
        default: return pass;
      }
    });

    const config = { configurable: { thread_id: newKey() } };
    const agent = createCadAgent('gpt-5.6-luna');
    await agent.invoke({ messages: [new HumanMessage('a stand')] }, config);
    await agent.invoke(new Command({ resume: { action: 'approve', chosenVariantId: 'B' } }), config);

    const drafterCall = invokeMock.mock.calls.map((c) => c[0]).find((m) => kindOf(m) === 'drafter')!;
    expect(reviewImages.A).toBeDefined();
    expect(reviewImages.B).not.toEqual(reviewImages.A);
    expect(imageOf(drafterCall)).toEqual(reviewImages.B);
    const text = JSON.stringify(drafterCall);
    expect(text).toContain('stand_b');
    expect(text).not.toContain('A-only finding');
    expect(text).not.toContain('stand_a');
  });

  it('a revise beyond the cap builds the chosen (non-recommended) variant as it stands, with a note', async () => {
    let revisions = 0;
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A', 'B'], 'A');
        case 'variant': return variantOf(messages) === 'A' ? boxSpec({ assemblyName: 'stand_a' }) : postSpec({ assemblyName: 'stand_b' });
        case 'revision': return postSpec({ assemblyName: `b_rev${++revisions}` });
        case 'drafter': return draft;
        default: return pass;
      }
    });

    const notes: string[] = [];
    const config = {
      configurable: { thread_id: newKey() },
      writer: (ev: Record<string, unknown>) => {
        if (ev?.t === 'delta' && typeof ev.text === 'string') notes.push(ev.text);
      },
    } as unknown as Parameters<ReturnType<typeof createCadAgent>['invoke']>[1];
    const agent = createCadAgent('gpt-5.6-luna');
    await agent.invoke({ messages: [new HumanMessage('a stand')] }, config);
    for (const comment of ['taller', 'wider', 'thicker']) {
      await agent.invoke(
        new Command({ resume: { action: 'revise', chosenVariantId: 'B', comment } }),
        config
      );
    }

    expect(revisions).toBe(2); // two revisions allowed; the third revise is spent
    const drafterCall = invokeMock.mock.calls.map((c) => c[0]).find((m) => kindOf(m) === 'drafter')!;
    const text = JSON.stringify(drafterCall);
    expect(text).toContain('b_rev2');
    expect(text).not.toContain('stand_a');
    expect(notes.join('')).toContain('Revision limit reached');
  });
});

describe('H2: a gate revise revises the chosen variant and never re-plans', () => {
  it('one "Revise this variant (B)" call with B previous sheet, image and comment; no second planner call', async () => {
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A', 'B'], 'A');
        case 'variant': return variantOf(messages) === 'A' ? boxSpec({ assemblyName: 'spec_a' }) : postSpec({ assemblyName: 'spec_b' });
        case 'revision': return postSpec({ assemblyName: 'spec_b_rev' });
        default: return pass;
      }
    });

    const config = { configurable: { thread_id: newKey() } };
    const agent = createCadAgent('gpt-5.6-luna');
    await agent.invoke({ messages: [new HumanMessage('a stand')] }, config);
    const result = await agent.invoke(
      new Command({ resume: { action: 'revise', chosenVariantId: 'B', comment: 'make walls 3mm' } }),
      config
    );

    const kinds = invokeMock.mock.calls.map((c) => kindOf(c[0]));
    expect(kinds.filter((k) => k === 'planner')).toHaveLength(1);
    const revisions = invokeMock.mock.calls.map((c) => c[0]).filter((m) => kindOf(m) === 'revision');
    expect(revisions).toHaveLength(1);
    const text = JSON.stringify(revisions[0]);
    expect(text).toContain('Revise this variant (B)');
    expect(text).toContain('B sheet marker'); // B's previous sheet
    expect(text).toContain('make walls 3mm');
    expect(imageOf(revisions[0])).toMatch(/^data:image\/png;base64,/);

    // The next gate offers only the revised B.
    expect(isInterrupted(result)).toBe(true);
    const payload = gatePayload(result);
    expect(payload.variants!.map((v) => v.id)).toEqual(['B']);
    expect(payload.variants![0].spec?.assemblyName).toBe('spec_b_rev');
    expect(payload.recommendedId).toBe('B');
  });
});

describe('H3: the Vercel budget starts before the planner and leaves room for the round', () => {
  function timedRouter(opts: { plannerMs: number; revisionMs?: number }) {
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner':
          vi.setSystemTime(Date.now() + opts.plannerMs);
          return plan(['A']);
        case 'variant': return boxSpec();
        case 'revision':
          vi.setSystemTime(Date.now() + (opts.revisionMs ?? 0));
          return boxSpec();
        case 'reviewer': return { matchesRequest: false, findings: [{ issue: 'flaw', severity: 'major' }] };
        default: return pass;
      }
    });
  }
  const run = async () =>
    createCadAgent('gpt-5.6-luna').invoke(
      { messages: [new HumanMessage('a 40mm box')] },
      { configurable: { thread_id: newKey() } }
    );
  const counts = () => invokeMock.mock.calls.map((c) => kindOf(c[0]));

  it('a slow planner eats the budget: no revision round is started', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    process.env.VERCEL = '1';
    process.env.CADAI_SPEC_REVIEW_BUDGET_MS = '150000'; // planner 80 s + 90 s default round = 170 s > 150 s
    timedRouter({ plannerMs: 80000 });
    const result = await run();
    expect(counts()).toEqual(['planner', 'variant', 'reviewer']);
    expect(gatePayload(result).variants![0].review?.validated).toBe(false);
  });

  it('the same planner time with a roomy budget does revise', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    process.env.VERCEL = '1';
    process.env.CADAI_SPEC_REVIEW_BUDGET_MS = '400000';
    process.env.CADAI_SPEC_REVIEW_RETRIES = '1';
    timedRouter({ plannerMs: 80000 });
    await run();
    expect(counts()).toEqual(['planner', 'variant', 'reviewer', 'revision', 'reviewer']);
  });

  it('a deadline that expires between rounds stops on the measured round time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    process.env.VERCEL = '1';
    // t=10s after the planner; each revision takes 120 s. Round 3 would start at
    // t=250 s: 250 + 90 s (default estimate) = 340 < 345 would wrongly allow it,
    // 250 + 120 s (measured) = 370 >= 345 stops it.
    process.env.CADAI_SPEC_REVIEW_BUDGET_MS = '345000';
    timedRouter({ plannerMs: 10000, revisionMs: 120000 });
    const result = await run();
    expect(counts()).toEqual([
      'planner', 'variant', 'reviewer', 'revision', 'reviewer', 'revision', 'reviewer',
    ]);
    expect(gatePayload(result).variants![0].review?.validated).toBe(false);
  });
});

describe('H4: the reviewer judges the latest human message', () => {
  it('turn 2 "make it 15 degrees" is what the reviewer is told, not turn 1', async () => {
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant': return boxSpec();
        default: return pass;
      }
    });
    await createCadAgent('gpt-5.6-luna').invoke(
      {
        messages: [
          new HumanMessage('a laptop stand with a 30 degree tilt'),
          new AIMessage('Here is the stand.'),
          new HumanMessage('make it 15 degrees'),
        ],
      },
      { configurable: { thread_id: newKey() } }
    );
    const reviewer = invokeMock.mock.calls.map((c) => c[0]).find((m) => kindOf(m) === 'reviewer')!;
    const text = (lastContent(reviewer) as Array<{ text?: string }>)[0].text!;
    expect(text).toContain('The user asked for:\n"make it 15 degrees"');
    expect(text).not.toContain('30 degree');
  });
});

describe('M1: a failed revision keeps the last good spec', () => {
  it('provider errors during revision -> previous spec and findings stay, labelled, not revisable', async () => {
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant': return boxSpec({ assemblyName: 'good_spec' });
        case 'revision': throw new Error('gateway 502');
        case 'reviewer': return { matchesRequest: false, findings: [{ issue: 'Wrong size', severity: 'major' }] };
        default: return pass;
      }
    });
    const config = { configurable: { thread_id: newKey() } };
    const agent = createCadAgent('gpt-5.6-luna');
    const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);
    const v = gatePayload(result).variants![0];
    expect(v.spec?.assemblyName).toBe('good_spec');
    expect(v.sheetSvg).toContain('<svg');
    expect(v.review?.note).toBe('revision failed; showing version 1');
    expect(v.review?.findings.map((f) => f.issue)).toEqual(['Wrong size']);
    expect(v.error).toBeUndefined();
    const state = (await agent.getState(config)).values;
    expect(state.specVariants[0].needsRevision).toBe(false);
  });
});

describe('M3: sheets are not kept in graph state', () => {
  it('the checkpointed state holds no SVG / base64 PNG, yet the gate payload carries the sheet', async () => {
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A', 'B']);
        case 'variant': return variantOf(messages) === 'A' ? boxSpec() : postSpec();
        default: return pass;
      }
    });
    const config = { configurable: { thread_id: newKey() } };
    const agent = createCadAgent('gpt-5.6-luna');
    const result = await agent.invoke({ messages: [new HumanMessage('a stand')] }, config);
    expect(gatePayload(result).variants!.every((v) => v.sheetSvg?.includes('<svg'))).toBe(true);
    const state = (await agent.getState(config)).values;
    const serialized = JSON.stringify(state.specVariants);
    expect(serialized).not.toContain('<svg');
    expect(serialized).not.toContain('base64');
    expect(state.specVariants[0].drawnVersion).toBe(1);
  });
});

describe('M5: placeholders are labelled for the reviewer sheet and the drafter', () => {
  const spec = (assumptions: Array<{ field: string; value: string; rationale: string }>) =>
    ({
      ...boxSpec({ assumptions }),
      components: [
        { name: 'box', description: 'a box', localExtents: [40, 40, 40], position: [0, 0, 0], shape: { kind: 'box' } },
        { name: 'ghost', description: 'no extents given', position: [0, 0, 0] },
      ],
    }) as never;

  it('sheet notes put placeholders first, then assumptions, at most 3 of 60 chars', () => {
    const a = (i: number) => ({ field: `field${i}`, value: 'x'.repeat(80), rationale: '' });
    const notes = sheetNotes(spec([a(1), a(2), a(3)]));
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/^ghost: not drawn/);
    expect(notes[1].startsWith('field1')).toBe(true);
    expect(notes.every((n) => n.length <= 60)).toBe(true);
  });

  it('the drafter is told which components are placeholders, not exact base shapes', async () => {
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant': return { ...boxSpec(), components: (spec([]) as { components: unknown[] }).components };
        case 'drafter': return draft;
        default: return pass;
      }
    });
    const config = { configurable: { thread_id: newKey() } };
    const agent = createCadAgent('gpt-5.6-luna');
    await agent.invoke({ messages: [new HumanMessage('a box')] }, config);
    await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    const drafterCall = invokeMock.mock.calls.map((c) => c[0]).find((m) => kindOf(m) === 'drafter')!;
    const text = (lastContent(drafterCall) as Array<{ text?: string }>)[0].text!;
    expect(text).toContain('Placeholders - build these from the skeleton, not from the starting script');
    expect(text).toMatch(/- ghost: not in the starting script/);
    expect(text).not.toContain('exact base shape');
  });
});

describe('M6: the no-spec drafter prompt keeps edges sharp', () => {
  it('says every edge stays sharp and never mentions corner-softening', async () => {
    invokeMock.mockImplementation(async (messages: unknown) => {
      const text = JSON.stringify(messages);
      if (text.includes('Write one complete OpenSCAD script')) return draft;
      if (kindOf(messages) === 'planner') return plan(['A']);
      throw new Error('no spec');
    });
    const config = { configurable: { thread_id: newKey() } };
    const agent = createCadAgent('gpt-5.6-luna');
    const result = await agent.invoke({ messages: [new HumanMessage('a box')] }, config);
    if (isInterrupted(result)) await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    const call = invokeMock.mock.calls.map((c) => JSON.stringify(c[0])).find((t) => t.includes('Write one complete OpenSCAD script'))!;
    expect(call).toContain('every edge stays sharp');
    expect(call).not.toMatch(/corner-softening/i);
  });
});

describe('M7: the review loop never trips the recursion limit', () => {
  it('8 review retries: the computed recursionLimit reaches the gate, the default limit of 25 does not', async () => {
    process.env.CADAI_SPEC_REVIEW_RETRIES = '8';
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant':
        case 'revision': return boxSpec();
        case 'reviewer': return { matchesRequest: false, findings: [{ issue: 'flaw', severity: 'major' }] };
        default: return pass;
      }
    });
    expect(graphRecursionLimit()).toBeGreaterThan(3 * (8 + 1) + 2);
    const result = await createCadAgent('gpt-5.6-luna').invoke(
      { messages: [new HumanMessage('a 40mm box')] },
      { configurable: { thread_id: newKey() }, recursionLimit: graphRecursionLimit() }
    );
    expect(isInterrupted(result)).toBe(true);
    expect(gatePayload(result).variants![0].review?.attempts).toBe(9);

    // The same run under LangGraph's default limit (25) is stopped.
    await expect(
      createCadAgent('gpt-5.6-luna').invoke(
        { messages: [new HumanMessage('a 40mm box')] },
        { configurable: { thread_id: newKey() } }
      )
    ).rejects.toThrow(/Recursion limit/);
  });
});

describe('loop-table rows', () => {
  it('illustrator failure -> labelled "sheet could not be drawn", no reviewer call, run continues to the gate', async () => {
    flags.drawFails = true;
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant': return boxSpec();
        default: return pass;
      }
    });
    const result = await createCadAgent('gpt-5.6-luna').invoke(
      { messages: [new HumanMessage('a 40mm box')] },
      { configurable: { thread_id: newKey() } }
    );
    expect(invokeMock.mock.calls.map((c) => kindOf(c[0]))).toEqual(['planner', 'variant']);
    const v = gatePayload(result).variants![0];
    expect(v.sheetSvg).toBeNull();
    expect(v.review).toMatchObject({ validated: false, note: 'sheet could not be drawn' });
  });

  it('matchesRequest:false with only minor findings -> not validated, no revision, findings kept', async () => {
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant': return boxSpec();
        case 'reviewer': return { matchesRequest: false, findings: [{ issue: 'Minor gap', severity: 'minor' }] };
        default: return pass;
      }
    });
    const result = await createCadAgent('gpt-5.6-luna').invoke(
      { messages: [new HumanMessage('a 40mm box')] },
      { configurable: { thread_id: newKey() } }
    );
    expect(invokeMock.mock.calls.map((c) => kindOf(c[0]))).toEqual(['planner', 'variant', 'reviewer']);
    const v = gatePayload(result).variants![0];
    // Not "validated" because the reviewer said it does not match; the minor finding is kept and shown.
    expect(v.review?.findings.map((f) => f.issue)).toEqual(['Minor gap']);
    expect(v.review?.validated).toBe(false);
  });
});

describe('L5/N4: approve fallback merges the brief once, names the variant it used, and sends that sheet', () => {
  it('chosen variant without a spec -> uses the already-merged spec, assumptions not duplicated, note names B, drafter gets B sheet', async () => {
    const reviewImages: Record<string, string> = {};
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner':
          return plan(['A', 'B'], 'A', { assumptions: [{ field: 'tolerance', value: '0.2', rationale: 'snug' }] });
        case 'variant':
          if (variantOf(messages) === 'A') throw new Error('gateway 502');
          return postSpec({ assemblyName: 'only_b' });
        case 'reviewer':
          reviewImages[variantOf(messages)] = imageOf(messages)!;
          return pass;
        case 'drafter': return draft;
        default: return pass;
      }
    });
    const notes: string[] = [];
    const config = {
      configurable: { thread_id: newKey() },
      writer: (ev: Record<string, unknown>) => {
        if (ev?.t === 'delta' && typeof ev.text === 'string') notes.push(ev.text);
      },
    } as unknown as Parameters<ReturnType<typeof createCadAgent>['invoke']>[1];
    const agent = createCadAgent('gpt-5.6-luna');
    await agent.invoke({ messages: [new HumanMessage('a stand')] }, config);
    await agent.invoke(new Command({ resume: { action: 'approve', chosenVariantId: 'A' } }), config);

    const drafterCall = invokeMock.mock.calls.map((c) => c[0]).find((m) => kindOf(m) === 'drafter')!;
    const text = JSON.stringify(drafterCall);
    expect(text).toContain('only_b');
    expect(text.match(/\\"field\\": \\"tolerance\\"/g)).toHaveLength(1);
    expect(notes.join('')).toContain('No variant spec to approve; using the spec of variant B');
    expect(reviewImages.B).toBeDefined();
    expect(imageOf(drafterCall)).toEqual(reviewImages.B);
  });
});


describe('H3 (rest): per-call timeouts keep a slow round inside the Vercel budget', () => {
  it('planner 40 s, variant 40 s, reviewer 30 s, revision 200 s: the revision is capped, not retried, and the gate arrives before 300 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    process.env.VERCEL = '1';
    process.env.CADAI_SPEC_REVIEW_BUDGET_MS = '240000';
    const timeouts: Array<number | undefined> = [];
    const tick = (ms: number) => vi.setSystemTime(Date.now() + ms);

    invokeMock.mockImplementation(async (messages: unknown, config?: { timeout?: number }) => {
      switch (kindOf(messages)) {
        case 'planner': tick(40000); return plan(['A']);
        case 'variant': tick(40000); return boxSpec({ assemblyName: 'good_spec' });
        case 'reviewer':
          tick(30000);
          return { matchesRequest: false, findings: [{ issue: 'flaw', severity: 'major' }] };
        case 'revision': {
          timeouts.push(config?.timeout);
          const need = 200000;
          // What a real model does: it is aborted when the call's timeout fires.
          if (config?.timeout !== undefined && config.timeout < need) {
            tick(config.timeout);
            throw new Error('aborted: timeout');
          }
          tick(need);
          return boxSpec();
        }
        default: return pass;
      }
    });

    const notes: string[] = [];
    const config = {
      configurable: { thread_id: newKey() },
      writer: (ev: Record<string, unknown>) => {
        if (ev?.t === 'delta' && typeof ev.text === 'string') notes.push(ev.text);
      },
    } as unknown as Parameters<ReturnType<typeof createCadAgent>['invoke']>[1];
    const result = await createCadAgent('gpt-5.6-luna').invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    expect(isInterrupted(result)).toBe(true);
    expect(Date.now()).toBeLessThan(300000);
    // t=110 s at the revision; 240 - 110 - 15 = 115 s. One attempt only: no time for another.
    expect(timeouts).toEqual([115000]);
    const v = gatePayload(result).variants![0];
    expect(v.spec?.assemblyName).toBe('good_spec');
    expect(v.review?.note).toBe('revision failed; showing version 1');
    expect(notes.join('')).toContain('revision failed (time budget); keeping version 1.');
  });

  it('off Vercel no timeout is added to any call', async () => {
    const seen: Array<number | undefined> = [];
    invokeMock.mockImplementation(async (messages: unknown, config?: { timeout?: number }) => {
      seen.push(config?.timeout);
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant': return boxSpec();
        case 'drafter': return draft;
        default: return pass;
      }
    });
    await createCadAgent('gpt-5.6-luna').invoke(
      { messages: [new HumanMessage('a 40mm box')] },
      { configurable: { thread_id: newKey() } }
    );
    expect(seen.every((t) => t === undefined)).toBe(true);
  });
});

describe('N1: the retry decision uses the round that just finished, reviewer included', () => {
  it('planner 5 s, variant 10 s, revisions 130 s, 240 s budget: no second revision round', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    process.env.VERCEL = '1';
    process.env.CADAI_SPEC_REVIEW_BUDGET_MS = '240000';
    const tick = (ms: number) => vi.setSystemTime(Date.now() + ms);
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': tick(5000); return plan(['A']);
        case 'variant': tick(10000); return boxSpec();
        case 'revision': tick(130000); return boxSpec();
        case 'reviewer': return { matchesRequest: false, findings: [{ issue: 'flaw', severity: 'major' }] };
        default: return pass;
      }
    });
    const result = await createCadAgent('gpt-5.6-luna').invoke(
      { messages: [new HumanMessage('a 40mm box')] },
      { configurable: { thread_id: newKey() } }
    );
    // Reviewer 2 runs at t=145 s: 145 + 130 (fresh) >= 240, so it stops. With the
    // stale 90 s default it would have started a second 130 s round (gate at 275 s).
    expect(invokeMock.mock.calls.map((c) => kindOf(c[0]))).toEqual([
      'planner', 'variant', 'reviewer', 'revision', 'reviewer',
    ]);
    expect(Date.now()).toBeLessThan(240000);
    expect(gatePayload(result).variants![0].review?.validated).toBe(false);
  });
});

describe('M4 (rest): errors on the last accepted attempt are labelled, never dropped', () => {
  it('a part always placed below z = 0 reaches the gate with a major finding, even for a single validated variant and a "40mm" prompt', async () => {
    process.env.CADAI_SPEC_REVIEW_RETRIES = '0';
    const underground = boxSpec({
      components: [
        { name: 'block', description: 'a block', localExtents: [40, 40, 40], position: [0, 0, -5], shape: { kind: 'box' } },
      ],
    });
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant': return underground;
        default: return pass;
      }
    });
    const result = await createCadAgent('gpt-5.6-luna').invoke(
      { messages: [new HumanMessage('a 40mm box')] },
      { configurable: { thread_id: newKey() } }
    );
    expect(invokeMock.mock.calls.filter((c) => kindOf(c[0]) === 'variant')).toHaveLength(3); // all attempts used
    expect(isInterrupted(result)).toBe(true); // the gate was forced
    const review = gatePayload(result).variants![0].review!;
    expect(review.validated).toBe(false);
    expect(review.findings.some((f) => f.severity === 'major' && f.issue.includes("'block' sits 5 mm below the ground plane"))).toBe(true);
  });

  it('a non-vision model (no reviewer) still forces the gate and shows the errors', async () => {
    const underground = boxSpec({
      components: [
        { name: 'block', description: 'a block', localExtents: [40, 40, 40], position: [0, 0, -5], shape: { kind: 'box' } },
      ],
    });
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant': return underground;
        default: return pass;
      }
    });
    const result = await createCadAgent('deepseek-v4-flash').invoke(
      { messages: [new HumanMessage('a 40mm box')] },
      { configurable: { thread_id: newKey() } }
    );
    expect(isInterrupted(result)).toBe(true);
    expect(gatePayload(result).variants![0].review?.findings.map((f) => f.issue).join(' ')).toContain('below the ground plane');
  });
});

describe('N3: a failed gate revise keeps the earlier review and says so', () => {
  it('B validated with a minor note, revise fails -> same findings at the next gate, labelled, transcript says keeping version 1', async () => {
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A', 'B'], 'A');
        case 'variant': return variantOf(messages) === 'A' ? boxSpec() : postSpec();
        case 'reviewer':
          return variantOf(messages) === 'B'
            ? { matchesRequest: true, findings: [{ issue: 'B-minor-note', severity: 'minor' }] }
            : pass;
        case 'revision': throw new Error('gateway 502');
        default: return pass;
      }
    });
    const notes: string[] = [];
    const config = {
      configurable: { thread_id: newKey() },
      writer: (ev: Record<string, unknown>) => {
        if (ev?.t === 'delta' && typeof ev.text === 'string') notes.push(ev.text);
      },
    } as unknown as Parameters<ReturnType<typeof createCadAgent>['invoke']>[1];
    const agent = createCadAgent('gpt-5.6-luna');
    await agent.invoke({ messages: [new HumanMessage('a stand')] }, config);
    const result = await agent.invoke(
      new Command({ resume: { action: 'revise', chosenVariantId: 'B', comment: 'taller' } }),
      config
    );
    const b = gatePayload(result).variants!.find((v) => v.id === 'B')!;
    expect(b.review?.findings.map((f) => f.issue)).toEqual(['B-minor-note']);
    expect(b.review?.validated).toBe(true);
    expect(b.review?.note).toBe('revision failed; showing version 1');
    expect(notes.join('')).toContain('revision failed (provider error); keeping version 1.');
    expect(notes.join('')).not.toContain('No valid spec after 3 attempts');
  });
});

describe('N2: builtin component names are renamed, so the sheet never says a drawn part is missing', () => {
  it('Hull + Mast: normalised to hull_part / mast and neither is "not drawn"', async () => {
    const { normalizeSpec } = await import('./spec-normalize');
    const { AssemblySpecSchema } = await import('./assembly-spec');
    const spec = normalizeSpec(
      AssemblySpecSchema.parse(
        boxSpec({
          components: [
            { name: 'Hull', description: 'h', localExtents: [40, 20, 10], position: [0, 0, 0], shape: { kind: 'box' } },
            { name: 'Mast', description: 'm', localExtents: [5, 5, 30], position: [10, 5, 10], shape: { kind: 'box' } },
          ],
        })
      )
    );
    expect(spec.components?.map((c) => c.name)).toEqual(['hull_part', 'mast']);
    expect(sheetNotes(spec).join(' ')).not.toContain('not drawn');
  });
});

describe('nits', () => {
  it('scratch mode: the placeholder text does not mention a starting script', async () => {
    process.env.CADAI_DRAFTER_START = 'scratch';
    invokeMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner': return plan(['A']);
        case 'variant':
          return boxSpec({
            components: [
              { name: 'box', description: 'a box', localExtents: [40, 40, 40], position: [0, 0, 0], shape: { kind: 'box' } },
              { name: 'ghost', description: 'no extents', position: [0, 0, 0] },
            ],
          });
        case 'drafter': return draft;
        default: return pass;
      }
    });
    const config = { configurable: { thread_id: newKey() } };
    const agent = createCadAgent('gpt-5.6-luna');
    await agent.invoke({ messages: [new HumanMessage('a box')] }, config);
    await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    const drafterCall = invokeMock.mock.calls.map((c) => c[0]).find((m) => kindOf(m) === 'drafter')!;
    const text = (lastContent(drafterCall) as Array<{ text?: string }>)[0].text!;
    expect(text).toContain('Placeholders');
    expect(text).toContain('- ghost: missing localExtents');
    expect(text).not.toMatch(/starting script/i);
  });

  it('singular status line for one variant; the no-spec sentence has its verb', async () => {
    process.env.CADAI_MAX_VARIANTS = '1';
    const deltas: string[] = [];
    invokeMock.mockImplementation(async (messages: unknown) => {
      const text = JSON.stringify(messages);
      if (text.includes('Write one complete OpenSCAD script')) {
        expect(text).toContain('and apply the stress-point mitigations the part needs');
        return draft;
      }
      if (kindOf(messages) === 'planner') return plan(['A']);
      throw new Error('no spec');
    });
    const config = {
      configurable: { thread_id: newKey() },
      writer: (ev: Record<string, unknown>) => {
        if (ev?.t === 'delta' && typeof ev.text === 'string') deltas.push(ev.text);
      },
    } as unknown as Parameters<ReturnType<typeof createCadAgent>['invoke']>[1];
    const agent = createCadAgent('gpt-5.6-luna');
    const result = await agent.invoke({ messages: [new HumanMessage('a box')] }, config);
    if (isInterrupted(result)) await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    expect(deltas.join('')).toContain('Planning up to 1 variant...');
    expect(deltas.join('')).not.toContain('1 variants');
  });
});
