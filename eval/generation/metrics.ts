import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import type { AgentStateType } from '@/lib/agent/graph';
import { isZeroVec } from '@/lib/design/placement-geometry';
import { parseParams } from '@/lib/design/parse-params';
import { judgeCompiledModel, type VisualCritique } from './judge';
import { classifyParams } from './param-classify';

export interface GenerationMetrics {
  id: string;
  model: string;
  pipeline?: 'drafter' | 'architect' | null;
  specOk: boolean;
  composed: boolean;
  compileOk: boolean;
  floorOk: boolean | null;
  floatingCount: number | null;
  localFrameOk: boolean | null;
  extentsOk: boolean | null;
  shellsOk: boolean | null;
  errorKinds: string[];
  attempts: number;
  wallMs: number;
  paramCount?: number;
  deadParams?: number;
  buildFallbacks?: number;
  /** Variants the architect planned on the last pass that still had them. */
  variantCount: number;
  /** How many of those variants have `review.validated`. */
  variantsValidated: number;
  /** Highest `review.attempts` across those variants. */
  reviewRounds: number;
  /** The recommended variant's `review.validated`, or null when it has no review. */
  chosenValidated: boolean | null;
  /**
   * The standalone judge's verdict. Null when the critic is off, there is
   * no STL, or the judge call failed. True only when the judge says the
   * part matches and reported no major finding. A missing graph violation
   * is not a match: the graph critic never runs after an audit error.
   */
  visualMatch: boolean | null;
  /** Findings the judge returned. Null when the part was not judged. */
  visualFindings: number | null;

  // Fields below are filled by the kernel-comparison eval (matrix.ts). All optional.
  kernel?: 'openscad' | 'brep';
  /** B-rep: the last geometry run succeeded. */
  brepOk?: boolean;
  partsTotal?: number;
  partsValid?: number;
  /** B-rep: a STEP came back and re-imports as >= 1 valid solid. */
  stepOk?: boolean;
  /**
   * Parameters the live ratio is taken over: numeric, not `$`-prefixed, not fixed
   * (min == max) and not guide-only. B-rep: the ones perturbed (cap 12).
   */
  eligibleParams?: number;
  /** Eligible parameters that change the model (B-rep: under perturbation; OpenSCAD: not swept dead). */
  liveParams?: number;
  /** Eligible parameters that did not change the model, by name. */
  deadParamNames?: string[];
  /** Parameters whose range has min == max. Left out of the ratio. */
  fixedParams?: string[];
  /** Parameters no geometry code reads, directly or through derived values. Left out of the ratio. */
  guideParams?: string[];
  /** B-rep: parameters whose perturbed value made the script fail. They also count as live. */
  breakingParams?: number;
  /** B-rep: numeric parameters parsed from the final script, before the perturbation cap. */
  paramTotal?: number;
  /** Total runBrep time inside the graph. The graph does not record it, so this is omitted today. */
  geometryMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  workable?: boolean;
  failureStage?: FailureStage;
  failureDetail?: string;
}

export type FailureStage = 'spec' | 'geometry' | 'validation' | 'step' | 'params' | 'none';

/** A parameter must change the model for this share of the tested parameters. */
export const LIVE_PARAM_SHARE = 0.8;

export interface VisualScore {
  visualMatch: boolean | null;
  visualFindings: number | null;
}

const UNJUDGED: VisualScore = { visualMatch: null, visualFindings: null };

/** True when the judge matched the request and raised no major finding. */
export function scoreCritique(critique: VisualCritique | null): VisualScore {
  if (!critique) return UNJUDGED;
  const findings = critique.findings ?? [];
  return {
    visualMatch: critique.matchesIntent && !findings.some((finding) => finding.severity === 'major'),
    visualFindings: findings.length,
  };
}

/**
 * Judge the compiled STL when the critic arm is on. Does nothing otherwise,
 * and does not read specViolations.
 */
export async function measureVisualMatch(input: {
  criticOn: boolean;
  stl: string | null | undefined;
  request: string;
  spec: AssemblySpec | null;
}): Promise<VisualScore> {
  if (!input.criticOn || !input.stl) return UNJUDGED;
  return scoreCritique(await judgeCompiledModel({
    stl: input.stl,
    request: input.request,
    spec: input.spec,
  }));
}

/**
 * Variant list captured at the spec-gate interrupt. The drafter clears
 * `specVariants` after the gate, so the final state can no longer answer
 * "how many did the architect plan".
 */
export interface SpecGateCapture {
  variants: Array<{
    id: string;
    review?: { validated: boolean; attempts: number } | null;
  }>;
  recommendedId?: string | null;
}

function variantStats(
  variants: SpecGateCapture['variants'],
  recommendedId: string | null,
): Pick<GenerationMetrics, 'variantCount' | 'variantsValidated' | 'reviewRounds' | 'chosenValidated'> {
  let reviewRounds = 0;
  let variantsValidated = 0;
  for (const variant of variants) {
    const attempts = variant.review?.attempts ?? 0;
    if (attempts > reviewRounds) reviewRounds = attempts;
    if (variant.review?.validated) variantsValidated += 1;
  }
  const chosen = recommendedId ? variants.find((variant) => variant.id === recommendedId) : undefined;
  return {
    variantCount: variants.length,
    variantsValidated,
    reviewRounds,
    chosenValidated: chosen?.review ? chosen.review.validated : null,
  };
}

export function metricsFromState(
  id: string,
  model: string,
  state: Partial<AgentStateType> & { pipeline?: 'drafter' | 'architect' | null },
  wallMs: number,
  capture?: SpecGateCapture | null,
  visual?: VisualScore | null,
): GenerationMetrics {
  const violations = state.specViolations ?? [];
  const errors = violations.filter((v) => v.severity === 'error');
  const has = (kind: string) => errors.some((v) => v.kind === kind);
  const report = state.placementReport ?? null;
  const measured = report?.components.filter((c) => c.measured) ?? [];
  const hasModel = !!state.modelInfo;
  const specHasExtents = !!state.assemblySpec?.components?.some((c) => (c as { localExtents?: unknown }).localExtents);

  // Prefer the variants still on the final state. Once the drafter has cleared
  // them, fall back to the list runOne copied off the spec-gate interrupt.
  const live = state.specVariants ?? [];
  const variants = live.length > 0
    ? live.map((variant) => ({ id: variant.id, review: variant.review }))
    : (capture?.variants ?? []);
  const recommendedId = (live.length > 0 ? state.specBrief?.recommendedId : undefined)
    ?? capture?.recommendedId
    ?? state.specBrief?.recommendedId
    ?? null;
  const judged = visual ?? UNJUDGED;

  const parsed = state.currentCode ? parseParams(state.currentCode) : [];
  const paramCount = parsed.filter((p) => typeof p.value === 'number').length;
  const deadParams = violations.filter((v) => v.kind === 'dead_parameter').length;
  const classes = state.currentCode ? classifyParams(state.currentCode) : null;
  const eligible = classes?.eligible.map((p) => p.name) ?? [];
  const deadNames = violations.filter((v) => v.kind === 'dead_parameter').map((v) => String(v.field)).filter((n) => eligible.includes(n));
  const kernel = state.kernel === 'brep' ? 'brep' : 'openscad';
  const lastAttempt = state.attemptHistory?.[state.attemptHistory.length - 1];
  const brepFields = kernel === 'brep'
    ? { brepOk: lastAttempt ? lastAttempt.exitCode === 0 : false }
    : {};

  return {
    id,
    model,
    pipeline: state.pipeline ?? null,
    specOk: !!state.assemblySpec,
    composed: report?.composed ?? false,
    compileOk: !!state.validation?.valid,
    floorOk: hasModel ? !has('floor') : null,
    floatingCount: report?.composed ? errors.filter((v) => v.kind === 'floating').length : null,
    localFrameOk: measured.length ? measured.every((c) => isZeroVec(c.localMin)) : null,
    extentsOk: specHasExtents && measured.length ? !has('extents') : null,
    shellsOk: hasModel ? !has('shells') : null,
    errorKinds: [...new Set(errors.map((v) => v.kind))],
    attempts: state.attemptCount ?? 0,
    wallMs,
    paramCount,
    deadParams,
    buildFallbacks: state.buildFallbacks ?? 0,
    ...variantStats(variants, recommendedId),
    visualMatch: judged.visualMatch,
    visualFindings: judged.visualFindings,
    kernel,
    ...brepFields,
    fixedParams: classes?.fixed ?? [],
    guideParams: classes?.guide ?? [],
    ...(kernel === 'openscad'
      ? { eligibleParams: eligible.length, deadParamNames: deadNames, liveParams: eligible.length - deadNames.length }
      : {}),
  };
}

/** Whether the geometry kernel produced a model on the last run. */
export function geometryOk(m: GenerationMetrics): boolean {
  return m.kernel === 'brep' ? m.brepOk === true : m.compileOk;
}

/** Live share over the eligible parameters; null when there are none to judge. */
function liveShare(m: GenerationMetrics): number | null {
  const denominator = m.eligibleParams ?? m.paramCount;
  if (!denominator) return null;
  return (m.liveParams ?? 0) / denominator;
}

/**
 * The single number both kernels are compared on: the spec parsed, the geometry
 * ran, the model passes extents, floor and floating, a B-rep also has a STEP
 * that re-imports, and at least 80% of the parameters change the model.
 */
export function isWorkable(m: GenerationMetrics): boolean {
  const share = liveShare(m);
  return m.specOk
    && geometryOk(m)
    && m.extentsOk !== false
    && m.floorOk !== false
    && (m.floatingCount ?? 0) === 0
    && (m.kernel !== 'brep' || m.stepOk === true)
    && (share === null || share >= LIVE_PARAM_SHARE);
}

const clip = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The first stage that failed, in pipeline order, with a short reason. */
export function failureOf(m: GenerationMetrics, firstError?: string): { failureStage: FailureStage; failureDetail?: string } {
  if (!m.specOk) return { failureStage: 'spec', failureDetail: 'no assembly spec was produced' };
  if (!geometryOk(m)) {
    return { failureStage: 'geometry', failureDetail: clip(firstError || (m.kernel === 'brep' ? 'the last build123d run failed' : 'the OpenSCAD compile failed')) };
  }
  const bad: string[] = [];
  if (m.extentsOk === false) bad.push('extents');
  if (m.floorOk === false) bad.push('floor');
  if ((m.floatingCount ?? 0) > 0) bad.push(`floating x${m.floatingCount}`);
  if (bad.length) return { failureStage: 'validation', failureDetail: bad.join(', ') };
  if (m.kernel === 'brep' && m.stepOk !== true) {
    return { failureStage: 'step', failureDetail: clip(firstError || 'STEP missing or did not re-import as a valid solid') };
  }
  const share = liveShare(m);
  if (share !== null && share < LIVE_PARAM_SHARE) {
    return { failureStage: 'params', failureDetail: `${m.liveParams ?? 0}/${m.eligibleParams ?? m.paramCount} parameters change the model${m.deadParamNames?.length ? ` (dead: ${m.deadParamNames.join(', ')})` : ''}` };
  }
  return { failureStage: 'none' };
}

/** Fills `workable`, `failureStage` and `failureDetail`. Call once every other field is set. */
export function withVerdict(m: GenerationMetrics, firstError?: string): GenerationMetrics {
  const failure = failureOf(m, firstError);
  return {
    ...m,
    workable: isWorkable(m),
    failureStage: failure.failureStage,
    failureDetail: failure.failureDetail,
  };
}

/**
 * A different, in-range value for a perturbation run: value + step, else
 * value - step, else the midpoint of the range. A parameter without a range
 * steps by 10% of its value (1 when it is 0). Null when no different value fits.
 */
export function perturbedValue(p: { value: number; min?: number; max?: number; step?: number }): number | null {
  const { value, min, max } = p;
  const step = p.step && p.step > 0 ? p.step : (value !== 0 ? Math.abs(value) * 0.1 : 1);
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const inRange = (n: number) => (min === undefined || n >= min) && (max === undefined || n <= max);
  const up = round(value + step);
  if (inRange(up)) return up;
  const down = round(value - step);
  if (inRange(down)) return down;
  if (min !== undefined && max !== undefined) {
    const mid = round((min + max) / 2);
    if (mid !== value) return mid;
  }
  return null;
}

function rate(rows: GenerationMetrics[], pick: (m: GenerationMetrics) => boolean | null): string {
  const vals = rows.map(pick).filter((v): v is boolean => v !== null);
  return `${vals.filter(Boolean).length}/${vals.length}`;
}

function meanOf(rows: GenerationMetrics[], pick: (m: GenerationMetrics) => number | null | undefined): string {
  const vals = rows.map(pick).filter((value): value is number => value !== null && value !== undefined);
  if (vals.length === 0) return '0.0';
  const mean = vals.reduce((sum, value) => sum + value, 0) / vals.length;
  return (Math.round(mean * 10) / 10).toFixed(1);
}

export function summarize(rows: GenerationMetrics[]): Record<string, string> {
  const sumParams = rows.reduce((sum, m) => sum + (m.paramCount ?? 0), 0);
  const sumDead = rows.reduce((sum, m) => sum + (m.deadParams ?? 0), 0);
  const liveRate = sumParams === 0 ? 1 : 1 - sumDead / sumParams;

  return {
    n: String(rows.length),
    specOk: rate(rows, (m) => m.specOk),
    composed: rate(rows, (m) => m.composed),
    compileOk: rate(rows, (m) => m.compileOk),
    floorOk: rate(rows, (m) => m.floorOk),
    noFloating: rate(rows, (m) => (m.floatingCount === null ? null : m.floatingCount === 0)),
    localFrameOk: rate(rows, (m) => m.localFrameOk),
    extentsOk: rate(rows, (m) => m.extentsOk),
    shellsOk: rate(rows, (m) => m.shellsOk),
    meanVariantCount: meanOf(rows, (m) => m.variantCount),
    meanVariantsValidated: meanOf(rows, (m) => m.variantsValidated),
    meanReviewRounds: meanOf(rows, (m) => m.reviewRounds),
    chosenValidated: rate(rows, (m) => m.chosenValidated),
    visualMatch: rate(rows, (m) => m.visualMatch),
    meanVisualFindings: meanOf(rows, (m) => m.visualFindings),
    meanWallMs: meanOf(rows, (m) => m.wallMs),
    meanParamCount: meanOf(rows, (m) => m.paramCount),
    meanDeadParams: meanOf(rows, (m) => m.deadParams),
    meanBuildFallbacks: meanOf(rows, (m) => m.buildFallbacks),
    liveParamRate: liveRate.toFixed(2),
  };
}

export function scoresFor(m: GenerationMetrics): Array<{ name: string; value: number; dataType: 'BOOLEAN' | 'NUMERIC' }> {
  const out: Array<{ name: string; value: number; dataType: 'BOOLEAN' | 'NUMERIC' }> = [];
  const bool = (name: string, v: boolean | null) => {
    if (v !== null) out.push({ name, value: v ? 1 : 0, dataType: 'BOOLEAN' });
  };
  bool('spec_ok', m.specOk);
  bool('composed', m.composed);
  bool('compile_ok', m.compileOk);
  bool('floor_ok', m.floorOk);
  if (m.floatingCount !== null) out.push({ name: 'floating_count', value: m.floatingCount, dataType: 'NUMERIC' });
  bool('local_frame_ok', m.localFrameOk);
  bool('extents_ok', m.extentsOk);
  bool('shells_ok', m.shellsOk);
  out.push({ name: 'variant_count', value: m.variantCount, dataType: 'NUMERIC' });
  out.push({ name: 'variants_validated', value: m.variantsValidated, dataType: 'NUMERIC' });
  out.push({ name: 'review_rounds', value: m.reviewRounds, dataType: 'NUMERIC' });
  bool('chosen_validated', m.chosenValidated);
  bool('workable', m.workable ?? null);
  bool('step_ok', m.stepOk ?? null);
  bool('visual_match', m.visualMatch);
  if (m.visualFindings !== null) out.push({ name: 'visual_findings', value: m.visualFindings, dataType: 'NUMERIC' });
  out.push({ name: 'wall_ms', value: m.wallMs, dataType: 'NUMERIC' });
  return out;
}
