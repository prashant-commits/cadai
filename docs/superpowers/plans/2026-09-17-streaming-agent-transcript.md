# Streaming Agent Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace cadai's discrete progress pings and raw-model-output chat messages with one assistant message per turn that streams token by token, renders every structured output as server-composed markdown, and carries its gates as persisted records.

**Architecture:** The graph streams through `.stream({ streamMode: ['updates','messages','custom'] })` instead of `invoke()`. Nodes write markdown via `config.writer`; the architect diffs successive partial-parsed spec objects into markdown deltas. The client accumulates a `TranscriptNode[]`, serialises it into `ChatMessage.transcript` for display, and keeps `ChatMessage.content` as a compact summary — the only field replayed to the model. Gates pause the stream, land as `GateRecord`s, and render their controls in a dock above the composer.

**Tech Stack:** Next.js 16 (App Router), React 19, LangGraph 1.4.12, LangChain core 1.2.9, zustand, idb (IndexedDB), react-markdown + remark-gfm, Vitest 4, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-09-14-streaming-agent-transcript-design.md`

## Global Constraints

- **Single provider.** cadai runs on the Experiential Labs gateway only. Never import `@langchain/google-genai` or reintroduce a Google/Gemini lane.
- **No raw model output in the UI.** Every structured or raw model output is rendered to markdown server-side before it reaches the browser.
- **Label, don't drop.** A value that fails a plausibility check is rendered with a warning label, never silently discarded.
- **No printing-process framing.** Geometry, dimensions, coordinate frames and assembly relationships only — no nozzle, layer-height, material, overhang or slicing language in any user-facing string or prompt. `bedFace` remains as a schema field.
- **No edge treatments.** They were removed from the spec, prompts and gate UI; do not reintroduce them.
- **`content` is the only replayed field.** `transcript` must never be POSTed to `/api/chat`.
- **Client-safe modules.** Anything imported by a `'use client'` component must not transitively import `@langchain/openai` (see `src/lib/agent/models.ts` for the established split).
- Tests: `npm test` (Vitest). Run from the repo root.

---

### Task 1: Transcript node model and marker serialisation

The transcript is a string in storage and a node list in memory. Sections carry a
status that is only known when they close, so the client accumulates nodes and
serialises once — string patching is not used.

**Files:**
- Create: `src/lib/agent/transcript.ts`
- Test: `src/lib/agent/transcript.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SectionStatus`, `TranscriptSection`, `TranscriptGate`, `TranscriptNode`, `serializeTranscript(nodes: TranscriptNode[]): string`, `parseTranscript(src: string): TranscriptNode[]`, `escapeMarkers(text: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/agent/transcript.test.ts
import { describe, it, expect } from 'vitest';
import {
  serializeTranscript,
  parseTranscript,
  escapeMarkers,
  type TranscriptNode,
} from './transcript';

describe('transcript markers', () => {
  it('round-trips sections and gates', () => {
    const nodes: TranscriptNode[] = [
      { kind: 'section', id: 'architectNode', label: 'Mechanical Architect', status: 'ok', body: 'Bounding box: 62 x 40 x 18 mm' },
      { kind: 'gate', id: 'g1' },
      { kind: 'section', id: 'drafterNode', label: 'Parametric Drafter', status: 'warn', body: 'wrote 2 modules' },
    ];
    expect(parseTranscript(serializeTranscript(nodes))).toEqual(nodes);
  });

  it('round-trips a section whose body contains a fenced code block', () => {
    const nodes: TranscriptNode[] = [
      { kind: 'section', id: 'drafterNode', label: 'Drafter', status: 'ok', body: '```openscad\ncube([1,2,3]);\n```' },
    ];
    expect(parseTranscript(serializeTranscript(nodes))).toEqual(nodes);
  });

  it('neutralises a marker sequence appearing inside content', () => {
    const body = escapeMarkers('the model wrote <!--/s--> in its output');
    const parsed = parseTranscript(
      serializeTranscript([{ kind: 'section', id: 'n', label: 'L', status: 'ok', body }])
    );
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as { body: string }).body).not.toContain('<!--');
  });

  it('ignores a trailing unclosed section rather than swallowing the document', () => {
    const src = serializeTranscript([
      { kind: 'section', id: 'a', label: 'A', status: 'ok', body: 'done' },
    ]) + '<!--s:b|B|running-->partial';
    expect(parseTranscript(src).map((n) => n.kind)).toEqual(['section']);
  });

  it('returns an empty list for an empty transcript', () => {
    expect(parseTranscript('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/agent/transcript.test.ts`
Expected: FAIL — `Failed to resolve import "./transcript"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agent/transcript.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/agent/transcript.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/transcript.ts src/lib/agent/transcript.test.ts
git commit -m "feat(transcript): section and gate markers with round-trip parsing"
```

---

### Task 2: Message shape and persistence

`ChatMessage` gains the display transcript, the gate records, and a lifecycle
status. `content` keeps its existing meaning and stays the only field replayed as
history. No IndexedDB version bump: rows are schemaless objects and no new store
or index is involved, so old rows simply lack the new fields.

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/storage/db-schema.ts`
- Modify: `src/lib/storage/thread-storage.ts`
- Test: `src/lib/storage/thread-storage.test.ts`

**Interfaces:**
- Consumes: `TranscriptNode` is *not* used here — the transcript persists as a string.
- Produces: `GateRecord`, and `ChatMessage` extended with `transcript?: string`, `gates?: Record<string, GateRecord>`, `status?: MessageStatus`, `runId?: string`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/storage/thread-storage.test.ts`:

```ts
it('round-trips a message carrying a transcript, gates and status', async () => {
  const thread = makeThread();           // existing helper in this suite
  thread.messages.push({
    id: 'assistant-1',
    role: 'assistant',
    content: 'Built bracket_body, 62 x 40 x 18 mm.',
    transcript: '<!--s:architectNode|Architect|ok-->Bounding box: 62 x 40 x 18 mm<!--/s-->',
    gates: {
      g1: {
        payload: { kind: 'spec', spec: null, contract: null, revisionCount: 0 },
        status: 'approved',
        decision: { action: 'approve', comment: 'looks right' },
        decidedAt: 1_700_000_000_000,
      },
    },
    status: 'complete',
    runId: 'run-abc',
    timestamp: Date.now(),
  });

  await saveThread(thread);
  const [loaded] = (await loadThreads()).filter((t) => t.id === thread.id);
  const msg = loaded.messages.find((m) => m.id === 'assistant-1')!;

  expect(msg.transcript).toContain('architectNode');
  expect(msg.gates!.g1.status).toBe('approved');
  expect(msg.gates!.g1.decision!.comment).toBe('looks right');
  expect(msg.status).toBe('complete');
  expect(msg.runId).toBe('run-abc');
});

it('loads a legacy message that has none of the new fields', async () => {
  const thread = makeThread();
  thread.messages.push({
    id: 'legacy-1', role: 'assistant', content: 'old message', timestamp: Date.now(),
  });
  await saveThread(thread);
  const [loaded] = (await loadThreads()).filter((t) => t.id === thread.id);
  const msg = loaded.messages.find((m) => m.id === 'legacy-1')!;

  expect(msg.content).toBe('old message');
  expect(msg.transcript).toBeUndefined();
  expect(msg.gates).toBeUndefined();
  expect(msg.status).toBeUndefined();
});
```

If `makeThread`, `saveThread` or `loadThreads` are named differently in the
existing suite, use the existing names — do not add new helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/storage/thread-storage.test.ts`
Expected: FAIL — TypeScript rejects `transcript`, `gates`, `status` and `runId` as unknown properties of `ChatMessage`.

- [ ] **Step 3: Write minimal implementation**

In `src/types/index.ts`, add above `ChatMessage`:

```ts
/** Where one gate got to. `open` is the only state that accepts input. */
export type GateStatus = 'open' | 'approved' | 'revised' | 'denied';

/** How far the assistant message's own turn got. */
export type MessageStatus = 'streaming' | 'awaiting_input' | 'complete' | 'interrupted' | 'error';

/**
 * One human-in-the-loop gate, as it appears in the transcript.
 *
 * The payload rides here rather than inside the markdown: embedding a
 * multi-kilobyte spec would mean escaping it through the renderer and
 * re-parsing it on every read. The markdown carries only `<!--gate:<id>-->`.
 */
export interface GateRecord {
  payload: GatePayload;
  decision?: GateDecision;
  status: GateStatus;
  decidedAt?: number;
}
```

Replace the `ChatMessage` interface with:

```ts
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /**
   * The compact summary. This is the ONLY field replayed to the model: every
   * prior message's `content` is re-POSTed on the next turn, so the full
   * thinking transcript must not live here or context cost compounds per turn.
   */
  content: string;
  /** Serialised TranscriptNode[]; display only, never leaves the browser. */
  transcript?: string;
  gates?: Record<string, GateRecord>;
  status?: MessageStatus;
  /** The paused run behind an open gate on this message. */
  runId?: string;
  image?: string;
  code?: string;
  timestamp: number;
}
```

Leave `AgentProgress` and `progressUpdates` in place for now; Task 9 removes them
once nothing reads them.

In `src/lib/storage/db-schema.ts`, extend `MessageRow` (import `GateRecord` and
`MessageStatus` alongside the existing type imports):

```ts
export interface MessageRow {
  rowId: string;
  threadId: string;
  id: string;
  role: ChatMessage['role'];
  content: string;
  image?: string;
  progressUpdates?: AgentProgress[];
  transcript?: string;
  gates?: Record<string, GateRecord>;
  status?: MessageStatus;
  runId?: string;
  timestamp: number;
  hasCode: boolean;
}
```

In `src/lib/storage/thread-storage.ts`, add to `toMessageRow`'s returned object,
after `progressUpdates`:

```ts
    transcript: message.transcript,
    gates: message.gates,
    status: message.status,
    runId: message.runId,
```

and in `assembleThread`'s mapper, after the `progressUpdates` line:

```ts
      if (m.transcript !== undefined) message.transcript = m.transcript;
      if (m.gates !== undefined) message.gates = m.gates;
      if (m.status !== undefined) message.status = m.status;
      if (m.runId !== undefined) message.runId = m.runId;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/storage/thread-storage.test.ts`
Expected: PASS, including both new tests.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/lib/storage/db-schema.ts src/lib/storage/thread-storage.ts src/lib/storage/thread-storage.test.ts
git commit -m "feat(storage): persist transcript, gate records and message status"
```

---

### Task 3: Incremental spec-to-markdown renderer

`withStructuredOutput(...).stream()` yields progressively-complete **parsed
objects** (measured: 382 chunks on `deepseek-v4-flash`, fields settling between
1.65 s and 13.9 s). This renderer turns that sequence into markdown deltas.

The settling rule is structural: JSON object keys arrive in order, so a key is
complete once a *later* key exists. An array element is complete once the array
has grown past it. A value that settles but is implausible is rendered with a
warning label, never dropped — hiding a wrong number is the failure mode the user
most needs to see.

**Files:**
- Create: `src/lib/agent/spec-markdown.ts`
- Test: `src/lib/agent/spec-markdown.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createSpecRenderer(): { push(partial: unknown): string }` — `push` returns markdown to append, `''` when nothing new settled.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/agent/spec-markdown.test.ts
import { describe, it, expect } from 'vitest';
import { createSpecRenderer } from './spec-markdown';

describe('createSpecRenderer', () => {
  it('emits nothing for a key that is still the last one present', () => {
    const r = createSpecRenderer();
    expect(r.push({ assemblyName: 'brack' })).toBe('');
    expect(r.push({ assemblyName: 'bracket_body' })).toBe('');
  });

  it('emits a key once a later key proves it settled', () => {
    const r = createSpecRenderer();
    r.push({ assemblyName: 'bracket_body' });
    const out = r.push({ assemblyName: 'bracket_body', boundingBox: {} });
    expect(out).toContain('bracket_body');
  });

  it('never re-emits a key', () => {
    const r = createSpecRenderer();
    r.push({ assemblyName: 'bracket_body' });
    r.push({ assemblyName: 'bracket_body', boundingBox: {} });
    const again = r.push({ assemblyName: 'bracket_body', boundingBox: { width: 62 }, components: [] });
    expect(again).not.toContain('bracket_body');
  });

  it('renders a settled bounding box as dimensions', () => {
    const r = createSpecRenderer();
    r.push({ boundingBox: { width: 62, length: 40, height: 18 } });
    const out = r.push({ boundingBox: { width: 62, length: 40, height: 18 }, components: [] });
    expect(out).toContain('62 x 40 x 18 mm');
  });

  it('emits each component once the array grows past it', () => {
    const r = createSpecRenderer();
    r.push({ components: [{ name: 'body', description: 'main body' }] });
    const out = r.push({
      components: [
        { name: 'body', description: 'main body' },
        { name: 'arm', description: 'clamp arm' },
      ],
    });
    expect(out).toContain('body');
    expect(out).not.toContain('clamp arm');
  });

  it('LABELS an implausible dimension rather than dropping it', () => {
    const r = createSpecRenderer();
    r.push({ boundingBox: { width: 100101010101, length: 40, height: 18 } });
    const out = r.push({ boundingBox: { width: 100101010101, length: 40, height: 18 }, components: [] });
    expect(out).toContain('100101010101');
    expect(out).toContain('implausible');
  });

  it('flushes whatever is still pending when the stream ends', () => {
    const r = createSpecRenderer();
    r.push({ assemblyName: 'bracket_body' });
    expect(r.push({ assemblyName: 'bracket_body', __done: true })).toContain('bracket_body');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/agent/spec-markdown.test.ts`
Expected: FAIL — `Failed to resolve import "./spec-markdown"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agent/spec-markdown.ts
/**
 * Turns the architect's streaming structured output into markdown deltas.
 *
 * withStructuredOutput(...).stream() yields progressively-complete PARSED
 * OBJECTS, not raw JSON fragments - LangChain's cumulative parser already does
 * the partial-JSON work - so this diffs consecutive snapshots rather than
 * re-parsing text.
 *
 * Settling rule: JSON keys arrive in order, so key N is complete once key N+1
 * exists. Emitting earlier would let a line rewrite itself while the user reads
 * it, which is worse than arriving late.
 */

/**
 * Beyond this, a dimension is not a design - it is a degenerate decode. The
 * value is still shown, labelled: silently dropping it would hide from the user
 * that the model produced something wrong.
 */
const PLAUSIBLE_MAX_MM = 10_000;

/** Top-level spec keys, in the order the schema emits them. */
const KEY_ORDER = [
  'assemblyName',
  'boundingBox',
  'components',
  'jointContracts',
  'stressPoints',
  'assumptions',
  'openQuestions',
] as const;

function num(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '?';
  if (Math.abs(v) > PLAUSIBLE_MAX_MM) return `${v} **(implausible)**`;
  return String(v);
}

function renderKey(key: string, value: unknown): string {
  switch (key) {
    case 'assemblyName':
      return typeof value === 'string' && value ? `**${value}**\n` : '';
    case 'boundingBox': {
      const b = value as { width?: unknown; length?: unknown; height?: unknown } | undefined;
      if (!b) return '';
      return `Bounding box: ${num(b.width)} x ${num(b.length)} x ${num(b.height)} mm\n`;
    }
    default:
      return '';
  }
}

function renderComponent(c: { name?: string; description?: string }): string {
  return `- ${c.name ?? 'unnamed'}: ${c.description ?? ''}\n`;
}

function renderListItem(key: string, item: Record<string, unknown>): string {
  switch (key) {
    case 'components':
      return renderComponent(item as { name?: string; description?: string });
    case 'stressPoints':
      return `- ${item.risk ?? 'unknown'} risk at ${item.location ?? '?'} - ${item.mitigation ?? ''}\n`;
    case 'assumptions':
      return `- ${item.field ?? '?'}: ${item.value ?? '?'} (${item.rationale ?? ''})\n`;
    case 'openQuestions':
      return `- ${item.question ?? '?'}\n`;
    case 'jointContracts':
      return `- ${item.type ?? 'joint'} between ${item.partA ?? '?'} and ${item.partB ?? '?'}, ${num(item.clearance)}mm clearance\n`;
    default:
      return '';
  }
}

/** Headings printed the first time a list key produces an item. */
const LIST_HEADINGS: Record<string, string> = {
  components: '\nComponents:\n',
  jointContracts: '\nJoints:\n',
  stressPoints: '\nStress points:\n',
  assumptions: '\nAssumptions:\n',
  openQuestions: '\nOpen questions:\n',
};

export function createSpecRenderer(): { push(partial: unknown): string } {
  const emittedKeys = new Set<string>();
  const emittedCounts = new Map<string, number>();
  const headed = new Set<string>();

  return {
    push(partial: unknown): string {
      if (!partial || typeof partial !== 'object') return '';
      const obj = partial as Record<string, unknown>;
      // A caller can force every pending key out by setting __done - used when
      // the stream ends and the last key has no successor to settle it.
      const done = obj.__done === true;
      const present = KEY_ORDER.filter((k) => obj[k] !== undefined);
      let out = '';

      for (let i = 0; i < present.length; i++) {
        const key = present[i];
        const settled = done || i < present.length - 1;
        const value = obj[key];

        if (Array.isArray(value)) {
          // An element is complete once the array grew past it; the last
          // element waits for the next key, or for __done.
          const limit = settled ? value.length : value.length - 1;
          const already = emittedCounts.get(key) ?? 0;
          for (let j = already; j < limit; j++) {
            if (!headed.has(key)) {
              out += LIST_HEADINGS[key] ?? '';
              headed.add(key);
            }
            out += renderListItem(key, value[j] as Record<string, unknown>);
          }
          if (limit > already) emittedCounts.set(key, limit);
          continue;
        }

        if (!settled || emittedKeys.has(key)) continue;
        emittedKeys.add(key);
        out += renderKey(key, value);
      }

      return out;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/agent/spec-markdown.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/spec-markdown.ts src/lib/agent/spec-markdown.test.ts
git commit -m "feat(agent): render streaming spec output as markdown deltas"
```

---

### Task 4: Composed run summary

`respondToUser` currently ships `state.explanation`, which is
`summarizeSpec(spec) + "\n\n" + <entire raw model reply>`. This replaces it with a
deterministic recap that becomes `ChatMessage.content` — and therefore the only
thing the next turn replays.

**Files:**
- Create: `src/lib/agent/run-summary.ts`
- Test: `src/lib/agent/run-summary.test.ts`

**Interfaces:**
- Consumes: `AssemblySpec` (`./assembly-spec`), `ModelInfo` (`@/types`), `SpecViolation` (`./spec-audit`), `ChosenApproach` (`../research/design-brief`).
- Produces: `composeRunSummary(input: RunSummaryInput): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/agent/run-summary.test.ts
import { describe, it, expect } from 'vitest';
import { composeRunSummary } from './run-summary';

const spec = {
  assemblyName: 'bracket_body',
  boundingBox: { width: 62, length: 40, height: 18 },
  components: [{ name: 'body', description: 'main body' }],
  assumptions: [],
  openQuestions: [],
} as never;

const modelInfo = {
  dimensions: { x: 62, y: 40, z: 18 },
  volumeMm3: 12_000,
} as never;

describe('composeRunSummary', () => {
  it('names the assembly and its measured dimensions', () => {
    const out = composeRunSummary({ spec, modelInfo, violations: [], attempts: 1, isValid: true });
    expect(out).toContain('bracket_body');
    expect(out).toContain('62 x 40 x 18 mm');
  });

  it('reports repairs when more than one attempt ran', () => {
    const out = composeRunSummary({ spec, modelInfo, violations: [], attempts: 3, isValid: true });
    expect(out).toMatch(/2 repair/);
  });

  it('says so plainly when the first attempt compiled', () => {
    const out = composeRunSummary({ spec, modelInfo, violations: [], attempts: 1, isValid: true });
    expect(out).not.toMatch(/repair/);
  });

  it('lists surviving violations as waived', () => {
    const out = composeRunSummary({
      spec, modelInfo, attempts: 1, isValid: true,
      violations: [{ kind: 'bbox', message: 'width is 2mm over', severity: 'warning' } as never],
    });
    expect(out).toContain('width is 2mm over');
    expect(out).toContain('waived');
  });

  it('reports a failed run without claiming a model was produced', () => {
    const out = composeRunSummary({ spec, modelInfo: null, violations: [], attempts: 3, isValid: false });
    expect(out).toMatch(/did not compile|could not be produced/i);
    expect(out).not.toContain('62 x 40 x 18 mm');
  });

  it('is never empty, even with nothing to report', () => {
    expect(composeRunSummary({ spec: null, modelInfo: null, violations: [], attempts: 0, isValid: false }).trim()).not.toBe('');
  });

  it('names the chosen research approach when one was picked', () => {
    const out = composeRunSummary({
      spec, modelInfo, violations: [], attempts: 1, isValid: true,
      approach: { id: 'a1', name: 'Two-plate gusseted bracket' } as never,
    });
    expect(out).toContain('Two-plate gusseted bracket');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/agent/run-summary.test.ts`
Expected: FAIL — `Failed to resolve import "./run-summary"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agent/run-summary.ts
import type { AssemblySpec } from './assembly-spec';
import type { SpecViolation } from './spec-audit';
import type { ModelInfo } from '@/types';
import type { ChosenApproach } from '../research/design-brief';

export interface RunSummaryInput {
  spec: AssemblySpec | null;
  modelInfo: ModelInfo | null;
  violations: SpecViolation[];
  /** Total draft+repair passes. 1 means the first draft compiled. */
  attempts: number;
  isValid: boolean;
  approach?: ChosenApproach;
}

/**
 * The assistant message body for a finished run.
 *
 * Deliberately deterministic and compact: this string becomes
 * ChatMessage.content, which is the only field replayed to the model on the
 * next turn. The model's own prose and the generated code are NOT here - the
 * prose streams into the transcript, and the code lives in the editor and
 * behind the message's own code disclosure.
 */
export function composeRunSummary(input: RunSummaryInput): string {
  const { spec, modelInfo, violations, attempts, isValid, approach } = input;
  const lines: string[] = [];

  if (approach?.name) lines.push(`Approach: ${approach.name}.`);

  if (!isValid) {
    lines.push(
      spec?.assemblyName
        ? `**${spec.assemblyName}** did not compile to a valid model after ${attempts} attempt${attempts === 1 ? '' : 's'}.`
        : 'No valid model could be produced for this request.'
    );
  } else {
    const name = spec?.assemblyName ?? 'the model';
    const d = modelInfo?.dimensions;
    lines.push(
      d
        ? `Built **${name}**, measuring ${d.x} x ${d.y} x ${d.z} mm.`
        : `Built **${name}**.`
    );
    if (spec?.components?.length) {
      lines.push(`${spec.components.length} component${spec.components.length === 1 ? '' : 's'}: ${spec.components.map((c) => c.name).join(', ')}.`);
    }
    if (attempts > 1) {
      lines.push(`Took ${attempts - 1} repair pass${attempts - 1 === 1 ? '' : 'es'} after the first draft.`);
    }
  }

  if (violations.length) {
    lines.push(`\n${violations.length} finding${violations.length === 1 ? '' : 's'} waived:`);
    for (const v of violations) lines.push(`- [${v.kind}] ${v.message}`);
  }

  // Never empty: an empty assistant bubble is a bug the user should see as
  // text, not as a blank. The old code papered over this with a literal
  // "Model generation completed." fallback on the client.
  return lines.length ? lines.join('\n') : 'The run finished without producing a summary.';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/agent/run-summary.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/run-summary.ts src/lib/agent/run-summary.test.ts
git commit -m "feat(agent): deterministic run summary replacing the raw model dump"
```

---

### Task 5: Stream event union and the section state machine

`readStream` stops producing `AgentProgress` items and starts producing a
`TranscriptNode[]`, a gate map and a summary. The event union collapses the
current eight-member `StreamEventPayload` to five kinds.

**Files:**
- Create: `src/lib/agent/stream-events.ts`
- Rewrite: `src/lib/stream-reader.ts`
- Test: `src/lib/stream-reader.test.ts`

**Interfaces:**
- Consumes: `TranscriptNode`, `serializeTranscript` (Task 1); `GateRecord` (Task 2).
- Produces: `StreamEvent` union; `readStream(response, callbacks): Promise<void>` with callbacks `{ onUpdate(state: StreamState): void; onDone(state: StreamState): void }` where `StreamState = { nodes: TranscriptNode[]; gates: Record<string, GateRecord>; summary: string; code?: string; stl?: string; designContract?: DesignContract; runId?: string; awaitingInput: boolean; error?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/stream-reader.test.ts
import { describe, it, expect } from 'vitest';
import { readStream, type StreamState } from './stream-reader';
import type { StreamEvent } from './agent/stream-events';

function sse(events: StreamEvent[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new Blob([body]).stream());
}

async function run(events: StreamEvent[]) {
  let final: StreamState | undefined;
  const updates: StreamState[] = [];
  await readStream(sse(events), {
    onUpdate: (s) => updates.push(structuredClone({ ...s, nodes: [...s.nodes] })),
    onDone: (s) => { final = s; },
  });
  return { final: final!, updates };
}

describe('readStream', () => {
  it('accumulates deltas into the open section', async () => {
    const { final } = await run([
      { t: 'section', id: 'architectNode', label: 'Architect', state: 'open' },
      { t: 'delta', text: 'Bounding box: ' },
      { t: 'delta', text: '62 x 40 x 18 mm' },
      { t: 'section', id: 'architectNode', state: 'close', status: 'ok' },
      { t: 'result', summary: 'Built it.' },
    ]);
    expect(final.nodes).toEqual([
      { kind: 'section', id: 'architectNode', label: 'Architect', status: 'ok', body: 'Bounding box: 62 x 40 x 18 mm' },
    ]);
    expect(final.summary).toBe('Built it.');
  });

  it('records a gate and marks the run as awaiting input', async () => {
    const payload = { kind: 'spec', spec: null, contract: null, revisionCount: 0 } as const;
    const { final } = await run([
      { t: 'section', id: 'architectNode', label: 'Architect', state: 'open' },
      { t: 'delta', text: 'spec' },
      { t: 'section', id: 'architectNode', state: 'close', status: 'ok' },
      { t: 'gate', id: 'g1', runId: 'run-1', payload },
    ]);
    expect(final.awaitingInput).toBe(true);
    expect(final.runId).toBe('run-1');
    expect(final.gates.g1.status).toBe('open');
    expect(final.nodes.at(-1)).toEqual({ kind: 'gate', id: 'g1' });
  });

  it('emits an update per delta so the UI can render progressively', async () => {
    const { updates } = await run([
      { t: 'section', id: 'n', label: 'N', state: 'open' },
      { t: 'delta', text: 'a' },
      { t: 'delta', text: 'b' },
      { t: 'section', id: 'n', state: 'close', status: 'ok' },
      { t: 'result', summary: 'done' },
    ]);
    expect(updates.length).toBeGreaterThanOrEqual(4);
  });

  it('routes a delta with no open section into an implicit section rather than dropping it', async () => {
    const { final } = await run([
      { t: 'delta', text: 'orphan text' },
      { t: 'result', summary: 'done' },
    ]);
    expect(serializeOf(final)).toContain('orphan text');
  });

  it('carries code, stl and contract off the result event', async () => {
    const { final } = await run([
      { t: 'result', summary: 'ok', code: 'cube(1);', stl: 'solid x facet normal', designContract: { standing: {}, pinnedParams: {} } },
    ]);
    expect(final.code).toBe('cube(1);');
    expect(final.stl).toContain('facet normal');
    expect(final.designContract).toBeDefined();
  });

  it('surfaces an error event and closes the open section as failed', async () => {
    const { final } = await run([
      { t: 'section', id: 'n', label: 'N', state: 'open' },
      { t: 'delta', text: 'partial' },
      { t: 'error', message: 'gateway refused' },
    ]);
    expect(final.error).toBe('gateway refused');
    expect((final.nodes[0] as { status: string }).status).toBe('error');
  });
});

function serializeOf(s: StreamState) {
  return s.nodes.map((n) => ('body' in n ? n.body : '')).join('');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/stream-reader.test.ts`
Expected: FAIL — `readStream` has the old signature and `StreamState` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agent/stream-events.ts
/**
 * The wire protocol between the graph and the chat client.
 *
 * Deliberately client-safe: no provider imports, so a 'use client' component
 * can import these types without dragging ChatOpenAI into the bundle.
 */
import type { GatePayload, DesignContract } from '@/types';
import type { SectionStatus } from './transcript';

export type StreamEvent =
  | { t: 'section'; id: string; label: string; state: 'open' }
  | { t: 'section'; id: string; state: 'close'; status: SectionStatus; summary?: string }
  /** Markdown appended to whichever section is currently open. */
  | { t: 'delta'; text: string }
  | { t: 'gate'; id: string; runId: string; payload: GatePayload }
  /** Terminal for a completed run. `summary` becomes ChatMessage.content. */
  | { t: 'result'; summary: string; code?: string; stl?: string; designContract?: DesignContract }
  | { t: 'error'; message: string };
```

```ts
// src/lib/stream-reader.ts
import type { DesignContract, GateRecord } from '@/types';
import type { StreamEvent } from './agent/stream-events';
import type { TranscriptNode, TranscriptSection } from './agent/transcript';
import { escapeMarkers } from './agent/transcript';

export interface StreamState {
  nodes: TranscriptNode[];
  gates: Record<string, GateRecord>;
  summary: string;
  code?: string;
  stl?: string;
  designContract?: DesignContract;
  /** The paused run to POST back to /api/chat/resume. */
  runId?: string;
  awaitingInput: boolean;
  error?: string;
}

export interface StreamCallbacks {
  onUpdate: (state: StreamState) => void;
  onDone: (state: StreamState) => void;
}

export async function readStream(response: Response, callbacks: StreamCallbacks): Promise<void> {
  if (!response.body) throw new Error('No response stream received.');

  const state: StreamState = { nodes: [], gates: {}, summary: '', awaitingInput: false };
  let open: TranscriptSection | null = null;

  /** A delta with no open section still has to land somewhere visible. */
  function ensureOpen(): TranscriptSection {
    if (open) return open;
    open = { kind: 'section', id: 'agent', label: 'Agent', status: 'running', body: '' };
    state.nodes.push(open);
    return open;
  }

  function apply(event: StreamEvent) {
    switch (event.t) {
      case 'section':
        if (event.state === 'open') {
          open = { kind: 'section', id: event.id, label: event.label, status: 'running', body: '' };
          state.nodes.push(open);
        } else if (open) {
          open.status = event.status;
          if (event.summary) open.body += `\n\n${escapeMarkers(event.summary)}`;
          open = null;
        }
        return;
      case 'delta':
        ensureOpen().body += event.text;
        return;
      case 'gate':
        if (open) { open.status = 'ok'; open = null; }
        state.gates[event.id] = { payload: event.payload, status: 'open' };
        state.nodes.push({ kind: 'gate', id: event.id });
        state.runId = event.runId;
        state.awaitingInput = true;
        return;
      case 'result':
        if (open) { open.status = 'ok'; open = null; }
        state.summary = event.summary;
        if (event.code) state.code = event.code;
        if (event.stl) state.stl = event.stl;
        if (event.designContract) state.designContract = event.designContract;
        // A resumed run that reaches a result really has finished, even if it
        // paused earlier in this same stream.
        state.awaitingInput = false;
        return;
      case 'error':
        if (open) { open.status = 'error'; open = null; }
        state.error = event.message;
        state.awaitingInput = false;
        return;
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      const trimmed = frame.trim();
      if (!trimmed.startsWith('data: ')) continue;
      try {
        apply(JSON.parse(trimmed.slice(6)) as StreamEvent);
        callbacks.onUpdate(state);
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    }
  }

  callbacks.onDone(state);
}
```

Note the deliberate change from the old reader: `onDone` fires **always**, including
while a gate is open. The caller decides what to do — `awaitingInput` says which
case it is. The old design suppressed the callback entirely and forced every
caller to guess.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/stream-reader.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/stream-events.ts src/lib/stream-reader.ts src/lib/stream-reader.test.ts
git commit -m "feat(stream): section state machine replacing progress-item events"
```

---

### Task 6: Nodes write markdown through `config.writer`

Graph nodes stop describing themselves through `onProgress` status pings and
start writing markdown. `architectNode` streams its structured output through the
Task 3 renderer; `respondToUser` emits the terminal `result` event built by Task 4.

Every custom payload carries its own `node` id, because langgraph's `custom`
stream mode yields the bare payload with no node metadata attached.

**Files:**
- Modify: `src/lib/agent/graph.ts`
- Test: `src/lib/agent/graph-writer.test.ts`

**Interfaces:**
- Consumes: `createSpecRenderer` (Task 3), `composeRunSummary` (Task 4), `StreamEvent` (Task 5).
- Produces: custom-channel payloads typed `StreamEvent & { node: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/agent/graph-writer.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const invokeMock = vi.fn();
const streamMock = vi.fn();
vi.mock('@langchain/openai', () => {
  class F {
    invoke = invokeMock;
    stream = streamMock;
    withStructuredOutput() { return this; }
    bindTools() { return this; }
  }
  return { ChatOpenAI: vi.fn().mockImplementation(function () { return new F(); }) };
});

import { createCadAgent } from './graph';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import { HumanMessage } from '@langchain/core/messages';

const keys: string[] = [];
afterAll(async () => {
  const cp = getCheckpointer();
  for (const k of keys) await cp.deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
});

describe('graph custom-channel writes', () => {
  beforeEach(() => {
    process.env.CADAI_VISUAL_CRITIC = 'off';
    process.env.CADAI_RESEARCH = 'off';
    invokeMock.mockReset();
    streamMock.mockReset();
  });

  it('streams the architect spec as markdown deltas tagged with the node id', async () => {
    // withStructuredOutput().stream() yields progressively-complete objects.
    streamMock.mockReturnValueOnce(
      (async function* () {
        yield { assemblyName: 'bracket_body' };
        yield { assemblyName: 'bracket_body', boundingBox: { width: 62, length: 40, height: 18 } };
        yield {
          assemblyName: 'bracket_body',
          boundingBox: { width: 62, length: 40, height: 18 },
          components: [{ name: 'body', description: 'main body' }],
          assumptions: [], openQuestions: [],
        };
      })()
    );

    const agent = createCadAgent(undefined, 'deepseek-v4-flash');
    const key = runCheckpointKey('writer-test', 'run-1');
    keys.push(key);

    const custom: Array<{ t: string; node?: string; text?: string }> = [];
    for await (const [mode, payload] of await agent.stream(
      { messages: [new HumanMessage('make a bracket')], designContract: null },
      { configurable: { thread_id: key }, streamMode: ['updates', 'custom'] }
    )) {
      if (mode === 'custom') custom.push(payload as never);
    }

    const deltas = custom.filter((c) => c.t === 'delta' && c.node === 'architectNode');
    expect(deltas.length).toBeGreaterThan(0);
    const md = deltas.map((d) => d.text).join('');
    expect(md).toContain('bracket_body');
    expect(md).toContain('62 x 40 x 18 mm');
    // The whole point: no JSON reaches the channel.
    expect(md).not.toContain('{');
  });

  it('never writes a raw provider error into the channel', async () => {
    streamMock.mockImplementation(() => {
      throw new Error('400 Bad Request {"error":{"message":"giant payload"}}');
    });
    invokeMock.mockRejectedValue(new Error('400 Bad Request {"error":{"message":"giant payload"}}'));

    const agent = createCadAgent(undefined, 'deepseek-v4-flash');
    const key = runCheckpointKey('writer-test', 'run-2');
    keys.push(key);

    const custom: Array<{ text?: string }> = [];
    for await (const [mode, payload] of await agent.stream(
      { messages: [new HumanMessage('make a bracket')], designContract: null },
      { configurable: { thread_id: key }, streamMode: ['custom'] }
    )) {
      if (mode === 'custom') custom.push(payload as never);
    }
    const all = custom.map((c) => c.text ?? '').join('');
    expect(all).not.toContain('giant payload');
    expect(all).not.toContain('400 Bad Request');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/agent/graph-writer.test.ts`
Expected: FAIL — no `custom` payloads are produced; `deltas.length` is 0.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/agent/graph.ts`:

1. Add imports at the top of the file:

```ts
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { createSpecRenderer } from './spec-markdown';
import { composeRunSummary } from './run-summary';
import type { StreamEvent } from './stream-events';
```

2. Add this helper immediately above `export function createCadAgent(`:

```ts
/**
 * Writes one stream event on the graph's `custom` channel.
 *
 * langgraph's custom mode yields the bare payload with no node metadata, so the
 * node id travels inside the payload - the client needs it to know which
 * section a delta belongs to.
 */
function write(
  config: LangGraphRunnableConfig | undefined,
  node: string,
  event: StreamEvent
): void {
  config?.writer?.({ ...event, node });
}
```

3. In `architectNode`, replace the `architectModel.invoke(attemptMessages, config)`
   call inside the retry loop with a streaming read that renders as it goes:

```ts
        const renderer = createSpecRenderer();
        let raw: unknown = null;
        for await (const partial of await architectModel.stream(attemptMessages, config)) {
          raw = partial;
          const md = renderer.push(partial);
          if (md) write(config, 'architectNode', { t: 'delta', text: md });
        }
        // Flush whatever settled last: the final key has no successor to
        // settle it, so without this the tail of every spec is never shown.
        const tail = renderer.push({ ...(raw as object), __done: true });
        if (tail) write(config, 'architectNode', { t: 'delta', text: tail });
```

   then continue with the existing `AssemblySpecSchema.safeParse(raw)` logic
   unchanged.

4. Replace the failure `onProgress?.({...})` block that currently interpolates
   `lastError.slice(0, 200)` with:

```ts
    if (!spec) {
      // The raw provider error goes to the log ONLY. It was being sliced into
      // the UI, which is how a provider's 400 payload ended up rendered as the
      // agent's own output.
      console.error('architectNode: no valid Assembly Spec after 3 attempts:', lastError);
      write(config, 'architectNode', {
        t: 'delta',
        text: '\nNo valid Assembly Spec after 3 attempts. Drafting without a dimensional contract.\n',
      });
    }
```

   `architectNode` already receives `config` as its second parameter.

5. In `respondToUser`, change the signature to
   `async function respondToUser(state: AgentStateType, config?: LangGraphRunnableConfig)`
   and replace **both** `onProgress?.({ ... })` calls with a single terminal write:

```ts
    const summary = composeRunSummary({
      spec: state.assemblySpec,
      modelInfo: state.modelInfo,
      violations: state.specViolations,
      attempts: state.attemptCount,
      isValid: state.isValid,
      approach: state.designContract?.researchApproach,
    });

    write(config, 'respondToUser', {
      t: 'result',
      summary,
      code: state.currentCode || undefined,
      stl: state.stlContent || undefined,
      designContract: state.designContract ?? undefined,
    });
```

6. Leave every other `onProgress?.()` call site alone in this task. Task 7's
   bridge derives section boundaries from the `updates` channel, so those pings
   become dead weight rather than a correctness problem; Task 10 deletes them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/agent/graph-writer.test.ts`
Expected: PASS, 2 tests.

Then run the existing suites to confirm nothing regressed:
Run: `npx vitest run src/lib/agent/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/graph.ts src/lib/agent/graph-writer.test.ts
git commit -m "feat(agent): stream node markdown through config.writer"
```

---

### Task 7: Graph-stream to SSE bridge

Translates langgraph's `[mode, payload]` tuples into the Task 5 event union.
Lives in its own module so it is unit-testable against a fake async iterable
rather than only through an HTTP route.

Shapes are as measured by spike on langgraph 1.4.12: `custom` yields the bare
payload; `messages` yields `[chunk, metadata]` with `metadata.langgraph_node`;
an interrupt arrives as `['updates', { __interrupt__: [{ id, value }] }]`.

**Files:**
- Create: `src/lib/agent/stream-bridge.ts`
- Test: `src/lib/agent/stream-bridge.test.ts`

**Interfaces:**
- Consumes: `StreamEvent` (Task 5).
- Produces: `NODE_LABELS: Record<string, string>`, `bridgeGraphStream(chunks: AsyncIterable<unknown>, runId: string, emit: (e: StreamEvent) => void): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/agent/stream-bridge.test.ts
import { describe, it, expect } from 'vitest';
import { bridgeGraphStream } from './stream-bridge';
import type { StreamEvent } from './stream-events';

async function bridge(chunks: unknown[]) {
  const out: StreamEvent[] = [];
  await bridgeGraphStream((async function* () { yield* chunks; })(), 'run-1', (e) => out.push(e));
  return out;
}

describe('bridgeGraphStream', () => {
  it('opens a section on the first delta for a node and labels it', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'hi', node: 'architectNode' }]]);
    expect(out[0]).toEqual({ t: 'section', id: 'architectNode', label: 'Mechanical Architect', state: 'open' });
    expect(out[1]).toEqual({ t: 'delta', text: 'hi' });
  });

  it('does not reopen a section for a second delta from the same node', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'architectNode' }],
      ['custom', { t: 'delta', text: 'b', node: 'architectNode' }],
    ]);
    expect(out.filter((e) => e.t === 'section')).toHaveLength(1);
  });

  it('closes the open section when a different node starts', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'architectNode' }],
      ['custom', { t: 'delta', text: 'b', node: 'drafterNode' }],
    ]);
    expect(out[2]).toEqual({ t: 'section', id: 'architectNode', state: 'close', status: 'ok' });
    expect(out[3]).toEqual({ t: 'section', id: 'drafterNode', label: 'Parametric Drafter', state: 'open' });
  });

  it('turns model token chunks into deltas under their own node', async () => {
    const out = await bridge([
      ['messages', [{ content: 'Hel' }, { langgraph_node: 'drafterNode' }]],
      ['messages', [{ content: 'lo' }, { langgraph_node: 'drafterNode' }]],
    ]);
    expect(out.filter((e) => e.t === 'delta')).toEqual([{ t: 'delta', text: 'Hel' }, { t: 'delta', text: 'lo' }]);
  });

  it('emits a gate event with the run id when an interrupt arrives', async () => {
    const payload = { kind: 'spec', spec: null, contract: null, revisionCount: 0 };
    const out = await bridge([['updates', { __interrupt__: [{ id: 'i1', value: payload }] }]]);
    const gate = out.find((e) => e.t === 'gate');
    expect(gate).toEqual({ t: 'gate', id: 'i1', runId: 'run-1', payload });
  });

  it('closes an open section before emitting a gate', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'architectNode' }],
      ['updates', { __interrupt__: [{ id: 'i1', value: { kind: 'spec' } }] }],
    ]);
    expect(out[2]).toEqual({ t: 'section', id: 'architectNode', state: 'close', status: 'ok' });
    expect(out[3]!.t).toBe('gate');
  });

  it('passes a result event straight through and closes any open section', async () => {
    const out = await bridge([
      ['custom', { t: 'delta', text: 'a', node: 'drafterNode' }],
      ['custom', { t: 'result', summary: 'Built it.', node: 'respondToUser' }],
    ]);
    expect(out.at(-1)).toEqual({ t: 'result', summary: 'Built it.' });
    expect(out.some((e) => e.t === 'section' && e.state === 'close')).toBe(true);
  });

  it('labels an unknown node with its own id rather than dropping it', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'x', node: 'brandNewNode' }]]);
    expect(out[0]).toEqual({ t: 'section', id: 'brandNewNode', label: 'brandNewNode', state: 'open' });
  });

  it('closes the trailing section when the stream ends', async () => {
    const out = await bridge([['custom', { t: 'delta', text: 'a', node: 'drafterNode' }]]);
    expect(out.at(-1)).toEqual({ t: 'section', id: 'drafterNode', state: 'close', status: 'ok' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/agent/stream-bridge.test.ts`
Expected: FAIL — `Failed to resolve import "./stream-bridge"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agent/stream-bridge.ts
import type { GatePayload } from '@/types';
import type { StreamEvent } from './stream-events';

/** Human labels for graph nodes. An unlisted node falls back to its own id. */
export const NODE_LABELS: Record<string, string> = {
  researchNode: 'Design Researcher',
  researchGate: 'Approach Review',
  architectNode: 'Mechanical Architect',
  specGate: 'Spec Review',
  drafterNode: 'Parametric Drafter',
  validateCode: 'Physical Validator',
  fixCode: 'Repair',
  visualCritic: 'Design Inspector',
  acceptGate: 'Model Review',
  respondToUser: 'Result',
};

type CustomPayload = StreamEvent & { node?: string };

/**
 * Translates langgraph's [mode, payload] tuples into the client's event union.
 *
 * Shapes verified by spike against langgraph 1.4.12: `custom` yields the bare
 * payload, `messages` yields [chunk, metadata] with metadata.langgraph_node,
 * and an interrupt arrives as ['updates', { __interrupt__: [{ id, value }] }].
 */
export async function bridgeGraphStream(
  chunks: AsyncIterable<unknown>,
  runId: string,
  emit: (event: StreamEvent) => void
): Promise<void> {
  let openNode: string | null = null;

  function closeOpen() {
    if (openNode === null) return;
    emit({ t: 'section', id: openNode, state: 'close', status: 'ok' });
    openNode = null;
  }

  function openFor(node: string) {
    if (openNode === node) return;
    closeOpen();
    emit({ t: 'section', id: node, label: NODE_LABELS[node] ?? node, state: 'open' });
    openNode = node;
  }

  for await (const chunk of chunks) {
    if (!Array.isArray(chunk) || chunk.length < 2) continue;
    const [mode, payload] = chunk as [string, unknown];

    if (mode === 'custom') {
      const p = payload as CustomPayload;
      if (p.t === 'delta') {
        openFor(p.node ?? 'agent');
        emit({ t: 'delta', text: p.text });
      } else if (p.t === 'result') {
        closeOpen();
        const { node: _node, ...rest } = p;
        emit(rest as StreamEvent);
      } else if (p.t === 'error') {
        closeOpen();
        emit({ t: 'error', message: p.message });
      }
      continue;
    }

    if (mode === 'messages') {
      const [msg, meta] = payload as [{ content?: unknown }, { langgraph_node?: string }];
      const text = typeof msg?.content === 'string' ? msg.content : '';
      if (!text) continue;
      openFor(meta?.langgraph_node ?? 'agent');
      emit({ t: 'delta', text });
      continue;
    }

    if (mode === 'updates') {
      const upd = payload as Record<string, unknown>;
      const interrupts = upd.__interrupt__ as Array<{ id: string; value: unknown }> | undefined;
      if (!interrupts?.length) continue;
      closeOpen();
      for (const i of interrupts) {
        emit({ t: 'gate', id: i.id, runId, payload: i.value as GatePayload });
      }
    }
  }

  closeOpen();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/agent/stream-bridge.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/stream-bridge.ts src/lib/agent/stream-bridge.test.ts
git commit -m "feat(agent): bridge graph stream chunks to client events"
```

---

### Task 8: Routes stream instead of invoking

Both routes swap `agent.invoke()` for `agent.stream()` and push the bridged
events down the existing SSE `TransformStream`. The interrupt handling that used
`isInterrupted(result)` / `result[INTERRUPT]` goes away — the bridge emits the
gate event from the `updates` channel instead.

**Files:**
- Modify: `src/app/api/chat/route.ts` (the agent block, currently lines 86-135)
- Modify: `src/app/api/chat/resume/route.ts` (the agent block, currently lines 58-125)

**Interfaces:**
- Consumes: `bridgeGraphStream` (Task 7), `StreamEvent` (Task 5).
- Produces: SSE frames of `StreamEvent`. No new exports.

- [ ] **Step 1: Rewrite `/api/chat`'s agent block**

In `src/app/api/chat/route.ts`, change the imports: drop `isInterrupted`,
`INTERRUPT`, `GatePayload` and `StreamEventPayload`; add:

```ts
import { createCadAgent } from '@/lib/agent/graph';
import { bridgeGraphStream } from '@/lib/agent/stream-bridge';
import type { StreamEvent } from '@/lib/agent/stream-events';
```

Change `sendEvent`'s parameter type to `StreamEvent`. Then replace the block from
`const agent = createCadAgent(` through the end of the `if (isInterrupted(result))`
/ `else` pair with:

```ts
        const agent = createCadAgent(undefined, model);

        let sawGate = false;
        const stream = await agent.stream(
          { messages: lcMessages, designContract: designContract ?? null },
          {
            configurable: { thread_id: checkpointKey },
            streamMode: ['updates', 'messages', 'custom'],
            callbacks: langfuseHandler ? [langfuseHandler] : undefined,
          }
        );

        await bridgeGraphStream(stream, runId, (event) => {
          if (event.t === 'gate') sawGate = true;
          sendEvent(event);
        });

        // A run that paused is the only one whose checkpoint is still needed.
        // Anything else - finished or failed - cannot be resumed, and dropping
        // it here is what keeps one-key-per-run from growing without bound.
        if (!sawGate) await deleteRunCheckpoint(checkpointKey);
```

In the `catch` block, replace the `sendEvent({ type: 'error', ... })` call with:

```ts
        await sendEvent({ t: 'error', message: `Agent execution failed: ${errorMessage}` });
```

Leave the `finally` block (Langfuse `forceFlush` then `writer.close()`) exactly as
it is — the comment there explains why the order matters.

- [ ] **Step 2: Rewrite `/api/chat/resume`'s agent block**

Apply the same import changes. Replace the cancel early-return's SSE body with:

```ts
        `data: ${JSON.stringify({ t: 'result', summary: 'Generation cancelled by user.' } satisfies StreamEvent)}\n\n`,
```

Replace the block from `const agent = createCadAgent(` through the
`isInterrupted` / `else` pair with:

```ts
        const agent = createCadAgent(undefined, model);

        let sawGate = false;
        const stream = await agent.stream(new Command({ resume: decision }), {
          configurable: { thread_id: checkpointKey },
          streamMode: ['updates', 'messages', 'custom'],
          callbacks: langfuseHandler ? [langfuseHandler] : undefined,
        });

        // A resumed run can hit ANOTHER gate - the accept gate right after the
        // spec gate. The bridge surfaces that identically to the first one.
        await bridgeGraphStream(stream, runId, (event) => {
          if (event.t === 'gate') sawGate = true;
          sendEvent(event);
        });

        if (!sawGate) await deleteRunCheckpoint(checkpointKey);
```

and the `catch` block's send with:

```ts
        await sendEvent({ t: 'error', message: `Agent resume failed: ${errorMessage}` });
```

- [ ] **Step 3: Verify the routes typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `src/app/api/chat/`. Errors in `src/components/chat/` are
expected at this point and are fixed by Tasks 9 and 10.

- [ ] **Step 4: Run the agent suites**

Run: `npx vitest run src/lib/agent/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/chat/route.ts src/app/api/chat/resume/route.ts
git commit -m "feat(api): stream the graph instead of invoking it"
```

---

### Task 9: Transcript rendering and the collapsed code disclosure

`MessageBubble` renders `transcript` as collapsible sections above the summary,
and puts `message.code` behind a disclosure.

**Files:**
- Create: `src/components/chat/transcript-view.tsx`
- Modify: `src/components/chat/message-bubble.tsx`
- Test: `src/components/chat/transcript-view.test.tsx`

**Interfaces:**
- Consumes: `parseTranscript`, `SectionStatus` (Task 1); `GateRecord` (Task 2).
- Produces: `<TranscriptView transcript={string} gates={Record<string, GateRecord> | undefined} />`.

- [ ] **Step 1: Write the test**

```tsx
// src/components/chat/transcript-view.test.tsx
import { describe, it, expect } from 'vitest';
import { parseTranscript } from '@/lib/agent/transcript';

// The component is thin; what matters is that it renders exactly the nodes the
// parser finds, in order, and never emits marker syntax as visible text.
describe('transcript parsing for the view', () => {
  it('yields sections and gates in document order', () => {
    const src =
      '<!--s:architectNode|Mechanical Architect|ok-->box<!--/s-->' +
      '<!--gate:g1-->' +
      '<!--s:drafterNode|Parametric Drafter|running-->drafting<!--/s-->';
    expect(parseTranscript(src).map((n) => (n.kind === 'gate' ? 'gate' : n.id)))
      .toEqual(['architectNode', 'gate', 'drafterNode']);
  });

  it('exposes a body with no marker syntax left in it', () => {
    const nodes = parseTranscript('<!--s:n|N|ok-->plain body<!--/s-->');
    expect((nodes[0] as { body: string }).body).toBe('plain body');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/components/chat/transcript-view.test.tsx`
Expected: PASS — Task 1 already provides `parseTranscript`. This test pins the
contract the component depends on. Proceed to Step 3.

- [ ] **Step 3: Write the component**

```tsx
// src/components/chat/transcript-view.tsx
'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseTranscript, type SectionStatus } from '@/lib/agent/transcript';
import type { GateRecord } from '@/types';
import { Check, AlertCircle, Loader2, MinusCircle, ChevronRight } from 'lucide-react';

const STATUS_ICON: Record<SectionStatus, React.ReactNode> = {
  running: <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />,
  ok: <Check className="w-3.5 h-3.5 text-emerald-400" />,
  warn: <AlertCircle className="w-3.5 h-3.5 text-amber-400" />,
  error: <AlertCircle className="w-3.5 h-3.5 text-rose-400" />,
  skipped: <MinusCircle className="w-3.5 h-3.5 text-slate-500" />,
};

interface TranscriptViewProps {
  transcript: string;
  gates?: Record<string, GateRecord>;
}

/**
 * Renders the streamed transcript as one collapsible section per graph hop.
 *
 * A running section is open so the user watches it fill; a finished one
 * collapses to its label, which is what keeps a ten-node run readable.
 */
export function TranscriptView({ transcript, gates }: TranscriptViewProps) {
  const nodes = parseTranscript(transcript);
  if (nodes.length === 0) return null;

  return (
    <div className="space-y-1">
      {nodes.map((node, i) => {
        if (node.kind === 'gate') {
          const record = gates?.[node.id];
          // An open gate is answered in the dock above the composer, so it has
          // nothing to show here yet.
          if (!record || record.status === 'open') return null;
          return (
            <div
              key={`gate-${node.id}-${i}`}
              className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-slate-900/60 border border-slate-800 text-[11px]"
            >
              <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-px" />
              <div className="min-w-0">
                <span className="text-slate-300 capitalize">{record.status}</span>
                {record.decidedAt ? (
                  <span className="text-slate-500">
                    {' · '}
                    {new Date(record.decidedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                ) : null}
                {record.decision?.comment ? (
                  <p className="text-slate-400 mt-0.5 break-words">{record.decision.comment}</p>
                ) : null}
              </div>
            </div>
          );
        }

        return (
          <details
            key={`${node.id}-${i}`}
            open={node.status === 'running'}
            className="group rounded-md border border-slate-800 bg-slate-900/40 open:bg-slate-900/70"
          >
            <summary className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer select-none text-[11px] text-slate-300 list-none">
              <ChevronRight className="w-3 h-3 text-slate-500 transition-transform group-open:rotate-90" />
              {STATUS_ICON[node.status]}
              <span className="font-medium">{node.label}</span>
            </summary>
            <div className="px-3 pb-2 pt-1 text-xs text-slate-300 max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.body}</ReactMarkdown>
            </div>
          </details>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into `MessageBubble`**

In `src/components/chat/message-bubble.tsx`:

- Replace `import { ThinkingIndicator } from './thinking-indicator';` with
  `import { TranscriptView } from './transcript-view';`.
- Replace the `{message.progressUpdates && message.progressUpdates.length > 0 && (...)}`
  block with:

```tsx
        {message.transcript && (
          <TranscriptView transcript={message.transcript} gates={message.gates} />
        )}
```

- Immediately after the message-body `</div>` (the one closing the
  `rounded-xl px-4 py-3` bubble), add the code disclosure:

```tsx
        {message.code && (
          <details className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
            <summary className="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer select-none text-[11px] text-indigo-300 list-none">
              <Code className="w-3.5 h-3.5" />
              <span>View code</span>
            </summary>
            <pre className="p-3 text-xs font-mono text-cyan-300 overflow-x-auto max-h-60">
              <code>{message.code}</code>
            </pre>
          </details>
        )}
```

`Code` is already imported in this file.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run src/components/chat/`
Expected: PASS.

```bash
git add src/components/chat/transcript-view.tsx src/components/chat/transcript-view.test.tsx src/components/chat/message-bubble.tsx
git commit -m "feat(chat): render the streamed transcript as collapsible sections"
```

---

### Task 10: Gate dock and chat-panel rewiring

The assistant message is created when the stream opens and mutated as it grows.
Gate controls move out of the transcript into a dock above the composer. The
three `pending*` state vars, the standalone gate render, both
`'Model generation…'` fallbacks and `AgentProgress` all go.

**Files:**
- Create: `src/components/chat/gate-dock.tsx`
- Modify: `src/components/chat/chat-panel.tsx`
- Delete: `src/components/chat/gate-inline-ui.tsx`, `src/components/chat/thinking-indicator.tsx`
- Modify: `src/types/index.ts`, `src/lib/storage/db-schema.ts`, `src/lib/storage/thread-storage.ts`, `src/store/app-store.ts`, `src/lib/agent/graph.ts`

**Interfaces:**
- Consumes: `readStream`, `StreamState` (Task 5); `serializeTranscript` (Task 1); `GateRecord` (Task 2); `updateMessage` (already exists, `src/store/app-store.ts:278`).
- Produces: `<GateDock gate={GatePayload} onResume={(d: GateDecision) => void} />`.

- [ ] **Step 1: Build `GateDock` from the existing gate UI**

Create `src/components/chat/gate-dock.tsx` by copying
`src/components/chat/gate-inline-ui.tsx` and deleting everything that renders
read-only detail — the Bounding Box, Design Intent, Stress Points, Pinned
Parameters, Measured Geometry and Violations blocks, and the research gate's
approach descriptions. That content is now server-rendered markdown in the
transcript. Keep, renaming the component to `GateDock`:

- the `comment` and `answers` state, `answerFor`, `collectedAnswers`, `chosenId`;
- the open-questions block (option chips + free-text inputs);
- the research gate's approach radio list (names only, no descriptions);
- the comment textarea and the three buttons;
- the `title` expression.

Change the outer wrapper from the message-shaped card to a dock:

```tsx
    <div className="border-t border-slate-800 bg-slate-900/90 px-3 py-2 space-y-2">
      <div className="text-[11px] font-semibold text-indigo-300">{title}</div>
      {/* answers / approach radios / comment box / buttons, unchanged */}
    </div>
```

Relabel the Cancel button to **Deny**. Its wire action stays `'cancel'` — the
server distinguishes cancel from revise and approve, and renaming the action
would break `researchGate`, `specGate` and `acceptGate` at once.

- [ ] **Step 2: Add the shared stream consumer to `ChatPanel`**

Add this module-scope helper above `export function ChatPanel()`:

```tsx
/** The one gate still awaiting a decision, if any. */
function firstOpenGate(gates: Record<string, GateRecord>): GatePayload | null {
  for (const record of Object.values(gates)) {
    if (record.status === 'open') return record.payload;
  }
  return null;
}
```

and this helper inside `ChatPanel`, above `handleSendMessage`:

```tsx
  /**
   * Drives one stream into ONE assistant message.
   *
   * The message is created when the stream opens and mutated as it grows,
   * because a turn that pauses at a gate spans two HTTP requests and both
   * halves belong to the same message.
   */
  const consumeStream = async (
    response: Response,
    targetThreadId: string,
    messageId: string
  ) => {
    // Persisting on every token would thrash IndexedDB, so the flush is
    // debounced and forced once at the end.
    let lastFlush = 0;
    const FLUSH_MS = 250;

    await readStream(response, {
      onUpdate: (state) => {
        const now = Date.now();
        if (now - lastFlush < FLUSH_MS) return;
        lastFlush = now;
        updateMessage(messageId, { transcript: serializeTranscript(state.nodes) }, targetThreadId);
      },
      onDone: async (state) => {
        const status = state.error
          ? 'error'
          : state.awaitingInput
            ? 'awaiting_input'
            : 'complete';

        updateMessage(
          messageId,
          {
            transcript: serializeTranscript(state.nodes),
            gates: Object.keys(state.gates).length ? state.gates : undefined,
            content: state.error ? `**Error:** ${state.error}` : state.summary,
            code: state.code,
            runId: state.runId,
            status,
          },
          targetThreadId
        );

        if (state.designContract) setThreadContract(state.designContract, targetThreadId);

        if (state.awaitingInput) {
          const open = firstOpenGate(state.gates);
          setPendingGate(open);
          setPendingRunId(state.runId ?? null);
          setPendingMessageId(messageId);
          showGateGeometry(open, targetThreadId);
          setIsGenerating(false);
          setGeneratingThreadId(null);
          return;
        }

        if (state.code) {
          setCode(state.code, targetThreadId);
          if (state.stl && state.stl.includes('facet normal')) {
            const { geometry, modelInfo } = parseStlToGeometry(state.stl);
            setCompileResult(
              { success: true, stlContent: state.stl, geometry, modelInfo, compileTimeMs: 0 },
              targetThreadId
            );
          } else {
            if (useAppStore.getState().activeThreadId === targetThreadId) setCompileStatus('compiling');
            setCompileResult(await compileOpenScad(state.code), targetThreadId);
          }
        }

        setIsGenerating(false);
        setGeneratingThreadId(null);
      },
    });
  };
```

- [ ] **Step 3: Rewrite `handleSendMessage`'s stream handling**

Replace the whole `handleStreamResponse` definition and its
`await handleStreamResponse(response, currentProgressList);` call with:

```tsx
      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        transcript: '',
        status: 'streaming',
        timestamp: Date.now(),
      };
      addMessage(assistantMsg, targetThreadId);

      await consumeStream(response, targetThreadId, assistantMsgId);
```

Delete the `initialProgress` block and the `currentProgressList` declaration.
Remove `apiKey` from the request body — `createCadAgent` no longer takes one.
In the `catch`, replace the `addMessage({ ... })` error path with:

```tsx
      updateMessage(assistantMsgId, { content: `**Error:** ${errorMessage}`, status: 'error' }, targetThreadId);
```

- [ ] **Step 4: Replace the pending state and rewrite `handleResume`**

Replace the three `pending*` `useState` declarations with:

```tsx
  const [pendingGate, setPendingGate] = useState<GatePayload | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  // The message a resumed run must continue appending to.
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
```

Rewrite `handleResume` entirely:

```tsx
  const handleResume = async (decision: GateDecision) => {
    const targetThreadId = activeThreadId;
    const targetRunId = pendingRunId;
    const messageId = pendingMessageId;
    if (!targetThreadId || !targetRunId || !messageId) return;

    const thread = threads.find((t) => t.id === targetThreadId);
    const message = thread?.messages.find((m) => m.id === messageId);
    const gates = { ...(message?.gates ?? {}) };
    const openId = Object.keys(gates).find((k) => gates[k].status === 'open');
    if (openId) {
      gates[openId] = {
        ...gates[openId],
        decision,
        decidedAt: Date.now(),
        status:
          decision.action === 'approve' ? 'approved'
          : decision.action === 'revise' ? 'revised'
          : 'denied',
      };
    }
    updateMessage(messageId, { gates, status: 'streaming', runId: undefined }, targetThreadId);

    setPendingGate(null);
    setPendingRunId(null);
    setPendingMessageId(null);
    setIsGenerating(true);
    setGeneratingThreadId(targetThreadId);

    try {
      const response = await fetch('/api/chat/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          threadId: targetThreadId,
          runId: targetRunId,
          decision,
        }),
      });
      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server responded with HTTP ${response.status}`);
      }
      await consumeStream(response, targetThreadId, messageId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      updateMessage(messageId, { content: `**Resume failed:** ${errorMessage}`, status: 'error' }, targetThreadId);
      setIsGenerating(false);
      setGeneratingThreadId(null);
    }
  };
```

- [ ] **Step 5: Replace the render sites and imports**

Delete `{pendingGate && <GateInlineUI gate={pendingGateData} onResume={handleResume} />}`
from the message list and the
`{isCurrentThreadGenerating && activeProgress && (<ThinkingIndicator … />)}` block.
Immediately above `<ChatInput …/>`, add:

```tsx
      {pendingGate && <GateDock gate={pendingGate} onResume={handleResume} />}
```

Update imports: drop `GateInlineUI`, `ThinkingIndicator`, `AgentProgress`,
`extractOpenScadCode`, and the store selectors `activeProgress`,
`setActiveProgress`, `addProgressUpdate`, `clearProgress`, `progressHistory`.
Add `GateDock`, `GateRecord`, `serializeTranscript` (from `@/lib/agent/transcript`),
`updateMessage` (store selector), and `readStream` (already imported — its
signature changed, not its path).

Also remove `progressHistory` and `pendingGateData` from the `useEffect`
dependency array that drives `scrollToBottom`; use `[messages, pendingGate]`.

- [ ] **Step 6: Delete the dead progress machinery**

```bash
rm src/components/chat/gate-inline-ui.tsx src/components/chat/thinking-indicator.tsx
```

- In `src/types/index.ts`: delete `AgentStepType`, `AgentProgress`, and the
  `progressUpdates` field from `ChatMessage`.
- In `src/lib/storage/db-schema.ts`: delete `progressUpdates` from `MessageRow`
  and the now-unused `AgentProgress` import.
- In `src/lib/storage/thread-storage.ts`: delete the `progressUpdates` line from
  `toMessageRow` and from `assembleThread`'s mapper.
- In `src/store/app-store.ts`: delete `activeProgress`, `progressHistory`,
  `setActiveProgress`, `addProgressUpdate` and `clearProgress` — their interface
  declarations, their initial values, and every reset block that lists them.
- In `src/lib/agent/graph.ts`: delete the `onProgress` parameter from
  `createCadAgent`, every remaining `onProgress?.()` call site, and the
  `StreamEventPayload` interface.

- [ ] **Step 7: Verify and commit**

Run: `npx tsc --noEmit`
Expected: zero errors. Any remaining reference to `AgentProgress`,
`progressUpdates`, `ThinkingIndicator` or `GateInlineUI` is a deletion this step
missed — remove the reference rather than re-adding the symbol.

Run: `npm test`
Expected: PASS. Suites that asserted on the old `onProgress` events must be
updated to assert on the `custom` channel instead, in the style of Task 6's test.

```bash
git add -A
git commit -m "feat(chat): gate dock, streamed message lifecycle, progress machinery removed"
```

---

### Task 11: Reload rehydration

The spec's reload rule: an **open gate survives a reload** — its `GateRecord` and
`runId` are persisted and the server checkpoint is keyed `threadId::runId`, so the
user can leave and come back to approve. A reload **during generation** cannot be
rejoined, so it freezes as `interrupted` rather than pretending to still be live.

Task 10 persists the fields but nothing reads them back on mount. This closes
that.

**Files:**
- Create: `src/lib/chat/rehydrate.ts`
- Modify: `src/components/chat/chat-panel.tsx`
- Test: `src/lib/chat/rehydrate.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `GatePayload`, `GateRecord`, `MessageStatus` (Task 2).
- Produces: `resumableGate(messages: ChatMessage[]): { messageId: string; runId: string; gate: GatePayload } | null` and `freezeStreamingMessages(messages: ChatMessage[]): ChatMessage[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/chat/rehydrate.test.ts
import { describe, it, expect } from 'vitest';
import { resumableGate, freezeStreamingMessages } from './rehydrate';
import type { ChatMessage } from '@/types';

const gatePayload = { kind: 'spec', spec: null, contract: null, revisionCount: 0 } as const;

function msg(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'm1', role: 'assistant', content: '', timestamp: 1, ...over };
}

describe('resumableGate', () => {
  it('finds the message holding an open gate and its run id', () => {
    const found = resumableGate([
      msg({ id: 'a', status: 'complete' }),
      msg({
        id: 'b',
        status: 'awaiting_input',
        runId: 'run-7',
        gates: { g1: { payload: gatePayload, status: 'open' } },
      }),
    ]);
    expect(found).toEqual({ messageId: 'b', runId: 'run-7', gate: gatePayload });
  });

  it('ignores a gate that was already decided', () => {
    expect(
      resumableGate([
        msg({ id: 'b', status: 'complete', runId: 'run-7', gates: { g1: { payload: gatePayload, status: 'approved' } } }),
      ])
    ).toBeNull();
  });

  it('ignores an open gate with no run id, which cannot be resumed', () => {
    expect(
      resumableGate([msg({ id: 'b', status: 'awaiting_input', gates: { g1: { payload: gatePayload, status: 'open' } } })])
    ).toBeNull();
  });

  it('returns the LAST open gate when a thread somehow holds two', () => {
    const found = resumableGate([
      msg({ id: 'a', status: 'awaiting_input', runId: 'run-1', gates: { g1: { payload: gatePayload, status: 'open' } } }),
      msg({ id: 'b', status: 'awaiting_input', runId: 'run-2', gates: { g2: { payload: gatePayload, status: 'open' } } }),
    ]);
    expect(found!.runId).toBe('run-2');
  });

  it('returns null for an empty thread', () => {
    expect(resumableGate([])).toBeNull();
  });
});

describe('freezeStreamingMessages', () => {
  it('marks a message left mid-stream as interrupted', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'streaming', transcript: 'partial' })]);
    expect(out.status).toBe('interrupted');
  });

  it('gives an interrupted message body text so the bubble is never blank', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'streaming', content: '' })]);
    expect(out.content.trim()).not.toBe('');
  });

  it('leaves a message awaiting input alone - its gate is still resumable', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'awaiting_input' })]);
    expect(out.status).toBe('awaiting_input');
  });

  it('leaves completed messages untouched', () => {
    const input = [msg({ status: 'complete', content: 'done' })];
    expect(freezeStreamingMessages(input)).toEqual(input);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/chat/rehydrate.test.ts`
Expected: FAIL — `Failed to resolve import "./rehydrate"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/chat/rehydrate.ts
import type { ChatMessage, GatePayload } from '@/types';

export interface ResumableGate {
  messageId: string;
  runId: string;
  gate: GatePayload;
}

/**
 * The gate a reloaded thread can still answer.
 *
 * A gate is where a human walks away from the screen, so it has to survive a
 * reload: the record and runId are persisted with the message, and the server
 * checkpoint is keyed threadId::runId. Without a runId there is no checkpoint
 * to address, so such a gate is not offered rather than posting a request the
 * server will reject.
 */
export function resumableGate(messages: ChatMessage[]): ResumableGate | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.gates || !m.runId) continue;
    for (const record of Object.values(m.gates)) {
      if (record.status === 'open') {
        return { messageId: m.id, runId: m.runId, gate: record.payload };
      }
    }
  }
  return null;
}

/**
 * Freezes any message the page was still streaming when it went away.
 *
 * Rejoining a live generation would need a server-side run registry and replay
 * buffer, which per-instance /tmp checkpoints would undermine anyway. Saying so
 * plainly beats leaving a bubble that looks like it is still thinking.
 */
export function freezeStreamingMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.status === 'streaming'
      ? {
          ...m,
          status: 'interrupted' as const,
          content: m.content?.trim()
            ? m.content
            : '_This run was interrupted before it finished. Send the request again to retry._',
        }
      : m
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/chat/rehydrate.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire rehydration into `ChatPanel`**

Add the import:

```tsx
import { resumableGate, freezeStreamingMessages } from '@/lib/chat/rehydrate';
```

Replace the existing mount effect

```tsx
  useEffect(() => {
    initializeFromStorage();
  }, [initializeFromStorage]);
```

with:

```tsx
  useEffect(() => {
    void initializeFromStorage();
  }, [initializeFromStorage]);

  // Runs after storage has populated the store, and again on every thread
  // switch: a gate left open in another thread must not stay docked here.
  useEffect(() => {
    if (!activeThreadId) return;
    const thread = threads.find((t) => t.id === activeThreadId);
    if (!thread) return;

    for (const frozen of freezeStreamingMessages(thread.messages)) {
      const original = thread.messages.find((m) => m.id === frozen.id);
      if (original && original.status !== frozen.status) {
        updateMessage(frozen.id, { status: frozen.status, content: frozen.content }, activeThreadId);
      }
    }

    const open = resumableGate(thread.messages);
    setPendingGate(open?.gate ?? null);
    setPendingRunId(open?.runId ?? null);
    setPendingMessageId(open?.messageId ?? null);
    // `threads` is intentionally absent: this must react to the thread
    // CHANGING, not to every message mutation during a live stream, which
    // would re-dock a gate the user just answered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);
```

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit` then `npm test`
Expected: zero type errors; all suites PASS.

```bash
git add src/lib/chat/rehydrate.ts src/lib/chat/rehydrate.test.ts src/components/chat/chat-panel.tsx
git commit -m "feat(chat): restore an open gate after reload, freeze interrupted runs"
```
---

## Execution Notes for Implementers

- **Do exactly the steps in your task.** Do not refactor neighbouring code, do
  not rename anything the task did not name, do not rewrite adjacent comments.
- **Do not add features.** If a step's code does not handle a case you can
  imagine, that is intentional unless the task's own tests demand otherwise.
- **Never introduce `any`.** Every type used is defined in this plan or already
  exists in the repo.
- **Run the exact commands given** and report real output. If a command fails,
  report the failure verbatim and stop — do not proceed to the commit step.
- **If a file does not match what the task describes**, stop and report the
  mismatch rather than guessing. Line numbers were taken against `main` on
  2026-09-17.
- **Never reintroduce**: `@langchain/google-genai`, a Gemini or Google lane, edge
  treatments, printing-process vocabulary (nozzle, layer height, material,
  overhang, supports, slicing), or raw model/JSON output in any user-facing
  string.
