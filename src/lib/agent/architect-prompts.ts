import type { SpecBrief, VariantId } from './spec-variants';

/**
 * The text of a fresh (non-revision) variant spec request.
 *
 * Shared by architectNode and eval/architect so the eval scores the prompt the
 * graph actually sends, not a copy that drifts.
 */

export interface PlannedVariant {
  id: VariantId;
  name: string;
  idea: string;
}

/** Planner brief, shared assumptions, open questions and sibling variants, in that order. */
export function variantPlanContext(variant: PlannedVariant, allVariants: PlannedVariant[], brief: SpecBrief): string[] {
  const parts: string[] = [];
  if (brief.markdown) {
    parts.push(`Planner Brief:\n${brief.markdown}`);
  }
  if (brief.assumptions && brief.assumptions.length > 0) {
    const assumptionsText = brief.assumptions
      .map((a) => `- ${a.field}: ${a.value} (${a.rationale})`)
      .join('\n');
    parts.push(`Shared Assumptions:\n${assumptionsText}`);
  }
  if (brief.openQuestions && brief.openQuestions.length > 0) {
    const questionsText = brief.openQuestions
      .map((q) => `- ${q.question}${q.suggestedAnswer ? ` (suggested: ${q.suggestedAnswer})` : ''}`)
      .join('\n');
    parts.push(`The user will be asked:\n${questionsText}`);
  }
  const otherVariants = allVariants.filter((v) => v.id !== variant.id);
  if (otherVariants.length > 0) {
    const othersText = otherVariants
      .map((o) => `- Variant ${o.id}: ${o.name} - ${o.idea}`)
      .join('\n');
    parts.push(
      `Other variants planned (this variant must stay structurally distinct):\n${othersText}`
    );
  }
  return parts;
}

/** The final user message of a fresh variant spec request. */
export function freshVariantPrompt(
  variant: PlannedVariant,
  allVariants: PlannedVariant[],
  brief: SpecBrief,
  notes?: string[]
): string {
  return [
    ...variantPlanContext(variant, allVariants, brief),
    `Generate the Assembly Spec for Variant ${variant.id}: ${variant.name} - ${variant.idea}`,
    notes?.length ? `Human notes:\n${notes.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
