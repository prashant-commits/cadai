/**
 * The transcript is markdown in storage and a node list in memory.
 *
 * Sections are delimited by HTML comments rather than tags or fences. Comments
 * are inert in markdown, survive round-tripping through IndexedDB, and render as
 * nothing if a parser ever misses one - where an unclosed fence would swallow
 * the rest of the document, and section bodies routinely contain fenced code
 * blocks of their own, so nesting fences is not available.
 */

export type SectionStatus = 'running' | 'ok' | 'warn' | 'error' | 'skipped';

export interface TranscriptSection {
  kind: 'section';
  /** The graph node this section reports on, e.g. `architectNode`. */
  id: string;
  label: string;
  status: SectionStatus;
  body: string;
}

export interface TranscriptGate {
  kind: 'gate';
  /** Key into ChatMessage.gates. The payload never lives in the markdown. */
  id: string;
}

export type TranscriptNode = TranscriptSection | TranscriptGate;

/** `|` and `>` would end a marker field early, so they cannot survive raw. */
function encodeField(s: string): string {
  return s.replace(/\|/g, '&#124;').replace(/>/g, '&gt;');
}
function decodeField(s: string): string {
  return s.replace(/&#124;/g, '|').replace(/&gt;/g, '>');
}

/**
 * Neutralises any comment opener in model-authored text.
 *
 * Without this, a model that writes `<!--/s-->` into its prose would close the
 * enclosing section early and every later node would land in the wrong place.
 * The entity renders back to a literal `<!--` in the browser.
 */
export function escapeMarkers(text: string): string {
  return text.replace(/<!--/g, '&lt;!--');
}

export function serializeTranscript(nodes: TranscriptNode[]): string {
  return nodes
    .map((n) =>
      n.kind === 'gate'
        ? `<!--gate:${encodeField(n.id)}-->`
        : `<!--s:${encodeField(n.id)}|${encodeField(n.label)}|${n.status}-->${n.body}<!--/s-->`
    )
    .join('\n');
}

const NODE_RE = /<!--s:([^|]*)\|([^|]*)\|([^>]*)-->([\s\S]*?)<!--\/s-->|<!--gate:([^>]*)-->/g;

export function parseTranscript(src: string): TranscriptNode[] {
  if (!src) return [];
  const out: TranscriptNode[] = [];
  // A section with no closing marker simply does not match, so a transcript
  // truncated mid-stream yields every completed node and drops the partial one
  // rather than returning nothing.
  for (const m of src.matchAll(NODE_RE)) {
    if (m[5] !== undefined) {
      out.push({ kind: 'gate', id: decodeField(m[5]) });
    } else {
      out.push({
        kind: 'section',
        id: decodeField(m[1]),
        label: decodeField(m[2]),
        status: m[3] as SectionStatus,
        body: m[4],
      });
    }
  }
  return out;
}
