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
  /** Research produced a brief this run (false on any skip reason). */
  researchRan: boolean;
  /** Whether the approach the Architect was bound to had a real source; null when research did not run. */
  citedApproachChosen: boolean | null;
  wallMs: number;
}

export function metricsFromState(
  id: string,
  model: string,
  state: Partial<AgentStateType>,
  wallMs: number
): GenerationMetrics {
  const violations = state.specViolations ?? [];
  const errors = violations.filter((v) => v.severity === 'error');
  const has = (kind: string) => errors.some((v) => v.kind === kind);
  const report = state.placementReport ?? null;
  const measured = report?.components.filter((c) => c.measured) ?? [];
  const hasModel = !!state.modelInfo;
  const specHasExtents = !!state.assemblySpec?.components?.some((c) => (c as { localExtents?: unknown }).localExtents);

  const researchRan = !state.researchSkipReason && !!state.designBrief;
  const chosen = state.designContract?.researchApproach;

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
    researchRan,
    citedApproachChosen: researchRan && chosen ? chosen.approach.grounding === 'cited' : null,
    wallMs,
  };
}

function rate(rows: GenerationMetrics[], pick: (m: GenerationMetrics) => boolean | null): string {
  const vals = rows.map(pick).filter((v): v is boolean => v !== null);
  return `${vals.filter(Boolean).length}/${vals.length}`;
}

export function summarize(rows: GenerationMetrics[]): Record<string, string> {
  const mean = rows.length ? Math.round(rows.reduce((a, m) => a + m.wallMs, 0) / rows.length) : 0;
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
    researchRan: rate(rows, (m) => m.researchRan),
    citedApproachChosen: rate(rows, (m) => m.citedApproachChosen),
    meanWallMs: String(mean),
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
  bool('research_ran', m.researchRan);
  bool('cited_approach_chosen', m.citedApproachChosen);
  out.push({ name: 'wall_ms', value: m.wallMs, dataType: 'NUMERIC' });
  return out;
}
