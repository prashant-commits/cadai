import type { GateDecision, GatePayload, GateVariant } from '@/types';

/**
 * What the generation eval sends back to a paused gate.
 *
 * A spec gate approves a validated variant (the recommended one when it
 * validated, otherwise the first that did). With none validated it revises
 * the recommended variant once, and only when that variant has a spec and a
 * review with at least one finding. Otherwise it approves the recommended id.
 * `approvedUnvalidated` is true only when that review exists and says
 * `validated: false`. An accept gate is approved.
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
  const findings = recommended?.review?.findings ?? [];
  if (recommended?.spec && findings.length >= 1 && revisionsUsed < 1) {
    return {
      decision: { action: 'revise', chosenVariantId, comment: reviewerComment(recommended) },
      approvedUnvalidated: false,
    };
  }

  return {
    decision: { action: 'approve', chosenVariantId },
    approvedUnvalidated: recommended?.review?.validated === false,
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
