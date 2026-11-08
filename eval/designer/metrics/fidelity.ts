/**
 * Fidelity metrics for the designer evals: did each follow-up land, were earlier
 * features kept, and did the edit leave everything else alone.
 *
 * All checks read measured facts (DesignerFacts) and scripts; no model calls.
 * Steps map to follow-ups as: steps[0] is the initial request, steps[i] answers
 * followUps[i - 1].
 */
import { findPoseParams } from '../../../src/lib/agent/designer/tools';
import type { DesignerFacts } from '../../../src/lib/agent/designer/types';
import type { EvalPrompt, FeatureProbe, FollowUp, MetricRow, RunRecord, StepRecord } from '../types';

export const DEFAULT_TOLERANCE_MM = 2;
/** Absolute tolerance on a before→after ratio probe (1.3 matches 1.25..1.35). */
export const RATIO_TOLERANCE = 0.05;
/** A named dimension counts as unchanged when it moved by no more than this (mm). */
export const UNCHANGED_EPS = 0.05;

export interface StepScripts {
  before: string;
  after: string;
}

const usable = (f: DesignerFacts | null | undefined): f is DesignerFacts => !!f && f.ok;

function labelRegex(src: string | undefined): RegExp | null {
  if (!src) return null;
  try {
    return new RegExp(src, 'i');
  } catch {
    return null;
  }
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

/**
 * Does a change of `delta` mm (before → after) match the probe?
 * Strict (a fresh landing): the delta is within tolerance of `deltaMm`, or the
 * ratio is within RATIO_TOLERANCE of `ratio`. With neither set, any change counts.
 * Cumulative (still holds later): one-sided, so a later edit that moves the
 * same dimension further in the same direction does not count as a loss.
 */
function changeMatches(probe: FeatureProbe, before: number, after: number, cumulative: boolean): boolean {
  const tol = probe.tolerance ?? DEFAULT_TOLERANCE_MM;
  const delta = after - before;
  if (typeof probe.deltaMm === 'number') {
    if (!cumulative) return Math.abs(delta - probe.deltaMm) <= tol;
    return probe.deltaMm >= 0 ? delta >= probe.deltaMm - tol : delta <= probe.deltaMm + tol;
  }
  if (typeof probe.ratio === 'number') {
    if (before === 0) return false;
    const r = after / before;
    if (!cumulative) return Math.abs(r - probe.ratio) <= RATIO_TOLERANCE;
    return probe.ratio >= 1 ? r >= probe.ratio - RATIO_TOLERANCE : r <= probe.ratio + RATIO_TOLERANCE;
  }
  return Math.abs(delta) > UNCHANGED_EPS;
}

function poseNames(facts: DesignerFacts, script: string): Set<string> {
  const names = new Set(findPoseParams(script).map((p) => p.name));
  for (const d of facts.dimensions) if (/_(deg|travel)$/.test(d.name)) names.add(d.name);
  return names;
}

function evaluate(
  probe: FeatureProbe,
  before: DesignerFacts | null,
  after: DesignerFacts | null,
  scripts: StepScripts,
  cumulative: boolean,
): boolean | 'reviewer' {
  if (probe.kind === 'reviewer') return 'reviewer';
  if (!usable(after)) return false;

  switch (probe.kind) {
    case 'newPart': {
      const re = labelRegex(probe.label);
      if (!re) return false;
      const afterCount = after.parts.filter((p) => re.test(p.label)).length;
      // A later step may rename nothing, so "present now" is the whole cumulative test.
      if (cumulative || !usable(before)) return afterCount > 0;
      return afterCount > before.parts.filter((p) => re.test(p.label)).length;
    }
    case 'partCountUp': {
      if (!usable(before)) return false;
      return after.parts.length - before.parts.length >= (probe.min ?? 1);
    }
    case 'dimensionChange': {
      const re = labelRegex(probe.dimension);
      if (!re || !usable(before)) return false;
      for (const a of after.dimensions) {
        if (!re.test(a.name)) continue;
        const b = before.dimensions.find((d) => d.name === a.name);
        if (b && changeMatches(probe, b.value, a.value, cumulative)) return true;
      }
      return false;
    }
    case 'spanChange': {
      if (!probe.axis || !usable(before) || !before.span || !after.span) return false;
      const i = AXIS_INDEX[probe.axis];
      return changeMatches(probe, before.span[i], after.span[i], cumulative);
    }
    case 'moves': {
      const b = usable(before) ? poseNames(before, scripts.before).size : 0;
      const a = poseNames(after, scripts.after).size;
      // A new pose parameter appeared; later it only has to still be there.
      return cumulative ? a > 0 && a >= b : a > b;
    }
    default:
      return false;
  }
}

/** Did the follow-up's feature land between `before` and `after`? 'reviewer' for probes only the reviewer can judge. */
export function probeLanded(
  probe: FeatureProbe,
  before: DesignerFacts | null,
  after: DesignerFacts | null,
  scripts: StepScripts,
): boolean | 'reviewer' {
  return evaluate(probe, before, after, scripts, false);
}

export interface KeptDetail {
  kept: number;
  total: number;
  /** Texts of the earlier follow-ups whose probe no longer holds in the final step. */
  lost: string[];
}

/** Cumulative check: every earlier follow-up's probe, re-run against the final step. */
export function earlierKeptDetail(steps: StepRecord[], followUps: FollowUp[]): KeptDetail | null {
  const last = steps.length - 1;
  // Follow-ups answered by steps 1..last-1 are "earlier"; the last step's own is measured by featureLanded.
  const final = steps[last];
  if (last < 2 || !final || !usable(final.facts)) return null;
  let kept = 0;
  let total = 0;
  const lost: string[] = [];
  for (let j = 1; j < last; j++) {
    const fu = followUps[j - 1];
    if (!fu || fu.probe.kind === 'reviewer') continue;
    const prev = steps[j - 1];
    const holds = evaluate(fu.probe, prev.facts, final.facts, { before: prev.script, after: final.script }, true);
    total++;
    if (holds === true) kept++;
    else lost.push(fu.text);
  }
  return total === 0 ? null : { kept, total, lost };
}

/** Share (0..1) of earlier geometric features still present in the final step; null when nothing to measure. */
export function earlierKept(steps: StepRecord[], followUps: FollowUp[]): number | null {
  const d = earlierKeptDetail(steps, followUps);
  return d ? d.kept / d.total : null;
}

// Words in a follow-up that point at a dimension without naming it.
const SYNONYMS: Array<[RegExp, string[]]> = [
  [/\b(tall|taller|higher|height|raise|lower|shorter)\b/, ['height', 'tall', 'high', 'h']],
  [/\b(wide|wider|narrower|width)\b/, ['width', 'wide', 'w']],
  [/\b(long|longer|length)\b/, ['length', 'long', 'len']],
  [/\b(deep|deeper|depth)\b/, ['depth', 'deep', 'd']],
  [/\b(thick|thicker|thin|thinner|thickness)\b/, ['thick', 'thickness', 'wall', 't']],
  [/\b(round|rounder|rounded|fillet|corner|corners|radius|edges?)\b/, ['radius', 'fillet', 'round', 'corner', 'r']],
];
const STOP_TOKENS = new Set(['mm', 'size', 'dim', 'total', 'overall', 'out', 'the', 'of', 'and']);

function tokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t) && !/^\d+$/.test(t));
}

/** Is the named dimension referred to by the follow-up (by name, probe target, or a synonym)? */
function mentioned(name: string, followUp: FollowUp): boolean {
  const text = followUp.text.toLowerCase();
  const re = labelRegex(followUp.probe.dimension);
  if (re && re.test(name)) return true;
  const toks = tokens(name);
  if (toks.some((t) => text.includes(t))) return true;
  const nameLower = name.toLowerCase();
  for (const [pattern, aliases] of SYNONYMS) {
    if (!pattern.test(text)) continue;
    if (aliases.some((a) => (a.length <= 2 ? toks.includes(a) || nameLower === a || nameLower.endsWith(`_${a}`) : nameLower.includes(a)))) return true;
  }
  if (followUp.probe.axis) {
    const axisWords = { x: ['width', 'length'], y: ['depth', 'length'], z: ['height'] }[followUp.probe.axis];
    if (axisWords.some((w) => nameLower.includes(w))) return true;
  }
  return false;
}

/**
 * Share (0..1) of the named dimensions the follow-up did not mention that are
 * unchanged after the edit. Null when no such dimension exists or a side has no usable facts.
 */
export function locality(before: DesignerFacts | null, after: DesignerFacts | null, followUp: FollowUp): number | null {
  if (!usable(before) || !usable(after)) return null;
  const untouched = before.dimensions.filter((d) => !mentioned(d.name, followUp));
  if (untouched.length === 0) return null;
  let same = 0;
  for (const d of untouched) {
    const now = after.dimensions.find((x) => x.name === d.name);
    if (now && Math.abs(now.value - d.value) <= UNCHANGED_EPS) same++;
  }
  return same / untouched.length;
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** featureLanded, earlierKept and locality for one run. All null for a prompt without follow-ups. */
export function fidelityMetrics(
  record: RunRecord,
  prompt: EvalPrompt,
): Pick<MetricRow, 'featureLanded' | 'earlierKept' | 'locality'> {
  const followUps = prompt.followUps ?? [];
  if (followUps.length === 0) return { featureLanded: null, earlierKept: null, locality: null };

  let geometric = 0;
  let landed = 0;
  const localities: number[] = [];
  followUps.forEach((fu, i) => {
    const step = record.steps[i + 1];
    const prev = record.steps[i];
    if (fu.probe.kind !== 'reviewer') {
      geometric++;
      // A step the run never reached, or one that failed, did not land its feature.
      if (step && prev && !step.failed) {
        const r = probeLanded(fu.probe, prev.facts, step.facts, { before: prev.script, after: step.script });
        if (r === true) landed++;
      }
    }
    if (step && prev && !step.failed) {
      const loc = locality(prev.facts, step.facts, fu);
      if (loc !== null) localities.push(loc);
    }
  });

  return {
    featureLanded: geometric === 0 ? null : landed / geometric,
    earlierKept: earlierKept(record.steps, followUps),
    locality: mean(localities),
  };
}
