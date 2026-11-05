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

/**
 * The REQUIRED CHANGES block that opens a revision request: reviewer majors,
 * then minors, then the user's own lines, then the rules for applying them.
 *
 * Human lines are mandatory and outrank everything else. Before this, only
 * majors were said to outrank "variant A follows the request literally", and a
 * live revise whose answer said "Front lip (variant B)" was revised on variant
 * A with the note "NOT applied in variant A".
 */
export function requiredChanges(findings: { severity: string; issue: string }[], notes: string[]): string {
  const required = [
    ...findings.filter((f) => f.severity === 'major').map((f) => `[MAJOR] ${f.issue}`),
    ...findings.filter((f) => f.severity !== 'major').map((f) => `[MINOR] ${f.issue}`),
    ...notes.map((n) => `[HUMAN] ${n}`),
  ];
  return `REQUIRED CHANGES:\n${required.length ? required.join('\n') : '(none listed)'}\n\n` +
    'Every [HUMAN] line is the user\'s instruction for THIS variant: apply it, even when it names another variant or asks for structure the request did not name. ' +
    'Human lines OUTRANK the reviewer\'s findings, "variant A follows the request literally" and the SCOPE rule. ' +
    'Each major finding must be resolved by a concrete geometric change: add, remove, reshape or move components, or change a shape. ' +
    'For this revision, major findings OUTRANK "variant A follows the request literally" and the SCOPE rule. ' +
    'If resolving one needs structure the request did not name (for example a lip so the held object cannot slide off), add it and record each addition in assumptions[]. ' +
    'The sheet must start with a "## Changes in this revision" section that maps each finding to the change (component and field).';
}

/** The single variant the user named in a comment or answer ("variant B"), if it exists; null when none or several are named. */
export function variantNamedIn<Id extends string>(texts: string[], ids: Id[]): Id | null {
  const named = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\bvariant\s+([A-C])\b/gi)) named.add(m[1].toUpperCase());
  if (named.size !== 1) return null;
  const [id] = [...named];
  return (ids as string[]).includes(id) ? (id as Id) : null;
}
