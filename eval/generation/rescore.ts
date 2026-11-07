/**
 * Rescore a finished matrix without a model call: the parameter, STEP and
 * workable metrics are recomputed from each run's saved final script. Only
 * geometry is re-run (B-rep through runBrep, so CADAI_GEO_URL when set;
 * OpenSCAD through the parameter sweep). Spec-level checks (extents, floor,
 * floating, specOk) are kept from the original row, because the spec is not saved.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrepResult } from '@/lib/engine/brep-runner';
import { sweepParameters } from '@/lib/agent/param-sweep';
import { defaultBrepDeps, finalizeMetrics, type BrepEvalDeps } from './brep-eval';
import type { MatrixRow } from './matrix-lib';
import { classifyParams } from './param-classify';
import { withVerdict, type GenerationMetrics } from './metrics';

export interface RescoreDeps extends BrepEvalDeps {
  /** Names of the parameters an OpenSCAD sweep found dead, and those it did not reach. */
  sweep: (code: string) => Promise<{ dead: string[]; skipped: string[] }>;
}

/** Errors from the transport to the geometry service, not from the script. */
const TRANSPORT_ERROR = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|timeout|HTTP 5\d\d/i;

/** Retries a run that failed on the service connection, so a flaky link is not scored as a bad script. */
export function withTransportRetry(run: BrepEvalDeps['runBrep'], tries = 3): BrepEvalDeps['runBrep'] {
  return async (script) => {
    let result = await run(script);
    for (let i = 1; i < tries && !result.ok && TRANSPORT_ERROR.test(result.error ?? ''); i++) result = await run(script);
    return result;
  };
}

export const defaultRescoreDeps: RescoreDeps = {
  ...defaultBrepDeps,
  runBrep: withTransportRetry(defaultBrepDeps.runBrep),
  sweep: (code) => sweepParameters(code, { budgetMs: 300_000 }),
};

/** The saved final script of a run: `<dir>/<tag>-<cell>-s<sample>-...-<promptId>.(py|scad)`. */
export function findScript(dir: string, tag: string, row: Pick<MatrixRow, 'cell' | 'promptId' | 'sample'>): string | null {
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return null; }
  const prefix = `${tag}-${row.cell}-s${row.sample}-`;
  const hit = files.find((f) => f.startsWith(prefix) && (f.endsWith(`-${row.promptId}.py`) || f.endsWith(`-${row.promptId}.scad`)));
  return hit ? path.join(dir, hit) : null;
}

const CLEARED: Partial<GenerationMetrics> = {
  eligibleParams: undefined, liveParams: undefined, deadParamNames: undefined, breakingParams: undefined,
  partsTotal: undefined, partsValid: undefined, stepOk: undefined, paramTotal: undefined,
};

export async function rescoreMetrics(m: GenerationMetrics, code: string, deps: RescoreDeps): Promise<GenerationMetrics> {
  if (!m.specOk) return withVerdict(m);

  if (m.kernel === 'brep') {
    if (!m.brepOk) return withVerdict(m, m.failureDetail);
    // One baseline run supplies the STEP and is reused by finalizeMetrics.
    const baseline: BrepResult = await deps.runBrep(code);
    const memo: BrepEvalDeps = {
      checkStep: deps.checkStep,
      runBrep: async (script) => (script === code ? baseline : deps.runBrep(script)),
    };
    return finalizeMetrics({ ...m, ...CLEARED }, { kernel: 'brep', currentCode: code, stepContent: baseline.step ?? null }, memo);
  }

  if (!m.compileOk) return withVerdict(m, m.failureDetail);
  const classes = classifyParams(code);
  // The graph only sweeps a model with no error violation; keep that rule so rows stay comparable.
  const swept = m.errorKinds.length === 0 ? await deps.sweep(code) : { dead: [], skipped: [] };
  const skipped = new Set(swept.skipped);
  const eligible = classes.eligible.map((p) => p.name).filter((n) => !skipped.has(n));
  const dead = swept.dead.filter((n) => eligible.includes(n));
  return withVerdict({
    ...m,
    ...CLEARED,
    eligibleParams: eligible.length,
    liveParams: eligible.length - dead.length,
    deadParams: swept.dead.length,
    deadParamNames: dead,
    fixedParams: classes.fixed,
    guideParams: classes.guide,
  }, m.failureDetail);
}

/** A row with its metrics recomputed. A crashed row, or one with no saved script, is returned as it was. */
export async function rescoreRow(row: MatrixRow, script: string | null, deps: RescoreDeps): Promise<MatrixRow> {
  if (!row.metrics || row.crashed || script === null) return row;
  return { ...row, metrics: await rescoreMetrics(row.metrics, script, deps) };
}
