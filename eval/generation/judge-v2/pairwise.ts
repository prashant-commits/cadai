import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getChatModel } from '@/lib/agent/model-provider';
import { structuredFor } from '@/lib/agent/llm-schemas';
import { UsageHandler } from '../usage';
import type { EvidencePack } from './evidence';
import type { RequirementsChecklist } from './requirements';

export const ChoiceSchema = z.enum(['first', 'second', 'tie']);
export type Choice = z.infer<typeof ChoiceSchema>;

export const SinglePairwiseVerdictSchema = z.object({
  winner: ChoiceSchema.describe('Overall winner between Design 1 and Design 2.'),
  criteria: z.object({
    requirementsCoverage: ChoiceSchema,
    layoutAndClearances: ChoiceSchema,
    functionAndMotion: ChoiceSchema,
    accessibility: ChoiceSchema,
    manufacturabilityAndRobustness: ChoiceSchema,
    parametricQuality: ChoiceSchema,
  }),
  reasons: z.object({
    requirementsCoverage: z.string(),
    layoutAndClearances: z.string(),
    functionAndMotion: z.string(),
    accessibility: z.string(),
    manufacturabilityAndRobustness: z.string(),
    parametricQuality: z.string(),
    overall: z.string(),
  }),
});

export type SinglePairwiseVerdict = z.infer<typeof SinglePairwiseVerdictSchema>;

export type PairWinner = 'A' | 'B' | 'tie';

export interface CriterionConsensus {
  winner: PairWinner;
  agreed: boolean;
  order1Winner: PairWinner;
  order2Winner: PairWinner;
}

export interface PairwiseComparisonResult {
  winner: PairWinner;
  agreed: boolean;
  criteria: {
    requirementsCoverage: CriterionConsensus;
    layoutAndClearances: CriterionConsensus;
    functionAndMotion: CriterionConsensus;
    accessibility: CriterionConsensus;
    manufacturabilityAndRobustness: CriterionConsensus;
    parametricQuality: CriterionConsensus;
  };
  order1: SinglePairwiseVerdict;
  order2: SinglePairwiseVerdict;
  costUsd: number | null;
}

export interface ComparePairInput {
  request: string;
  checklist: RequirementsChecklist;
  evA: EvidencePack;
  evB: EvidencePack;
  labelA?: string;
  labelB?: string;
  model?: string;
}

const PAIRWISE_SYSTEM_PROMPT = `You are a Senior Mechanical CAD Engineer and Product Auditor conducting a rigorous side-by-side evaluation of two candidate parametric CAD designs (Design 1 vs Design 2).

Both designs were generated for the same user request.
Evaluate which design is better overall and on each of the 6 core criteria:
1. requirementsCoverage: Which design implements more of the stated requirements and dimensions accurately?
2. layoutAndClearances: Which design has better spatial organization, avoids part interferences/clashes, and leaves sensible clearances?
3. functionAndMotion: Which design works better mechanically? (Kinematic clearance when hinges open, cable slot usability, device docking fit).
4. accessibility: Which design better ensures screws, cables, and storage items can be accessed without disassembly or collision?
5. manufacturabilityAndRobustness: Which design is more physically sound? (Check the stability margin against tipping: positive is stable, negative will tip over. Check wall thickness and print posture).
6. parametricQuality: Which design exposes cleaner, safer parameters whose ranges do not collide or break geometry?

RULES:
- Base facts on the provided Deterministic Facts Tables for each design (ground truth for dimensions, clashes, and stability).
- Sound engineering additions that prevent collisions or enable physical use (e.g. offsetting a hinge to swing clear) are superior to naive literal models that collide.
- Pick 'first' if Design 1 is distinctly better, 'second' if Design 2 is distinctly better, or 'tie' if both are approximately equal.
- Output structured JSON matching the schema.`;

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

function buildDesignPresentation(title: string, ev: EvidencePack): ContentPart[] {
  const parts: ContentPart[] = [];
  const textLines: string[] = [
    `=== ${title} ===`,
  ];
  if (ev.notes) {
    textLines.push(`Design Notes: ${ev.notes}\n`);
  }
  textLines.push(ev.factsMarkdown);
  if (ev.legend.length > 0) {
    textLines.push('Part Colours: ' + ev.legend.map((l) => `${l.label}=${l.hex}`).join(', '));
  }
  parts.push({ type: 'text', text: textLines.join('\n') });

  // Key closed renders (iso, front, right, top)
  for (const v of ev.closedViews.filter((v) => ['iso', 'front', 'right', 'top'].includes(v.name))) {
    parts.push({ type: 'text', text: `${title} [closed ${v.name} view]:` });
    parts.push({ type: 'image_url', image_url: { url: v.dataUrl } });
  }

  // Lid-hidden views
  if (ev.lidHiddenViews.length > 0) {
    for (const v of ev.lidHiddenViews) {
      parts.push({ type: 'text', text: `${title} [lid hidden ${v.name} view]:` });
      parts.push({ type: 'image_url', image_url: { url: v.dataUrl } });
    }
  }

  // Pose views
  if (ev.poseRenders.length > 0) {
    for (const pose of ev.poseRenders) {
      for (const v of pose.views) {
        parts.push({ type: 'text', text: `${title} [pose ${pose.name} ${v.name} view]:` });
        parts.push({ type: 'image_url', image_url: { url: v.dataUrl } });
      }
    }
  }

  return parts;
}

function buildComparisonMessage(
  request: string,
  checklist: RequirementsChecklist,
  d1Title: string,
  ev1: EvidencePack,
  d2Title: string,
  ev2: EvidencePack
): ContentPart[] {
  const intro: ContentPart[] = [
    {
      type: 'text',
      text: `# USER REQUEST\n"${request}"\n\n# REQUIREMENTS CHECKLIST\n` +
        checklist.requirements.map((r) => `- [${r.id}] ${r.text}`).join('\n') +
        '\n\nPlease evaluate Design 1 vs Design 2.',
    },
  ];

  const d1Parts = buildDesignPresentation(d1Title, ev1);
  const d2Parts = buildDesignPresentation(d2Title, ev2);

  return [...intro, ...d1Parts, ...d2Parts];
}

function resolveChoice(
  choice: Choice,
  firstIsA: boolean
): PairWinner {
  if (choice === 'tie') return 'tie';
  if (firstIsA) {
    return choice === 'first' ? 'A' : 'B';
  } else {
    return choice === 'first' ? 'B' : 'A';
  }
}

function resolveConsensus(w1: PairWinner, w2: PairWinner): { winner: PairWinner; agreed: boolean } {
  if (w1 === w2) {
    return { winner: w1, agreed: true };
  }
  // Disagreement between orders counts as a tie
  return { winner: 'tie', agreed: false };
}

export async function comparePair(input: ComparePairInput): Promise<PairwiseComparisonResult> {
  const modelSlug = input.model ?? process.env.CADAI_JUDGE_MODEL ?? 'claude-sonnet-5.5';
  const chatModel = getChatModel(modelSlug);
  const structured = structuredFor(chatModel, modelSlug, SinglePairwiseVerdictSchema);
  const usage = new UsageHandler();

  const labelA = input.labelA ?? 'Design A';
  const labelB = input.labelB ?? 'Design B';

  // Call 1: Order (A, B) -> Design 1 is A, Design 2 is B
  const content1 = buildComparisonMessage(
    input.request,
    input.checklist,
    `Design 1 (${labelA})`,
    input.evA,
    `Design 2 (${labelB})`,
    input.evB
  );

  const raw1 = await structured.invoke(
    [
      new SystemMessage(PAIRWISE_SYSTEM_PROMPT),
      new HumanMessage({ content: content1 as never }),
    ],
    { callbacks: [usage] }
  );
  const order1 = SinglePairwiseVerdictSchema.parse(raw1);

  // Call 2: Order (B, A) -> Design 1 is B, Design 2 is A
  const content2 = buildComparisonMessage(
    input.request,
    input.checklist,
    `Design 1 (${labelB})`,
    input.evB,
    `Design 2 (${labelA})`,
    input.evA
  );

  const raw2 = await structured.invoke(
    [
      new SystemMessage(PAIRWISE_SYSTEM_PROMPT),
      new HumanMessage({ content: content2 as never }),
    ],
    { callbacks: [usage] }
  );
  const order2 = SinglePairwiseVerdictSchema.parse(raw2);

  // Interpret winners relative to A and B
  const o1Overall = resolveChoice(order1.winner, true);
  const o2Overall = resolveChoice(order2.winner, false);
  const overallConsensus = resolveConsensus(o1Overall, o2Overall);

  const critKeys = [
    'requirementsCoverage',
    'layoutAndClearances',
    'functionAndMotion',
    'accessibility',
    'manufacturabilityAndRobustness',
    'parametricQuality',
  ] as const;

  const criteriaConsensus = {} as PairwiseComparisonResult['criteria'];

  for (const k of critKeys) {
    const w1 = resolveChoice(order1.criteria[k], true);
    const w2 = resolveChoice(order2.criteria[k], false);
    const c = resolveConsensus(w1, w2);
    criteriaConsensus[k] = {
      winner: c.winner,
      agreed: c.agreed,
      order1Winner: w1,
      order2Winner: w2,
    };
  }

  return {
    winner: overallConsensus.winner,
    agreed: overallConsensus.agreed,
    criteria: criteriaConsensus,
    order1,
    order2,
    costUsd: usage.cost(modelSlug),
  };
}
