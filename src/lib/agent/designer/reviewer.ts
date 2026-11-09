import { HumanMessage, type AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { estimateCostUsd, extractReplyUsage } from './cost-params';
import { structuredFor, UnusableReplyError, unusableStop } from '../llm-schemas';
import { getChatModel, isAbortOrTimeout } from '../model-provider';
import { DEFAULT_MODEL, isOfferedModel } from '../models';
import { cachedSystemMessage } from '../system-prompt';
import { MARKUP_SENTENCE } from './prompt';
import type {
  DesignerFacts,
  FlagSeverity,
  RenderImage,
  ReviewFlag,
  ReviewFn,
  ReviewInput,
  ReviewOutput,
} from './types';

/**
 * Independent design reviewer.
 *
 * A new model instance on every call (no designer transcript). Sonnet and Opus
 * 5.5 return 400 on a forced tool_choice, so the reply is constrained with the
 * same JSON-schema path the planner and specReviewer use (`structuredFor`).
 * Temperature is never sent.
 */

const SEVERITY_RANK: Record<FlagSeverity, number> = { blocking: 0, major: 1, minor: 2 };
const SEVERITIES = new Set<string>(['blocking', 'major', 'minor']);
const MAX_FLAGS = 3;
const MAX_TEXT = 400;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Object schema: Anthropic's json_schema format rejects a top-level array. */
export const ReviewerReplySchema = z.object({
  flags: z
    .array(
      z.object({
        severity: z.enum(['blocking', 'major', 'minor']).describe('blocking, major, or minor.'),
        issue: z.string().describe('Concrete use-level problem.'),
        whyItMatters: z.string().describe('Why that problem matters in real use.'),
      })
    )
    .describe('At most 3 flags, most severe first. Empty when nothing is wrong.'),
});

const REVIEWER_PREAMBLE = [
  'You are an independent senior product-design reviewer. Judge whether this design works for the request in real use: it does the job, it is stable when it should stand, it is reachable, moving parts work, it can be made, and the form is coherent.',
  'Reference images, when present, show what the user wants, and are not renders.',
  'Return at most 3 concrete flags, most severe first.',
  'Never flag differences in style or interpretation, or a mismatch with any plan.',
  'There is no floor or z = 0 rule.',
].join(' ');

const FINAL_BLOCKING = 'A blocking flag means the design fails the request in use.';

type StructuredRunnable = {
  invoke: (messages: unknown[], config?: { signal?: AbortSignal }) => Promise<unknown>;
  withConfig?: (config: { tags?: string[] }) => StructuredRunnable;
};

export type DesignerReviewer = ReviewFn & { lastError: unknown };

function reviewerSlug(opts?: { model?: string }): string {
  if (opts?.model) return opts.model;
  const pinned = process.env.CADAI_REVIEWER_MODEL?.trim();
  if (pinned) {
    if (isOfferedModel(pinned)) return pinned;
    console.warn(
      `CADAI_REVIEWER_MODEL "${pinned}" is not an offered model; ignoring and falling back to "${DEFAULT_MODEL}".`
    );
  }
  return DEFAULT_MODEL;
}

function systemPrompt(final: boolean): string {
  return final ? `${REVIEWER_PREAMBLE} ${FINAL_BLOCKING}` : REVIEWER_PREAMBLE;
}

function cleanText(value: string): string {
  return value.replace(CONTROL_CHARS, '').trim().slice(0, MAX_TEXT);
}

function cell(value: string): string {
  const cleaned = value.replace(CONTROL_CHARS, ' ').replace(/\|/g, '/').trim();
  return cleaned || '(unnamed)';
}

/** Compact facts table. Only measured DesignerFacts, never the designer's messages. */
export function formatFactsTable(facts: DesignerFacts): string {
  const lines: string[] = [`Status: ${facts.ok ? 'OK' : 'ERROR'}`];
  if (!facts.ok && facts.error) lines.push(`Error: ${cleanText(facts.error)}`);

  if (facts.parts.length === 0) {
    lines.push('Parts: none');
  } else {
    lines.push('Parts:', '| Label | Size (X x Y x Z mm) | Valid |', '| --- | --- | --- |');
    for (const part of facts.parts) {
      const [x, y, z] = part.size;
      lines.push(
        `| ${cell(part.label)} | ${x.toFixed(1)} x ${y.toFixed(1)} x ${z.toFixed(1)} | ${part.valid ? 'yes' : 'NO'} |`
      );
    }
  }

  if (facts.interferences.length === 0) {
    lines.push('Closed-pose interferences: none');
  } else {
    lines.push('Closed-pose interferences:');
    for (const hit of facts.interferences) {
      lines.push(`- ${cell(hit.a)} collides with ${cell(hit.b)} (${hit.volume.toFixed(1)} mm3)`);
    }
  }

  if (facts.disconnected === 'not checked') {
    lines.push('Disconnected parts: not checked');
  } else if (facts.disconnected.length === 0) {
    lines.push('Disconnected parts: none');
  } else {
    lines.push(`Disconnected parts: ${facts.disconnected.map(cell).join(', ')}`);
  }

  if (facts.dimensions.length === 0) {
    lines.push('Dimensions: none');
  } else {
    lines.push('Dimensions:', '| Name | Value |', '| --- | --- |');
    for (const dim of facts.dimensions) {
      lines.push(`| ${cell(dim.name)} | ${dim.value} |`);
    }
  }

  if (facts.span) {
    const [x, y, z] = facts.span;
    lines.push(`Span (mm): ${x.toFixed(1)} x ${y.toFixed(1)} x ${z.toFixed(1)}`);
  }
  return lines.join('\n');
}

function severityOf(value: unknown): FlagSeverity | null {
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  return SEVERITIES.has(word) ? (word as FlagSeverity) : null;
}

function whyText(record: Record<string, unknown>): string {
  const value = record.whyItMatters ?? record.why_it_matters ?? record.why;
  return typeof value === 'string' ? cleanText(value) : '';
}

/** Drop malformed flags, then keep the 3 most severe (stable within a severity). */
export function parseReviewFlags(raw: unknown): ReviewFlag[] {
  if (!Array.isArray(raw)) return [];
  const flags: ReviewFlag[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const severity = severityOf(record.severity);
    const issue = typeof record.issue === 'string' ? cleanText(record.issue) : '';
    const whyItMatters = whyText(record);
    if (!severity || !issue || !whyItMatters) continue;
    flags.push({ severity, issue, whyItMatters });
  }
  flags.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return flags.slice(0, MAX_FLAGS);
}

function flagItems(parsed: unknown): unknown[] | null {
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { flags?: unknown }).flags)) {
    return (parsed as { flags: unknown[] }).flags;
  }
  return null;
}

function unwrapResult(result: unknown): { parsed: unknown; raw: unknown } {
  if (
    result &&
    typeof result === 'object' &&
    'parsed' in result &&
    'raw' in result &&
    !('flags' in result)
  ) {
    const box = result as { parsed: unknown; raw: unknown };
    return { parsed: box.parsed, raw: box.raw };
  }
  return { parsed: result, raw: undefined };
}

function costOf(slug: string, raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  return estimateCostUsd(slug, extractReplyUsage(raw as AIMessage));
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function humanContent(input: ReviewInput): Array<
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
> {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    {
      type: 'text',
      text: `Request:\n${input.request}\n\nFacts:\n${formatFactsTable(input.facts)}`,
    },
  ];
  const markupImages: RenderImage[] = [];
  const referenceImages: RenderImage[] = [];
  const renderImages: RenderImage[] = [];
  for (const image of input.images) {
    if (image.view.startsWith('markup:')) {
      markupImages.push(image);
    } else if (image.view.startsWith('reference:')) {
      referenceImages.push(image);
    } else {
      renderImages.push(image);
    }
  }
  for (const image of markupImages) {
    const n = image.view.slice('markup:'.length);
    content.push({ type: 'text', text: `User's markup image ${n}` });
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
    content.push({ type: 'text', text: MARKUP_SENTENCE });
  }
  for (const image of referenceImages) {
    const n = image.view.slice('reference:'.length);
    content.push({ type: 'text', text: `User's reference image ${n}` });
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
  }
  for (const image of renderImages) {
    content.push({ type: 'text', text: `View: ${image.view}` });
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
  }
  return content;
}

export function makeReviewer(opts?: { model?: string }): DesignerReviewer {
  const box = { lastError: null as unknown };

  const review = async (input: ReviewInput): Promise<ReviewOutput> => {
    const slug = reviewerSlug(opts);
    if (input.signal?.aborted) {
      const err = abortError();
      box.lastError = err;
      throw err;
    }

    try {
      // Fresh instance: no messages carried over from the designer or a prior review.
      const model = getChatModel(slug);
      const bound = structuredFor(model, slug, ReviewerReplySchema, {
        name: 'DesignReview',
        includeRaw: true,
      }) as StructuredRunnable;
      const runnable = bound.withConfig ? bound.withConfig({ tags: ['nostream'] }) : bound;
      const result = await runnable.invoke(
        [cachedSystemMessage(systemPrompt(input.final)), new HumanMessage({ content: humanContent(input) as never })],
        input.signal ? { signal: input.signal } : undefined
      );
      const { parsed, raw } = unwrapResult(result);
      const costUsd = costOf(slug, raw);
      const items = flagItems(parsed);
      if (!items) {
        const stop = unusableStop(raw);
        box.lastError = stop ? new UnusableReplyError(stop) : new Error('malformed reviewer output');
        return { flags: [], costUsd };
      }
      box.lastError = null;
      return { flags: parseReviewFlags(items), costUsd };
    } catch (err) {
      box.lastError = err;
      if (isAbortOrTimeout(err) || input.signal?.aborted) throw err;
      console.warn('designer reviewer failed:', err);
      return { flags: [], costUsd: 0 };
    }
  };

  Object.defineProperty(review, 'lastError', {
    enumerable: true,
    get: () => box.lastError,
  });
  return review as DesignerReviewer;
}

const MD_CONTROL = /[\\`*_{}[\]()#+\-.!|~]/g;

/** Model text is untrusted. Escape markdown punctuation and HTML-like characters. */
function escapeReviewText(value: string): string {
  return value
    .replace(CONTROL_CHARS, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(MD_CONTROL, (ch) => `\\${ch}`);
}

export function formatFlags(flags: ReviewFlag[], final: boolean): string {
  if (flags.length === 0) return '';
  const who = final ? 'Final reviewer' : 'Reviewer';
  return flags
    .map((flag) => `**${who} (${flag.severity}):** ${escapeReviewText(flag.issue)} — ${escapeReviewText(flag.whyItMatters)}`)
    .join('\n');
}
