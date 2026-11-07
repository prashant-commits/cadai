import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_JUDGE_MODEL, measureIntent, UNJUDGED_INTENT, type IntentJudgeFn } from './judge';
import { childArgs } from './matrix';
import { planRuns, renderReport, validateCells, type MatrixRow } from './matrix-lib';
import type { GenerationMetrics } from './metrics';

const verdict = { matchesIntent: true, score: 8, findings: [{ issue: 'hole is small', severity: 'minor' as const, view: 'top' }] };
const fake = (out: Awaited<ReturnType<IntentJudgeFn>>): IntentJudgeFn => vi.fn(async () => out);

describe('measureIntent', () => {
  const input = { on: true, stl: 'solid x', request: 'a plate', spec: null, model: DEFAULT_JUDGE_MODEL };

  it('records match, score, findings and its own cost', async () => {
    const judge = fake({ verdict, costUsd: 0.012 });
    expect(await measureIntent(input, judge)).toEqual({
      intentMatch: true, intentScore: 8, intentFindings: verdict.findings, judgeCostUsd: 0.012,
    });
    expect(judge).toHaveBeenCalledWith({ stl: 'solid x', request: 'a plate', spec: null, model: 'claude-sonnet-5.5' });
  });

  it('never calls the judge when off or when there is no STL', async () => {
    const judge = fake({ verdict, costUsd: 0 });
    expect(await measureIntent({ ...input, on: false }, judge)).toBe(UNJUDGED_INTENT);
    expect(await measureIntent({ ...input, stl: null }, judge)).toBe(UNJUDGED_INTENT);
    expect(judge).not.toHaveBeenCalled();
  });

  it('leaves every field null when the judge fails', async () => {
    expect(await measureIntent(input, fake(null))).toEqual(UNJUDGED_INTENT);
  });

  it('defaults to Sonnet 5.5', () => expect(DEFAULT_JUDGE_MODEL).toBe('claude-sonnet-5.5'));
});

describe('cells: env and judge', () => {
  const cells = validateCells(JSON.parse(fs.readFileSync(path.join(__dirname, 'cells-hard.json'), 'utf8')));
  const [run] = planRuns([cells[1]], [{ id: 'p', prompt: 'P' }], 1);

  it('ships the three hard cells, all brep, attempts 3, judge on', () => {
    expect(cells.map((c) => c.name)).toEqual(['haiku-off', 'haiku-buildthink', 'sonnet']);
    for (const c of cells) expect(c).toMatchObject({ kernel: 'brep', attempts: 3, judge: true, thinking: 'off' });
    expect(cells.map((c) => c.model)).toEqual(['claude-haiku-5.5', 'claude-haiku-5.5', 'claude-sonnet-5.5']);
    expect(cells[1].env).toEqual({ CADAI_BUILD_THINKING: 'adaptive', CADAI_BUILD_EFFORT: 'medium' });
    expect(cells[0].env).toBeUndefined();
  });

  it('a judged cell passes --judge on, and nothing turns the graph critic on', () => {
    const args = childArgs(run, '/o', '/o/r.json', 't', '/p.json');
    expect(args.join(' ')).toContain('--judge on');
    expect(args).not.toContain('--critic');
    expect(childArgs(planRuns([{ name: 'x', kernel: 'brep' }], [{ id: 'p', prompt: 'P' }], 1)[0], '/o', '/o/r.json', 't', '/p.json')).not.toContain('--judge');
  });

  it('rejects an env map that is not strings to strings', () => {
    expect(() => validateCells([{ name: 'x', kernel: 'brep', env: { A: 1 } }])).toThrow(/env/);
    expect(() => validateCells([{ name: 'x', kernel: 'brep', env: ['A'] }])).toThrow(/env/);
  });
});

describe('report rows for the judge', () => {
  const m = (over: Partial<GenerationMetrics>): GenerationMetrics => ({
    id: 'a', model: 'x', kernel: 'brep', specOk: true, composed: true, compileOk: true, floorOk: true, floatingCount: 0, localFrameOk: null,
    extentsOk: null, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 1000, variantCount: 0, variantsValidated: 0, reviewRounds: 0,
    chosenValidated: null, visualMatch: null, visualFindings: null, workable: true, ...over,
  });
  const row = (cell: string, id: string, metrics: GenerationMetrics): MatrixRow => ({ cell, promptId: id, sample: 1, metrics, at: 't' });

  it('shows intentMatch, mean intentScore and mean judge cost, and "-" for an unjudged cell', () => {
    const md = renderReport('t', [
      row('judged', 'a', m({ intentMatch: true, intentScore: 9, judgeCostUsd: 0.01 })),
      row('judged', 'b', m({ intentMatch: false, intentScore: 4, judgeCostUsd: 0.03 })),
      row('judged', 'c', m({ intentMatch: null, intentScore: null, judgeCostUsd: null })),
      row('plain', 'a', m({})),
    ], ['judged', 'plain']);
    expect(md).toContain('| intentMatch (judge) | 1/2 (50%) | - |');
    expect(md).toContain('| mean intentScore | 6.5 | - |');
    expect(md).toContain('| mean judge cost / run | $0.0200 | - |');
  });
});
