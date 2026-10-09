import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { isInterrupted, INTERRUPT } from '@langchain/langgraph';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import type { GatePayload } from '@/types';
import { skeletonSignature } from './spec-variants';
import { REVISION_TEMPERATURE } from './graph';

/** Records the temperature of the model instance each call was made on. */
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
  const k = runCheckpointKey(`revision-${Date.now()}`, `run-${counter++}`);
  keys.push(k);
  return k;
};
afterAll(async () => {
  for (const k of keys) await getCheckpointer().deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
});

const box = (side: number, extra: Record<string, unknown> = {}) => ({
  sheet: '## Plate\nA box',
  assemblyName: 'box_spec',
  boundingBox: { width: side, length: side, height: side },
  components: [
    { name: 'box', description: 'a box', localExtents: [side, side, side], position: [0, 0, 0], shape: { kind: 'box' } },
  ],
  assumptions: [],
  openQuestions: [],
  ...extra,
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
  variants: [{ id: 'A', name: 'VarA', idea: 'Literal slotted stand' }], recommendedId: 'A',
};
const MAJOR = 'the stand has no retaining lip, so the phone can slide off';
const majorReview = { matchesRequest: false, findings: [{ issue: MAJOR, severity: 'major' }, { issue: 'plate looks thin', severity: 'minor' }] };
const pass = { matchesRequest: true, findings: [] };

function gate(result: unknown) {
  return (result as Record<string | symbol, Array<{ value: Extract<GatePayload, { kind: 'spec' }> }>>)[INTERRUPT][0].value;
}

beforeEach(() => {
  callMock.mockReset();
  process.env.CADAI_SPEC_SHEETS = 'on';
  process.env.CADAI_MAX_VARIANTS = '1';
  process.env.CADAI_SPEC_REVIEW_RETRIES = '1';
  delete process.env.VERCEL;
});

/** Runs a single-variant request whose first review is a major finding; `revisions` supplies each revision attempt's reply. */
async function run(revisions: Array<ReturnType<typeof box>>, secondReview = pass) {
  let rev = 0;
  let reviews = 0;
  callMock.mockImplementation(async (messages: unknown) => {
    switch (kindOf(messages)) {
      case 'planner': return plan;
      case 'variant': return box(40);
      case 'revision': return revisions[Math.min(rev++, revisions.length - 1)];
      case 'reviewer': return reviews++ === 0 ? majorReview : secondReview;
      case 'drafter': return { content: '```openscad\ncube(40);\n```', tool_calls: [] };
      default: return pass;
    }
  });
  const result = await createCadAgent('gpt-6-sol').invoke(
    { messages: [new HumanMessage('a 40mm phone stand')] },
    { configurable: { thread_id: newKey() } }
  );
  const calls = callMock.mock.calls.map((c) => ({ messages: c[0], temperature: c[2] as number | undefined, model: c[3] as string | undefined, kind: kindOf(c[0]) }));
  return { result, calls };
}

describe('skeletonSignature', () => {
  const spec = (over: Record<string, unknown> = {}) => box(40, over) as never;

  it('ignores sub-tolerance noise, guides, sheet text and assumptions', () => {
    const a = skeletonSignature(spec());
    const noisy = {
      ...box(40),
      sheet: 'reworded sheet',
      assumptions: [{ field: 'x', value: 'y', rationale: 'z' }],
      guides: [{ kind: 'line', label: 'tilt', points: [[0, 0, 0], [1, 1, 1]] }],
      components: [
        { name: 'box', description: 'rephrased', localExtents: [40.1, 39.9, 40.2], position: [0.1, 0, -0.1], rotation: [0.2, 0, 0], shape: { kind: 'box' } },
      ],
    };
    expect(skeletonSignature(noisy as never)).toBe(a);
  });

  it('catches an added component, a moved part, a changed shape kind and a new rotation', () => {
    const a = skeletonSignature(spec());
    const added = { ...box(40), components: [...box(40).components, { name: 'lip', description: 'lip', localExtents: [40, 3, 6], position: [0, 37, 0], shape: { kind: 'box' } }] };
    expect(skeletonSignature(added as never)).not.toBe(a);
    const moved = { ...box(40), components: [{ ...box(40).components[0], position: [2, 0, 0] }] };
    expect(skeletonSignature(moved as never)).not.toBe(a);
    const reshaped = { ...box(40), components: [{ ...box(40).components[0], shape: { kind: 'cylinder', axis: 'z' } }] };
    expect(skeletonSignature(reshaped as never)).not.toBe(a);
    const rotated = { ...box(40), components: [{ ...box(40).components[0], rotation: [0, 15, 0] }] };
    expect(skeletonSignature(rotated as never)).not.toBe(a);
  });
});

describe('revision prompt: findings first', () => {
  it('opens with REQUIRED CHANGES (majors, then minors) and the override rule; the previous skeleton comes after', async () => {
    const { calls } = await run([box(46)]);
    const rev = calls.find((c) => c.kind === 'revision')!;
    const content = (rev.messages as BaseMessage[]).at(-1)!.content as Array<{ type: string; text?: string }>;
    const text = content[0].text!;
    expect(text.startsWith('REQUIRED CHANGES:')).toBe(true);
    expect(text.indexOf(`[MAJOR] ${MAJOR}`)).toBeLessThan(text.indexOf('[MINOR] plate looks thin'));
    expect(text).toContain('Each major finding must be resolved by a concrete geometric change');
    expect(text).toContain('major findings OUTRANK "variant A follows the request literally" and the SCOPE rule');
    expect(text).toContain('a lip so the held object cannot slide off');
    expect(text).toContain('record each addition in assumptions[]');
    expect(text).toContain('## Changes in this revision');
    expect(text.indexOf('Previous version (to be changed) - skeleton')).toBeGreaterThan(text.indexOf('REQUIRED CHANGES'));
    expect(text.indexOf('Previous version (to be changed) - skeleton')).toBeGreaterThan(text.indexOf(`[MAJOR] ${MAJOR}`));
    expect(content.some((p) => p.type === 'image_url')).toBe(true); // the previous sheet image stays
  });
});

describe('revision change check', () => {
  it('an unchanged revision is retried with "did not change the geometry"; a changed one is accepted', async () => {
    const { calls, result } = await run([box(40), box(46)]);
    const revisions = calls.filter((c) => c.kind === 'revision');
    expect(revisions).toHaveLength(2);
    const retryText = JSON.stringify(revisions[1].messages);
    expect(retryText).toContain(`Your revision did not change the geometry. You must change it to resolve: ${MAJOR}`);
    // The second attempt was accepted: reviewed again, then drafted.
    expect(calls.map((c) => c.kind)).toEqual(['planner', 'variant', 'reviewer', 'revision', 'revision', 'reviewer', 'drafter']);
    expect(result).toBeDefined();
  });

  it('every attempt unchanged: keeps the last, stops revising, and reaches the gate labelled with its findings', async () => {
    const { calls, result } = await run([box(40)]);
    expect(calls.filter((c) => c.kind === 'revision')).toHaveLength(3);
    expect(calls.filter((c) => c.kind === 'reviewer')).toHaveLength(1); // not reviewed again, not looped
    expect(isInterrupted(result)).toBe(true);
    const v = gate(result).variants![0];
    expect(v.review?.note).toBe('revision made no geometric change');
    expect(v.review?.validated).toBe(false);
    expect(v.review?.findings.map((f) => f.issue)).toEqual([MAJOR, 'plate looks thin']);
    expect(v.spec).not.toBeNull();
  });
});

describe('revision temperature', () => {
  it('revision calls run on the 0.6 model; planner, fresh specs and the reviewer keep 0.2', async () => {
    expect(REVISION_TEMPERATURE).toBe(0.6);
    const { calls } = await run([box(46)]);
    for (const c of calls) {
      if (c.kind === 'revision') expect(c.temperature).toBe(0.6);
      else expect(c.temperature).toBe(0.2);
    }
    expect(calls.some((c) => c.kind === 'revision')).toBe(true);
    expect(calls.some((c) => c.kind === 'planner' && c.temperature === 0.2)).toBe(true);
    expect(calls.some((c) => c.kind === 'variant' && c.temperature === 0.2)).toBe(true);
  });
});

describe('pinned sheet reviewer', () => {
  it('CADAI_REVIEWER_MODEL routes only the reviewer to that model; unset, the run model reviews', async () => {
    process.env.CADAI_REVIEWER_MODEL = 'gpt-5.6-luna';
    try {
      const { calls } = await run([box(46)]);
      const reviewers = calls.filter((c) => c.kind === 'reviewer');
      expect(reviewers.length).toBeGreaterThan(0);
      expect(reviewers.every((c) => c.model === 'gpt-5.6-luna')).toBe(true);
      expect(calls.filter((c) => c.kind !== 'reviewer').every((c) => c.model === 'gpt-6-sol')).toBe(true);
    } finally {
      delete process.env.CADAI_REVIEWER_MODEL;
    }
    callMock.mockReset();
    const { calls } = await run([box(46)]);
    expect(calls.every((c) => c.model === 'gpt-6-sol')).toBe(true);
  });
});
