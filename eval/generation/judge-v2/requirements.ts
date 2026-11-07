import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getChatModel } from '@/lib/agent/model-provider';
import { structuredFor } from '@/lib/agent/llm-schemas';

export type RequirementKind = 'dimension' | 'feature' | 'parameter' | 'relation' | 'constraint';

export interface Requirement {
  id: string;
  text: string;
  kind: RequirementKind;
}

export interface RequirementsChecklist {
  promptId: string;
  requirements: Requirement[];
}

export const RequirementSchema = z.object({
  id: z.string().describe('Short snake_case identifier for the requirement, e.g. base_dimensions.'),
  text: z.string().describe('Atomic, unambiguous description of the requirement.'),
  kind: z.enum(['dimension', 'feature', 'parameter', 'relation', 'constraint']),
});

export const RequirementsChecklistSchema = z.object({
  requirements: z.array(RequirementSchema),
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

function getCacheDir(): string {
  return path.resolve(process.cwd(), 'eval/generation/judge-v2/requirements');
}

/**
 * Returns atomic checkable requirements for a prompt.
 * Reads from disk cache if present, otherwise calls the LLM and caches the result.
 */
export async function getRequirements(
  promptId: string,
  promptText: string,
  modelSlug?: string
): Promise<RequirementsChecklist> {
  const cacheDir = getCacheDir();
  const cachePath = path.join(cacheDir, `${promptId}.json`);

  if (existsSync(cachePath)) {
    try {
      const data = await fs.readFile(cachePath, 'utf-8');
      const parsed = JSON.parse(data) as RequirementsChecklist;
      if (Array.isArray(parsed?.requirements) && parsed.requirements.length > 0) {
        return parsed;
      }
    } catch {
      // cache invalid, fall through to regenerate
    }
  }

  const slug = modelSlug ?? process.env.CADAI_JUDGE_MODEL ?? 'claude-sonnet-5.5';
  const model = getChatModel(slug);
  const structured = structuredFor(model, slug, RequirementsChecklistSchema);

  const rawResponse = await structured.invoke([
    new SystemMessage(REQUIREMENTS_PROMPT),
    new HumanMessage(`CAD Request:\n\n${promptText}`),
  ]);
  const parsed = RequirementsChecklistSchema.parse(rawResponse);

  const checklist: RequirementsChecklist = {
    promptId,
    requirements: parsed.requirements,
  };

  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(checklist, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`Failed to write requirements cache to ${cachePath}:`, err);
  }

  return checklist;
}
