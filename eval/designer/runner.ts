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
import { createHash, randomUUID } from 'crypto';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import sharp from 'sharp';

for (const f of ['.env', '.env.local']) {
  try { process.loadEnvFile(f); } catch { /* absent is fine */ }
}

import { createDesignerAgent } from '@/lib/agent/designer/graph';
import type { AgentStateType } from '@/lib/agent/designer/state';
import { DEFAULT_MODEL, isOfferedModel } from '@/lib/agent/models';
import { runBrep as realRunBrep } from '@/lib/engine/brep-runner';
import { factsFromRun } from '@/lib/agent/designer/tools';
import { stlToAscii } from '@/lib/brep/measurements';
import { graphRecursionLimit } from '@/lib/agent/run-limits';
import { getDb, closeDb } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { loadRunInput } from '@/lib/persist/run-input';
import { DesignStore } from '@/lib/persist/designs';
import { put as putArtifact, get as getArtifact } from '@/lib/runs/owner-artifacts';
import { getObjectStore, setObjectStore } from '@/lib/storage/object-store';
import { abortRun } from '@/lib/runs/run-control';
import { streamRun } from '@/lib/runs/stream-run';
import { REFUSAL } from '@/lib/persist/phrases';
import { StoreError } from '@/lib/persist/types';
import type { DesignerNodeDeps } from '@/lib/agent/designer/node';
import type { DesignerCheckDeps } from '@/lib/agent/designer/check';
import type { DesignerTriageDeps } from '@/lib/agent/designer/triage';
import type { DesignerAgentDeps } from '@/lib/agent/designer/graph';
import type { DesignerFacts, DesignerResult, RunDesignerFn } from '@/lib/agent/designer/types';
import type { Arm, EvalPrompt, RunRecord, StepRecord } from './types';

export const DEFAULT_RESULTS_DIR = path.join(__dirname, 'results');
const SETS_DIR = path.join(__dirname, 'sets');
const ARMS: Arm[] = ['designer', 'reviewer'];

export const EVAL_OWNER_KEY = createHash('sha256').update('cadai-eval').digest('hex');

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
export type RunnerDeps = Pick<DesignerNodeDeps & DesignerCheckDeps, 'runDesigner' | 'runBrep' | 'makeReviewer'> & {
  classify?: DesignerTriageDeps['classify'];
};

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

export const CAP_ERROR = 'cost cap reached';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);

const complete = (f: DesignerFacts | null | undefined): f is DesignerFacts =>
  !!f && Array.isArray(f.interferences) && f.disconnected !== undefined && Array.isArray(f.parts) && Array.isArray(f.dimensions);

export interface RunContext {
  opts: RunnerOptions;
  budget: Budget;
  deps: RunnerDeps;
}

interface SseResult {
  transcript: string;
  endEvent: {
    t: 'end';
    seq: number;
    status: 'done' | 'failed' | 'cancelled';
    reply: { messageId: string; kind: string; markdown: string };
    designVersion?: number;
  } | null;
}

async function readSseStream(response: Response): Promise<SseResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let transcript = '';
  let endEvent: SseResult['endEvent'] = null;

  const handleBlock = (block: string) => {
    const trimmed = block.trim();
    if (!trimmed.startsWith('data:')) return;
    const jsonStr = trimmed.slice(5).trim();
    try {
      const ev = JSON.parse(jsonStr) as Record<string, unknown>;
      if (ev.t === 'delta' && typeof ev.text === 'string') {
        transcript += ev.text;
      } else if (ev.t === 'end') {
        endEvent = ev as SseResult['endEvent'];
        const md = endEvent?.reply?.markdown;
        if (md && !transcript.includes(md)) {
          transcript += `${transcript && !transcript.endsWith('\n') ? '\n' : ''}${md}\n`;
        }
      }
    } catch {
      // ignore parse errors
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      handleBlock(part);
    }
  }
  if (buffer.trim()) {
    handleBlock(buffer);
  }

  return { transcript, endEvent };
}

async function uploadAttachments(ownerKey: string, filePaths?: string[]): Promise<string[]> {
  if (!filePaths || filePaths.length === 0) return [];
  const artifactIds: string[] = [];
  for (const file of filePaths) {
    const raw = fs.readFileSync(file);
    const png = await sharp(raw, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const id = await putArtifact(ownerKey, 'image', png);
    artifactIds.push(id);
  }
  return artifactIds;
}

// ---------------------------------------------------------------- one run

/** Run one (prompt, arm, sample): the request, then each follow-up on the same thread. Writes mesh files; returns the record. */
export async function runOne(prompt: EvalPrompt, arm: Arm, sample: number, ctx: RunContext): Promise<RunRecord> {
  const { opts, budget, deps } = ctx;
  const armDir = path.join(opts.outDir, opts.tag, arm);
  fs.mkdirSync(armDir, { recursive: true });
  const base = `${prompt.id}-s${sample}`;
  const brep = deps.runBrep ?? realRunBrep;
  const db = getDb();
  const ownerKey = EVAL_OWNER_KEY;
  const threadId = randomUUID();

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

  interface RecordedCall {
    result: DesignerResult;
    priorScriptSha: string | null;
  }
  const calls: RecordedCall[] = [];
  const inner: RunDesignerFn = deps.runDesigner ?? (await import('@/lib/agent/designer/run-designer')).runDesigner;
  let activeRunId: string | null = null;

  const onBudgetAbort = () => {
    if (activeRunId) {
      abortRun(activeRunId);
    }
  };
  budget.controller.signal.addEventListener('abort', onBudgetAbort, { once: true });

  const runDesigner: RunDesignerFn = async (input, d) => {
    if (budget.exceeded) {
      if (activeRunId) abortRun(activeRunId);
      throw Object.assign(new Error(CAP_ERROR), { name: 'AbortError' });
    }
    const priorScriptSha = typeof input.priorScript === 'string' && input.priorScript
      ? createHash('sha256').update(input.priorScript).digest('hex')
      : null;
    const result = await inner(input, {
      ...d,
      review: arm === 'designer' ? undefined : d?.review,
    });
    calls.push({ result, priorScriptSha });
    if (typeof result.costUsd === 'number' && result.costUsd > 0) {
      budget.add(result.costUsd);
    }
    return result;
  };

  const agentDeps: DesignerAgentDeps = {
    runDesigner,
    runBrep: deps.runBrep,
    makeReviewer: deps.makeReviewer,
    model: opts.model,
    ...(deps.classify ? { classify: deps.classify } : {}),
  };

  const agent = createDesignerAgent(opts.model, agentDeps);

  const stepItems: Array<{ text: string; attachments?: string[] }> = [
    { text: prompt.request, attachments: prompt.attachments },
    ...(prompt.followUps ?? []).map((f) => ({ text: f.text, attachments: f.attachments })),
  ];

  let lastDesignVersion: number | null = null;

  try {
    for (let step = 0; step < stepItems.length; step++) {
      if (budget.exceeded) throw new Error(`${CAP_ERROR} ($${budget.max})`);
      const firstCall = calls.length;
      const t0 = Date.now();
      const item = stepItems[step];
      const clientMessageId = randomUUID();
      const viewingVersion = step === 0 ? null : lastDesignVersion;

      const attachmentIds = await uploadAttachments(ownerKey, item.attachments);

      let r:
        | { replay: true; runId: string }
        | {
            replay: false;
            runId: string;
            threadId: string;
            baseVersion: number | null;
            userMessageId: string;
          };

      try {
        r = await db.transaction((q) =>
          DbRunStore.start(q, {
            ownerKey,
            threadId,
            clientMessageId,
            text: item.text,
            viewingVersion,
            attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
            model: opts.model,
          })
        );
      } catch (err) {
        if (err instanceof StoreError) {
          throw new Error(`${err.code}: ${err.message}`);
        }
        throw err;
      }

      if (r.replay) {
        throw new Error(`Unexpected replay for run ${r.runId}`);
      }

      activeRunId = r.runId;
      if (budget.controller.signal.aborted) {
        abortRun(activeRunId);
      }

      const capturedState: { values: AgentStateType | null } = { values: null };
      let graphError: unknown = null;
      let sseResult: SseResult;

      try {
        const runRow = await DbRunStore.get(db, r.runId);
        if (!runRow) throw new Error(`Run ${r.runId} not found after start`);
        const deadlineAt = runRow.deadlineAt;

        const input = await loadRunInput(
          db,
          ownerKey,
          threadId,
          r.baseVersion,
          attachmentIds
        );

        const lcMessages = input.messages.map((m) =>
          m.role === 'user'
            ? new HumanMessage({ content: m.content })
            : new AIMessage({ content: m.content })
        );

        const graphInput = {
          messages: lcMessages,
          baseVersion: input.baseVersion,
          baseBody: input.baseBody,
          baseRequest: input.baseRequest,
          attachments: input.attachments,
          baseEdits: input.baseEdits,
        };

        const response = streamRun({
          runId: r.runId,
          threadId,
          ownerKey,
          deadlineAt,
          invoke: async (signal) => {
            const graphStream = await agent.stream(graphInput, {
              configurable: { ownerKey, threadId, runId: r.runId, deadlineAt },
              recursionLimit: graphRecursionLimit(),
              streamMode: ['updates', 'messages', 'custom', 'tasks', 'values'],
              signal,
            });
            async function* tapValues(source: AsyncIterable<unknown>) {
              try {
                for await (const chunk of source) {
                  if (Array.isArray(chunk) && chunk[0] === 'values') {
                    capturedState.values = chunk[1] as AgentStateType;
                  }
                  yield chunk;
                }
              } catch (err) {
                graphError = err;
                throw err;
              }
            }
            return tapValues(graphStream as AsyncIterable<unknown>);
          },
        });

        sseResult = await readSseStream(response);
      } catch (err) {
        try {
          await db.transaction((q) =>
            DbRunStore.terminate(q, r.runId, 'failed', 'internal')
          );
        } catch (termErr) {
          console.error('Failed to terminate run after setup error:', termErr);
        }
        throw err;
      } finally {
        activeRunId = null;
      }

      if (graphError && !budget.exceeded) {
        throw graphError;
      }

      const wallMs = Date.now() - t0;
      const endEvent = sseResult.endEvent;

      if (typeof endEvent?.designVersion === 'number') {
        lastDesignVersion = endEvent.designVersion;
      }

      // Read run row for cost, time, turns
      const finalRunRow = await DbRunStore.get(db, r.runId);
      const costUsd = Number(finalRunRow?.costUsd ?? 0);
      const recordedWallMs = finalRunRow?.wallMs ?? wallMs;
      const turns = finalRunRow?.turns ?? 0;

      const mine = calls.slice(firstCall);
      const designerCostThisStep = mine.reduce(
        (sum, c) => sum + (typeof c.result.costUsd === 'number' && c.result.costUsd > 0 ? c.result.costUsd : 0),
        0
      );
      const remainder = Math.max(0, costUsd - designerCostThisStep);
      if (remainder > 0) {
        budget.add(remainder);
      }

      if ((finalRunRow?.status === 'cancelled' || endEvent?.status === 'cancelled') && budget.exceeded) {
        throw Object.assign(new Error(`${CAP_ERROR} ($${budget.max})`), { name: 'AbortError' });
      }

      // Read committed design if one exists
      let script = '';
      let facts: DesignerFacts | null = capturedState.values?.designerFacts ?? null;
      let stl: Buffer | null = null;
      let stepData: Buffer | null = null;

      if (endEvent?.designVersion) {
        const design = await DesignStore.get(db, ownerKey, threadId, endEvent.designVersion);
        if (design) {
          script = design.body;
          if (design.facts) facts = design.facts as DesignerFacts;
          if (design.stlArtifact) {
            const row = await getArtifact(db, ownerKey, design.stlArtifact);
            if (row) {
              const stream = await getObjectStore().openStream(row.objectKey);
              if (stream) {
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                stl = Buffer.concat(chunks);
              }
            }
          }
          if (design.stepArtifact) {
            const row = await getArtifact(db, ownerKey, design.stepArtifact);
            if (row) {
              const stream = await getObjectStore().openStream(row.objectKey);
              if (stream) {
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                stepData = Buffer.concat(chunks);
              }
            }
          }
        }
      }

      // Re-measure fallback
      if (script && (!complete(facts) || !stl)) {
        try {
          const res = await brep(script, { signal: budget.controller.signal, interferences: true, connectivity: true });
          if (!complete(facts)) facts = factsFromRun(res, script);
          if (!stl && res.stl) stl = Buffer.from(stlToAscii(res.stl), 'utf8');
          if (!stepData && res.step) stepData = Buffer.from(res.step, 'base64');
        } catch (e) {
          if (budget.exceeded) throw e;
        }
      }

      const last = mine[mine.length - 1]?.result;

      const rec: StepRecord = {
        step,
        text: item.text,
        script,
        facts,
        costUsd,
        wallMs: recordedWallMs,
        turns,
        checkFailures: capturedState.values?.designerCheckFailures ?? null,
        reviewerFlags: last?.reviewerFlags ?? [],
        transcript: sseResult.transcript,
        priorScriptSha: calls[firstCall]?.priorScriptSha ?? null,
        runId: r.runId,
        designVersion: endEvent?.designVersion ?? null,
        endStatus: endEvent?.status ?? finalRunRow?.status,
        replyKind: endEvent?.reply?.kind,
        refused: endEvent?.reply?.markdown === REFUSAL,
      };

      const capped = [...mine].reverse().find((c) => c.result.capped)?.result.capped;
      if (capped) {
        rec.capped = capped;
      } else if ((finalRunRow?.status === 'cancelled' || endEvent?.status === 'cancelled') && budget.exceeded) {
        rec.capped = 'cost';
      }

      if (last?.failed || finalRunRow?.status === 'failed' || endEvent?.status === 'failed') rec.failed = true;

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
    budget.controller.signal.removeEventListener('abort', onBudgetAbort);
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
  process.env.CADAI_EVAL_RUNNER = '1';
  process.env.CADAI_DB = 'pglite';
  const appDir = path.join(opts.outDir, opts.tag, '.app');
  fs.mkdirSync(appDir, { recursive: true });
  process.env.CADAI_RUN_DIR = appDir;
  process.env.CADAI_PGLITE_DIR = path.join(appDir, 'pglite');

  // Reset database connection if previously opened for another directory
  if (globalThis.__cadaiDb) {
    await closeDb();
  }
  setObjectStore(undefined);

  const db = getDb();
  await db.query('SELECT 1');

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
  process.env.CADAI_EVAL_RUNNER = '1';
  const args = parseArgs(process.argv.slice(2));
  const prompts = loadSet(args.set);

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
