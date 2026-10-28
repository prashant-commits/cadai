/**
 * Architect-only eval: planner, then one spec per planned variant, scored by
 * the deterministic audits. No Drafter, no reviewer, no repair.
 *
 *   npm run eval:architect -- --model claude-haiku-5-5 --limit 2 --sync --tag smoke
 *   npm run eval:architect -- --model claude-sonnet-5-5 --samples 3 --tag s55
 *   npm run eval:architect -- --model claude-opus-5-5 --effort high --samples 3 --tag o55
 *
 * Calls Anthropic directly with ANTHROPIC_API_KEY (or an `ant auth login`
 * profile), not the gateway. By default both rounds go through the Message
 * Batches API at half price; --sync sends the same requests one by one at full
 * price, for a quick smoke run.
 *
 * It scores FIRST attempts. The graph retries a spec that fails its self-checks
 * up to three times; that rescue is deliberately left out so the number moves
 * only when the Architect's first draft gets better.
 *
 * Each spec is compiled from its blockout (blockoutScad), composed and audited
 * exactly as eval/placement does, so compile and audit errors are the spec's
 * own: no Drafter-written body is involved.
 *
 * Batch ids are kept in eval/results/.architect-<tag>-<model>.state.json, so a
 * rerun with the same tag and model picks up a batch still in flight instead of
 * paying for a new one. Delete that file to start over.
 *
 * Results: eval/results/architect-<tag>-<model>-<timestamp>.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
for (const f of ['.env', '.env.local']) {
  try { process.loadEnvFile(f); } catch { /* absent is fine */ }
}

import { systemPromptFor } from '@/lib/agent/system-prompt';
import { ArchitectPlanSchema, claudeVariantSpecSchema, normalizeClaudeSentinels } from '@/lib/agent/llm-schemas';
import { toAnthropicCompatibleSchema, nullsToUndefined } from '@/lib/agent/strict-schema';
import { AssemblySpec, AssemblySpecSchema } from '@/lib/agent/assembly-spec';
import { normalizeSpec } from '@/lib/agent/spec-normalize';
import { auditSpecCoherence } from '@/lib/agent/spec-coherence';
import { auditSpecGround, auditSpecShapes } from '@/lib/agent/spec-shape-audit';
import { maxVariantsFromEnv, processPlannerVariants, skeletonSignature, type SpecBrief, type VariantId } from '@/lib/agent/spec-variants';
import { freshVariantPrompt, type PlannedVariant } from '@/lib/agent/architect-prompts';
import { blockoutScad } from '@/lib/spec-sheet/blockout-scad';
import { auditFixture } from '../placement/harness';
import { costUsd, summarize, type PromptScore, type VariantScore } from './score';

const RESULTS_DIR = path.join(__dirname, '..', 'results');
const PROMPTS: { id: string; prompt: string }[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'generation', 'prompts.json'), 'utf8')
);
const POLL_MS = 30_000;
// Thinking counts against max_tokens. A variant spec plus its sheet is the
// longest reply in the graph; batch requests have no HTTP timeout to respect.
const MAX_TOKENS = 32_000;
const SPEC_TOOL = 'AssemblySpec';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface Args {
  model: string;
  tag: string;
  samples: number;
  limit: number;
  only: string[];
  effort: Effort;
  sync: boolean;
}

function parseArgs(argv: string[]): Args {
  // Effort is set explicitly: Opus 5.5 and Haiku 5.5 default to medium, Sonnet 5.5 to high.
  const a: Args = { model: 'claude-haiku-5-5', tag: 'run', samples: 1, limit: Infinity, only: [], effort: 'high', sync: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--model') a.model = argv[++i];
    else if (v === '--tag') a.tag = argv[++i];
    else if (v === '--samples') a.samples = Number(argv[++i]);
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v === '--only') a.only = argv[++i].split(',');
    else if (v === '--effort') a.effort = argv[++i] as Effort;
    else if (v === '--sync') a.sync = true;
    else throw new Error(`unknown flag ${v}`);
  }
  if (!Number.isInteger(a.samples) || a.samples < 1) throw new Error('--samples must be a positive integer');
  return a;
}

type Request = Anthropic.Messages.BatchCreateParams.Request;
type Outcome = { message: Anthropic.Message } | { error: string };

/**
 * The cached prefix is the system prompt, which is identical across every
 * request in a round. Nothing volatile goes in it.
 */
function systemBlocks(node: 'planner' | 'variant'): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: systemPromptFor(node), cache_control: { type: 'ephemeral' } }];
}

function plannerSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(ArchitectPlanSchema) as Record<string, unknown>;
  return toAnthropicCompatibleSchema(json);
}

function plannerRequest(args: Args, id: string, prompt: string): Request {
  return {
    custom_id: id,
    params: {
      model: args.model,
      max_tokens: MAX_TOKENS,
      system: systemBlocks('planner'),
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: args.effort, format: { type: 'json_schema', schema: plannerSchema() } },
    },
  };
}

/**
 * The variant spec is a tool call, not output_config.format: a strict grammar
 * for the full spec schema is rejected as too large (see structuredFor). Forced
 * tool_choice is a 400 on the 5.5 models, so the tool is offered with auto and
 * the request says to call it.
 */
function variantRequest(args: Args, id: string, prompt: string, text: string): Request {
  return {
    custom_id: id,
    params: {
      model: args.model,
      max_tokens: MAX_TOKENS,
      system: systemBlocks('variant'),
      tools: [{
        name: SPEC_TOOL,
        description: 'Emit the Assembly Spec for this variant.',
        input_schema: claudeVariantSpecSchema() as Anthropic.Tool.InputSchema,
      }],
      tool_choice: { type: 'auto' },
      messages: [
        { role: 'user', content: prompt },
        { role: 'user', content: `${text}\n\nReply by calling the ${SPEC_TOOL} tool.` },
      ],
      output_config: { effort: args.effort },
    },
  };
}

function loadState(file: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

async function runRound(client: Anthropic, round: string, reqs: Request[], args: Args, stateFile: string): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  if (reqs.length === 0) return out;

  if (args.sync) {
    for (const r of reqs) {
      try {
        out.set(r.custom_id, { message: await client.messages.create(r.params as Anthropic.MessageCreateParamsNonStreaming) });
      } catch (e) {
        out.set(r.custom_id, { error: `provider: ${e instanceof Error ? e.message : String(e)}` });
      }
      process.stdout.write('.');
    }
    process.stdout.write('\n');
    return out;
  }

  const state = loadState(stateFile);
  let batchId = state[round];
  if (batchId) {
    console.log(`${round}: resuming batch ${batchId}`);
  } else {
    const batch = await client.messages.batches.create({ requests: reqs });
    batchId = batch.id;
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, [round]: batchId }, null, 2));
    console.log(`${round}: submitted batch ${batchId} (${reqs.length} requests)`);
  }

  for (;;) {
    const b = await client.messages.batches.retrieve(batchId);
    const c = b.request_counts;
    console.log(`${round}: ${b.processing_status} - ${c.succeeded} ok, ${c.errored} errored, ${c.processing} processing`);
    if (b.processing_status === 'ended') break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Results arrive in any order: keyed by custom_id, never by position.
  for await (const r of await client.messages.batches.results(batchId)) {
    if (r.result.type === 'succeeded') out.set(r.custom_id, { message: r.result.message });
    else if (r.result.type === 'errored') out.set(r.custom_id, { error: `provider: ${r.result.error.error.message}` });
    else out.set(r.custom_id, { error: r.result.type });
  }
  return out;
}

function usdOf(args: Args, o: Outcome | undefined): number | null {
  return o && 'message' in o ? costUsd(args.model, o.message.usage, !args.sync) : 0;
}

/** Refusal and truncation checked before content is read. */
function stopFailure(m: Anthropic.Message): string | null {
  if (m.stop_reason === 'refusal') return `refusal: ${m.stop_details?.category ?? 'uncategorised'}`;
  if (m.stop_reason === 'max_tokens') return 'max_tokens: reply truncated';
  return null;
}

function parsePlan(o: Outcome | undefined): { plan: z.infer<typeof ArchitectPlanSchema> | null; failure: string | null } {
  if (!o) return { plan: null, failure: 'missing: no result' };
  if ('error' in o) return { plan: null, failure: o.error };
  const stop = stopFailure(o.message);
  if (stop) return { plan: null, failure: stop };
  const text = o.message.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') return { plan: null, failure: 'no_text: planner returned no text block' };
  try {
    const parsed = ArchitectPlanSchema.safeParse(nullsToUndefined(JSON.parse(text.text)));
    if (parsed.success && parsed.data.variants.length > 0) return { plan: parsed.data, failure: null };
    return { plan: null, failure: parsed.success ? 'schema: no variants' : `schema: ${parsed.error.issues[0]?.message}` };
  } catch (e) {
    return { plan: null, failure: `json: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function parseSpec(o: Outcome | undefined): { spec: AssemblySpec | null; failure: string | null } {
  if (!o) return { spec: null, failure: 'missing: no result' };
  if ('error' in o) return { spec: null, failure: o.error };
  const stop = stopFailure(o.message);
  if (stop) return { spec: null, failure: stop };
  const call = o.message.content.find((b) => b.type === 'tool_use' && b.name === SPEC_TOOL);
  if (!call || call.type !== 'tool_use') return { spec: null, failure: 'no_tool_call: the model answered in text' };
  const parsed = AssemblySpecSchema.safeParse(nullsToUndefined(normalizeClaudeSentinels(call.input)));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { spec: null, failure: `schema: ${i?.path.join('.')} ${i?.message}` };
  }
  return { spec: normalizeSpec(parsed.data), failure: null };
}

/** Same fallback as architectNode when the planner yields nothing usable. */
function planOrFallback(plan: z.infer<typeof ArchitectPlanSchema> | null): { variants: PlannedVariant[]; brief: SpecBrief } {
  if (!plan) {
    return {
      variants: [{ id: 'A' as VariantId, name: 'As requested', idea: 'the design the request describes' }],
      brief: { markdown: '', assumptions: [], openQuestions: [], recommendedId: 'A' as VariantId },
    };
  }
  const { variants, recommendedId } = processPlannerVariants(plan.variants, plan.recommendedId, maxVariantsFromEnv(process.env.CADAI_MAX_VARIANTS));
  return {
    variants,
    brief: { markdown: plan.brief || '', assumptions: plan.assumptions || [], openQuestions: plan.openQuestions || [], recommendedId: recommendedId as VariantId },
  };
}

async function scoreSpec(spec: AssemblySpec): Promise<Pick<VariantScore, 'firstAttemptClean' | 'selfCheckErrors' | 'blockoutSkipped' | 'compiled' | 'auditErrors' | 'bbox' | 'signature'>> {
  // The three checks architectNode runs before accepting a spec.
  const selfCheck = [...auditSpecCoherence(spec), ...auditSpecShapes(spec), ...auditSpecGround(spec)]
    .filter((v) => v.severity === 'error');
  const blockout = blockoutScad(spec);
  const audit = await auditFixture({ name: spec.assemblyName, intent: '', spec, code: blockout.code });
  return {
    firstAttemptClean: selfCheck.length === 0,
    selfCheckErrors: selfCheck.map((v) => v.kind),
    blockoutSkipped: blockout.skipped.length,
    compiled: audit.compiled,
    auditErrors: audit.violations.filter((v) => v.severity === 'error').map((v) => v.kind),
    bbox: audit.bbox,
    signature: skeletonSignature(spec),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new Anthropic();
  const items = PROMPTS.filter((p) => args.only.length === 0 || args.only.includes(p.id)).slice(0, args.limit);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stateFile = path.join(RESULTS_DIR, `.architect-${args.tag}-${args.model}.state.json`);
  console.log(`architect eval: ${items.length} prompts x ${args.samples} samples on ${args.model} (effort ${args.effort}, ${args.sync ? 'sync' : 'batch'})`);

  // custom_id allows [a-zA-Z0-9_-] only.
  const jobs = items.flatMap((item) => Array.from({ length: args.samples }, (_, s) => ({ item, sample: s, key: `${item.id}-s${s}` })));

  const plans = await runRound(client, 'plan', jobs.map((j) => plannerRequest(args, `${j.key}-plan`, j.item.prompt)), args, stateFile);

  const promptScores: PromptScore[] = [];
  const variantJobs: { job: (typeof jobs)[number]; variant: PlannedVariant; req: Request }[] = [];
  for (const job of jobs) {
    const o = plans.get(`${job.key}-plan`);
    const { plan, failure } = parsePlan(o);
    const { variants, brief } = planOrFallback(plan);
    promptScores.push({ promptId: job.item.id, sample: job.sample, plannerOk: !!plan, plannerFailure: failure, variantsPlanned: variants.length, usd: usdOf(args, o) });
    for (const v of variants) {
      variantJobs.push({ job, variant: v, req: variantRequest(args, `${job.key}-${v.id}`, job.item.prompt, freshVariantPrompt(v, variants, brief)) });
    }
  }

  const specs = await runRound(client, 'variant', variantJobs.map((v) => v.req), args, stateFile);

  const variantScores: VariantScore[] = [];
  for (const { job, variant, req } of variantJobs) {
    const o = specs.get(req.custom_id);
    const { spec, failure } = parseSpec(o);
    const base = { promptId: job.item.id, sample: job.sample, variantId: variant.id, usd: usdOf(args, o) };
    if (!spec) {
      variantScores.push({ ...base, failure, firstAttemptClean: false, selfCheckErrors: [], blockoutSkipped: 0, compiled: false, auditErrors: [], bbox: 'none', signature: '' });
      continue;
    }
    variantScores.push({ ...base, failure: null, ...(await scoreSpec(spec)) });
  }

  const summary = summarize(promptScores, variantScores);
  const outFile = path.join(RESULTS_DIR, `architect-${args.tag}-${args.model}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ args, summary, prompts: promptScores, variants: variantScores }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`wrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
