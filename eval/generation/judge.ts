import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { getChatModel } from '@/lib/agent/model-provider';
import { JUDGE_SYSTEM_PROMPT } from './judge-prompt';
import { renderStlViews } from '@/lib/engine/stl-renderer';

/**
 * Same shape as the graph's VisualCritiqueSchema. No `.optional()`: the
 * gateway's strict json_schema rejects a property that is not required.
 */
const VisualCritiqueSchema = z.object({
  matchesIntent: z.boolean(),
  findings: z
    .array(
      z.object({
        issue: z.string().describe('What is visibly wrong, in one sentence.'),
        severity: z.enum(['minor', 'major']),
        view: z.string().describe('front | right | top | iso, or "" if it applies to all views'),
      })
    )
    .default([]),
});

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
    const critique = (await getChatModel(process.env.CADAI_CRITIC_MODEL)
      .withStructuredOutput(VisualCritiqueSchema)
      .invoke([
        new SystemMessage(JUDGE_SYSTEM_PROMPT),
        new HumanMessage({ content: criticUserContent(input.request, input.spec, views) as never }),
      ])) as VisualCritique;
    return { matchesIntent: !!critique?.matchesIntent, findings: critique?.findings ?? [] };
  } catch (e) {
    console.warn('Visual judge: model call failed', e);
    return null;
  }
}
