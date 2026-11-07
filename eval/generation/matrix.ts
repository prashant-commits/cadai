/**
 * Kernel comparison matrix: prompts x cells x samples through the real agent
 * graph, one child process (eval/generation/run.ts) per run so per-cell env
 * vars never leak between concurrent runs.
 *
 *   npm run eval:matrix -- --cells eval/generation/cells-brep.json --tag brep1
 *   npm run eval:matrix -- --cells eval/generation/cells-brep.json --only brep-adaptive --limit 1 --samples 1 --tag smoke
 *   npm run eval:matrix -- --tag brep1 --report      # rebuild the markdown from the jsonl
 *
 * Flags: --cells <file> (required unless --report or --rescore), --prompts <file>, --samples N (2),
 * --concurrency N (2), --tag, --limit N (first N prompts), --only a,b (cells), --report,
 * --results-dir <dir> (default eval/results), --rescore <tag>.
 *
 * --rescore <tag> recomputes the parameter, STEP and workable metrics from the saved
 * final scripts of matrix-<tag> (no model calls; geometry only, through CADAI_GEO_URL
 * when set) and writes matrix-<tag>-rescored.jsonl and .md beside it.
 *
 * One JSON line per finished run is appended to eval/results/matrix-<tag>.jsonl.
 * A re-run skips runs already there, so an interrupted matrix resumes. The
 * report goes to eval/results/matrix-<tag>.md.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CELL_MODEL, crashReason, latestRows, parseJsonl, pendingRuns, planRuns, renderReport, runKey, validateCells,
  type Cell, type MatrixRow, type PlannedRun,
} from './matrix-lib';
import type { GenerationMetrics } from './metrics';
import { defaultRescoreDeps, findScript, rescoreRow } from './rescore';

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_RESULTS = path.join(ROOT, 'eval', 'results');
const CHILD_TIMEOUT_MS = 30 * 60_000;

interface Args {
  cells?: string; prompts: string; samples: number; concurrency: number; tag: string;
  limit: number; only: string[]; report: boolean; resultsDir: string; rescore?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    prompts: path.join(__dirname, 'prompts.json'), samples: 2, concurrency: 2, tag: 'run',
    limit: Infinity, only: [], report: false, resultsDir: DEFAULT_RESULTS,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--cells') a.cells = argv[++i];
    else if (v === '--prompts') a.prompts = path.resolve(argv[++i]);
    else if (v === '--samples') a.samples = Number(argv[++i]);
    else if (v === '--concurrency') a.concurrency = Number(argv[++i]);
    else if (v === '--tag') a.tag = argv[++i];
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v === '--only') a.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === '--report') a.report = true;
    else if (v === '--results-dir') a.resultsDir = path.resolve(argv[++i]);
    else if (v === '--rescore') a.rescore = argv[++i];
  }
  return a;
}

/** The run.ts flags for one planned run. */
export function childArgs(run: PlannedRun, outDir: string, resultFile: string, tag: string, promptsFile: string): string[] {
  const c = run.cell;
  const args = [
    'eval/generation/run.ts', '--no-langfuse', '--no-delay',
    '--tag', `${tag}-${c.name}-s${run.sample}`, '--model', c.model ?? DEFAULT_CELL_MODEL,
    '--only', run.promptId, '--prompts', promptsFile, '--kernel', c.kernel, '--out-dir', outDir, '--result', resultFile,
  ];
  if (c.thinking) args.push('--thinking', c.thinking);
  if (c.effort) args.push('--effort', c.effort);
  if (c.attempts) args.push('--attempts', String(c.attempts));
  return args;
}

function runChild(run: PlannedRun, outDir: string, tag: string, promptsFile: string): Promise<MatrixRow> {
  const base = { cell: run.cell.name, promptId: run.promptId, sample: run.sample, at: new Date().toISOString() };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-matrix-'));
  const resultFile = path.join(tmp, 'row.json');
  return new Promise((resolve) => {
    const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), childArgs(run, outDir, resultFile, tag, promptsFile), {
      cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (c: Buffer) => { tail = (tail + c.toString()).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      let metrics: GenerationMetrics | null = null;
      try { metrics = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as GenerationMetrics; } catch { /* crashed */ }
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(metrics ? { ...base, metrics } : { ...base, metrics: null, crashed: crashReason(code, tail) });
    });
  });
}

async function rescoreMatrix(args: Args) {
  const tag = args.rescore!;
  const source = path.join(args.resultsDir, `matrix-${tag}.jsonl`);
  if (!fs.existsSync(source)) throw new Error(`${source} not found`);
  const rows = latestRows(parseJsonl(fs.readFileSync(source, 'utf8')));
  const scripts = path.join(args.resultsDir, `matrix-${tag}`);
  const out = path.join(args.resultsDir, `matrix-${tag}-rescored.jsonl`);
  fs.writeFileSync(out, '');
  const done: MatrixRow[] = [];
  const queue = [...rows];
  console.log(`rescore ${tag}: ${rows.length} run(s), scripts in ${scripts}, concurrency ${args.concurrency}.`);
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const script = findScript(scripts, tag, row);
      if (!script && row.metrics) console.warn(`no saved script for ${runKey(row.cell, row.promptId, row.sample)}: kept as it was`);
      const next = await rescoreRow(row, script && fs.readFileSync(script, 'utf8'), defaultRescoreDeps);
      fs.appendFileSync(out, JSON.stringify(next) + '\n');
      done.push(next);
      const m = next.metrics;
      console.log(`${runKey(row.cell, row.promptId, row.sample)}: workable ${row.metrics?.workable} -> ${m?.workable} (${m?.failureStage})`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  const order = [...new Set(rows.map((r) => r.cell))];
  const md = path.join(args.resultsDir, `matrix-${tag}-rescored.md`);
  fs.writeFileSync(md, renderReport(`${tag}-rescored`, done, order));
  console.log(`wrote ${out}\nwrote ${md}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rescore) return rescoreMatrix(args);
  const RESULTS = args.resultsDir;
  fs.mkdirSync(RESULTS, { recursive: true });
  const jsonl = path.join(RESULTS, `matrix-${args.tag}.jsonl`);
  const md = path.join(RESULTS, `matrix-${args.tag}.md`);
  const existing = fs.existsSync(jsonl) ? parseJsonl(fs.readFileSync(jsonl, 'utf8')) : [];

  if (args.report) {
    fs.writeFileSync(md, renderReport(args.tag, existing));
    console.log(`wrote ${md}`);
    return;
  }
  if (!args.cells) throw new Error('--cells <file.json> is required');

  const allCells = validateCells(JSON.parse(fs.readFileSync(args.cells, 'utf8')));
  const cells: Cell[] = args.only.length ? allCells.filter((c) => args.only.includes(c.name)) : allCells;
  if (cells.length === 0) throw new Error(`no cell matches --only ${args.only.join(',')}`);
  const prompts = (JSON.parse(fs.readFileSync(args.prompts, 'utf8')) as Array<{ id: string; prompt: string }>).slice(0, args.limit);

  const plan = planRuns(cells, prompts, args.samples);
  const todo = pendingRuns(plan, existing);
  console.log(`matrix ${args.tag}: ${plan.length} run(s) planned, ${plan.length - todo.length} already done, ${todo.length} to go ` +
    `(concurrency ${args.concurrency}).`);

  const outDir = path.join(RESULTS, `matrix-${args.tag}`);
  const queue = [...todo];
  const worker = async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      const row = await runChild(run, outDir, args.tag, args.prompts);
      fs.appendFileSync(jsonl, JSON.stringify(row) + '\n');
      const m = row.metrics;
      console.log(`${runKey(row.cell, row.promptId, row.sample)}: ${row.crashed ? `CRASH ${row.crashed}` : `workable=${m?.workable} stage=${m?.failureStage} ${m?.wallMs} ms`}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));

  const rows = parseJsonl(fs.readFileSync(jsonl, 'utf8'));
  fs.writeFileSync(md, renderReport(args.tag, rows, cells.map((c) => c.name)));
  console.log(`wrote ${jsonl}\nwrote ${md}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
