import { describe, it, expect } from 'vitest';
import type { DesignerFacts } from '../../../src/lib/agent/designer/types';
import type { EvalPrompt, FeatureProbe, FollowUp, RunRecord, StepRecord } from '../types';
import { earlierKept, earlierKeptDetail, fidelityMetrics, locality, probeLanded } from './fidelity';

const facts = (over: Partial<DesignerFacts> = {}): DesignerFacts => ({
  ok: true,
  parts: [{ label: 'base', size: [100, 60, 40], valid: true }],
  interferences: [],
  disconnected: [],
  dimensions: [
    { name: 'box_width', value: 100 },
    { name: 'box_depth', value: 60 },
    { name: 'box_height', value: 40 },
    { name: 'wall', value: 3 },
  ],
  span: [100, 60, 40],
  ...over,
});
const none = { before: '', after: '' };

describe('probeLanded', () => {
  it('newPart: a matching label appears', () => {
    const p: FeatureProbe = { kind: 'newPart', label: 'handle|grip' };
    const after = facts({ parts: [...facts().parts, { label: 'Handle_1', size: [10, 10, 10], valid: true }] });
    expect(probeLanded(p, facts(), after, none)).toBe(true);
    expect(probeLanded(p, facts(), facts(), none)).toBe(false);
    // already present before: not a new landing
    expect(probeLanded(p, after, after, none)).toBe(false);
  });

  it('partCountUp: counts parts, honours min', () => {
    const more = facts({ parts: [...facts().parts, { label: 'a', size: [1, 1, 1], valid: true }, { label: 'b', size: [1, 1, 1], valid: true }] });
    expect(probeLanded({ kind: 'partCountUp' }, facts(), more, none)).toBe(true);
    expect(probeLanded({ kind: 'partCountUp', min: 2 }, facts(), more, none)).toBe(true);
    expect(probeLanded({ kind: 'partCountUp', min: 3 }, facts(), more, none)).toBe(false);
    expect(probeLanded({ kind: 'partCountUp' }, facts(), facts(), none)).toBe(false);
  });

  it('dimensionChange: by deltaMm within tolerance, by ratio, signed', () => {
    const taller = facts({ dimensions: facts().dimensions.map((d) => (d.name === 'box_height' ? { ...d, value: 60.5 } : d)) });
    expect(probeLanded({ kind: 'dimensionChange', dimension: 'height', deltaMm: 20 }, facts(), taller, none)).toBe(true);
    expect(probeLanded({ kind: 'dimensionChange', dimension: 'height', deltaMm: 20, tolerance: 0.1 }, facts(), taller, none)).toBe(false);
    expect(probeLanded({ kind: 'dimensionChange', dimension: 'height', deltaMm: -20 }, facts(), taller, none)).toBe(false);
    expect(probeLanded({ kind: 'dimensionChange', dimension: 'width', deltaMm: 20 }, facts(), taller, none)).toBe(false);
    const wider = facts({ dimensions: facts().dimensions.map((d) => (d.name === 'box_width' ? { ...d, value: 130 } : d)) });
    expect(probeLanded({ kind: 'dimensionChange', dimension: 'width', ratio: 1.3 }, facts(), wider, none)).toBe(true);
    expect(probeLanded({ kind: 'dimensionChange', dimension: 'width', ratio: 1.5 }, facts(), wider, none)).toBe(false);
    // no target: any change
    expect(probeLanded({ kind: 'dimensionChange', dimension: 'width' }, facts(), wider, none)).toBe(true);
    expect(probeLanded({ kind: 'dimensionChange', dimension: 'width' }, facts(), facts(), none)).toBe(false);
  });

  it('spanChange: assembly span on an axis', () => {
    const tall = facts({ span: [100, 60, 60] });
    expect(probeLanded({ kind: 'spanChange', axis: 'z', deltaMm: 20 }, facts(), tall, none)).toBe(true);
    expect(probeLanded({ kind: 'spanChange', axis: 'x', deltaMm: 20 }, facts(), tall, none)).toBe(false);
    expect(probeLanded({ kind: 'spanChange', axis: 'z', ratio: 1.5 }, facts(), tall, none)).toBe(true);
    expect(probeLanded({ kind: 'spanChange', deltaMm: 20 }, facts(), tall, none)).toBe(false); // no axis
    expect(probeLanded({ kind: 'spanChange', axis: 'z', deltaMm: 20 }, facts(), { ...facts(), span: undefined }, none)).toBe(false);
  });

  it('moves: a new pose parameter appears', () => {
    const hinge = { before: 'w = 10', after: 'w = 10\nlid_deg = 0  # [0:5:110]' };
    expect(probeLanded({ kind: 'moves' }, facts(), facts(), hinge)).toBe(true);
    expect(probeLanded({ kind: 'moves' }, facts(), facts(), { before: hinge.after, after: hinge.after })).toBe(false);
    expect(probeLanded({ kind: 'moves' }, facts(), facts(), none)).toBe(false);
    const drawer = { before: hinge.after, after: `${hinge.after}\ndrawer_travel = 0  # [0:1:40]` };
    expect(probeLanded({ kind: 'moves' }, facts(), facts(), drawer)).toBe(true);
  });

  it("reviewer: defers to the reviewer, even with unusable facts", () => {
    expect(probeLanded({ kind: 'reviewer', question: 'is the front recessed?' }, facts(), facts(), none)).toBe('reviewer');
    expect(probeLanded({ kind: 'reviewer' }, null, null, none)).toBe('reviewer');
  });

  it('a failed or missing after build never lands', () => {
    expect(probeLanded({ kind: 'partCountUp' }, facts(), null, none)).toBe(false);
    expect(probeLanded({ kind: 'partCountUp' }, facts(), facts({ ok: false }), none)).toBe(false);
    expect(probeLanded({ kind: 'partCountUp' }, null, facts(), none)).toBe(false);
  });
});

const step = (n: number, f: DesignerFacts | null, script = '', extra: Partial<StepRecord> = {}): StepRecord => ({
  step: n, text: `t${n}`, script, facts: f, costUsd: 0.1, wallMs: 1000, turns: 3, reviewerFlags: [], ...extra,
});
const withDim = (name: string, value: number, base = facts()) =>
  facts({ ...base, dimensions: base.dimensions.map((d) => (d.name === name ? { ...d, value } : d)) });
const part = (label: string) => ({ label, size: [5, 5, 5] as [number, number, number], valid: true });

const followUps: FollowUp[] = [
  { text: 'add a handle', kind: 'part', probe: { kind: 'newPart', label: 'handle' } },
  { text: 'make it 20 mm taller', kind: 'global', probe: { kind: 'dimensionChange', dimension: 'height', deltaMm: 20 } },
  { text: 'add a hinged lid', kind: 'mechanism', probe: { kind: 'moves' } },
];

describe('earlierKept', () => {
  const s0 = step(0, facts(), 'a = 1');
  const s1 = step(1, facts({ parts: [...facts().parts, part('handle')] }), 'a = 1');
  const s2 = step(2, withDim('box_height', 60, s1.facts!), 'a = 1');

  it('null with fewer than two follow-ups or when final facts are unusable', () => {
    expect(earlierKept([s0, s1], followUps)).toBeNull();
    expect(earlierKept([s0, s1, step(2, null)], followUps)).toBeNull();
  });

  it('counts earlier probes that still hold at the final step', () => {
    const s3 = step(3, facts({ ...s2.facts!, parts: [...s2.facts!.parts, part('lid')] }), 'a = 1\nlid_deg = 0');
    expect(earlierKept([s0, s1, s2, s3], followUps)).toBe(1);
    expect(earlierKeptDetail([s0, s1, s2, s3], followUps)).toEqual({ kept: 2, total: 2, lost: [] });
  });

  it('a feature counts as lost when its part is gone from the final step', () => {
    const s3 = step(3, withDim('box_height', 60), 'lid_deg = 0'); // handle part dropped
    const d = earlierKeptDetail([s0, s1, s2, s3], followUps)!;
    expect(d.lost).toEqual(['add a handle']);
    expect(earlierKept([s0, s1, s2, s3], followUps)).toBe(0.5);
  });

  it('a later edit that moves the same dimension further does not count as a loss', () => {
    const s3 = step(3, withDim('box_height', 75, s2.facts!), '');
    expect(earlierKeptDetail([s0, s1, s2, s3], followUps)!.lost).toEqual([]);
    // but undoing it does
    const undone = step(3, withDim('box_height', 40, s2.facts!), '');
    expect(earlierKeptDetail([s0, s1, s2, undone], followUps)!.lost).toEqual(['make it 20 mm taller']);
  });

  it('skips reviewer probes', () => {
    const fus: FollowUp[] = [
      { text: 'recess the label', kind: 'cut', probe: { kind: 'reviewer', question: 'q' } },
      followUps[0],
      followUps[1],
    ];
    expect(earlierKeptDetail([s0, s1, s2, step(3, s2.facts)], fus)).toEqual({ kept: 1, total: 1, lost: [] });
  });
});

describe('locality', () => {
  const fu: FollowUp = followUps[1];

  it('is the share of unmentioned dimensions left unchanged', () => {
    expect(locality(facts(), withDim('box_height', 60), fu)).toBe(1);
    const sideEffect = facts({ dimensions: facts().dimensions.map((d) => (d.name === 'box_height' ? { ...d, value: 60 } : d.name === 'wall' ? { ...d, value: 5 } : d)) });
    // untouched: width, depth, wall; wall changed -> 2/3
    expect(locality(facts(), sideEffect, fu)).toBeCloseTo(2 / 3);
  });

  it('treats a dimension that disappeared as changed', () => {
    const dropped = facts({ dimensions: facts().dimensions.filter((d) => d.name !== 'wall') });
    expect(locality(facts(), dropped, fu)).toBeCloseTo(2 / 3);
  });

  it('does not count a mentioned dimension (name, synonym, or probe target)', () => {
    const moved = facts({ dimensions: facts().dimensions.map((d) => (d.name === 'box_width' ? { ...d, value: 130 } : d)) });
    const wider: FollowUp = { text: 'make it 30% wider', kind: 'global', probe: { kind: 'dimensionChange', dimension: 'width', ratio: 1.3 } };
    expect(locality(facts(), moved, wider)).toBe(1);
    const thinner: FollowUp = { text: 'thinner walls', kind: 'global', probe: { kind: 'dimensionChange', dimension: 'wall', ratio: 0.7 } };
    expect(locality(facts(), withDim('wall', 2), thinner)).toBe(1);
  });

  it('is null when nothing is left to compare or facts are unusable', () => {
    expect(locality(null, facts(), fu)).toBeNull();
    expect(locality(facts(), facts({ ok: false }), fu)).toBeNull();
    expect(locality(facts({ dimensions: [] }), facts(), fu)).toBeNull();
  });
});

describe('fidelityMetrics', () => {
  const prompt: EvalPrompt = { id: 'p', set: 'iterative', request: 'box', followUps };
  const mk = (steps: StepRecord[]): RunRecord => ({ tag: 't', arm: 'reviewer', promptId: 'p', set: 'iterative', sample: 0, model: 'm', startedAt: '', steps });
  const s0 = step(0, facts(), 'a = 1');
  const s1 = step(1, facts({ parts: [...facts().parts, part('handle')] }), 'a = 1');
  const s2 = step(2, withDim('box_height', 60, s1.facts!), 'a = 1');
  const s3 = step(3, facts({ ...s2.facts!, parts: [...s2.facts!.parts, part('lid')] }), 'a = 1\nlid_deg = 0');

  it('all follow-ups land and are kept', () => {
    const m = fidelityMetrics(mk([s0, s1, s2, s3]), prompt);
    expect(m.featureLanded).toBe(1);
    expect(m.earlierKept).toBe(1);
    expect(m.locality).toBe(1);
  });

  it('a follow-up that did not land, and a lost earlier feature, are counted', () => {
    const noHandle = step(1, facts(), 'a = 1');
    const t2 = step(2, withDim('box_height', 60), 'a = 1');
    const t3 = step(3, facts({ ...t2.facts!, parts: [...t2.facts!.parts, part('lid')] }), 'a = 1\nlid_deg = 0');
    const m = fidelityMetrics(mk([s0, noHandle, t2, t3]), prompt);
    expect(m.featureLanded).toBeCloseTo(2 / 3);
    expect(m.earlierKept).toBe(0.5); // handle never landed so it is not there; height kept
  });

  it('steps the run never reached and failed steps count as not landed', () => {
    expect(fidelityMetrics(mk([s0, s1]), prompt).featureLanded).toBeCloseTo(1 / 3);
    expect(fidelityMetrics(mk([s0, { ...s1, failed: true }]), prompt).featureLanded).toBe(0);
  });

  it('reviewer probes are left out of the denominator', () => {
    const p: EvalPrompt = { ...prompt, followUps: [followUps[0], { text: 'q', kind: 'cut', probe: { kind: 'reviewer' } }] };
    expect(fidelityMetrics(mk([s0, s1, step(2, s1.facts)]), p).featureLanded).toBe(1);
    const only: EvalPrompt = { ...prompt, followUps: [{ text: 'q', kind: 'cut', probe: { kind: 'reviewer' } }] };
    expect(fidelityMetrics(mk([s0, step(1, s0.facts)]), only).featureLanded).toBeNull();
  });

  it('is all null for a prompt without follow-ups', () => {
    expect(fidelityMetrics(mk([s0]), { id: 'p', set: 'open', request: 'x' })).toEqual({ featureLanded: null, earlierKept: null, locality: null });
  });
});
