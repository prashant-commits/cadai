/**
 * Blind review page for one designer-eval tag.
 *
 *   npx tsx eval/designer/blind.ts --tag <tag> [--set open] [--with-baselines]
 *
 * Writes eval/designer/results/<tag>/blind/index.html and key.json.
 * The HTML shows letters only. The letter → arm map stays in key.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPoseParams } from '../../src/lib/agent/designer/tools';
import { runBrep, type BrepResult } from '../../src/lib/engine/brep-runner';
import { renderStlViews, type RenderedView, type RenderOptions, type ViewName } from '../../src/lib/engine/stl-renderer';
import { SEED, type Arm, type EvalPrompt, type RunRecord, type SetName } from './types';
import { ARM_ORDER, SET_ORDER, finalStep, loadPrompts, loadRunFiles, promptFor } from './report';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLOSED_VIEWS: ViewName[] = ['iso', 'back_iso', 'front'];
const DEFAULT_RENDER_SIZE = 256;

export interface BlindArgs {
  tag: string;
  setName?: SetName;
  withBaselines: boolean;
  resultsDir?: string;
  setsDir?: string;
  baselinesDir?: string;
}

export interface BlindDeps {
  runBrep?: (script: string, opts?: { timeoutMs?: number }) => Promise<BrepResult>;
  renderStlViews?: (stl: string, opts?: RenderOptions) => RenderedView[];
}

interface BaselineEntry {
  source: string;
  scriptPath?: string;
  stlPath?: string;
}

interface DesignSource {
  arm: string;
  kind: 'run' | 'baseline';
  sample?: number;
  source?: string;
  script: string;
  stlFile?: string;
}

interface PageImage {
  iso?: string;
  back_iso?: string;
  front?: string;
  open?: string;
}

interface PageDesign {
  letter: string;
  missing: boolean;
  img: PageImage;
}

interface PageCase {
  id: string;
  label: string;
  prompt: string;
  designs: PageDesign[];
}

export interface KeyEntry {
  arm: string;
  kind: 'run' | 'baseline';
  sample?: number;
  source?: string;
}

export type BlindKey = Record<string, Record<string, KeyEntry>>;

export interface BlindBuild {
  html: string;
  key: BlindKey;
  cases: PageCase[];
}

function letterAt(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function mixSeed(seed: number, id: string): number {
  let hash = 2166136261 ^ (seed >>> 0);
  const text = `${seed}\0${id}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Letters for one prompt. Stable for a given seed and prompt id. */
export function assignLetters(promptId: string, count: number, seed = SEED): string[] {
  if (!Number.isInteger(count) || count < 0) throw new Error('count must be a non-negative integer');
  const letters = Array.from({ length: count }, (_, index) => letterAt(index));
  const random = mulberry32(mixSeed(seed, promptId));
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = letters[i];
    letters[i] = letters[j];
    letters[j] = swap;
  }
  return letters;
}

/** Top-level numeric assignment rewrite. Same idea as applyParameterOverrides, without pulling in the agent graph. */
function applyOverrides(script: string, overrides: Record<string, number>): string {
  return script.split('\n').map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^#\n]+?)(\s*(?:#.*)?)$/.exec(line);
    if (!match) return line;
    const value = overrides[match[1]];
    if (typeof value !== 'number' || !Number.isFinite(value)) return line;
    return `${match[1]} = ${value}${match[3]}`;
  }).join('\n');
}

function stlBytesToAscii(buf: Buffer): string {
  if (buf.length >= 84) {
    const count = buf.readUInt32LE(80);
    if (count > 0 && buf.length === 84 + count * 50) {
      const lines = ['solid model'];
      for (let i = 0; i < count; i++) {
        const offset = 84 + i * 50;
        const f = (k: number) => buf.readFloatLE(offset + k * 4);
        lines.push(`facet normal ${f(0)} ${f(1)} ${f(2)}`, 'outer loop');
        for (let vertex = 0; vertex < 3; vertex++) {
          lines.push(`vertex ${f(3 + vertex * 3)} ${f(4 + vertex * 3)} ${f(5 + vertex * 3)}`);
        }
        lines.push('endloop', 'endfacet');
      }
      lines.push('endsolid model');
      return `${lines.join('\n')}\n`;
    }
  }
  return buf.toString('utf8');
}

function hasMesh(stl: string): boolean {
  return /vertex\s+[-\d.]/.test(stl);
}

function readStlAscii(file: string | undefined): string {
  if (!file || !existsSync(file)) return '';
  const buf = readFileSync(file);
  if (buf.length === 0 || buf.length > 50_000_000) return '';
  return stlBytesToAscii(buf);
}

function readScript(file: string | undefined): string {
  if (!file || !existsSync(file)) return '';
  const buf = readFileSync(file);
  if (buf.length === 0 || buf.length > 2_000_000) return '';
  return buf.toString('utf8');
}

function resolveFrom(baseDir: string, file: string | undefined): string | undefined {
  if (!file) return undefined;
  return path.isAbsolute(file) ? file : path.join(baseDir, file);
}

function clampSize(size: number | undefined): number {
  if (!size || !Number.isFinite(size)) return DEFAULT_RENDER_SIZE;
  return Math.max(16, Math.min(512, Math.round(size)));
}

function viewsToImage(views: RenderedView[]): PageImage {
  const img: PageImage = {};
  for (const view of views) {
    if (typeof view.dataUrl === 'string' && view.dataUrl.startsWith('data:image/png;base64,')) {
      if (view.name === 'iso' || view.name === 'back_iso' || view.name === 'front') img[view.name] = view.dataUrl;
    }
  }
  return img;
}

function poseOverrides(script: string): Record<string, number> | null {
  const overrides: Record<string, number> = {};
  for (const pose of findPoseParams(script)) {
    if (typeof pose.max === 'number' && Number.isFinite(pose.max)) overrides[pose.name] = pose.max;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

async function renderMesh(
  stl: string,
  views: ViewName[],
  size: number,
  render: NonNullable<BlindDeps['renderStlViews']>,
): Promise<RenderedView[]> {
  if (!hasMesh(stl)) return [];
  return render(stl, { views, size });
}

async function stlFromBrep(script: string, run: NonNullable<BlindDeps['runBrep']>): Promise<string> {
  try {
    const result = await run(script, { timeoutMs: 60_000 });
    if (!result?.ok || typeof result.stl !== 'string' || result.stl.length === 0) return '';
    return stlBytesToAscii(Buffer.from(result.stl, 'base64'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`render failed: ${message}`);
    return '';
  }
}

async function renderSource(
  source: DesignSource,
  size: number,
  deps: Required<Pick<BlindDeps, 'runBrep' | 'renderStlViews'>>,
): Promise<PageDesign['img']> {
  let closed = readStlAscii(source.stlFile);
  if (!hasMesh(closed) && source.script.trim()) closed = await stlFromBrep(source.script, deps.runBrep);
  const img = viewsToImage(await renderMesh(closed, CLOSED_VIEWS, size, deps.renderStlViews));
  const overrides = source.script.trim() ? poseOverrides(source.script) : null;
  if (overrides) {
    const opened = await stlFromBrep(applyOverrides(source.script, overrides), deps.runBrep);
    const openViews = await renderMesh(opened, ['iso'], size, deps.renderStlViews);
    const open = openViews.find((view) => view.name === 'iso' && view.dataUrl.startsWith('data:image/png;base64,'));
    if (open) img.open = open.dataUrl;
  }
  return img;
}

function labelFor(prompt: EvalPrompt): string {
  const request = prompt.request?.trim() ?? '';
  const sentence = request.split(/(?<=\.)\s/)[0]?.trim() ?? '';
  const short = sentence.length > 0 && sentence.length <= 80 ? sentence : request.slice(0, 80).trim();
  if (short) return short;
  return prompt.id.replace(/[_-]+/g, ' ');
}

function normalizeBaseline(value: unknown): BaselineEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const source = typeof entry.source === 'string' ? entry.source.trim() : '';
  if (!source) return null;
  const scriptPath = typeof entry.scriptPath === 'string' && entry.scriptPath.trim() ? entry.scriptPath : undefined;
  const stlPath = typeof entry.stlPath === 'string' && entry.stlPath.trim() ? entry.stlPath : undefined;
  if (!scriptPath && !stlPath) return null;
  return { source, scriptPath, stlPath };
}

function baselineList(value: unknown): BaselineEntry[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map(normalizeBaseline).filter((entry): entry is BaselineEntry => entry !== null);
}

export function loadBaselines(manifestPath: string): Map<string, BaselineEntry[]> {
  const map = new Map<string, BaselineEntry[]>();
  if (!existsSync(manifestPath)) return map;
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const add = (id: string, value: unknown) => {
    if (!id || id === 'prompts') return;
    const entries = baselineList(value);
    if (entries.length === 0) return;
    const current = map.get(id) ?? [];
    current.push(...entries);
    map.set(id, current);
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id = typeof record.promptId === 'string' ? record.promptId : typeof record.id === 'string' ? record.id : '';
      add(id, item);
    }
    return map;
  }
  if (!parsed || typeof parsed !== 'object') return map;
  const root = parsed as Record<string, unknown>;
  const nested = root.prompts && typeof root.prompts === 'object' && !Array.isArray(root.prompts)
    ? root.prompts as Record<string, unknown>
    : undefined;
  for (const [id, value] of Object.entries(root)) add(id, value);
  if (nested) for (const [id, value] of Object.entries(nested)) add(id, value);
  for (const [id, entries] of map) {
    entries.sort((a, b) => a.source.localeCompare(b.source) || (a.stlPath ?? '').localeCompare(b.stlPath ?? '') || (a.scriptPath ?? '').localeCompare(b.scriptPath ?? ''));
    map.set(id, entries);
  }
  return map;
}

function armIndex(arm: Arm): number {
  const index = ARM_ORDER.indexOf(arm);
  return index === -1 ? ARM_ORDER.length : index;
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const PAGE_STYLE = `
:root {
  --bg: #eef0ee; --surface: #fbfcfb; --ink: #16191b; --muted: #5a6266; --line: #d5d9d6; --accent: #245f9e; --plate: #1a1a1a; --win: #e2f1e8; --win-ink: #23704a;
  --display: "Archivo", "Helvetica Neue", Arial, sans-serif; --body: "Source Sans 3", "Segoe UI", system-ui, sans-serif; --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #111315; --surface: #181b1e; --ink: #e6e9ea; --muted: #9ba3a8; --line: #2a2f33; --accent: #79aee6; --win: #16301f; --win-ink: #6fcf97; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #111315; --surface: #181b1e; --ink: #e6e9ea; --muted: #9ba3a8; --line: #2a2f33; --accent: #79aee6; --win: #16301f; --win-ink: #6fcf97; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 16px/1.5 var(--body); margin: 0; }
.wrap { max-width: 1240px; margin: 0 auto; padding-block: 32px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 22px; }
h1 { font: 700 clamp(1.6rem, 3.2vw, 2.2rem)/1.1 var(--display); margin: 0; text-wrap: balance; }
.lede { color: var(--muted); margin: 6px 0 0; max-width: 78ch; }
.label { font: 600 0.72rem/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.case { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 18px; display: grid; gap: 14px; }
.case h2 { font: 700 1.15rem/1.2 var(--display); margin: 0; }
.prompt { margin: 0; color: var(--muted); font-size: 0.93rem; max-width: 100ch; white-space: pre-line; }
.designs { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
.design { display: grid; gap: 8px; min-width: 0; align-content: start; border-radius: 6px; padding: 6px; }
.design.best { background: var(--win); }
.design-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.design-head b { font: 700 1rem/1 var(--display); }
.reveal { font: 600 0.78rem/1.2 var(--mono); color: var(--accent); text-align: right; }
.plate { background: var(--plate); border-radius: 4px; aspect-ratio: 1 / 1; max-width: 100%; overflow: hidden; }
.plate img { width: 100%; height: 100%; object-fit: contain; display: block; }
.views { display: flex; gap: 6px; flex-wrap: wrap; }
button { font: 600 0.8rem/1 var(--body); padding: 7px 10px; border-radius: 4px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); cursor: pointer; }
button[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pick { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.none { color: var(--muted); font-size: 0.9rem; padding: 40px 12px; text-align: center; border: 1px dashed var(--line); border-radius: 4px; }
.key { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.notes { color: var(--muted); font-size: 0.92rem; max-width: 90ch; }
#picksJson { width: 100%; min-height: 7rem; box-sizing: border-box; font: 0.85rem/1.45 var(--mono); color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 8px; }
`;

const PAGE_SCRIPT = `
const C = JSON.parse(document.getElementById('data').textContent);
const TAG = JSON.parse(document.getElementById('meta').textContent).tag;
document.title = 'Blind review · ' + TAG;
document.getElementById('kicker').textContent = 'cadai · blind review · ' + TAG;
const VIEWS = [['iso', 'Iso'], ['back_iso', 'Back'], ['front', 'Front'], ['open', 'Open']];
const picks = {};
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const firstImg = (img) => img && (img.iso || img.front || img.back_iso || img.open);
const design = (c, d) => {
  const initial = firstImg(d.img);
  const views = VIEWS.filter(([v]) => d.img && d.img[v]).map(([v, n], i) =>
    '<button type="button" data-v="' + esc(v) + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '">' + esc(n) + '</button>').join('');
  const body = initial
    ? '<div class="plate"><img src="' + initial + '" alt="Design ' + esc(d.letter) + ' for ' + esc(c.label) + '"></div><div class="views" role="group" aria-label="Design ' + esc(d.letter) + ' views">' + views + '</div>'
    : '<div class="none">No model produced</div>';
  return '<div class="design" data-letter="' + esc(d.letter) + '"><div class="design-head"><b>' + esc(d.letter) + '</b><span class="reveal" hidden></span></div>' + body + '</div>';
};
document.getElementById('cases').innerHTML = C.map((c) => '<article class="case" data-id="' + esc(c.id) + '"><h2>' + esc(c.label) + '</h2><p class="prompt">' + esc(c.prompt) + '</p><div class="designs">' + c.designs.map((d) => design(c, d)).join('') + '</div><div class="pick" role="group" aria-label="Best design"><span class="label">Best</span>' + c.designs.map((d) => '<button type="button" data-p="' + esc(d.letter) + '" aria-pressed="false">' + esc(d.letter) + '</button>').join('') + '</div></article>').join('');
let keyPromise = null;
function loadKey() {
  if (!keyPromise) {
    keyPromise = fetch('key.json').then((res) => {
      if (!res.ok) throw new Error('key ' + res.status);
      return res.json();
    }).catch((err) => { keyPromise = null; throw err; });
  }
  return keyPromise;
}
function applyPick(article, letter) {
  article.querySelectorAll('.pick button').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.p === letter)));
  article.querySelectorAll('.design').forEach((el) => el.classList.toggle('best', el.dataset.letter === letter));
}
function remember(promptId, letter, arm, sample) {
  picks[promptId] = { letter: letter, arm: arm, sample: sample };
  try {
    const storeKey = 'cadai-blind-picks:' + TAG;
    let prev = {};
    try { prev = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch (err) { prev = {}; }
    prev[promptId] = picks[promptId];
    localStorage.setItem(storeKey, JSON.stringify(prev));
  } catch (err) {}
  try { window.cadaiSavePick?.(promptId, letter, arm); } catch (err) {}
}
async function onPick(article, letter) {
  applyPick(article, letter);
  const promptId = article.dataset.id;
  let arm = '';
  let sample = null;
  try {
    const key = await loadKey();
    const entry = key && key[promptId] && key[promptId][letter];
    if (entry) {
      arm = typeof entry.arm === 'string' ? entry.arm : '';
      sample = typeof entry.sample === 'number' ? entry.sample : null;
    }
  } catch (err) {}
  remember(promptId, letter, arm, sample);
}
document.getElementById('cases').addEventListener('click', (event) => {
  const viewButton = event.target.closest('.views button');
  if (viewButton) {
    const el = viewButton.closest('.design');
    const article = viewButton.closest('.case');
    const c = C.find((item) => item.id === article.dataset.id);
    const d = c && c.designs.find((item) => item.letter === el.dataset.letter);
    const next = d && d.img && d.img[viewButton.dataset.v];
    if (next) el.querySelector('img').src = next;
    el.querySelectorAll('.views button').forEach((button) => button.setAttribute('aria-pressed', String(button === viewButton)));
    return;
  }
  const pickButton = event.target.closest('.pick button');
  if (pickButton) onPick(pickButton.closest('.case'), pickButton.dataset.p);
});
document.getElementById('revealAll').addEventListener('click', async () => {
  let key;
  try { key = await loadKey(); } catch (err) {
    document.getElementById('score').textContent = 'Could not load the key';
    return;
  }
  const tally = {};
  document.querySelectorAll('.case').forEach((article) => {
    const map = key[article.dataset.id] || {};
    article.querySelectorAll('.design').forEach((el) => {
      const entry = map[el.dataset.letter];
      const span = el.querySelector('.reveal');
      span.hidden = false;
      span.textContent = entry && entry.arm ? entry.arm : '';
    });
    const pick = picks[article.dataset.id];
    if (pick && map[pick.letter] && map[pick.letter].arm) {
      const name = map[pick.letter].arm;
      tally[name] = (tally[name] || 0) + 1;
    }
  });
  const text = Object.keys(tally).map((name) => name + ' ' + tally[name]).join(' · ');
  document.getElementById('score').textContent = text ? 'Your picks: ' + text : '';
});
document.getElementById('copyPicks').addEventListener('click', async () => {
  const text = JSON.stringify(picks, null, 2);
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch (err) { copied = false; }
  const box = document.getElementById('picksJson');
  const status = document.getElementById('copyStatus');
  if (copied) {
    box.hidden = true;
    status.textContent = 'Copied';
  } else {
    box.hidden = false;
    box.value = text;
    status.textContent = 'Clipboard refused. The JSON is in the box below.';
  }
});
document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const cur = root.getAttribute('data-theme');
  if (cur === 'dark') root.setAttribute('data-theme', 'light');
  else if (cur === 'light') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', 'dark');
});
try {
  const saved = JSON.parse(localStorage.getItem('cadai-blind-picks:' + TAG) || '{}');
  if (saved && typeof saved === 'object') {
    for (const id of Object.keys(saved)) {
      const pick = saved[id];
      if (!pick || typeof pick.letter !== 'string') continue;
      const article = Array.from(document.querySelectorAll('.case')).find((el) => el.dataset.id === id);
      if (!article) continue;
      applyPick(article, pick.letter);
      picks[id] = pick;
    }
  }
} catch (err) {}
`;

export function pageHtml(cases: PageCase[], tag: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="claude:viewport-fit-sides" content="cover">
<title>Blind review</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700&family=Source+Sans+3:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
${PAGE_STYLE}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="label" id="kicker">cadai · blind review</div>
    <h1>Which design is best?</h1>
    <p class="lede">Each request was built more than one way. Every design is rendered the same way, in plain grey, and labelled only with a letter. Pick the best design for each request, then reveal which was which.</p>
  </header>
  <main id="cases" style="display:grid;gap:18px"></main>
  <div class="key">
    <button type="button" id="revealAll">Reveal which is which</button>
    <button type="button" id="copyPicks">Copy picks as JSON</button>
    <button type="button" id="theme">Theme</button>
    <span class="label" id="score"></span>
    <span class="label" id="copyStatus" role="status"></span>
  </div>
  <textarea id="picksJson" hidden readonly></textarea>
  <p class="notes">Open shows a moving part at the end of its range when the design has one. Picks are saved in this browser. Copy picks as JSON if you want them elsewhere.</p>
</div>
<script id="meta" type="application/json">${jsonForScript({ tag })}</script>
<script id="data" type="application/json">${jsonForScript(cases)}</script>
<script>
${PAGE_SCRIPT}
</script>
</body>
</html>
`;
}

function runSource(record: RunRecord, recordDir: string): DesignSource {
  const step = finalStep(record);
  const script = typeof step?.script === 'string' ? step.script : '';
  const stlPath = typeof step?.stlPath === 'string' ? step.stlPath : undefined;
  return {
    arm: record.arm,
    kind: 'run',
    sample: record.sample,
    script,
    stlFile: resolveFrom(recordDir, stlPath),
  };
}

export async function buildBlind(options: {
  tag: string;
  resultsDir: string;
  setsDir?: string;
  setName?: SetName;
  withBaselines?: boolean;
  baselinesDir?: string;
  renderSize?: number;
}, deps: BlindDeps = {}): Promise<BlindBuild> {
  const tagDir = path.join(options.resultsDir, options.tag);
  const runs = loadRunFiles(tagDir).filter((loaded) => !options.setName || loaded.record.set === options.setName);
  if (runs.length === 0) throw new Error(`No runs for tag ${options.tag}`);
  const prompts = loadPrompts(options.setsDir ?? path.join(ROOT, 'eval/designer/sets'));
  let baselines = new Map<string, BaselineEntry[]>();
  let manifestDir = options.baselinesDir ?? path.join(ROOT, 'eval/designer/baselines');
  if (options.withBaselines) {
    const manifestPath = path.join(manifestDir, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`No baseline manifest at ${manifestPath}`);
    manifestDir = path.dirname(manifestPath);
    baselines = loadBaselines(manifestPath);
  }
  const render = deps.renderStlViews ?? renderStlViews;
  const run = deps.runBrep ?? runBrep;
  const size = clampSize(options.renderSize);
  const byPrompt = new Map<string, { prompt: EvalPrompt; set: SetName; sources: DesignSource[] }>();
  for (const loaded of runs) {
    const record = loaded.record;
    const bucket = byPrompt.get(record.promptId) ?? {
      prompt: promptFor(record, prompts),
      set: record.set,
      sources: [],
    };
    bucket.sources.push(runSource(record, loaded.dir));
    byPrompt.set(record.promptId, bucket);
  }
  const promptIds = [...byPrompt.keys()].sort((a, b) => {
    const left = byPrompt.get(a)!;
    const right = byPrompt.get(b)!;
    const setDelta = SET_ORDER.indexOf(left.set) - SET_ORDER.indexOf(right.set);
    return setDelta || a.localeCompare(b);
  });
  const cases: PageCase[] = [];
  const key: BlindKey = {};
  for (const promptId of promptIds) {
    const bucket = byPrompt.get(promptId)!;
    const sources = [...bucket.sources].sort((a, b) => armIndex(a.arm as Arm) - armIndex(b.arm as Arm) || (a.sample ?? 0) - (b.sample ?? 0));
    if (options.withBaselines) {
      for (const entry of baselines.get(promptId) ?? []) {
        sources.push({
          arm: entry.source,
          kind: 'baseline',
          source: entry.source,
          script: readScript(resolveFrom(manifestDir, entry.scriptPath)),
          stlFile: resolveFrom(manifestDir, entry.stlPath),
        });
      }
    }
    const letters = assignLetters(promptId, sources.length);
    const designs: PageDesign[] = [];
    key[promptId] = {};
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const letter = letters[i];
      const img = await renderSource(source, size, { runBrep: run, renderStlViews: render });
      const missing = !img.iso && !img.back_iso && !img.front && !img.open;
      designs.push({ letter, missing, img });
      const entry: KeyEntry = { arm: source.arm, kind: source.kind };
      if (typeof source.sample === 'number') entry.sample = source.sample;
      if (source.source) entry.source = source.source;
      key[promptId][letter] = entry;
    }
    cases.push({ id: promptId, label: labelFor(bucket.prompt), prompt: bucket.prompt.request, designs });
  }
  return { html: pageHtml(cases, options.tag), key, cases };
}

export async function writeBlind(options: Parameters<typeof buildBlind>[0], deps: BlindDeps = {}): Promise<{ htmlPath: string; keyPath: string; html: string; key: BlindKey }> {
  const built = await buildBlind(options, deps);
  const outDir = path.join(options.resultsDir, options.tag, 'blind');
  mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'index.html');
  const keyPath = path.join(outDir, 'key.json');
  writeFileSync(htmlPath, built.html);
  writeFileSync(keyPath, `${JSON.stringify(built.key, null, 2)}\n`);
  return { htmlPath, keyPath, html: built.html, key: built.key };
}

function isSetName(value: string): value is SetName {
  return (SET_ORDER as readonly string[]).includes(value);
}

export function parseBlindArgs(argv: string[]): BlindArgs {
  const out: BlindArgs = { tag: '', withBaselines: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const take = (): string => {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
      return value;
    };
    if (key === '--tag') out.tag = take();
    else if (key === '--set') {
      const name = take();
      if (!isSetName(name)) throw new Error(`Unknown set ${name}`);
      out.setName = name;
    } else if (key === '--with-baselines') out.withBaselines = true;
    else if (key === '--results') out.resultsDir = take();
    else if (key === '--sets') out.setsDir = take();
    else if (key === '--baselines') out.baselinesDir = take();
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!out.tag) throw new Error('--tag is required');
  return out;
}

async function main(argv: string[]): Promise<void> {
  const args = parseBlindArgs(argv);
  const written = await writeBlind({
    tag: args.tag,
    setName: args.setName,
    withBaselines: args.withBaselines,
    resultsDir: args.resultsDir ?? path.join(ROOT, 'eval/designer/results'),
    setsDir: args.setsDir ?? path.join(ROOT, 'eval/designer/sets'),
    baselinesDir: args.baselinesDir ?? path.join(ROOT, 'eval/designer/baselines'),
  });
  console.log(`wrote ${written.htmlPath}`);
  console.log(`wrote ${written.keyPath}`);
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
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
