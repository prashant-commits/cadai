import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import type { BrepResult } from '../../src/lib/engine/brep-runner';
import type { DesignerDeps, DesignerResult, RunDesignerFn } from '../../src/lib/agent/designer/types';
import type { EvalPrompt, RunRecord } from './types';
import { closeDb, getDb } from '../../src/lib/db/db';
import {
  Budget,
  executeRun,
  loadSet,
  parseArgs,
  defaultOptions,
  EVAL_OWNER_KEY,
  type RunnerOptions,
} from './runner';

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

const TMP_ROOT = path.resolve(process.env.TMPDIR ?? path.join(process.cwd(), '.cadai', 'tasks', 'tmp'));
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

const emitCost = (res: DesignerResult, d?: DesignerDeps): DesignerResult => {
  if (d?.onEvent && typeof res.costUsd === 'number' && res.costUsd > 0) {
    d.onEvent({ kind: 'cost', usd: res.costUsd });
  }
  return res;
};

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
afterEach(async () => {
  await closeDb();
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
  it('the runner starts every step through store.start and streamRun', async () => {
    let n = 0;
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(++n), d));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const classify = vi.fn().mockResolvedValue('edit');
    const promptWithFollowUp: EvalPrompt = {
      id: 'box-seq',
      set: 'iterative',
      request: 'a box with a lid',
      followUps: [{ text: 'add a cable hole', kind: 'cut', probe: { kind: 'reviewer' } }],
    };
    const summary = await executeRun([promptWithFollowUp], opts({ arms: ['reviewer'] }), { runDesigner, runBrep, classify });

    expect(summary.records).toHaveLength(1);
    const rec = summary.records[0];
    expect(rec.steps).toHaveLength(2);

    const db = getDb();
    const threadRes = await db.query(
      `SELECT thread_id FROM runs WHERE id = $1`,
      [rec.steps[0].runId]
    );
    const threadId = threadRes.rows[0].thread_id;

    // two runs in the DB, both done
    const runsRes = await db.query(
      `SELECT id, status, base_version, design_version FROM runs WHERE thread_id = $1 ORDER BY created_at ASC`,
      [threadId]
    );
    expect(runsRes.rows).toHaveLength(2);
    expect(runsRes.rows[0].status).toBe('done');
    expect(runsRes.rows[1].status).toBe('done');

    // the thread has v1 and v2; v2's parent_version is 1; step 1's request had viewingVersion: 1
    const designsRes = await db.query(
      `SELECT version, parent_version FROM designs WHERE thread_id = $1 ORDER BY version ASC`,
      [threadId]
    );
    expect(designsRes.rows).toHaveLength(2);
    expect(designsRes.rows[0].version).toBe(1);
    expect(designsRes.rows[0].parent_version).toBeNull();
    expect(designsRes.rows[1].version).toBe(2);
    expect(designsRes.rows[1].parent_version).toBe(1);

    expect(runsRes.rows[1].base_version).toBe(1);
  });

  it('step cost, time and turns come from the run row', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(1, { costUsd: 0.15, turns: 3 }), d));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const summary = await executeRun([prompts[1]], opts({ arms: ['designer'] }), { runDesigner, runBrep });
    const rec = summary.records[0];
    expect(rec.steps).toHaveLength(1);

    const db = getDb();
    const runRow = (await db.query(`SELECT cost_usd, wall_ms, turns FROM runs WHERE id = $1`, [rec.steps[0].runId])).rows[0];
    expect(rec.steps[0].costUsd).toBe(Number(runRow.cost_usd));
    expect(rec.steps[0].wallMs).toBe(runRow.wall_ms);
    expect(rec.steps[0].turns).toBe(runRow.turns);
  });

  it('sends follow-ups on the same thread as edits of the accepted script, and records every step', async () => {
    let n = 0;
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(++n), d));
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
    const mk = (arm: string): RunDesignerFn => async (_i, d) => { seen.push({ arm, hasReview: !!d.review }); return emitCost(result(1), d); };
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    await executeRun([prompts[1]], opts({ arms: ['designer'] }), { runDesigner: mk('designer'), runBrep });
    await executeRun([prompts[1]], opts({ arms: ['reviewer'] }), { runDesigner: mk('reviewer'), runBrep });
    expect(seen).toEqual([{ arm: 'designer', hasReview: false }, { arm: 'reviewer', hasReview: true }]);
  });

  it('records capped and failed, and re-measures facts with interferences and connectivity when the state lacks them', async () => {
    const bare = { ok: true, parts: [], dimensions: [] } as unknown as DesignerResult['facts']; // no interferences/disconnected
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(1, { facts: bare, capped: 'cost', failed: true }), d));
    const runBrep = vi.fn().mockResolvedValue({ ...brepOk, interferences: [{ a: 'p', b: 'q', volume: 5 }], disconnected: ['q'] });
    await executeRun([prompts[1]], opts({ arms: ['reviewer'] }), { runDesigner, runBrep });
    const rec = readRecord('reviewer', 'cube');
    expect(rec.steps[0]).toMatchObject({ capped: 'cost', failed: true });
    expect(rec.steps[0].facts).toMatchObject({ ok: true, interferences: [{ a: 'p', b: 'q', volume: 5 }], disconnected: ['q'] });
    expect(runBrep.mock.calls.some((c) => c[1]?.interferences === true && c[1]?.connectivity === true)).toBe(true);
  });

  it('stops the whole run at the cost cap, aborting nothing it has not started, and writes no record for runs never begun', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(1, { costUsd: 0.6 }), d));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const many: EvalPrompt[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, set: 'open' as const, request: id }));
    const summary = await executeRun(many, opts({ arms: ['designer'], maxUsd: 1 }), { runDesigner, runBrep });
    expect(summary.stoppedByCap).toBe(true);
    expect(runDesigner).toHaveBeenCalledTimes(2); // 0.6, then 1.2 >= 1
    expect(summary.records).toHaveLength(2);
    expect(summary.spent).toBeCloseTo(1.2);
    expect(fs.existsSync(path.join(outDir, 't', 'designer', 'c-s0.json'))).toBe(false);
  });

  it('a cost cap aborts the in-flight run', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(1, { costUsd: 0.6 }), d));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const classify = vi.fn().mockResolvedValue('edit');
    await executeRun([prompts[0]], opts({ arms: ['reviewer'], maxUsd: 1 }), { runDesigner, runBrep, classify });
    const rec = readRecord('reviewer', 'box');
    expect(rec.steps).toHaveLength(1); // step 1 was in flight when the cap tripped, so it is aborted
    expect(rec.error).toMatch(/cost cap/);

    const db = getDb();
    const runs = (await db.query(`SELECT status, error FROM runs ORDER BY created_at ASC`)).rows;
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[0].status).toBe('done');
    expect(runs[1].status).toBe('cancelled');
  });

  it('--resume skips runs whose record exists, but re-runs a record the cost cap cut short', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(1), d));
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
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(1), d));
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

  it("priorScriptSha of step 1 is the sha256 of step 0's script", async () => {
    let n = 0;
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(++n), d));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const classify = vi.fn().mockResolvedValue('edit');
    const summary = await executeRun([prompts[0]], opts({ arms: ['designer'] }), { runDesigner, runBrep, classify });

    expect(summary.records).toHaveLength(1);
    const rec = summary.records[0];
    expect(rec.steps.length).toBeGreaterThanOrEqual(2);
    expect(rec.steps[0].priorScriptSha).toBeNull();
    expect(rec.steps[0].script).not.toBe('');
    expect(rec.steps[1].script).not.toBe('');
    expect(rec.steps[1].script).not.toBe(rec.steps[0].script);

    const expectedSha = createHash('sha256').update(rec.steps[0].script).digest('hex');
    expect(rec.steps[1].priorScriptSha).toBe(expectedSha);
    expect(runDesigner.mock.calls[1][0].priorScript).toBe(rec.steps[0].script);
  });

  it("the runner seeds step 2 with step 1's script", async () => {
    let n = 0;
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(++n), d));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const classify = vi.fn().mockResolvedValue('edit');
    const summary = await executeRun([prompts[0]], opts({ arms: ['designer'] }), { runDesigner, runBrep, classify });

    expect(summary.records).toHaveLength(1);
    expect(runDesigner).toHaveBeenCalledTimes(3);
    const thirdCall = runDesigner.mock.calls[2][0];
    expect(thirdCall.priorScript).toBe(result(2).script);
  });

  it('the runner uses a private run dir, the eval owner and no reaper loop', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) => emitCost(result(1), d));
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const summary = await executeRun([prompts[1]], opts({ arms: ['designer'] }), { runDesigner, runBrep });
    const rec = summary.records[0];

    const appDir = path.join(outDir, 't', '.app');
    expect(fs.existsSync(path.join(appDir, 'pglite'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'objects'))).toBe(true);

    const db = getDb();
    const threadRow = (await db.query(
      `SELECT owner_key FROM threads WHERE id = (SELECT thread_id FROM runs WHERE id = $1)`,
      [rec.steps[0].runId]
    )).rows[0];
    expect(threadRow.owner_key).toBe(EVAL_OWNER_KEY);
    expect(process.env.CADAI_EVAL_RUNNER).toBe('1');
  });

  it("the runner passes the run's deadline to streamRun and the graph", async () => {
    const prevMaxMs = process.env.CADAI_RUN_MAX_MS;
    process.env.CADAI_RUN_MAX_MS = '300000';
    try {
      let seenWallMs: number | undefined;
      const runDesigner: RunDesignerFn = async (_input, d) => {
        seenWallMs = d.wallMs;
        return emitCost(result(1), d);
      };
      const runBrep = vi.fn().mockResolvedValue(brepOk);
      const summary = await executeRun([prompts[1]], opts({ arms: ['designer'] }), { runDesigner, runBrep });
      const rec = summary.records[0];

      const db = getDb();
      const runRow = (await db.query(
        `SELECT deadline_at FROM runs WHERE id = $1`,
        [rec.steps[0].runId]
      )).rows[0];
      const deadlineAt = Number(runRow.deadline_at);
      expect(deadlineAt).toBeGreaterThan(Date.now());

      expect(seenWallMs).toBeDefined();
      expect(seenWallMs!).toBeLessThan(420_000);
      const expectedBudget = deadlineAt - Date.now() - 150_000;
      expect(Math.abs(seenWallMs! - expectedBudget)).toBeLessThanOrEqual(5_000);
    } finally {
      if (prevMaxMs !== undefined) process.env.CADAI_RUN_MAX_MS = prevMaxMs;
      else delete process.env.CADAI_RUN_MAX_MS;
    }
  });

  it('a step with attachments uploads them and the designer sees them', async () => {
    let seenAttachments: Array<{ mediaType: string; base64: string }> | undefined;
    const runDesigner: RunDesignerFn = async (input, d) => {
      seenAttachments = input.attachments;
      return emitCost(result(1), d);
    };
    const runBrep = vi.fn().mockResolvedValue(brepOk);

    const imgPath = path.join(outDir, 'sample.png');
    const pngBuf = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    fs.writeFileSync(imgPath, pngBuf);

    const promptWithAtt: EvalPrompt = {
      id: 'dock-att',
      set: 'open',
      request: 'a dock with an attachment',
      attachments: [imgPath],
    };

    const summary = await executeRun([promptWithAtt], opts({ arms: ['designer'] }), { runDesigner, runBrep });
    expect(summary.records).toHaveLength(1);

    expect(seenAttachments).toBeDefined();
    expect(seenAttachments).toHaveLength(1);
    expect(seenAttachments![0].mediaType).toBe('image/png');
    expect(typeof seenAttachments![0].base64).toBe('string');

    const db = getDb();
    const arts = (await db.query(`SELECT kind, owner_key FROM artifacts WHERE kind = 'image'`)).rows;
    expect(arts.length).toBeGreaterThanOrEqual(1);
    expect(arts[0].owner_key).toBe(EVAL_OWNER_KEY);
  });

  it('a refusal step is recorded as refused', async () => {
    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (_i, d) =>
      emitCost(result(1, { stop: 'refusal', script: '' }), d)
    );
    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const classify = vi.fn().mockResolvedValue('refusal');
    const summary = await executeRun([prompts[1]], opts({ arms: ['designer'] }), { runDesigner, runBrep, classify });
    const rec = summary.records[0];
    expect(rec.steps).toHaveLength(1);
    expect(rec.steps[0].refused).toBe(true);
    expect(rec.steps[0].replyKind).toBe('error');
    expect(rec.steps[0].script).toBe('');
  });

  it('a cost cap trips during one prompt and aborts another in-flight prompt at concurrency 2', async () => {
    let resolveP2Started: () => void;
    const p2Started = new Promise<void>((r) => {
      resolveP2Started = r;
    });

    const runDesigner = vi.fn<RunDesignerFn>().mockImplementation(async (input, d) => {
      if (input.request === 'prompt two') {
        resolveP2Started();
        // Wait until aborted by the cap
        await new Promise((resolve) => {
          if (d?.signal?.aborted) return resolve(undefined);
          d?.signal?.addEventListener('abort', () => resolve(undefined));
        });
        return emitCost(result(2), d);
      } else {
        // Wait for prompt two to be in flight
        await p2Started;
        // Trip the budget cap
        return emitCost(result(1, { costUsd: 1.5 }), d);
      }
    });

    const runBrep = vi.fn().mockResolvedValue(brepOk);
    const twoPrompts: EvalPrompt[] = [
      { id: 'p1', set: 'open', request: 'prompt one' },
      { id: 'p2', set: 'open', request: 'prompt two' },
    ];

    const summary = await executeRun(
      twoPrompts,
      opts({ concurrency: 2, maxUsd: 1, arms: ['designer'] }),
      { runDesigner, runBrep }
    );

    expect(summary.stoppedByCap).toBe(true);

    const db = getDb();
    const runs = (await db.query(`SELECT id, status FROM runs ORDER BY created_at ASC`)).rows;
    expect(runs.length).toBe(2);
    const cancelledRun = runs.find((r) => r.status === 'cancelled');
    expect(cancelledRun).toBeDefined();

    const p2Rec = summary.records.find((r) => r.promptId === 'p2');
    expect(p2Rec?.error).toMatch(/cost cap/);
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
