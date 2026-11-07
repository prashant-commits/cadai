/**
 * B-rep metrics that need the geometry kernel: a baseline re-run of the final
 * script, a STEP re-import, and parameter perturbation. Every dependency is
 * injectable so the unit tests run without Python or a model.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentStateType } from '@/lib/agent/graph';
import { runBrep, type BrepPart, type BrepResult } from '@/lib/engine/brep-runner';
import { setParamValue } from '@/lib/design/write-params';
import { classifyParams } from './param-classify';
import { perturbedValue, withVerdict, type GenerationMetrics } from './metrics';

export const MAX_PERTURBED_PARAMS = 12;
const REL_TOL = 1e-6;

export interface StepCheck { solids: number; valid: boolean; error?: string }

export interface BrepEvalDeps {
  runBrep: (script: string) => Promise<BrepResult>;
  checkStep: (stepBase64: string) => Promise<StepCheck>;
}

export const defaultBrepDeps: BrepEvalDeps = {
  runBrep: (script) => runBrep(script),
  checkStep: checkStepWithPython,
};

/** Every line the checker prints starts with this, so noise around it cannot be mistaken for the result. */
export const STEP_CHECK_PREFIX = '@@cadai-step-check@@';
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Reads the one prefixed JSON line out of whatever the checker printed (escape codes included). */
export function parseStepCheckOutput(out: string): StepCheck {
  const clean = out.replace(ANSI, '');
  for (const line of clean.split(/\r?\n/)) {
    const at = line.indexOf(STEP_CHECK_PREFIX);
    if (at < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(at + STEP_CHECK_PREFIX.length).trim()) as StepCheck;
      return { solids: Number(parsed.solids) || 0, valid: parsed.valid === true, error: parsed.error };
    } catch { /* keep looking */ }
  }
  const tail = clean.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200);
  return { solids: 0, valid: false, error: `step check printed no result${tail ? `: ${tail}` : ''}` };
}

/** Writes the STEP to a temp file and asks the geo Python (build123d) to re-import it. */
export async function checkStepWithPython(stepBase64: string): Promise<StepCheck> {
  const py = process.env.CADAI_GEO_PYTHON ?? path.resolve(process.cwd(), 'geo/.venv/bin/python');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadai-step-'));
  try {
    const file = path.join(dir, 'model.step');
    await fs.writeFile(file, Buffer.from(stepBase64, 'base64'));
    const script = path.join(__dirname, 'step-check.py');
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(py, ['-I', script, file], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', PYTHONUNBUFFERED: '1' },
      });
      let text = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.stdout.on('data', (c) => { text += c; });
      child.stderr.on('data', (c) => { text += c; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', () => { clearTimeout(timer); resolve(text); });
    });
    return parseStepCheckOutput(out);
  } catch (e) {
    return { solids: 0, valid: false, error: `step check unavailable: ${(e as Error).message}`.slice(0, 300) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const differs = (a: number, b: number) => Math.abs(a - b) > REL_TOL * Math.max(1, Math.abs(a), Math.abs(b));
const vecDiffers = (a: number[], b: number[]) => a.some((v, i) => differs(v, b[i] ?? NaN));

function partsDiffer(a: BrepPart[], b: BrepPart[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((p, i) => {
    const q = b[i];
    return p.label !== q.label || differs(p.volume, q.volume) || vecDiffers(p.min, q.min) || vecDiffers(p.max, q.max);
  });
}

/** True when any part's bbox or volume (or the whole bbox) differs from the baseline. */
export function geometryChanged(base: BrepResult, next: BrepResult): boolean {
  if (partsDiffer(base.parts, next.parts)) return true;
  if (base.solids !== next.solids) return true;
  if (base.bbox && next.bbox) return vecDiffers(base.bbox.min, next.bbox.min) || vecDiffers(base.bbox.max, next.bbox.max);
  return false;
}

export interface PerturbResult {
  /** Eligible parameters perturbed (cap 12). */
  tested: number;
  live: number;
  dead: number;
  deadNames: string[];
  breaking: number;
  /** Numeric parameters in the script, fixed and guide-only included. */
  total: number;
  fixed: string[];
  guide: string[];
}

/**
 * Re-runs the script once per eligible parameter (cap 12) at a different
 * in-range value. Fixed (min == max) and guide-only parameters are not tested.
 */
export async function perturbParams(
  code: string,
  baseline: BrepResult,
  run: BrepEvalDeps['runBrep'],
  cap = MAX_PERTURBED_PARAMS,
): Promise<PerturbResult> {
  const classes = classifyParams(code);
  const out: PerturbResult = {
    tested: 0, live: 0, dead: 0, deadNames: [], breaking: 0,
    total: classes.total.length, fixed: classes.fixed, guide: classes.guide,
  };
  for (const p of classes.eligible.slice(0, cap)) {
    out.tested += 1;
    const next = perturbedValue(p);
    if (next === null) { out.dead += 1; out.deadNames.push(p.name); continue; }
    const result = await run(setParamValue(code, p.name, next));
    if (!result.ok) { out.live += 1; out.breaking += 1; continue; }
    if (geometryChanged(baseline, result)) out.live += 1;
    else { out.dead += 1; out.deadNames.push(p.name); }
  }
  return out;
}

function firstErrorOf(state: Partial<AgentStateType>): string | undefined {
  const violations = (state.specViolations ?? []).filter((v) => v.severity === 'error');
  const last = state.attemptHistory?.[state.attemptHistory.length - 1];
  return last?.errors?.[0]?.message || violations[0]?.message;
}

/**
 * Adds the B-rep-only fields and the verdict. OpenSCAD rows only get the verdict.
 * The baseline re-run supplies the part counts; a failed baseline leaves the
 * parameter fields unset because the geometry stage has already failed.
 */
export async function finalizeMetrics(
  m: GenerationMetrics,
  state: Partial<AgentStateType>,
  deps: BrepEvalDeps = defaultBrepDeps,
): Promise<GenerationMetrics> {
  if (m.kernel !== 'brep') return withVerdict(m, firstErrorOf(state));

  const next: GenerationMetrics = { ...m };
  let stepError: string | undefined;
  let rerunError: string | undefined;

  if (state.stepContent) {
    const check = await deps.checkStep(state.stepContent);
    next.stepOk = check.valid && check.solids >= 1;
    if (!next.stepOk) stepError = check.error ?? `STEP re-imported as ${check.solids} solid(s), valid=${check.valid}`;
  } else {
    next.stepOk = false;
    stepError = 'no STEP in the final state';
  }

  const code = state.currentCode ?? '';
  if (next.brepOk && code) {
    const baseline = await deps.runBrep(code);
    if (baseline.ok) {
      next.partsTotal = baseline.parts.length;
      next.partsValid = baseline.parts.filter((p) => p.valid).length;
      const r = await perturbParams(code, baseline, deps.runBrep);
      next.paramCount = r.total;
      next.paramTotal = r.total;
      next.eligibleParams = r.tested;
      next.liveParams = r.live;
      next.deadParams = r.dead;
      next.deadParamNames = r.deadNames;
      next.fixedParams = r.fixed;
      next.guideParams = r.guide;
      next.breakingParams = r.breaking;
    } else {
      // The final script did not reproduce its own result: count it as a geometry failure.
      next.brepOk = false;
      rerunError = `final script failed on re-run: ${baseline.error ?? 'unknown'}`;
    }
  }
  const firstError = rerunError ?? (next.brepOk ? stepError : firstErrorOf(state));
  return withVerdict(next, firstError);
}
