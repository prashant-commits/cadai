/**
 * Compare generation-eval arms and print a markdown report.
 *
 *   npm run eval:compare -- --arm A=eval/results/baseline-A-*.jsonl,eval/results/baseline-A2-*.jsonl --arm B=...
 *
 * Globs are expanded here. Several files in one arm are merged by prompt id;
 * a later file replaces an earlier row with the same id. A `.jsonl` file is
 * one metrics row per line. A `.json` file is a row, an array of rows, or
 * `{ rows: [...] }` as written by eval:generation.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface CompareRow {
  id: string;
  compileOk: boolean;
  extentsOk: boolean | null;
  shellsOk: boolean | null;
  floorOk: boolean | null;
  visualMatch: boolean | null;
  errorKinds: string[];
  wallMs: number;
  reviewRounds: number;
}

export interface CompareArm {
  label: string;
  rows: CompareRow[];
}

interface ArmSpec {
  label: string;
  patterns: string[];
}

function rate(flags: Array<boolean | null>): string {
  const vals = flags.filter((value): value is boolean => value !== null);
  return `${vals.filter(Boolean).length}/${vals.length}`;
}

function mean(values: number[]): string {
  if (values.length === 0) return '0.0';
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return (Math.round(avg * 10) / 10).toFixed(1);
}

function cell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asRow(value: unknown): CompareRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<CompareRow>;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  const kinds = Array.isArray(row.errorKinds) ? row.errorKinds.filter((kind): kind is string => typeof kind === 'string') : [];
  return {
    id: row.id,
    compileOk: row.compileOk === true,
    extentsOk: asBool(row.extentsOk),
    shellsOk: asBool(row.shellsOk),
    floorOk: asBool(row.floorOk),
    visualMatch: asBool(row.visualMatch),
    errorKinds: kinds,
    wallMs: typeof row.wallMs === 'number' && Number.isFinite(row.wallMs) ? row.wallMs : 0,
    reviewRounds: typeof row.reviewRounds === 'number' && Number.isFinite(row.reviewRounds) ? row.reviewRounds : 0,
  };
}

export function parseArmArgs(argv: string[]): ArmSpec[] {
  const arms: ArmSpec[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === '--arm') value = argv[++i];
    else if (arg.startsWith('--arm=')) value = arg.slice('--arm='.length);
    else continue;
    if (!value) throw new Error('--arm needs LABEL=glob[,glob...]');
    const eq = value.indexOf('=');
    if (eq <= 0) throw new Error(`--arm must be LABEL=glob, got ${value}`);
    const label = value.slice(0, eq);
    const patterns = value.slice(eq + 1).split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    if (patterns.length === 0) throw new Error(`arm ${label} has no files`);
    arms.push({ label, patterns });
  }
  if (arms.length === 0) throw new Error('pass at least one --arm LABEL=glob');
  return arms;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function segmentRegExp(segment: string): RegExp {
  const body = segment.split('*').map(escapeRegex).join('[^/]*');
  return new RegExp(`^${body}$`);
}

/** Expand one glob. `*` matches inside a single path segment. A path with no `*` is one file. */
export function expandGlob(pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, '/');
  if (!normalized.includes('*')) {
    const abs = path.resolve(pattern);
    return fs.existsSync(abs) && fs.statSync(abs).isFile() ? [abs] : [];
  }
  const abs = path.resolve(normalized).replace(/\\/g, '/');
  const segments = abs.split('/');
  const star = segments.findIndex((segment) => segment.includes('*'));
  if (star < 0) return [];
  const base = segments.slice(0, star).join('/') || '.';
  return walk(base, segments.slice(star)).sort((a, b) => a.localeCompare(b));
}

function walk(dir: string, segments: string[]): string[] {
  if (segments.length === 0 || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const [head, ...tail] = segments;
  const hits: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!segmentRegExp(head).test(name)) continue;
    const child = path.join(dir, name);
    let isFile = false;
    let isDir = false;
    try {
      const stat = fs.statSync(child);
      isFile = stat.isFile();
      isDir = stat.isDirectory();
    } catch {
      continue;
    }
    if (tail.length === 0) {
      if (isFile) hits.push(child);
    } else if (isDir) {
      hits.push(...walk(child, tail));
    }
  }
  return hits;
}

export function readResultFile(file: string): CompareRow[] {
  const text = fs.readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.jsonl')) {
    const rows: CompareRow[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = asRow(JSON.parse(trimmed));
      if (row) rows.push(row);
    }
    return rows;
  }
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed.map(asRow).filter((row): row is CompareRow => row !== null);
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)) {
    return (parsed as { rows: unknown[] }).rows.map(asRow).filter((row): row is CompareRow => row !== null);
  }
  const single = asRow(parsed);
  return single ? [single] : [];
}

/** Later files replace an earlier row with the same prompt id. */
export function loadArm(patterns: string[]): CompareRow[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = expandGlob(pattern);
    if (matches.length === 0) throw new Error(`no files matched ${pattern}`);
    files.push(...matches);
  }
  const byId = new Map<string, CompareRow>();
  for (const file of files) {
    for (const row of readResultFile(file)) byId.set(row.id, row);
  }
  return [...byId.values()];
}

function errorFree(row: CompareRow): boolean {
  return row.compileOk && row.errorKinds.length === 0;
}

function promptCell(row: CompareRow | undefined): string {
  if (!row) return '-';
  if (errorFree(row)) return 'ok';
  if (row.errorKinds.length === 0) return 'compile';
  return row.errorKinds.join(', ');
}

export function buildReport(arms: CompareArm[]): string {
  const header = '| arm | n | error-free | compileOk | extentsOk | shellsOk | floorOk | visualMatch | mean wall s | mean review rounds |';
  const rule = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const table = arms.map((arm) => {
    const rows = arm.rows;
    return `| ${cell(arm.label)} | ${rows.length} | ${rate(rows.map(errorFree))} | ${rate(rows.map((row) => row.compileOk))} | ${rate(rows.map((row) => row.extentsOk))} | ${rate(rows.map((row) => row.shellsOk))} | ${rate(rows.map((row) => row.floorOk))} | ${rate(rows.map((row) => row.visualMatch))} | ${mean(rows.map((row) => row.wallMs / 1000))} | ${mean(rows.map((row) => row.reviewRounds))} |`;
  });

  const kinds = [...new Set(arms.flatMap((arm) => arm.rows.flatMap((row) => row.errorKinds)))].sort();
  const kindLines = kinds.length === 0
    ? ['## Error kinds', '', 'No error kinds.']
    : [
        '## Error kinds',
        '',
        `| arm | ${kinds.map(cell).join(' | ')} |`,
        `| --- | ${kinds.map(() => '---').join(' | ')} |`,
        ...arms.map((arm) => {
          const counts = new Map<string, number>();
          for (const row of arm.rows) {
            for (const kind of row.errorKinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
          }
          return `| ${cell(arm.label)} | ${kinds.map((kind) => String(counts.get(kind) ?? 0)).join(' | ')} |`;
        }),
      ];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const arm of arms) {
    for (const row of arm.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      ids.push(row.id);
    }
  }
  const promptLines = [
    '## Prompts',
    '',
    `| prompt | ${arms.map((arm) => cell(arm.label)).join(' | ')} |`,
    `| --- | ${arms.map(() => '---').join(' | ')} |`,
    ...ids.map((id) => {
      const cells = arms.map((arm) => promptCell(arm.rows.find((row) => row.id === id)));
      return `| ${cell(id)} | ${cells.join(' | ')} |`;
    }),
  ];

  return [...[header, rule, ...table], '', ...kindLines, '', ...promptLines].join('\n');
}

function main() {
  const specs = parseArmArgs(process.argv.slice(2));
  const arms = specs.map((spec) => ({ label: spec.label, rows: loadArm(spec.patterns) }));
  process.stdout.write(`${buildReport(arms)}\n`);
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
