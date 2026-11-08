/**
 * Multi-turn eval runner for designer mode (docs/superpowers/plans/2026-11-08-designer-evals.md).
 *
 *   npx tsx eval/designer/runner.ts --set open --arms designer,reviewer --tag m1
 *
 * Flags:
 *   --set <name|path>     a set in eval/designer/sets/<name>.json, or a path to a JSON file of EvalPrompt[]
 *   --arms a,b            designer, reviewer (default both). reviewer = designer + live reviewer
 *   --samples N           samples per (prompt, arm) (default 1)
 *   --concurrency N       parallel runs (default 5)
 *   --tag <tag>           results go to eval/designer/results/<tag>/ (default "run")
 *   --max-usd N           hard stop for the whole run (default 25). In-flight runs are aborted
 *   --only id,id          only these prompt ids
 *   --resume              skip runs whose record exists (a record cut short by the cost cap is re-run)
 *   --model <slug>        designer model (default: CADAI_MODEL or the app default)
 *   --out-dir <dir>       results root (default eval/designer/results)
 *
 * Each run drives the real graph with CADAI_PIPELINE=designer. Gates are auto-approved. Follow-ups
 * are sent as new user messages on the SAME thread, so the graph routes each as an edit of the
 * accepted script, as a user's chat message would be.
 *
 * Output: <out-dir>/<tag>/<arm>/<promptId>-s<n>.json (a RunRecord), with each step's mesh and STEP
 * beside it as <promptId>-s<n>-step<k>.stl / .step (StepRecord.stlPath and stepPath are relative
 * to the record's directory).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Command } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
for (const f of ['.env', '.env.local']) {
  try { process.loadEnvFile(f); } catch { /* absent is fine */ }
}

import { createCadAgent } from '@/lib/agent/graph';
import type { AgentStateType } from '@/lib/agent/designer/state';
import { runCheckpointKey, getCheckpointer } from '@/lib/agent/checkpointer';
import { DEFAULT_MODEL, isOfferedModel } from '@/lib/agent/models';
import { runBrep as realRunBrep } from '@/lib/engine/brep-runner';
import { factsFromRun } from '@/lib/agent/designer/tools';
import { stlToAscii } from '@/lib/brep/measurements';
import type { DesignerNodeDeps } from '@/lib/agent/designer/node';
import type { DesignerCheckDeps } from '@/lib/agent/designer/check';
import type { DesignerFacts, DesignerResult, RunDesignerFn } from '@/lib/agent/designer/types';
import type { Arm, EvalPrompt, RunRecord, StepRecord } from './types';

export const DEFAULT_RESULTS_DIR = path.join(__dirname, 'results');
const SETS_DIR = path.join(__dirname, 'sets');
const ARMS: Arm[] = ['designer', 'reviewer'];
const MAX_GATES = 12;

export interface RunnerOptions {
  tag: string;
  arms: Arm[];
  samples: number;
  concurrency: number;
  maxUsd: number;
  only: string[];
  resume: boolean;
  model: string;
  outDir: string;
}

/** Test seams: replace the designer loop, the geometry runner, or the reviewer factory. */
export type RunnerDeps = Pick<DesignerNodeDeps & DesignerCheckDeps, 'runDesigner' | 'runBrep' | 'makeReviewer'>;

export const defaultOptions = (): RunnerOptions => ({
  tag: 'run',
  arms: [...ARMS],
  samples: 1,
  concurrency: 5,
  maxUsd: 25,
  only: [],
  resume: false,
  model: process.env.CADAI_MODEL && isOfferedModel(process.env.CADAI_MODEL) ? process.env.CADAI_MODEL : DEFAULT_MODEL,
  outDir: DEFAULT_RESULTS_DIR,
});

// ---------------------------------------------------------------- args and sets

export function parseArgs(argv: string[]): { set: string } & RunnerOptions {
  const o = { set: '', ...defaultOptions() };
  const positive = (flag: string, v: string | undefined) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i];
    if (v === '--set') o.set = next() ?? '';
    else if (v === '--arms') {
      const arms = (next() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const bad = arms.filter((a) => !ARMS.includes(a as Arm));
      if (bad.length > 0 || arms.length === 0) throw new Error(`--arms takes ${ARMS.join(',')} (got "${arms.join(',')}")`);
      o.arms = [...new Set(arms)] as Arm[];
    } else if (v === '--samples') o.samples = Math.floor(positive(v, next()));
    else if (v === '--concurrency') o.concurrency = Math.floor(positive(v, next()));
    else if (v === '--tag') o.tag = next() ?? o.tag;
    else if (v === '--max-usd') o.maxUsd = positive(v, next());
    else if (v === '--only') o.only = (next() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === '--resume') o.resume = true;
    else if (v === '--model') o.model = next() ?? o.model;
    else if (v === '--out-dir') o.outDir = path.resolve(next() ?? o.outDir);
    else throw new Error(`unknown flag ${v}`);
  }
  if (!o.set) throw new Error('--set <name|path> is required');
  if (!/^[A-Za-z0-9._-]+$/.test(o.tag)) throw new Error('--tag may only contain letters, digits, ".", "_" and "-"');
  return o;
}

/** A set by name (eval/designer/sets/<name>.json) or by path. Accepts EvalPrompt[] or { prompts: EvalPrompt[] }. */
export function loadSet(nameOrPath: string): EvalPrompt[] {
  const file = fs.existsSync(nameOrPath) ? nameOrPath : path.join(SETS_DIR, `${nameOrPath}.json`);
  if (!fs.existsSync(file)) throw new Error(`set not found: ${nameOrPath} (looked for ${file})`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { prompts?: unknown }).prompts;
  if (!Array.isArray(list)) throw new Error(`${file} is not an array of prompts`);
  for (const p of list as EvalPrompt[]) {
    if (!p || typeof p.id !== 'string' || typeof p.request !== 'string') throw new Error(`${file}: every prompt needs an id and a request`);
  }
  return list as EvalPrompt[];
}

// ---------------------------------------------------------------- cost cap

/** One cost counter shared by every worker. Crossing the cap aborts all in-flight runs. */
export class Budget {
  spent = 0;
  readonly controller = new AbortController();
  constructor(readonly max: number) {}
  add(usd: number) {
    if (Number.isFinite(usd)) this.spent += usd;
    if (this.exceeded && !this.controller.signal.aborted) this.controller.abort();
  }
  get exceeded() {
    return this.spent >= this.max;
  }
}

const CAP_ERROR = 'cost cap reached';

// ---------------------------------------------------------------- one run

type Agent = ReturnType<typeof createCadAgent>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);

/** Send one user message and drive the graph to the end, auto-approving every gate. Returns the rendered stream text. */
async function drive(agent: Agent, message: string, config: Record<string, unknown>): Promise<string> {
  let transcript = '';
  let input: unknown = { messages: [new HumanMessage(message)] };
  for (let gate = 0; gate <= MAX_GATES; gate++) {
    const stream = await agent.stream(input as never, { ...config, streamMode: ['custom'] } as never);
    for await (const chunk of stream as AsyncIterable<unknown>) {
      const ev = (Array.isArray(chunk) ? chunk[1] : chunk) as { t?: string; text?: string; summary?: string } | undefined;
      if (ev?.t === 'delta' && typeof ev.text === 'string') transcript += ev.text;
      else if (ev?.t === 'result' && typeof ev.summary === 'string' && ev.summary) transcript += `${transcript && !transcript.endsWith('\n') ? '\n' : ''}${ev.summary}\n`;
    }
    const snapshot = await agent.getState(config as never);
    const interrupted = (snapshot.tasks ?? []).some((t) => (t.interrupts ?? []).length > 0);
    if (!interrupted) return transcript;
    input = new Command({ resume: { action: 'approve' } });
  }
  return transcript;
}

const complete = (f: DesignerFacts | null | undefined): f is DesignerFacts =>
  !!f && Array.isArray(f.interferences) && f.disconnected !== undefined && Array.isArray(f.parts) && Array.isArray(f.dimensions);

export interface RunContext {
  opts: RunnerOptions;
  budget: Budget;
  deps: RunnerDeps;
}

/** Run one (prompt, arm, sample): the request, then each follow-up on the same thread. Writes mesh files; returns the record. */
export async function runOne(prompt: EvalPrompt, arm: Arm, sample: number, ctx: RunContext): Promise<RunRecord> {
  const { opts, budget, deps } = ctx;
  const armDir = path.join(opts.outDir, opts.tag, arm);
  fs.mkdirSync(armDir, { recursive: true });
  const base = `${prompt.id}-s${sample}`;
  const brep = deps.runBrep ?? realRunBrep;

  const record: RunRecord = {
    tag: opts.tag,
    arm,
    promptId: prompt.id,
    set: prompt.set,
    sample,
    model: opts.model,
    startedAt: new Date().toISOString(),
    steps: [],
  };

  // Every designer call of this run, in order. The graph state keeps cost and turns but not
  // capped/failed, so the real loop is wrapped to record its results. The designer arm also
  // drops the reviewer here (CADAI_REVIEWER=off is process-wide and arms run concurrently).
  const calls: DesignerResult[] = [];
  const inner: RunDesignerFn = deps.runDesigner ?? (await import('@/lib/agent/designer/run-designer')).runDesigner;
  const runDesigner: RunDesignerFn = async (input, d) => {
    if (budget.exceeded) throw Object.assign(new Error(CAP_ERROR), { name: 'AbortError' });
    const result = await inner(input, arm === 'designer' ? { ...d, review: undefined } : d);
    calls.push(result);
    budget.add(result.costUsd);
    return result;
  };
  const agent = createCadAgent(opts.model, { runDesigner, runBrep: deps.runBrep, makeReviewer: deps.makeReviewer, model: opts.model });
  const threadKey = runCheckpointKey(`evd-${opts.tag}`, `${arm}-${base}-${Date.now()}`);
  const config = { configurable: { thread_id: threadKey }, signal: budget.controller.signal, recursionLimit: 100 };

  const messages = [prompt.request, ...(prompt.followUps ?? []).map((f) => f.text)];
  try {
    for (let step = 0; step < messages.length; step++) {
      if (budget.exceeded) throw new Error(CAP_ERROR);
      const firstCall = calls.length;
      const t0 = Date.now();
      const transcript = await drive(agent, messages[step], config);
      const wallMs = Date.now() - t0;
      const state = (await agent.getState(config as never)).values as AgentStateType;
      const mine = calls.slice(firstCall);
      const last = mine[mine.length - 1];

      const script = state.currentCode ?? '';
      let facts: DesignerFacts | null = state.designerFacts ?? null;
      let stl = state.stlContent ? Buffer.from(state.stlContent, 'utf8') : null;
      let stepData = state.stepContent ? Buffer.from(state.stepContent, 'base64') : null;
      // Re-measure when the state lacks full facts or a mesh (e.g. the check failed before it kept one).
      if (script && (!complete(facts) || !stl)) {
        try {
          const r = await brep(script, { signal: budget.controller.signal, interferences: true, connectivity: true });
          if (!complete(facts)) facts = factsFromRun(r, script);
          if (!stl && r.stl) stl = Buffer.from(stlToAscii(r.stl), 'utf8');
          if (!stepData && r.step) stepData = Buffer.from(r.step, 'base64');
        } catch (e) {
          if (budget.exceeded) throw e;
        }
      }

      const rec: StepRecord = {
        step,
        text: messages[step],
        script,
        facts,
        costUsd: mine.reduce((s, c) => s + (c.costUsd || 0), 0),
        wallMs,
        turns: mine.reduce((s, c) => s + (c.turns || 0), 0),
        checkFailures: state.designerCheckFailures ?? null,
        reviewerFlags: last?.reviewerFlags ?? [],
        transcript,
      };
      const capped = [...mine].reverse().find((c) => c.capped)?.capped;
      if (capped) rec.capped = capped;
      if (last?.failed) rec.failed = true;
      if (stl) {
        rec.stlPath = `${base}-step${step}.stl`;
        fs.writeFileSync(path.join(armDir, rec.stlPath), stl);
      }
      if (stepData) {
        rec.stepPath = `${base}-step${step}.step`;
        fs.writeFileSync(path.join(armDir, rec.stepPath), stepData);
      }
      record.steps.push(rec);
    }
  } catch (e) {
    record.error = budget.exceeded ? `${CAP_ERROR} ($${budget.max})` : errText(e);
  } finally {
    await getCheckpointer().deleteThread(threadKey).catch(() => undefined);
  }
  fs.writeFileSync(path.join(armDir, `${base}.json`), JSON.stringify(record, null, 2));
  return record;
}

// ---------------------------------------------------------------- the whole run

export interface RunSummary {
  records: RunRecord[];
  skipped: number;
  spent: number;
  stoppedByCap: boolean;
}

/** True when a record for this run exists and is final (a cost-cap stop is not final). */
function hasFinalRecord(opts: RunnerOptions, arm: Arm, prompt: EvalPrompt, sample: number): boolean {
  const file = path.join(opts.outDir, opts.tag, arm, `${prompt.id}-s${sample}.json`);
  if (!fs.existsSync(file)) return false;
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as RunRecord;
    return !(typeof r.error === 'string' && r.error.startsWith(CAP_ERROR));
  } catch {
    return false;
  }
}

export async function executeRun(
  prompts: EvalPrompt[],
  opts: RunnerOptions,
  deps: RunnerDeps = {},
  log: (line: string) => void = () => undefined,
): Promise<RunSummary> {
  const chosen = opts.only.length > 0 ? prompts.filter((p) => opts.only.includes(p.id)) : prompts;
  const missing = opts.only.filter((id) => !prompts.some((p) => p.id === id));
  if (missing.length > 0) throw new Error(`unknown prompt id(s): ${missing.join(', ')}`);

  const jobs: Array<{ prompt: EvalPrompt; arm: Arm; sample: number }> = [];
  let skipped = 0;
  for (const prompt of chosen) {
    for (const arm of opts.arms) {
      for (let sample = 0; sample < opts.samples; sample++) {
        if (opts.resume && hasFinalRecord(opts, arm, prompt, sample)) skipped++;
        else jobs.push({ prompt, arm, sample });
      }
    }
  }

  const budget = new Budget(opts.maxUsd);
  const ctx: RunContext = { opts, budget, deps };
  const records: RunRecord[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length && !budget.exceeded) {
      const job = jobs[next++];
      const rec = await runOne(job.prompt, job.arm, job.sample, ctx);
      records.push(rec);
      done++;
      const cost = rec.steps.reduce((s, x) => s + x.costUsd, 0);
      log(`[${done}/${jobs.length}] ${rec.promptId} ${rec.arm} s${rec.sample}: ${rec.steps.length} step(s), $${cost.toFixed(3)}, spent $${budget.spent.toFixed(2)}/${budget.max}${rec.error ? `, ERROR ${rec.error}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, jobs.length)) }, worker));
  return { records, skipped, spent: budget.spent, stoppedByCap: budget.exceeded };
}

// ---------------------------------------------------------------- CLI

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompts = loadSet(args.set);
  // The graph reads these at run time. The reviewer arm keeps the reviewer; with the designer arm
  // alone the env switch matches the app, and mixed runs rely on the runDesigner wrapper.
  process.env.CADAI_PIPELINE = 'designer';
  if (args.arms.length === 1 && args.arms[0] === 'designer') process.env.CADAI_REVIEWER = 'off';
  else delete process.env.CADAI_REVIEWER;

  console.log(`designer eval "${args.tag}": ${prompts.length} prompt(s) from ${args.set}, arms ${args.arms.join(',')}, ${args.samples} sample(s), concurrency ${args.concurrency}, cap $${args.maxUsd}, model ${args.model}`);
  const summary = await executeRun(prompts, args, {}, console.log);
  for (const arm of args.arms) {
    const rs = summary.records.filter((r) => r.arm === arm);
    const steps = rs.flatMap((r) => r.steps);
    console.log(`${arm}: ${rs.length} run(s), ${steps.length} step(s), cost $${steps.reduce((s, x) => s + x.costUsd, 0).toFixed(3)}, median step ${(median(steps.map((s) => s.wallMs)) / 1000).toFixed(0)} s, capped ${steps.filter((s) => s.capped).length}, errors ${rs.filter((r) => r.error).length}`);
  }
  console.log(`skipped ${summary.skipped} existing, spent $${summary.spent.toFixed(2)}${summary.stoppedByCap ? ' (STOPPED: cost cap reached; re-run with --resume to finish)' : ''}`);
  console.log(`records: ${path.join(args.outDir, args.tag)}`);
  if (summary.stoppedByCap) process.exitCode = 2;
}

if (process.argv[1] && /runner\.ts$/.test(process.argv[1])) {
  main().then(() => process.exit(process.exitCode ?? 0), (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
