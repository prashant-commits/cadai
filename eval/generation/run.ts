/**
 * Generation eval: runs each prompt through the real agent graph with gates
 * auto-approved and automatic repair off, then reports first-draft quality.
 *
 *   npm run eval:generation -- --model deepseek-v4-flash --tag baseline
 *   npm run eval:generation -- --seed-dataset          # once, creates the Langfuse dataset
 *   npm run eval:generation -- --no-langfuse --limit 2 # local only
 *
 * Results land in eval/results/<tag>-<model>-<timestamp>.json and, when
 * LANGFUSE_* keys are set, as a Langfuse experiment run on dataset
 * "cadai-generation" with one score per metric.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { HumanMessage } from '@langchain/core/messages';
import { Command, isInterrupted } from '@langchain/langgraph';

for (const f of ['.env', '.env.local']) {
  try { process.loadEnvFile(f); } catch { /* absent is fine */ }
}
// Eval defaults: no automatic repair, no critic. Explicit env still wins.
process.env.CADAI_MAX_ATTEMPTS ??= '1';
process.env.CADAI_VISUAL_CRITIC ??= 'off';

import { createCadAgent, type AgentStateType } from '@/lib/agent/graph';
import { getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { getLangfuseCallbackHandler, getLangfuseSpanProcessor, initLangfuseTracing } from '@/lib/tracing/langfuse';
import { GenerationMetrics, metricsFromState, scoresFor, summarize } from './metrics';

const DATASET = 'cadai-generation';

interface Args { model: string; tag: string; limit: number; only: string[]; langfuse: boolean; seed: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { model: 'deepseek-v4-flash', tag: 'run', limit: Infinity, only: [], langfuse: true, seed: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--model') a.model = argv[++i];
    else if (v === '--tag') a.tag = argv[++i];
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v === '--only') a.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === '--no-langfuse') a.langfuse = false;
    else if (v === '--seed-dataset') a.seed = true;
  }
  return a;
}

const RESULTS_DIR = path.join(__dirname, '..', 'results');
const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-');

interface PromptItem { id: string; prompt: string }
const prompts: PromptItem[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts.json'), 'utf8'));

function gitSha(): string {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; }
}

async function runOne(item: PromptItem, args: Args, jsonl: string): Promise<GenerationMetrics> {
  const handler = getLangfuseCallbackHandler({
    tags: ['cadai', 'eval', args.model],
    metadata: { model: args.model, tag: args.tag, promptId: item.id },
  });
  console.log(`\n=== ${item.id} ===`);
  // Node-by-node progress in the log: a prompt that goes quiet after
  // "Physical Validator" is a frozen wasm compile, which nothing in-process
  // can interrupt - kill the run and re-run the rest with --only.
  const agent = createCadAgent(
    (e) => console.log(`  ${new Date().toISOString().slice(11, 19)} [${e.type}] ${e.message.slice(0, 160)}`),
    args.model
  );
  const key = runCheckpointKey(`eval-${args.tag}`, `${item.id}-${Date.now()}`);
  const config = { configurable: { thread_id: key }, callbacks: handler ? [handler] : undefined };

  const t0 = Date.now();
  let result = await agent.invoke({ messages: [new HumanMessage(item.prompt)] }, config);
  for (let i = 0; i < 4 && isInterrupted(result); i++) {
    result = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
  }
  const state = (await agent.getState(config)).values as AgentStateType;
  await getCheckpointer().deleteThread(key);

  const m = metricsFromState(item.id, args.model, state, Date.now() - t0);
  console.log(`${item.id}: composed=${m.composed} floor=${m.floorOk} floating=${m.floatingCount} localFrame=${m.localFrameOk} errors=[${m.errorKinds.join(',')}] ${m.wallMs} ms`);
  // Written per prompt so a killed run keeps what it finished.
  fs.appendFileSync(jsonl, JSON.stringify(m) + '\n');
  return m;
}

async function seedDataset(): Promise<void> {
  const { LangfuseClient } = await import('@langfuse/client');
  const langfuse = new LangfuseClient();
  try {
    await langfuse.api.datasets.create({ name: DATASET, description: 'Multi-part prompts for first-draft generation quality.' });
  } catch (e) {
    console.log(`dataset ${DATASET} exists or could not be created: ${(e as Error).message}`);
  }
  for (const p of prompts) {
    // A fixed id makes this an upsert, so re-seeding never duplicates items.
    await langfuse.api.datasetItems.create({ datasetName: DATASET, id: `cadai-gen-${p.id}`, input: p });
  }
  console.log(`seeded ${prompts.length} items into ${DATASET}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keysPresent = !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
  const useLangfuse = args.langfuse && keysPresent;
  if (args.langfuse && !keysPresent) console.log('LANGFUSE_* keys not set: running locally only.');

  if (args.seed) {
    if (!keysPresent) throw new Error('--seed-dataset needs LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    await seedDataset();
    return;
  }

  const items = (args.only.length ? prompts.filter((p) => args.only.includes(p.id)) : prompts).slice(0, args.limit);
  console.log(`Eval: ${items.length} prompt(s) on ${args.model}, tag "${args.tag}". ` +
    `Expect roughly ${items.length * 2}-${items.length * 5} model calls (architect retries + drafter tool round). Starting in 5 s, Ctrl+C to abort.`);
  await new Promise((r) => setTimeout(r, 5000));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const base = path.join(RESULTS_DIR, `${args.tag}-${args.model}-${stamp(new Date())}`);
  const jsonl = `${base}.jsonl`;
  console.log(`per-prompt results: ${jsonl}`);

  let rows: GenerationMetrics[] = [];
  if (useLangfuse) {
    // Register the OpenTelemetry span processor BEFORE runExperiment opens its
    // per-item spans; otherwise those traces are created but never exported.
    initLangfuseTracing();
    const { LangfuseClient } = await import('@langfuse/client');
    const langfuse = new LangfuseClient();
    const dataset = await langfuse.dataset.get(DATASET);
    const wanted = new Set(items.map((p) => p.id));
    const data = dataset.items.filter((it) => wanted.has((it.input as PromptItem).id));
    const result = await dataset.runExperiment({
      name: 'cadai-generation',
      runName: `${args.tag}-${args.model}-${new Date().toISOString().slice(0, 16)}`,
      metadata: { model: args.model, tag: args.tag, gitSha: gitSha() },
      data,
      // One at a time: each run drives a wasm compiler and spends model quota.
      maxConcurrency: 1,
      task: async ({ input }) => runOne(input as PromptItem, args, jsonl),
      evaluators: [async ({ output }) => scoresFor(output as GenerationMetrics)],
    } as Parameters<typeof dataset.runExperiment>[0]);
    rows = result.itemResults.map((r) => r.output as GenerationMetrics);
    await langfuse.flush();
    if (result.datasetRunUrl) console.log(`Langfuse run: ${result.datasetRunUrl}`);
  } else {
    for (const item of items) rows.push(await runOne(item, args, jsonl));
  }

  const summary = summarize(rows);
  console.table(summary);
  const file = `${base}.json`;
  fs.writeFileSync(file, JSON.stringify({ args, gitSha: gitSha(), summary, rows }, null, 2));
  console.log(`wrote ${file}`);

  await getLangfuseSpanProcessor()?.forceFlush();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
