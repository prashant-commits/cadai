import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { BrepResult } from '../../src/lib/engine/brep-runner';
import type { DesignerResult, RunDesignerFn } from '../../src/lib/agent/designer/types';
import type { EvalPrompt, RunRecord } from './types';
import { Budget, executeRun, loadSet, parseArgs, defaultOptions, type RunnerOptions } from './runner';

vi.mock('@langchain/anthropic', () => {
  class FakeChatModel {
    invoke = () => Promise.resolve({});
    async *stream() { yield {}; }
    withStructuredOutput() { return this; }
    withConfig() { return this; }
    bindTools() { return this; }
  }
  return { ChatAnthropic: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

const TMP_ROOT = path.join(process.cwd(), '.cadai', 'tasks', 'tmp');
let outDir = '';

const stlAscii = 'solid model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid model';
const brepOk: BrepResult = {
  ok: true,
  parts: [{ label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
  solids: 1,
  stl: Buffer.from(stlAscii).toString('base64'),
  step: Buffer.from('STEP-DATA').toString('base64'),
  ms: 5,
  disconnected: [],
  interferences: [],
};

const result = (n: number, over: Partial<DesignerResult> = {}): DesignerResult => ({
  script: `base = Box(10, 10, 10)\n_cadai_parts = [base]  # v${n}`,
  facts: { ok: true, parts: [{ label: 'base', size: [10, 10, 10], valid: true }], interferences: [], disconnected: [], dimensions: [{ name: 'size', value: 10 }], span: [10, 10, 10] },
  summary: `done ${n}`,
  reviewerFlags: [{ severity: 'minor', issue: 'tidy', whyItMatters: 'x', round: 1, final: true }],
  turns: 2,
  costUsd: 0.1,
  ...over,
});

const prompts: EvalPrompt[] = [
  {
    id: 'box',
    set: 'iterative',
    request: 'a box with a lid',
    followUps: [
      { text: 'add a cable hole at the back', kind: 'cut', probe: { kind: 'reviewer' } },
      { text: 'make it 20 mm taller', kind: 'global', probe: { kind: 'spanChange', axis: 'z', deltaMm: 20 } },
    ],
  },
  { id: 'cube', set: 'open', request: 'a cube' },
];

const opts = (over: Partial<RunnerOptions> = {}): RunnerOptions => ({
  ...defaultOptions(), tag: 't', model: 'gpt-6-sol', concurrency: 1, outDir, ...over,
});

const readRecord = (arm: string, id: string, n = 0) =>
  JSON.parse(fs.readFileSync(path.join(outDir, 't', arm, `${id}-s${n}.json`), 'utf8')) as RunRecord;

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  outDir = fs.mkdtempSync(path.join(TMP_ROOT, 'runner-'));
  process.env.CADAI_PIPELINE = 'designer';
  delete process.env.CADAI_REVIEWER;
});
afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
  delete process.env.CADAI_PIPELINE;
});

describe('runner flags and sets', () => {
  it('parses flags with the documented defaults', () => {
    const a = parseArgs(['--set', 'open']);
    expect(a).toMatchObject({ set: 'open', arms: ['designer', 'reviewer'], samples: 1, concurrency: 5, maxUsd: 25, only: [], resume: false });
    const b = parseArgs(['--set', 'x.json', '--arms', 'reviewer', '--samples', '2', '--concurrency', '3', '--tag', 'm1', '--max-usd', '4.5', '--only', 'a,b', '--resume']);
    expect(b).toMatchObject({ arms: ['reviewer'], samples: 2, concurrency: 3, tag: 'm1', maxUsd: 4.5, only: ['a', 'b'], resume: true });
    expect(() => parseArgs([])).toThrow(/--set/);
    expect(() => parseArgs(['--set', 'x', '--arms', 'bogus'])).toThrow(/--arms/);
    expect(() => parseArgs(['--set', 'x', '--tag', '../up'])).toThrow(/--tag/);
  });

  it('loads a set from a path as an array or a { prompts } object', () => {
    const f = path.join(outDir, 's.json');
    fs.writeFileSync(f, JSON.stringify(prompts));
    expect(loadSet(f).map((p) => p.id)).toEqual(['box', 'cube']);
    fs.writeFileSync(f, JSON.stringify({ prompts }));
    expect(loadSet(f)).toHaveLength(2);
    expect(() => loadSet('no-such-set')).toThrow(/not found/);
  });
});

describe('executeRun', () => {
  it('sends follow-ups on the same thread as edits of the accepted script, and records every step', async () => {
    let n = 0;
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async () => result(++n));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const summary = await executeRun([prompts[0]], opts({ arms: ['reviewer'] }), { runDesigner, runBrep });

    expect(summary.records).toHaveLength(1);
    expect(runDesigner).toHaveBeenCalledTimes(3);
    const [first, second, third] = runDesigner.mock.calls.map((c) => c[0]);
    expect(first.priorScript).toBeUndefined();
    expect(second).toMatchObject({ request: 'a box with a lid', priorScript: result(1).script, editRequest: 'add a cable hole at the back' });
    expect(third).toMatchObject({ request: 'a box with a lid', priorScript: result(2).script, editRequest: 'make it 20 mm taller' });
    expect(first.buildId).toBe(second.buildId); // same thread

    const rec = readRecord('reviewer', 'box');
    expect(rec).toMatchObject({ tag: 't', arm: 'reviewer', promptId: 'box', set: 'iterative', sample: 0, model: 'gpt-6-sol' });
    expect(rec.error).toBeUndefined();
    expect(rec.steps.map((s) => s.step)).toEqual([0, 1, 2]);
    expect(rec.steps.map((s) => s.text)).toEqual(['a box with a lid', 'add a cable hole at the back', 'make it 20 mm taller']);
    expect(rec.steps[2].script).toBe(result(3).script);
    const s = rec.steps[1];
    expect(s).toMatchObject({ costUsd: 0.1, turns: 2, checkFailures: null });
    expect(s.facts?.span).toEqual([10, 10, 10]);
    expect(s.reviewerFlags).toHaveLength(1);
    expect(s.wallMs).toBeGreaterThanOrEqual(0);
    expect(s.transcript).toContain('done 2');
    // mesh and STEP saved next to the record
    expect(fs.readFileSync(path.join(outDir, 't', 'reviewer', s.stlPath!), 'utf8')).toContain('solid model');
    expect(fs.readFileSync(path.join(outDir, 't', 'reviewer', s.stepPath!), 'utf8')).toBe('STEP-DATA');
  });

  it('the designer arm runs without the reviewer; the reviewer arm gets one', async () => {
    const seen: Array<{ arm: string; hasReview: boolean }> = [];
    const mk = (arm: string): RunDesignerFn => async (_i, d) => { seen.push({ arm, hasReview: !!d.review }); return result(1); };
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    await executeRun([prompts[1]], opts({ arms: ['designer'] }), { runDesigner: mk('designer'), runBrep });
    await executeRun([prompts[1]], opts({ arms: ['reviewer'] }), { runDesigner: mk('reviewer'), runBrep });
    expect(seen).toEqual([{ arm: 'designer', hasReview: false }, { arm: 'reviewer', hasReview: true }]);
  });

  it('records capped and failed, and re-measures facts with interferences and connectivity when the state lacks them', async () => {
    const bare = { ok: true, parts: [], dimensions: [] } as unknown as DesignerResult['facts']; // no interferences/disconnected
    const runDesigner = vi.fn<RunDesignerFn>().mockResolvedValue(result(1, { facts: bare, capped: 'cost', failed: true }));
    const runBrep = vi.fn().mockResolvedValue({ ...brepOk, interferences: [{ a: 'p', b: 'q', volume: 5 }], disconnected: ['q'] });
    await executeRun([prompts[1]], opts({ arms: ['reviewer'] }), { runDesigner, runBrep });
    const rec = readRecord('reviewer', 'cube');
    expect(rec.steps[0]).toMatchObject({ capped: 'cost', failed: true });
    expect(rec.steps[0].facts).toMatchObject({ ok: true, interferences: [{ a: 'p', b: 'q', volume: 5 }], disconnected: ['q'] });
    expect(runBrep.mock.calls.some((c) => c[1]?.interferences === true && c[1]?.connectivity === true)).toBe(true);
  });

  it('stops the whole run at the cost cap, aborting nothing it has not started, and writes no record for runs never begun', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async () => result(1, { costUsd: 0.6 }));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const many: EvalPrompt[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, set: 'open' as const, request: id }));
    const summary = await executeRun(many, opts({ arms: ['designer'], maxUsd: 1 }), { runDesigner, runBrep });
    expect(summary.stoppedByCap).toBe(true);
    expect(runDesigner).toHaveBeenCalledTimes(2); // 0.6, then 1.2 >= 1
    expect(summary.records).toHaveLength(2);
    expect(summary.spent).toBeCloseTo(1.2);
    expect(fs.existsSync(path.join(outDir, 't', 'designer', 'c-s0.json'))).toBe(false);
  });

  it('a cap hit mid-sequence ends that run with an error and keeps the steps it finished', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async () => result(1, { costUsd: 0.6 }));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    await executeRun([prompts[0]], opts({ arms: ['reviewer'], maxUsd: 1 }), { runDesigner, runBrep });
    const rec = readRecord('reviewer', 'box');
    expect(rec.steps).toHaveLength(1); // step 1 was in flight when the cap tripped, so it is aborted
    expect(rec.error).toMatch(/cost cap/);
  });

  it('--resume skips runs whose record exists, but re-runs a record the cost cap cut short', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async () => result(1));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const o = opts({ arms: ['designer'], only: ['cube'] });
    await executeRun(prompts, o, { runDesigner, runBrep });
    expect(runDesigner).toHaveBeenCalledTimes(1);

    const again = await executeRun(prompts, { ...o, resume: true }, { runDesigner, runBrep });
    expect(again.skipped).toBe(1);
    expect(again.records).toHaveLength(0);
    expect(runDesigner).toHaveBeenCalledTimes(1);

    const file = path.join(outDir, 't', 'designer', 'cube-s0.json');
    fs.writeFileSync(file, JSON.stringify({ ...readRecord('designer', 'cube'), error: 'cost cap reached ($1)' }));
    const third = await executeRun(prompts, { ...o, resume: true }, { runDesigner, runBrep });
    expect(third.skipped).toBe(0);
    expect(third.records).toHaveLength(1);
    expect(runDesigner).toHaveBeenCalledTimes(2);
  });

  it('writes one record per prompt, arm and sample, and honours --only', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async () => result(1));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    await executeRun([prompts[1]], opts({ samples: 2, concurrency: 5 }), { runDesigner, runBrep });
    for (const arm of ['designer', 'reviewer']) for (const n of [0, 1]) expect(fs.existsSync(path.join(outDir, 't', arm, `cube-s${n}.json`))).toBe(true);
    await expect(executeRun(prompts, opts({ only: ['nope'] }), { runDesigner, runBrep })).rejects.toThrow(/unknown prompt/);
  });

  it('a graph error becomes a record with the error, not a crash', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockRejectedValue(new Error('model down'));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const summary = await executeRun([prompts[1]], opts({ arms: ['designer'] }), { runDesigner, runBrep });
    expect(summary.records[0].error).toMatch(/model down/);
    expect(readRecord('designer', 'cube').steps).toEqual([]);
  });

  it("records priorScriptSha: null on step 0 and sha256 of step 0's script on step 1", async () => {
    let n = 0;
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async () => result(++n));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const summary = await executeRun([prompts[0]], opts({ arms: ['designer'] }), { runDesigner, runBrep });

    expect(summary.records).toHaveLength(1);
    const rec = summary.records[0];
    expect(rec.steps.length).toBeGreaterThanOrEqual(2);
    expect(rec.steps[0].priorScriptSha).toBeNull();
    const expectedSha = createHash('sha256').update(rec.steps[0].script).digest('hex');
    expect(rec.steps[1].priorScriptSha).toBe(expectedSha);
    expect(runDesigner.mock.calls[1][0].priorScript).toBe(rec.steps[0].script);
  });
});

describe('Budget', () => {
  it('aborts its signal when the cap is crossed', () => {
    const b = new Budget(1);
    b.add(0.5);
    expect(b.controller.signal.aborted).toBe(false);
    b.add(0.5);
    expect(b.exceeded).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
  });
});
