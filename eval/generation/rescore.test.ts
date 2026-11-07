import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseStepCheckOutput, STEP_CHECK_PREFIX } from './brep-eval';
import { findScript, rescoreRow, withTransportRetry, type RescoreDeps } from './rescore';
import { renderReport, type MatrixRow } from './matrix-lib';
import type { GenerationMetrics } from './metrics';
import type { BrepResult } from '@/lib/engine/brep-runner';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const ESC = String.fromCharCode(27);

describe('parseStepCheckOutput', () => {
  const line = `${STEP_CHECK_PREFIX} {"solids": 2, "valid": true}`;

  it('reads the prefixed line out of plain output', () =>
    expect(parseStepCheckOutput(`${line}\n`)).toMatchObject({ solids: 2, valid: true }));

  it('ignores banners and reads through escape codes around the JSON', () => {
    const out = `${ESC}[0m\nloaded OCP ${ESC}[32mok${ESC}[0m\n${ESC}[0m${line}${ESC}[0m\n${ESC}[0m`;
    expect(parseStepCheckOutput(out)).toMatchObject({ solids: 2, valid: true });
  });

  it('reads a result glued to a half line of noise', () =>
    expect(parseStepCheckOutput(`warning ${ESC}[1m${line}`)).toMatchObject({ solids: 2, valid: true }));

  it('reports a checker that printed no result, with the tail of what it did print', () => {
    const r = parseStepCheckOutput(`${ESC}[0m\nSegmentation fault\n`);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('printed no result');
    expect(r.error).toContain('Segmentation fault');
  });

  it('reports an invalid solid as invalid', () =>
    expect(parseStepCheckOutput(`${STEP_CHECK_PREFIX} {"solids": 1, "valid": false}`)).toMatchObject({ solids: 1, valid: false }));
});

const base: GenerationMetrics = {
  id: 'phone_stand', model: 'm', kernel: 'brep', specOk: true, composed: true, compileOk: true, brepOk: true, floorOk: true,
  floatingCount: 0, localFrameOk: null, extentsOk: null, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 5, paramCount: 12,
  eligibleParams: 12, liveParams: 8, deadParams: 4, variantCount: 0, variantsValidated: 0, reviewRounds: 0, chosenValidated: null,
  visualMatch: null, visualFindings: null, stepOk: false, workable: false, failureStage: 'step', failureDetail: 'step check unavailable',
};
const row = (cell: string, promptId: string, metrics: GenerationMetrics | null, crashed?: string): MatrixRow =>
  ({ cell, promptId, sample: 1, metrics, crashed, at: 't' });

/** Every perturbation moves the model, so all eligible parameters come out live. */
const result = (n: number): BrepResult => ({
  ok: true, solids: 1, ms: 1, step: 'U1RFUA==', bbox: { min: [0, 0, 0], max: [n, 1, 1] },
  parts: [{ label: 'a', valid: true, volume: n, min: [0, 0, 0], max: [n, 1, 1] }],
});
let counter = 0;
const deps = (over: Partial<RescoreDeps> = {}): RescoreDeps => ({
  runBrep: vi.fn(async () => result(++counter + 1)),
  checkStep: vi.fn(async () => ({ solids: 1, valid: true })),
  sweep: vi.fn(async () => ({ dead: ['lean_deg'], skipped: [] })),
  ...over,
});

describe('rescoreRow', () => {
  const brepScript = `${fixture('phone_stand.brep.py')}\n# @@baseline\n`;

  it('re-runs a B-rep script: fixes the STEP, drops guide parameters, recounts liveness', async () => {
    const d = deps({ runBrep: vi.fn(async (script: string) => (script === brepScript ? result(1) : result(++counter + 1))) });
    const next = await rescoreRow(row('brep', 'phone_stand', base), brepScript, d);
    expect(next.metrics).toMatchObject({
      stepOk: true, paramCount: 12, eligibleParams: 8, liveParams: 8, deadParams: 0, workable: true, failureStage: 'none',
      guideParams: ['phone_w', 'phone_t', 'phone_len', 'phone_s0'], fixedParams: [], deadParamNames: [],
    });
    expect(next.metrics?.failureDetail).toBeUndefined();
    // One baseline (reused, not run twice) plus one run per eligible parameter.
    expect(d.runBrep).toHaveBeenCalledTimes(1 + 8);
    expect(d.checkStep).toHaveBeenCalledOnce();
  });

  it('rescores an OpenSCAD row from the sweep, leaving fixed and guide parameters out', async () => {
    const scad = fixture('phone_stand.scad');
    const m: GenerationMetrics = { ...base, kernel: 'openscad', brepOk: undefined, stepOk: undefined, paramCount: 7, deadParams: 3, liveParams: 4, eligibleParams: undefined };
    const d = deps();
    const next = await rescoreRow(row('scad', 'phone_stand', m), scad, d);
    expect(d.runBrep).not.toHaveBeenCalled();
    expect(next.metrics).toMatchObject({ eligibleParams: 6, liveParams: 5, deadParams: 1, deadParamNames: ['lean_deg'], workable: true });
  });

  it('does not sweep an OpenSCAD row that had error violations', async () => {
    const m: GenerationMetrics = { ...base, kernel: 'openscad', errorKinds: ['floor'], floorOk: false };
    const d = deps();
    const next = await rescoreRow(row('scad', 'phone_stand', m), fixture('phone_stand.scad'), d);
    expect(d.sweep).not.toHaveBeenCalled();
    expect(next.metrics).toMatchObject({ liveParams: 6, failureStage: 'validation' });
  });

  it('treats a B-rep script that no longer runs as a geometry failure', async () => {
    const d = deps({ runBrep: vi.fn(async () => ({ ok: false, error: 'boom', parts: [], solids: 0, ms: 1 })) });
    const next = await rescoreRow(row('brep', 'phone_stand', base), brepScript, d);
    expect(next.metrics).toMatchObject({ brepOk: false, workable: false, failureStage: 'geometry' });
    expect(next.metrics?.failureDetail).toContain('boom');
  });

  it('keeps crashed rows, rows without metrics and rows without a saved script as they were', async () => {
    const d = deps();
    const crashed = row('brep', 'a', null, 'exit 1');
    expect(await rescoreRow(crashed, 'x', d)).toBe(crashed);
    const orphan = row('brep', 'b', base);
    expect(await rescoreRow(orphan, null, d)).toBe(orphan);
    expect(d.runBrep).not.toHaveBeenCalled();
  });
});

describe('withTransportRetry', () => {
  it('retries a failed connection but not a failing script', async () => {
    const flaky = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'fetch failed', parts: [], solids: 0, ms: 1 })
      .mockResolvedValueOnce(result(1));
    expect((await withTransportRetry(flaky)('s')).ok).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(2);
    const bad = vi.fn(async () => ({ ok: false, error: 'NameError: x', parts: [], solids: 0, ms: 1 }) as BrepResult);
    await withTransportRetry(bad)('s');
    expect(bad).toHaveBeenCalledOnce();
  });
});

describe('findScript and the rescored report', () => {
  it('finds a run script by tag, cell, sample and prompt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescore-'));
    for (const f of [
      't-brep-s1-m-2026-A-pen_holder.py', 't-brep-s1-m-2026-A-pen_holder.json', 't-brep-s2-m-2026-B-pen_holder.py', 't-scad-s1-m-2026-C-pen_holder.scad',
    ]) fs.writeFileSync(path.join(dir, f), '');
    const find = (cell: string, sample: number) => findScript(dir, 't', { cell, promptId: 'pen_holder', sample });
    expect(find('brep', 1)).toMatch(/t-brep-s1-.*\.py$/);
    expect(find('brep', 2)).toMatch(/-s2-/);
    expect(find('scad', 1)).toMatch(/\.scad$/);
    expect(find('scad', 2)).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });

  it('a small fixture rescored end to end gives a report with the new workable rate', async () => {
    const script = `${fixture('phone_stand.brep.py')}\n# @@baseline\n`;
    const d = deps({ runBrep: vi.fn(async (s: string) => (s === script ? result(1) : result(++counter + 1))) });
    const before = [row('brep', 'phone_stand', base), row('brep', 'pen', null, 'exit 1')];
    const after = await Promise.all(before.map((r) => rescoreRow(r, script, d)));
    const md = renderReport('t-rescored', after, ['brep']);
    expect(renderReport('t', before, ['brep'])).toContain('| **workable** | 0/2 (0%) |');
    expect(md).toContain('| **workable** | 1/2 (50%) |');
    expect(md).toContain('| stepOk (B-rep) | 1/1 (100%) |');
    expect(md).toContain('| brep | pen | 1 | crash | exit 1 |');
  });
});
