import type { GateDecision, GatePayload, GateVariant } from '@/types';

/**
 * What the generation eval sends back to a paused gate.
 *
 * A spec gate approves a validated variant (the recommended one when it
 * validated, otherwise the first that did). With none validated it revises
 * the recommended variant once, then approves it and flags the approval.
 * An accept gate is approved.
 */
export function evalGateDecision(
  payload: GatePayload,
  revisionsUsed: number,
): { decision: GateDecision; approvedUnvalidated: boolean } {
  if (payload.kind !== 'spec') {
    return { decision: { action: 'approve' }, approvedUnvalidated: false };
  }

  const variants = payload.variants ?? [];
  const validated = variants.filter((variant) => variant.review?.validated);
  if (validated.length > 0) {
    const chosen = validated.find((variant) => variant.id === payload.recommendedId) ?? validated[0];
    return {
      decision: { action: 'approve', chosenVariantId: chosen.id },
      approvedUnvalidated: false,
    };
  }

  const recommended = variants.find((variant) => variant.id === payload.recommendedId);
  const chosenVariantId = recommended?.id ?? payload.recommendedId;
  if (revisionsUsed < 1) {
    return {
      decision: { action: 'revise', chosenVariantId, comment: reviewerComment(recommended) },
      approvedUnvalidated: false,
    };
  }

  return {
    decision: { action: 'approve', chosenVariantId },
    approvedUnvalidated: true,
  };
}

/** Majors first, then everything else, in the order the reviewer wrote them. */
function reviewerComment(variant: GateVariant | undefined): string {
  const findings = variant?.review?.findings ?? [];
  const ordered = [
    ...findings.filter((finding) => finding.severity === 'major'),
    ...findings.filter((finding) => finding.severity !== 'major'),
  ];
  const listed = ordered.map((finding) => `[${finding.severity}] ${finding.issue}`).join('; ');
  return listed ? `Fix these reviewer findings: ${listed}` : 'Fix these reviewer findings.';
}
