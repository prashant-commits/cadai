/**
 * Pure parts of the kernel-comparison matrix: the run plan, resume, and the
 * markdown report. No processes and no model calls, so it is unit-tested directly.
 */
import { LIVE_PARAM_SHARE, type GenerationMetrics } from './metrics';

export interface Cell {
  name: string;
  kernel: 'openscad' | 'brep';
  thinking?: 'off' | 'adaptive';
  effort?: 'low' | 'medium' | 'high';
  model?: string;
  attempts?: number;
}

export const DEFAULT_CELL_MODEL = 'claude-haiku-5.5';

/** One line of matrix-<tag>.jsonl. `metrics` is null when the child crashed before writing a row. */
export interface MatrixRow {
  cell: string;
  promptId: string;
  sample: number;
  metrics: GenerationMetrics | null;
  /** Why the child died (stderr tail). A crashed run is retried on resume. */
  crashed?: string;
  at: string;
}

export interface PlannedRun { cell: Cell; promptId: string; prompt: string; sample: number }

export const runKey = (cell: string, promptId: string, sample: number) => `${cell}|${promptId}|${sample}`;
const keyOf = (r: { cell: string; promptId: string; sample: number }) => runKey(r.cell, r.promptId, r.sample);

export function validateCells(raw: unknown): Cell[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('cells file must be a non-empty JSON array');
  const seen = new Set<string>();
  return raw.map((c, i) => {
    const cell = c as Partial<Cell>;
    if (!cell || typeof cell.name !== 'string' || !cell.name) throw new Error(`cell ${i}: missing name`);
    if (cell.kernel !== 'openscad' && cell.kernel !== 'brep') throw new Error(`cell ${cell.name}: kernel must be openscad or brep`);
    if (seen.has(cell.name)) throw new Error(`duplicate cell name ${cell.name}`);
    seen.add(cell.name);
    return cell as Cell;
  });
}

/** Cells x prompts x samples, in a stable order. */
export function planRuns(cells: Cell[], prompts: Array<{ id: string; prompt: string }>, samples: number): PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (let sample = 1; sample <= samples; sample++) {
    for (const p of prompts) {
      for (const cell of cells) runs.push({ cell, promptId: p.id, prompt: p.prompt, sample });
    }
  }
  return runs;
}

/** Runs not yet finished. A crashed row does not count as finished. */
export function pendingRuns(plan: PlannedRun[], existing: MatrixRow[]): PlannedRun[] {
  const done = new Set(existing.filter((r) => !r.crashed && r.metrics).map(keyOf));
  return plan.filter((r) => !done.has(runKey(r.cell.name, r.promptId, r.sample)));
}

export function parseJsonl(text: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as MatrixRow); } catch { /* a torn last line from a killed run */ }
  }
  return rows;
}

/** The latest row per run, so a retried crash replaces its earlier row. */
export function latestRows(rows: MatrixRow[]): MatrixRow[] {
  const byKey = new Map<string, MatrixRow>();
  for (const r of rows) byKey.set(keyOf(r), r);
  return [...byKey.values()];
}

const pct = (k: number, n: number) => (n === 0 ? '-' : `${k}/${n} (${Math.round((100 * k) / n)}%)`);

function rate(rows: MatrixRow[], pick: (m: GenerationMetrics) => boolean | null | undefined): string {
  const vals = rows.map((r) => (r.metrics ? pick(r.metrics) : false)).filter((v): v is boolean => v !== null && v !== undefined);
  return pct(vals.filter(Boolean).length, vals.length);
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const seconds = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);

function liveShare(rows: MatrixRow[]): string {
  let live = 0;
  let total = 0;
  for (const r of rows) {
    const m = r.metrics;
    if (!m?.paramCount || m.liveParams === undefined) continue;
    live += m.liveParams;
    total += m.paramCount;
  }
  return total === 0 ? '-' : `${live}/${total} (${Math.round((100 * live) / total)}%)`;
}

function meanCost(rows: MatrixRow[]): string {
  const costs = rows.map((r) => r.metrics?.costUsd).filter((c): c is number => typeof c === 'number');
  if (costs.length === 0) return '-';
  return `$${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(4)}`;
}

const cellText = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The markdown report: per-cell summary, per-prompt workable grid, then every failed run. */
export function renderReport(tag: string, all: MatrixRow[], cellOrder?: string[]): string {
  const rows = latestRows(all);
  const cells = cellOrder?.length ? cellOrder : [...new Set(rows.map((r) => r.cell))];
  const byCell = (c: string) => rows.filter((r) => r.cell === c);

  const out: string[] = [`# Matrix ${tag}`, '', `${rows.length} run(s) over ${cells.length} cell(s).`, ''];
  const header = `| metric | ${cells.join(' | ')} |`;
  const rule = `|---|${cells.map(() => '---').join('|')}|`;
  const line = (label: string, f: (rows: MatrixRow[]) => string) =>
    `| ${label} | ${cells.map((c) => f(byCell(c))).join(' | ')} |`;
  const wall = (rs: MatrixRow[]) => rs.map((r) => r.metrics?.wallMs).filter((v): v is number => typeof v === 'number');
  const brepRows = (rs: MatrixRow[]) => rs.filter((r) => r.metrics?.kernel === 'brep');

  out.push(header, rule,
    line('runs', (rs) => String(rs.length)),
    line('**workable**', (rs) => rate(rs, (m) => m.workable ?? false)),
    line('specOk', (rs) => rate(rs, (m) => m.specOk)),
    line('geometry ok', (rs) => rate(rs, (m) => (m.kernel === 'brep' ? m.brepOk === true : m.compileOk))),
    line('extents ok', (rs) => rate(rs, (m) => m.extentsOk)),
    line('floor ok', (rs) => rate(rs, (m) => m.floorOk)),
    line('no floating', (rs) => rate(rs, (m) => (m.floatingCount === null ? null : m.floatingCount === 0))),
    line('stepOk (B-rep)', (rs) => (brepRows(rs).length ? rate(brepRows(rs), (m) => m.stepOk === true) : '-')),
    line(`live params (>= ${LIVE_PARAM_SHARE * 100}% per run)`, liveShare),
    line('median wall', (rs) => seconds(percentile(wall(rs), 50))),
    line('p90 wall', (rs) => seconds(percentile(wall(rs), 90))),
    line('mean cost / run', meanCost),
    '');

  const promptIds = [...new Set(rows.map((r) => r.promptId))];
  out.push('## Workable per prompt', '', header.replace('metric', 'prompt'), rule);
  for (const id of promptIds) {
    const cols = cells.map((c) => {
      const rs = rows.filter((r) => r.cell === c && r.promptId === id);
      return rs.length === 0 ? '-' : `${rs.filter((r) => r.metrics?.workable).length}/${rs.length}`;
    });
    out.push(`| ${id} | ${cols.join(' | ')} |`);
  }
  out.push('');

  const failed = rows.filter((r) => r.crashed || !r.metrics?.workable)
    .sort((a, b) => cells.indexOf(a.cell) - cells.indexOf(b.cell) || a.promptId.localeCompare(b.promptId) || a.sample - b.sample);
  out.push(`## Failed runs (${failed.length})`, '');
  if (failed.length) {
    out.push('| cell | prompt | sample | failureStage | failureDetail |', '|---|---|---|---|---|');
    for (const r of failed) {
      const stage = r.crashed ? 'crash' : (r.metrics?.failureStage ?? 'unknown');
      const detail = r.crashed ?? r.metrics?.failureDetail ?? '';
      out.push(`| ${r.cell} | ${r.promptId} | ${r.sample} | ${stage} | ${cellText(detail).slice(0, 240)} |`);
    }
    out.push('');
  }
  return out.join('\n');
}
