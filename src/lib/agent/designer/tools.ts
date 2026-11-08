import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { BrepResult } from '../../engine/brep-runner';
import {
  parseStlTriangles,
  renderTriangleViews,
  type ColoredTriangle,
  type RGB,
} from '../../engine/stl-renderer';
import { PRELUDE_SENTINEL } from '../../brep/body-check';
import { parseParams } from '../../design/parse-params';
import type { DesignerFacts, RenderImage, ReviewFlag } from './types';

/** Closed-pose overlaps at or below this volume (mm³) are numerical noise. */
export const INTERFERENCE_MIN_VOLUME = 1.0;

/** Per-part colours for the renders, so a reviewer can tell parts apart. */
export const PART_PALETTE: Array<{ rgb: RGB; hex: string }> = [
  { rgb: [65, 117, 164], hex: '#4175A4' },
  { rgb: [218, 124, 48], hex: '#DA7C30' },
  { rgb: [67, 160, 71], hex: '#43A047' },
  { rgb: [142, 68, 173], hex: '#8E44AD' },
  { rgb: [230, 81, 0], hex: '#E65100' },
  { rgb: [0, 150, 136], hex: '#009688' },
  { rgb: [233, 30, 99], hex: '#E91E63' },
  { rgb: [121, 85, 72], hex: '#795548' },
  { rgb: [96, 125, 139], hex: '#607D8B' },
  { rgb: [244, 81, 30], hex: '#F4511E' },
  { rgb: [30, 136, 229], hex: '#1E88E5' },
  { rgb: [124, 179, 66], hex: '#7CB342' },
];

export const RENDER_VIEWS = ['iso', 'front', 'right', 'top'] as const;

// ---------------------------------------------------------------- tools

export function designerTools() {
  const runScript = new DynamicStructuredTool({
    name: 'run_script',
    description:
      'Run the build123d Python design code (body) and return geometric measurements, validity, interferences and parameters.',
    schema: z.object({
      script: z.string().describe('The build123d Python design code (body) to execute.'),
    }),
    func: async () => 'handled in loop',
  });
  const render = new DynamicStructuredTool({
    name: 'render',
    description:
      'Re-run the last script that ran, with optional parameter overrides, and render views (iso, front, right, top) as coloured images to inspect clearances and motion.',
    schema: z.object({
      overrides: z
        .record(z.string(), z.number())
        .optional()
        .describe('Top-level parameter overrides, e.g. {"lid_open_deg": 90} or {"drawer_travel": 50}.'),
    }),
    func: async () => 'handled in loop',
  });
  const finish = new DynamicStructuredTool({
    name: 'finish',
    description:
      'Complete the design session. Provide a short summary of the design, its clearances and how you read the request.',
    schema: z.object({
      summary: z.string().describe('Summary of the design, features and interpretations.'),
      script: z.string().optional().describe('Optional. Must equal the last design code (body) you ran; geometry changes go through run_script.'),
    }),
    func: async () => 'handled in loop',
  });
  return [runScript, render, finish];
}

// ------------------------------------------------------- script parsing

/** The part of a script after the generated prelude (all of it when there is no sentinel). */
function scriptBody(script: string): string {
  const i = script.indexOf(PRELUDE_SENTINEL);
  return i === -1 ? script : script.slice(i + PRELUDE_SENTINEL.length);
}

const POSE_NAME = /(?:_deg|_travel)$/;

/** Hash of a script with every top-level numeric value blanked, so a pose-only edit keeps the same key. */
export function scriptBaseKey(script: string): string {
  const normalized = script
    .replace(
      /^([A-Za-z_][A-Za-z0-9_]*\s*=\s*)(-?[0-9.]+)(\s*(?:#\s*\[[0-9.-]+(?::[0-9.-]+)?:[0-9.-]+\].*)?)$/gm,
      '$1__POSE_VAL__$3',
    )
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** Top-level `name = number` lines of the script body, pose parameters excluded. */
export function parseDimensions(script: string): Array<{ name: string; value: number }> {
  const out: Array<{ name: string; value: number }> = [];
  for (const line of scriptBody(script).split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*(?:#.*)?$/.exec(line);
    if (!m || POSE_NAME.test(m[1])) continue;
    out.push({ name: m[1], value: Number(m[2]) });
  }
  return out;
}

export interface PoseParam {
  name: string;
  value: number;
  min?: number;
  max?: number;
}

/** Top-level `*_deg` / `*_travel` lines; min and max are unset when the range comment is missing. */
export function findPoseParams(script: string): PoseParam[] {
  const out: PoseParam[] = [];
  for (const line of scriptBody(script).split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*(?:_deg|_travel))\s*=\s*(-?\d+(?:\.\d+)?)\s*(?:#(.*))?$/.exec(line);
    if (!m) continue;
    const range = m[3] ? /^\s*\[\s*(-?[\d.]+)\s*:\s*(?:(-?[\d.]+)\s*:\s*)?(-?[\d.]+)\s*\]/.exec(m[3]) : null;
    const min = range ? parseFloat(range[1]) : undefined;
    const max = range ? parseFloat(range[3]) : undefined;
    out.push({
      name: m[1],
      value: Number(m[2]),
      min: Number.isFinite(min) ? min : undefined,
      max: Number.isFinite(max) ? max : undefined,
    });
  }
  return out;
}

// ------------------------------------------------------------- results

/** A short error line for facts: the last line of a traceback, paths removed, clipped. Never a traceback. */
export function shortError(error: string | undefined): string {
  const lines = (error ?? 'unknown error').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? 'unknown error';
  return last.replace(/(?:[A-Za-z]:)?\/[^\s'"]+/g, '<path>').slice(0, 300);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function factsFromRun(r: BrepResult, script: string): DesignerFacts {
  const dimensions = parseDimensions(script);
  if (!r.ok) {
    return { ok: false, error: shortError(r.error), parts: [], interferences: [], disconnected: [], dimensions };
  }
  const span: [number, number, number] | undefined = r.bbox
    ? [r1(r.bbox.max[0] - r.bbox.min[0]), r1(r.bbox.max[1] - r.bbox.min[1]), r1(r.bbox.max[2] - r.bbox.min[2])]
    : undefined;
  return {
    ok: true,
    parts: (r.parts ?? []).map((p, i) => ({
      label: p.label || `part_${i + 1}`,
      size: [r1(p.max[0] - p.min[0]), r1(p.max[1] - p.min[1]), r1(p.max[2] - p.min[2])] as [number, number, number],
      valid: p.valid,
    })),
    interferences: (r.interferences ?? [])
      .filter((i) => i.volume > INTERFERENCE_MIN_VOLUME)
      .map((i) => ({ a: i.a, b: i.b, volume: r1(i.volume) })),
    disconnected: r.disconnected === 'not checked' ? 'not checked' : [...(r.disconnected ?? [])],
    dimensions,
    span,
  };
}

/** Compact markdown facts for the designer model, built from numbers and labels only. */
export function formatFactsTable(r: BrepResult, script: string): string {
  const lines: string[] = [`**Status**: ${r.ok ? 'OK' : 'ERROR'}`];
  if (!r.ok) {
    lines.push(`**Error**: ${(r.error ?? 'Unknown error').slice(-2000)}`);
    return lines.join('\n');
  }
  const parts = r.parts ?? [];
  if (parts.length > 0) {
    lines.push('\n**Parts**:', '| Label | Size (X x Y x Z mm) | Volume (mm³) | Valid | Centroid |', '| :--- | :--- | :--- | :--- | :--- |');
    for (const p of parts) {
      const size = [0, 1, 2].map((k) => (p.max[k] - p.min[k]).toFixed(1)).join(' x ');
      const c = p.centroid ?? ([0, 1, 2].map((k) => (p.min[k] + p.max[k]) / 2) as [number, number, number]);
      lines.push(`| ${p.label || '(unnamed)'} | ${size} | ${Math.round(p.volume)} | ${p.valid ? 'yes' : 'NO'} | (${c.map((v) => v.toFixed(1)).join(', ')}) |`);
    }
  } else {
    lines.push('\n**Parts**: none returned in _cadai_parts.');
  }
  const clashes = (r.interferences ?? []).filter((i) => i.volume > INTERFERENCE_MIN_VOLUME);
  if (clashes.length === 0) lines.push('\n**Closed-pose interferences**: none');
  else {
    lines.push('\n**Closed-pose interferences**:');
    for (const c of clashes) lines.push(`- '${c.a}' collides with '${c.b}' (${c.volume.toFixed(1)} mm³)`);
  }
  const dis = r.disconnected;
  if (dis === 'not checked') lines.push('**Disconnected parts**: not checked');
  else lines.push(`**Disconnected parts**: ${!dis || dis.length === 0 ? 'none' : dis.join(', ')}`);

  const params = parseParams(script);
  if (params.length > 0) {
    lines.push('\n**Parameters**:', '| Parameter | Value | Range [min:max] | Description |', '| :--- | :--- | :--- | :--- |');
    for (const p of params) {
      const range = p.min !== undefined && p.max !== undefined ? `[${p.min}:${p.max}]` : '-';
      lines.push(`| \`${p.name}\` | ${p.value} | ${range} | ${p.label || '-'} |`);
    }
  }
  return lines.join('\n');
}

/** Whether a run passes the hard checks that a finish needs. */
export function checkRun(r: BrepResult): { passing: boolean; reason?: string } {
  if (!r.ok) return { passing: false, reason: `the run failed: ${shortError(r.error)}` };
  if (!r.parts || r.parts.length === 0) return { passing: false, reason: 'no parts in _cadai_parts' };
  const invalid = r.parts.filter((p) => !p.valid);
  if (invalid.length > 0) return { passing: false, reason: `invalid parts: ${invalid.map((p) => p.label || 'unnamed').join(', ')}` };
  if (Array.isArray(r.disconnected) && r.disconnected.length > 0) {
    return { passing: false, reason: `disconnected parts: ${r.disconnected.join(', ')}` };
  }
  const clashes = (r.interferences ?? []).filter((i) => i.volume > INTERFERENCE_MIN_VOLUME);
  if (clashes.length > 0) {
    return { passing: false, reason: `interferences: ${clashes.map((c) => `${c.a} collides with ${c.b} (${c.volume.toFixed(1)} mm³)`).join(', ')}` };
  }
  return { passing: true };
}

// -------------------------------------------------------------- renders

function decodeStl(meshData: string): string {
  if (meshData.startsWith('solid') || meshData.startsWith('facet')) return meshData;
  try {
    const decoded = Buffer.from(meshData, 'base64').toString('utf8');
    if (decoded.includes('solid') || decoded.includes('facet')) return decoded;
  } catch {
    // not base64
  }
  return meshData;
}

/** Four coloured views of a run, one colour per part. Empty when the run has no mesh. */
export function renderPartViews(r: BrepResult): Array<{ name: string; dataUrl: string }> {
  const tris: ColoredTriangle[] = [];
  const parts = r.parts ?? [];
  const meshes = r.partMeshes ?? {};
  const keys = Object.keys(meshes);
  parts.forEach((p, idx) => {
    const label = p.label || `part_${idx + 1}`;
    const mesh = (p.label && meshes[p.label]) || meshes[label] || meshes[`part_${idx + 1}`] || meshes[keys[idx]];
    if (!mesh) return;
    const color = PART_PALETTE[idx % PART_PALETTE.length].rgb;
    for (const t of parseStlTriangles(decodeStl(mesh))) tris.push({ a: t.a, b: t.b, c: t.c, color });
  });
  if (tris.length === 0 && r.stl) {
    const color: RGB = [180, 185, 195];
    for (const t of parseStlTriangles(decodeStl(r.stl))) tris.push({ a: t.a, b: t.b, c: t.c, color });
  }
  return renderTriangleViews(tris, { views: [...RENDER_VIEWS], size: 512 }).views;
}

export function toRenderImages(views: Array<{ name: string; dataUrl: string }>, pose?: string): RenderImage[] {
  return views.map((v) => ({ view: pose ? `${v.name}@open:${pose}` : v.name, dataUrl: v.dataUrl }));
}

export function formatFlags(flags: ReviewFlag[], prefix = ''): string {
  return flags.map((f) => `${prefix}- [${f.severity.toUpperCase()}] ${f.issue}: ${f.whyItMatters}`).join('\n');
}

// ---------------------------------------------------- cache and usage

function countCacheBreakpoints(messages: BaseMessage[], tools?: unknown[]): number {
  let count = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) if ((block as { cache_control?: unknown })?.cache_control) count++;
  }
  for (const tool of tools ?? []) if ((tool as { cache_control?: unknown })?.cache_control) count++;
  return count;
}

/**
 * Moves the single rolling prompt-cache breakpoint to the newest message. The
 * system prompt keeps its own breakpoint, history is append-only, so every turn
 * reads the whole earlier conversation from the cache. Anthropic allows 4.
 */
export function applyRollingCacheBreakpoint(
  conversation: BaseMessage[],
  prev: BaseMessage | null,
  tools?: unknown[],
): BaseMessage | null {
  if (prev && Array.isArray(prev.content)) {
    for (const block of prev.content) {
      if ((block as { cache_control?: unknown })?.cache_control) delete (block as { cache_control?: unknown }).cache_control;
    }
  }
  if (conversation.length === 0) return null;
  const newest = conversation[conversation.length - 1];
  if (typeof newest.content === 'string') newest.content = [{ type: 'text', text: newest.content }];
  if (countCacheBreakpoints(conversation, tools) < 4 && Array.isArray(newest.content) && newest.content.length > 0) {
    (newest.content[newest.content.length - 1] as { cache_control?: { type: string } }).cache_control = { type: 'ephemeral' };
    return newest;
  }
  return null;
}

export interface ReplyUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Billed token counts of a reply, with cache reads and writes kept out of the plain input count. */
export function replyUsage(reply: AIMessage): ReplyUsage {
  const meta = reply.usage_metadata as
    | { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_creation?: number; cache_read?: number } }
    | undefined;
  const resp = (reply.response_metadata as { usage?: Record<string, unknown> } | undefined)?.usage;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const cacheCreation = num(meta?.input_token_details?.cache_creation) ?? num(resp?.cache_creation_input_tokens) ?? 0;
  const cacheRead = num(meta?.input_token_details?.cache_read) ?? num(resp?.cache_read_input_tokens) ?? 0;
  const input =
    num(resp?.input_tokens) ??
    (num(meta?.input_tokens) !== undefined ? Math.max(0, (meta!.input_tokens as number) - cacheCreation - cacheRead) : 0);
  const output = num(meta?.output_tokens) ?? num(resp?.output_tokens) ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}
