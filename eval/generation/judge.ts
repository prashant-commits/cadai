import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { getChatModel } from '@/lib/agent/model-provider';
import { coerceRouteModel, isOfferedModel } from '@/lib/agent/models';
import { structuredFor, parseVisualCritique, VisualCritiqueSchema } from '@/lib/agent/llm-schemas';
import { JUDGE_SYSTEM_PROMPT } from './judge-prompt';
import { renderStlViews } from '@/lib/engine/stl-renderer';
import { z } from 'zod';
import { UsageHandler } from './usage';

export interface VisualCritique {
  matchesIntent: boolean;
  findings: Array<{ issue: string; severity: 'minor' | 'major'; view: string }>;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Outline the graph's critic is allowed to see. Numbers stay out of it. */
function criticSpecSummary(spec: AssemblySpec | null): string {
  if (!spec) return '';
  const lines: string[] = [];
  if (spec.sheet) {
    lines.push(`Design sheet:\n${spec.sheet}`);
  }
  for (const c of spec.components ?? []) {
    const extras = [];
    if (c.bedFace) extras.push(`expected bed face ${c.bedFace}`);
    lines.push(`- ${c.name}: ${c.description}${extras.length ? ` (${extras.join('; ')})` : ''}`);
  }
  for (const s of spec.stressPoints ?? []) {
    if (s.risk === 'low') continue;
    lines.push(`- ${s.risk}-risk stress point at ${s.component ? `${s.component} ` : ''}${s.location}; the spec demands: ${s.mitigation}`);
  }
  return lines.length ? `\n\nApproved spec, in outline:\n${lines.join('\n')}` : '';
}

/**
 * The user text plus one label and one image per view. Copied from the
 * graph's critic, but the system prompt is now frozen. `request` is the
 * user's words, quoted, not a paraphrase.
 */
export function criticUserContent(
  request: string,
  spec: AssemblySpec | null,
  views: Array<{ name: string; dataUrl: string }>,
): ContentPart[] {
  const specText = criticSpecSummary(spec);
  const bedFaces = (spec?.components ?? [])
    .filter((c) => c.bedFace)
    .map((c) => `${c.name} on ${c.bedFace}`);
  const postureText = bedFaces.length
    ? ` The part should rest on its declared bed face (${bedFaces.join(', ')}); check the print posture against that.`
    : '';
  const asked = request || 'the user request above';
  const content: ContentPart[] = [
    {
      type: 'text',
      text:
        `The user asked for:\n"${asked}"${specText}\n\n` +
        `Here are ${views.length} renders of the compiled part (${views
          .map((v) => v.name)
          .join(', ')}). Does the geometry match the request?${postureText}`,
    },
  ];
  for (const view of views) {
    content.push({ type: 'text', text: `View: ${view.name}` });
    content.push({ type: 'image_url', image_url: { url: view.dataUrl } });
  }
  return content;
}

/**
 * Judge a compiled mesh outside the graph. The graph's own critic never
 * runs when a deterministic audit failed, so the eval cannot read the
 * answer off specViolations. Returns null when the render or the model
 * call fails; the caller records that as an unmeasured match.
 */
export async function judgeCompiledModel(input: {
  stl: string;
  request: string;
  spec: AssemblySpec | null;
}): Promise<VisualCritique | null> {
  let views;
  try {
    views = renderStlViews(input.stl);
  } catch (e) {
    console.warn('Visual judge: render failed', e);
    return null;
  }
  if (views.length === 0) {
    console.warn('Visual judge: render produced no views');
    return null;
  }

  try {
    // The app's path: structuredFor (native structured output, never a forced
    // tool_choice) and the same validation as the graph's Design Inspector.
    const envCritic = process.env.CADAI_CRITIC_MODEL;
    const slug = envCritic && isOfferedModel(envCritic) ? envCritic : coerceRouteModel(undefined);
    const raw = await structuredFor(getChatModel(slug), slug, VisualCritiqueSchema).invoke([
      new SystemMessage(JUDGE_SYSTEM_PROMPT),
      new HumanMessage({ content: criticUserContent(input.request, input.spec, views) as never }),
    ]);
    const critique = parseVisualCritique(raw);
    if (!critique) {
      console.warn('Visual judge: reply did not match the critique schema');
      return null;
    }
    return { matchesIntent: critique.matchesIntent, findings: critique.findings };
  } catch (e) {
    console.warn('Visual judge: model call failed', e);
    return null;
  }
}

/** Default model for the standalone intent judge, fixed across cells so scores compare. */
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5.5';

const IntentJudgeSchema = z.object({
  matchesIntent: z.boolean(),
  score: z.number().describe('0 (wrong object) to 10 (exactly what was asked), an integer.'),
  findings: VisualCritiqueSchema.shape.findings,
});

export interface IntentVerdict {
  matchesIntent: boolean;
  score: number;
  findings: VisualCritique['findings'];
}

/** What a judged run records. All null when the judge is off, there is no STL, or the call failed. */
export interface IntentScore {
  intentMatch: boolean | null;
  intentScore: number | null;
  intentFindings: VisualCritique['findings'] | null;
  /** USD for the judge's own tokens; null when it did not run or the model has no price. */
  judgeCostUsd: number | null;
}

export const UNJUDGED_INTENT: IntentScore = { intentMatch: null, intentScore: null, intentFindings: null, judgeCostUsd: null };

export interface IntentJudgeInput { stl: string; request: string; spec: AssemblySpec | null; model: string }
export type IntentJudgeFn = (input: IntentJudgeInput) => Promise<{ verdict: IntentVerdict; costUsd: number | null } | null>;

/**
 * Asks `input.model` whether the rendered final STL matches the request, with
 * the same renders and frozen system prompt as the visualMatch judge plus a
 * 0-10 score. Runs outside the graph: it reads the finished STL and nothing it
 * does reaches the run. Null when the render or the call fails.
 */
export const judgeIntent: IntentJudgeFn = async (input) => {
  let views;
  try {
    views = renderStlViews(input.stl);
  } catch (e) {
    console.warn('Intent judge: render failed', e);
    return null;
  }
  if (views.length === 0) return null;
  try {
    const usage = new UsageHandler();
    const content = criticUserContent(input.request, input.spec, views);
    content.push({ type: 'text', text: 'Also give "score": an integer from 0 (not the requested object) to 10 (exactly what was asked, nothing missing).' });
    const raw = await structuredFor(getChatModel(input.model), input.model, IntentJudgeSchema).invoke(
      [new SystemMessage(JUDGE_SYSTEM_PROMPT), new HumanMessage({ content: content as never })],
      { callbacks: [usage] },
    );
    const parsed = IntentJudgeSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('Intent judge: reply did not match the schema');
      return null;
    }
    const critique = parseVisualCritique({ matchesIntent: parsed.data.matchesIntent, findings: parsed.data.findings });
    const score = Math.min(10, Math.max(0, Math.round(parsed.data.score)));
    return {
      verdict: { matchesIntent: parsed.data.matchesIntent, score, findings: critique?.findings ?? parsed.data.findings },
      costUsd: usage.cost(input.model),
    };
  } catch (e) {
    console.warn('Intent judge: model call failed', e);
    return null;
  }
};

/** Runs the intent judge when it is on. A failed or skipped judge leaves every field null. */
export async function measureIntent(
  input: { on: boolean; stl: string | null | undefined; request: string; spec: AssemblySpec | null; model: string },
  judge: IntentJudgeFn = judgeIntent,
): Promise<IntentScore> {
  if (!input.on || !input.stl) return UNJUDGED_INTENT;
  const out = await judge({ stl: input.stl, request: input.request, spec: input.spec, model: input.model });
  if (!out) return UNJUDGED_INTENT;
  return {
    intentMatch: out.verdict.matchesIntent,
    intentScore: out.verdict.score,
    intentFindings: out.verdict.findings,
    judgeCostUsd: out.costUsd,
  };
}
