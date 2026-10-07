import type { AgentStateType } from '@/lib/agent/graph';
import { isZeroVec } from '@/lib/design/placement-geometry';

export interface GenerationMetrics {
  id: string;
  model: string;
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
  /** Variants the architect planned on the last pass that still had them. */
  variantCount: number;
  /** How many of those variants have `review.validated`. */
  variantsValidated: number;
  /** Highest `review.attempts` across those variants. */
  reviewRounds: number;
  /** The recommended variant's `review.validated`, or null when it has no review. */
  chosenValidated: boolean | null;
  /** Null while the critic is off. True when no `kind: 'visual'` violation remains. */
  visualMatch: boolean | null;
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
  state: Partial<AgentStateType>,
  wallMs: number,
  capture?: SpecGateCapture | null,
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
  const criticOn = process.env.CADAI_VISUAL_CRITIC === 'on';

  return {
    id,
    model,
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
    ...variantStats(variants, recommendedId),
    visualMatch: criticOn ? !violations.some((v) => v.kind === 'visual') : null,
  };
}

function rate(rows: GenerationMetrics[], pick: (m: GenerationMetrics) => boolean | null): string {
  const vals = rows.map(pick).filter((v): v is boolean => v !== null);
  return `${vals.filter(Boolean).length}/${vals.length}`;
}

function meanOf(rows: GenerationMetrics[], pick: (m: GenerationMetrics) => number): string {
  if (rows.length === 0) return '0';
  return String(Math.round(rows.reduce((sum, row) => sum + pick(row), 0) / rows.length));
}

export function summarize(rows: GenerationMetrics[]): Record<string, string> {
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
    meanWallMs: meanOf(rows, (m) => m.wallMs),
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
  bool('visual_match', m.visualMatch);
  out.push({ name: 'wall_ms', value: m.wallMs, dataType: 'NUMERIC' });
  return out;
}
