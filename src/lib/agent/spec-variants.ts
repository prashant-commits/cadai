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
   * The SVG itself is never kept in state - each embeds four base64 PNGs and
   * the checkpointer rewrites all of state per step - it is re-rendered on demand.
   */
  drawnVersion: number | null;
  review: VariantReview | null;
  retries: number;
  needsRevision: boolean;
  error?: string;
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

