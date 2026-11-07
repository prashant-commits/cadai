import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getChatModel } from './model-provider';
import { structuredFor } from './llm-schemas';

export type RequirementKind = 'dimension' | 'feature' | 'parameter' | 'relation' | 'constraint';

export interface BuildRequirement {
  id: string;
  text: string;
  kind: RequirementKind;
}

export interface BuildRequirementsChecklist {
  requirements: BuildRequirement[];
}

export const BuildRequirementSchema = z.object({
  id: z.string().describe('Short snake_case identifier for the requirement, e.g. base_dimensions.'),
  text: z.string().describe('Atomic, unambiguous description of the requirement.'),
  kind: z.enum(['dimension', 'feature', 'parameter', 'relation', 'constraint']),
});

export const BuildRequirementsChecklistSchema = z.object({
  requirements: z.array(BuildRequirementSchema),
});

const REQUIREMENTS_PROMPT = `You are a senior mechanical systems engineer.
Turn the following CAD design prompt into a checklist of atomic, verifiable requirements.
Each requirement must test exactly one checkable item:
- dimension: explicit stated sizes (length, width, thickness, radius, angle)
- feature: specific functional or physical features (slots, compartments, holes, knuckles, lips)
- parameter: variables explicitly requested to be adjustable parameters
- relation: relative placement or positioning between parts (e.g. cradle on front-left, box at back)
- constraint: guardrails or prohibitions (e.g. no fillets, stay separate solid, nothing below z=0)

Output structured JSON matching the schema.`;

// In-memory cache per prompt / build to ensure we call the model at most once per build.
const checklistCache = new Map<string, Promise<BuildRequirementsChecklist> | BuildRequirementsChecklist>();

export function clearBuildRequirementsCache(): void {
  checklistCache.clear();
}

/**
 * Returns atomic checkable requirements for a user request.
 * Cached so that subsequent calls for the same request within the build do not invoke the model again.
 */
export async function getBuildRequirements(
  userPrompt: string,
  modelSlug?: string,
  customModel?: unknown
): Promise<BuildRequirementsChecklist> {
  const trimmed = userPrompt.trim();
  if (checklistCache.has(trimmed)) {
    return checklistCache.get(trimmed)!;
  }

  const fetchPromise = (async (): Promise<BuildRequirementsChecklist> => {
    try {
      const slug = modelSlug ?? process.env.CADAI_JUDGE_MODEL ?? 'claude-sonnet-5.5';
      const model = customModel ? (customModel as ReturnType<typeof getChatModel>) : getChatModel(slug);
      const structured = structuredFor(model, slug, BuildRequirementsChecklistSchema);

      const raw = await (structured as unknown as { invoke: (msgs: unknown[]) => Promise<unknown> }).invoke([
        new SystemMessage(REQUIREMENTS_PROMPT),
        new HumanMessage(`CAD Request:\n\n${trimmed}`),
      ]);
      const parsed = BuildRequirementsChecklistSchema.parse(raw);
      return { requirements: parsed.requirements };
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('Failed to generate build requirements checklist:', err);
      }
      // Fallback: derive minimal requirement from prompt so build can proceed
      return {
        requirements: [
          { id: 'cad_request', text: trimmed.slice(0, 100), kind: 'feature' },
        ],
      };
    }
  })();

  checklistCache.set(trimmed, fetchPromise);
  try {
    const res = await fetchPromise;
    checklistCache.set(trimmed, res);
    return res;
  } catch (err) {
    checklistCache.delete(trimmed);
    throw err;
  }
}
