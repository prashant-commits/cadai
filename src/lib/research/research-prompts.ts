import type { SearchHit } from './search-provider';

/**
 * Prompts for the Design Researcher, the node that runs before the Architect.
 *
 * Kept out of system-prompt.ts on purpose: the researcher never sees OpenSCAD
 * and never decides a dimension, so it does not need the CAD rules, and the
 * shared CAD_AI_SYSTEM_PROMPT (which rides on every other node's calls) does
 * not grow. research-prompts.test.ts holds this file to a 120-word preamble.
 */
export const RESEARCHER_PREAMBLE = `You are the Design Researcher for a parametric CAD pipeline that produces FDM-printed mechanical parts. You run BEFORE the Mechanical Architect. Your job is to find how the requested class of part is normally built - its construction: which bodies exist, how they join, how it prints - so a human can choose an approach before any dimension is fixed. You never decide dimensions and never write code. Every edge stays sharp: do not propose fillets, chamfers or rounds. Prefer constructions that print without support and keep bending loads in the layer plane.`;

/** The query-plan call: turns the request into a part class and 2-4 searches. */
export function queryPlanPrompt(request: string, constraints: string): string {
  return `Plan web searches for prior art on this request.

Request:
${request}
${constraints ? `\nStanding constraints:\n${constraints}\n` : ''}
Return partClass (a short noun phrase naming the class of part, e.g. "wall-mounted hair dryer holder") and 2-4 search queries that would find how makers and engineers build this class of part for 3D printing: construction styles, joining schemes, print orientation. Queries are plain search-engine phrases, each under 12 words, no quotes.`;
}

/** The brief-synthesis call: compares constructions using only the numbered hits. */
export function briefPrompt(request: string, partClass: string, hits: SearchHit[]): string {
  const sources = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.content}`).join('\n\n');
  return `Compare construction approaches for: ${partClass}

Request:
${request}

Sources:
${sources}

Return 2-3 approaches. For each: id (a1, a2, a3), name, construction (2-4 sentences: what bodies, how they join, how it prints on an FDM bed), strengths, weaknesses, and sources - only URLs copied exactly from the list above that actually support the approach; leave sources empty if none does. Set recommendedId to the approach best suited to FDM printing and to the request. Do not invent URLs.`;
}
