import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { ArchitectPlanSchema, normalizeClaudeSentinels } from '@/lib/agent/llm-schemas';
import { nullsToUndefined } from '@/lib/agent/strict-schema';
import { AssemblySpec, AssemblySpecSchema } from '@/lib/agent/assembly-spec';
import { normalizeSpec } from '@/lib/agent/spec-normalize';

/** Turning one batch or sync result into a plan or a spec, shared by run.ts and render.ts. */

export const SPEC_TOOL = 'AssemblySpec';

/**
 * An Anthropic message (batch or sync), an already-parsed structured reply from
 * the gateway path (structuredFor did the provider-specific work), or an error.
 */
export type Outcome =
  | { message: Anthropic.Message }
  | { value: unknown; usd: number | null }
  | { error: string };

/** Refusal and truncation checked before content is read. */
function stopFailure(m: Anthropic.Message): string | null {
  if (m.stop_reason === 'refusal') return `refusal: ${m.stop_details?.category ?? 'uncategorised'}`;
  if (m.stop_reason === 'max_tokens') return 'max_tokens: reply truncated';
  return null;
}

export function parsePlan(o: Outcome | undefined): { plan: z.infer<typeof ArchitectPlanSchema> | null; failure: string | null } {
  if (!o) return { plan: null, failure: 'missing: no result' };
  if ('error' in o) return { plan: null, failure: o.error };
  let value: unknown;
  if ('value' in o) {
    value = o.value;
  } else {
    const stop = stopFailure(o.message);
    if (stop) return { plan: null, failure: stop };
    const text = o.message.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') return { plan: null, failure: 'no_text: planner returned no text block' };
    try {
      value = JSON.parse(text.text);
    } catch (e) {
      return { plan: null, failure: `json: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const parsed = ArchitectPlanSchema.safeParse(nullsToUndefined(value));
  if (parsed.success && parsed.data.variants.length > 0) return { plan: parsed.data, failure: null };
  return { plan: null, failure: parsed.success ? 'schema: no variants' : `schema: ${parsed.error.issues[0]?.message}` };
}

export function parseSpec(o: Outcome | undefined): { spec: AssemblySpec | null; failure: string | null } {
  if (!o) return { spec: null, failure: 'missing: no result' };
  if ('error' in o) return { spec: null, failure: o.error };
  let value: unknown;
  if ('value' in o) {
    value = o.value;
  } else {
    const stop = stopFailure(o.message);
    if (stop) return { spec: null, failure: stop };
    const call = o.message.content.find((b) => b.type === 'tool_use' && b.name === SPEC_TOOL);
    if (!call || call.type !== 'tool_use') return { spec: null, failure: 'no_tool_call: the model answered in text' };
    value = normalizeClaudeSentinels(call.input);
  }
  if (value === null || value === undefined) return { spec: null, failure: 'empty: no structured reply' };
  const parsed = AssemblySpecSchema.safeParse(nullsToUndefined(value));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { spec: null, failure: `schema: ${i?.path.join('.')} ${i?.message}` };
  }
  return { spec: normalizeSpec(parsed.data), failure: null };
}
