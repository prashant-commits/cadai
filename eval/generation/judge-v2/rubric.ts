import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getChatModel } from '@/lib/agent/model-provider';
import { structuredFor } from '@/lib/agent/llm-schemas';
import { UsageHandler } from '../usage';
import { RUBRIC_SYSTEM_PROMPT } from './rubric-prompt';
import type { EvidencePack } from './evidence';
import type { RequirementsChecklist } from './requirements';

export const CriterionScoreSchema = z.object({
  score: z.number().min(0).max(5).describe('Score from 0 to 5, an integer.'),
  justification: z.string().describe('One-line concise justification for this score.'),
});

export const RequirementVerdictSchema = z.object({
  id: z.string().describe('The requirement id from the checklist.'),
  status: z.enum(['met', 'partly', 'unmet', 'unverifiable']),
  evidence: z.string().describe('One-line factual evidence supporting the status.'),
});

export const FindingSchema = z.object({
  issue: z.string().describe('A concise statement of the problem or defect.'),
  severity: z.enum(['minor', 'major']),
  criterion: z.string().optional(),
});

export const RubricVerdictSchema = z.object({
  requirements: z.array(RequirementVerdictSchema),
  criteria: z.object({
    requirementsCoverage: CriterionScoreSchema.describe('Weight 25. Completeness of requested requirements.'),
    layoutAndClearances: CriterionScoreSchema.describe('Weight 12. Spatial arrangement and lack of collisions.'),
    functionAndMotion: CriterionScoreSchema.describe('Weight 18. Mechanism operation, kinematics, and device fit.'),
    accessibility: CriterionScoreSchema.describe('Weight 8. Fastener access and operational reach.'),
    manufacturabilityAndRobustness: CriterionScoreSchema.describe('Weight 12. Stability margin and structural rigidity.'),
    parametricQuality: CriterionScoreSchema.describe('Weight 10. Meaningful parameters and safe ranges.'),
    formAndAesthetics: CriterionScoreSchema.describe('Weight 15. Visual cohesion, proportion, consistent design language, purposeful shaping.'),
  }),
  findings: z.array(FindingSchema),
  summary: z.string().describe('2-3 sentence overall engineering review summary.'),
});

export type RubricVerdict = z.infer<typeof RubricVerdictSchema>;

export interface CoverageStats {
  met: number;
  partly: number;
  unmet: number;
  unverifiable: number;
  total: number;
  percent: number;
}

export interface RubricJudgeResult {
  verdict: RubricVerdict;
  overallScore: number;
  coverage: CoverageStats;
  costUsd: number | null;
}

export interface JudgeRubricInput {
  request: string;
  checklist: RequirementsChecklist;
  evidence: EvidencePack;
  notes?: string;
  model?: string;
}

/**
 * Computes overall 0-100 score as weighted sum:
 * coverage: 25, layout: 12, function: 18, access: 8, manufacturing: 12, parametric: 10, form: 15
 */
export function computeOverallScore(criteria: RubricVerdict['criteria']): number {
  const clamp5 = (n: number) => Math.max(0, Math.min(5, Math.round(n)));
  const cov = (clamp5(criteria.requirementsCoverage.score) / 5) * 25;
  const lay = (clamp5(criteria.layoutAndClearances.score) / 5) * 12;
  const fnm = (clamp5(criteria.functionAndMotion.score) / 5) * 18;
  const acc = (clamp5(criteria.accessibility.score) / 5) * 8;
  const man = (clamp5(criteria.manufacturabilityAndRobustness.score) / 5) * 12;
  const par = (clamp5(criteria.parametricQuality.score) / 5) * 10;
  const form = (clamp5(criteria.formAndAesthetics.score) / 5) * 15;
  return Math.round(cov + lay + fnm + acc + man + par + form);
}

export function computeCoverageStats(requirements: RubricVerdict['requirements']): CoverageStats {
  let met = 0;
  let partly = 0;
  let unmet = 0;
  let unverifiable = 0;

  for (const r of requirements) {
    if (r.status === 'met') met++;
    else if (r.status === 'partly') partly++;
    else if (r.status === 'unmet') unmet++;
    else if (r.status === 'unverifiable') unverifiable++;
  }

  const total = requirements.length;
  const effectiveMet = met + partly * 0.5;
  const percent = total > 0 ? Math.round((effectiveMet / total) * 100) : 0;
  return { met, partly, unmet, unverifiable, total, percent };
}

type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export function buildRubricUserContent(input: JudgeRubricInput): MessageContentPart[] {
  const parts: MessageContentPart[] = [];

  const textLines: string[] = [
    `# USER REQUEST\n"${input.request}"\n`,
  ];

  if (input.notes) {
    textLines.push(`# DESIGN NOTES FROM AUTHOR\n${input.notes}\n*(Judge their soundness against facts/renders; never trust claimed numbers as facts)*\n`);
  }

  textLines.push(`# REQUIREMENTS CHECKLIST`);
  for (const req of input.checklist.requirements) {
    textLines.push(`- [${req.id}] (${req.kind}): ${req.text}`);
  }
  textLines.push('');

  textLines.push(input.evidence.factsMarkdown);
  textLines.push('');

  if (input.evidence.legend.length > 0) {
    textLines.push('#### Part Colours Legend');
    for (const leg of input.evidence.legend) {
      textLines.push(`- **${leg.label}**: ${leg.hex} [R=${leg.color[0]}, G=${leg.color[1]}, B=${leg.color[2]}]`);
    }
    textLines.push('');
  }

  textLines.push('Please review the following visual renders alongside the facts table:');
  parts.push({ type: 'text', text: textLines.join('\n') });

  // Closed renders
  for (const view of input.evidence.closedViews) {
    parts.push({ type: 'text', text: `View [closed]: ${view.name}` });
    parts.push({ type: 'image_url', image_url: { url: view.dataUrl } });
  }

  // Lid-hidden renders
  if (input.evidence.lidHiddenViews.length > 0) {
    parts.push({ type: 'text', text: '--- INTERIOR INSPECTION (Lid/Door hidden) ---' });
    for (const view of input.evidence.lidHiddenViews) {
      parts.push({ type: 'text', text: `View [lid-hidden]: ${view.name}` });
      parts.push({ type: 'image_url', image_url: { url: view.dataUrl } });
    }
  }

  // Pose renders
  if (input.evidence.poseRenders.length > 0) {
    parts.push({ type: 'text', text: '--- MOTION & POSE INSPECTION ---' });
    for (const pose of input.evidence.poseRenders) {
      for (const view of pose.views) {
        parts.push({ type: 'text', text: `View [pose ${pose.name}]: ${view.name}` });
        parts.push({ type: 'image_url', image_url: { url: view.dataUrl } });
      }
    }
  }

  return parts;
}

export async function judgeRubric(input: JudgeRubricInput): Promise<RubricJudgeResult> {
  const modelSlug = input.model ?? process.env.CADAI_JUDGE_MODEL ?? 'claude-sonnet-5.5';
  const chatModel = getChatModel(modelSlug);
  const structured = structuredFor(chatModel, modelSlug, RubricVerdictSchema);

  const usage = new UsageHandler();
  const content = buildRubricUserContent(input);

  const raw = await structured.invoke(
    [
      new SystemMessage(RUBRIC_SYSTEM_PROMPT),
      new HumanMessage({ content: content as never }),
    ],
    { callbacks: [usage] }
  );

  const verdict = RubricVerdictSchema.parse(raw);
  const overallScore = computeOverallScore(verdict.criteria);
  const coverage = computeCoverageStats(verdict.requirements);
  const costUsd = usage.cost(modelSlug);

  return {
    verdict,
    overallScore,
    coverage,
    costUsd,
  };
}
