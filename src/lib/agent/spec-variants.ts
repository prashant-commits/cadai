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
  sheetSvg: string | null;
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

export function processPlannerVariants(
  variants: { id: VariantId; name: string; idea: string }[],
  recommendedId: VariantId,
  maxLimit: number = 3
): {
  variants: { id: VariantId; name: string; idea: string }[];
  recommendedId: VariantId;
} {
  const maxVariants = Math.min(variants.length, maxLimit);
  const plannedVariants = variants.slice(0, maxVariants);
  const seen = new Set<string>();
  const deduped: { id: VariantId; name: string; idea: string }[] = [];
  for (const v of plannedVariants) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      deduped.push(v);
    }
  }
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

