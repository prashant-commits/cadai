import type { GateVariant } from '@/types';
import { AssemblySpec } from './assembly-spec';

export type VariantId = 'A' | 'B' | 'C';

export interface ReviewFinding {
  issue: string;
  severity: 'minor' | 'major';
}

export interface VariantReview {
  validated: boolean;
  findings: ReviewFinding[];
  attempts: number;
  note?: string;
}

export interface SpecVariant {
  id: VariantId;
  name: string;
  idea: string;
  spec: AssemblySpec | null;
  version: number;
  /**
   * Version of `spec` the concept sheet was last drawn for (null = not drawn).
   * The SVG is not kept in graph state - each embeds four base64 PNGs and the
   * checkpointer rewrites all of state per step - it is re-rendered on demand.
   * (One copy per open gate still lives in that gate's interrupt payload, so it
   * is stored there until the run is resumed, cancelled or expires.)
   */
  drawnVersion: number | null;
  review: VariantReview | null;
  retries: number;
  needsRevision: boolean;
  error?: string;
  /**
   * Shape / coherence / ground errors the spec still carried when the architect
   * accepted it on its LAST attempt. Never dropped: the reviewer folds them into
   * the review as major findings and the gate shows them.
   */
  specErrors?: ReviewFinding[];
  /** Set by generateVariantSpec when every revision attempt reproduced the previous skeleton. */
  revisionUnchanged?: boolean;
  /** Major findings of the previous review round, for the no-progress stop. */
  previousMajors?: string[];
  /** Consecutive major rounds that did not improve (not fewer majors than the round before). */
  stagnantRounds?: number;
  /** The review the variant had before a gate revise cleared it; restored if the revision fails. */
  previousReview?: VariantReview | null;
}

export interface SpecBrief {
  markdown: string;
  assumptions: AssemblySpec['assumptions'];
  openQuestions: AssemblySpec['openQuestions'];
  recommendedId: VariantId;
}

/** The chosen variant's spec with the brief's shared assumptions/openQuestions merged in (shared first, then the variant's own assumptions). */
export function mergeBriefIntoSpec(spec: AssemblySpec, brief: SpecBrief | null): AssemblySpec {
  if (!brief) return spec;
  return {
    ...spec,
    assumptions: [...(brief.assumptions || []), ...(spec.assumptions || [])],
    openQuestions: [...(brief.openQuestions || []), ...(spec.openQuestions || [])]
  };
}

export function recommendedVariant(variants: SpecVariant[], brief: SpecBrief | null): SpecVariant | null {
  if (variants.length === 0) return null;
  if (brief) {
    const rec = variants.find(v => v.id === brief.recommendedId && v.spec !== null);
    if (rec) return rec;
  }
  return variants.find(v => v.spec !== null) || null;
}

/**
 * What makes two skeletons the same design: component names, shape kinds,
 * localExtents, positions, rotations and profile point counts, numbers rounded
 * to 0.5 mm and 1 degree. Guides, sheet text, assumptions and everything else
 * are excluded. Used to detect a "revision" that changed nothing.
 */
export function skeletonSignature(spec: AssemblySpec | null | undefined): string {
  const r = (n: number, step: number) => Math.round(n / step) * step;
  const pad = (v: number[] | undefined) => [v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0]; // unset position/rotation is the zero vector
  const mm = (v: number[] | undefined) => pad(v).map((n) => r(n, 0.5)); // 0.5 mm: below this a change is rounding noise
  const deg = (v: number[] | undefined) => pad(v).map((n) => r(n, 1)); // 1 degree
  const components = [...(spec?.components ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => [
      c.name,
      c.shape?.kind ?? 'box',
      mm(c.localExtents),
      mm(c.position),
      deg(c.rotation),
      (c.shape as { points?: unknown[] } | undefined)?.points?.length ?? 0,
    ]);
  return JSON.stringify(components);
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'of', 'in', 'on', 'at', 'to', 'for',
  'and', 'or', 'but', 'not', 'no', 'too', 'very', 'by', 'with', 'as', 'that', 'this', 'which', 'while', 'than',
  'should', 'must', 'does', 'do', 'has', 'have', 'there', 'from', 'so', 'then',
]);

const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
const isNumber = (w: string) => /^[0-9]+$/.test(w);

/** Word-set Jaccard similarity of two findings with stopwords dropped, 0..1. */
export function findingSimilarity(a: string, b: string): number {
  const wa = new Set(tokens(a).filter((w) => !STOPWORDS.has(w)));
  const wb = new Set(tokens(b).filter((w) => !STOPWORDS.has(w)));
  if (wa.size === 0 && wb.size === 0) return 1;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** The components a finding talks about: every name that appears in it as whole words (underscores read as spaces). */
function partsMentioned(text: string, partNames: string[]): string {
  const padded = ` ${tokens(text).join(' ')} `;
  return partNames
    .filter((n) => padded.includes(` ${tokens(n).join(' ')} `))
    .sort()
    .join('|');
}

const numbersIn = (text: string): string => tokens(text).filter(isNumber).sort().join(',');

/**
 * Whether `current` is the same finding as one the previous round made. Needs
 * ALL of: the same component(s) named (when names are known), the same numbers
 * quoted (an angle that moved from 30 to 60 degrees is progress, not a repeat),
 * and a stopword-free word-set Jaccard >= 0.6.
 */
export function repeatsPrevious(previous: string[], current: string[], partNames: string[] = []): boolean {
  return current.some((c) =>
    previous.some(
      (p) =>
        partsMentioned(p, partNames) === partsMentioned(c, partNames) &&
        numbersIn(p) === numbersIn(c) &&
        findingSimilarity(p, c) >= 0.6 // 0.6: more than half the meaningful words, so one differing part word is not a repeat
    )
  );
}

/** CADAI_MAX_VARIANTS, validated: non-numeric or < 1 -> 3, clamped to 1..3. */
export function maxVariantsFromEnv(raw: string | undefined): number {
  const n = Math.floor(Number(raw ?? 3)); // 3: A/B/C is the most variants the gate offers
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(n, 3);
}

const VARIANT_IDS: VariantId[] = ['A', 'B', 'C'];

export function processPlannerVariants(
  variants: { id: VariantId; name: string; idea: string }[],
  recommendedId: VariantId,
  maxLimit: number = 3
): {
  variants: { id: VariantId; name: string; idea: string }[];
  recommendedId: VariantId;
} {
  const limit = Number.isFinite(maxLimit) && maxLimit >= 1 ? Math.min(Math.floor(maxLimit), 3) : 3; // 3 = A/B/C
  // Ids the planner used once keep their letter; only a repeat is re-lettered, and
  // never to a letter another variant already claims.
  const claimed = new Set<VariantId>(variants.map((v) => v.id));
  const seen = new Set<VariantId>();
  const relettered: { id: VariantId; name: string; idea: string }[] = [];
  for (const v of variants) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      relettered.push(v);
      continue;
    }
    // A repeated id is re-lettered to a free letter rather than dropped, so a
    // planner that numbered its variants badly still keeps every idea it had.
    const id = VARIANT_IDS.find((c) => !claimed.has(c));
    if (!id) continue;
    claimed.add(id);
    seen.add(id);
    relettered.push({ ...v, id });
  }
  const deduped = relettered.slice(0, limit);
  const resolvedRecId = deduped.some((v) => v.id === recommendedId)
    ? recommendedId
    : (deduped[0]?.id ?? 'A');
  return { variants: deduped, recommendedId: resolvedRecId };
}

export function gateVariants(payload: {
  variants?: GateVariant[];
  spec?: AssemblySpec | null;
}): GateVariant[] {
  if (payload.variants && payload.variants.length > 0) {
    return payload.variants;
  }
  if (payload.spec) {
    return [
      {
        id: 'A',
        name: payload.spec.assemblyName,
        idea: '',
        spec: payload.spec,
        sheetSvg: null,
        review: null,
      },
    ];
  }
  return payload.variants ?? [];
}

