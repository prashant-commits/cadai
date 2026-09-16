# Streaming Agent Transcript

Design doc — 2026-09-14

## Problem

Three failures share one root cause: the client is handed raw model output and
discrete progress pings, and is left to assemble a result from them.

**A gate can open with nothing to approve.** `architectNode` calls
`withStructuredOutput(assemblySpecRequestSchema())`. When that decoder
degenerates — it emits a valid number then repeats digits until the token cap,
producing unparseable JSON (measured 1/5 valid, `src/lib/agent/model-provider.ts`).
After three failed attempts `spec` is `null`, and `shouldGateSpec` returns `true`
for a null spec, so the gate opens on an empty approval card. Worse,
`src/lib/agent/graph.ts:559` slices 200 characters of the parse error — the
degenerate JSON itself — into the progress feed.

**The final message is a raw dump.** `explanation` is built as
`summarizeSpec(spec) + "\n\n" + <entire raw drafter reply>`
(`src/lib/agent/graph.ts:670`, again at 946), so the assistant message is a wall
of model prose duplicating code that already sits in the editor and viewport.
When that string arrives empty, the client substitutes the literal
`'Model generation resumed and completed.'` (`src/components/chat/chat-panel.tsx:381`).

**Gates leave no trace.** `pendingGate`, `pendingGateData` and `pendingRunId` are
transient React state (`src/components/chat/chat-panel.tsx:52-56`) rendered after
the message list. `handleResume` clears them without writing anything into
`messages`, so the card vanishes on click and takes the user's comment and
open-question answers with it. Nothing survives a reload or a thread switch.

A fourth, smaller bug falls out of the same design: `progressUpdates` on saved
messages is always empty on resume and one item on send, because both call sites
pass their own local array and ignore the full list `readStream` returns.

## Goal

One assistant message per turn that streams token by token and reads as a
continuous stretch of the agent thinking, with collapsible sections marking each
hop through the LangGraph pipeline. The server renders everything — including
structured output — to markdown before it reaches the browser. Gates interrupt
that stream and resume into the same message.

## Non-goals

- Model routing. cadai is single-provider on the Experiential Labs gateway; the
  Google lane has already been removed from `model-provider.ts`. This design
  neither reintroduces it nor changes slug selection.
- Spec editing at the gate. `GateDecision.spec` exists but the current UI only
  passes `gate.spec` through unchanged (`src/components/chat/gate-inline-ui.tsx:295`).
  That pass-through behaviour is preserved; no editor is added.
- Reattaching to an in-flight generation after a reload.

## Architecture

### Stream protocol

`StreamEventPayload` — today an eight-member type union carrying `message`,
`code`, `stl`, `explanation`, `gate`, `runId`, `designContract` and `timestamp` —
collapses to five event kinds, one of which (`section`) carries two shapes:

```ts
type StreamEvent =
  | { t: 'section'; id: string; label: string; state: 'open' }
  | { t: 'section'; id: string; state: 'close';
      status: 'ok' | 'warn' | 'error' | 'skipped'; summary?: string }
  | { t: 'delta'; text: string }
  | { t: 'gate'; id: string; runId: string; payload: GatePayload }
  | { t: 'result'; summary: string; code?: string; stl?: string;
      designContract?: DesignContract }
  | { t: 'error'; message: string };
```

`delta` appends markdown to whichever section is currently open. `result.summary`
is the compact recap that becomes `ChatMessage.content`.

`AgentProgress`, `AgentStepType` and `progressUpdates` are deleted outright,
along with `ThinkingIndicator`'s history mode and the per-step id generation in
`readStream`.

### Transcript format

Sections are delimited by HTML comments rather than tags or fences. Comments are
inert in markdown, survive round-tripping through storage, and render as nothing
if a parser ever misses them — where an unclosed fence would swallow the rest of
the document, and section content routinely contains fenced code blocks of its
own, so nesting fences is not available.

```
<!--s:architect|Mechanical Architect|ok-->
Bounding box: 62 × 40 × 18 mm

Components (2): bracket_body, clamp_arm
<!--/s-->
<!--gate:g1-->
```

The client splits the transcript on these markers into a section tree before
rendering, and hands each section's inner markdown to `react-markdown`
unmodified. Gate markers carry only an id; the payload arrives as its own typed
`gate` event and is stored separately. Embedding multi-kilobyte spec JSON in the
markdown would mean escaping it through the renderer and re-parsing it on every
read.

### Message shape

```ts
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;             // compact summary — the ONLY thing replayed as history
  transcript?: string;         // streamed markdown with section and gate markers
  gates?: Record<string, GateRecord>;
  status?: 'streaming' | 'awaiting_input' | 'complete' | 'interrupted' | 'error';
  runId?: string;              // set while a gate on this message is open
  image?: string;
  code?: string;
  timestamp: number;
}

interface GateRecord {
  payload: GatePayload;
  decision?: GateDecision;
  status: 'open' | 'approved' | 'revised' | 'denied';
  decidedAt?: number;
}
```

The split between `content` and `transcript` is load-bearing.
`src/components/chat/chat-panel.tsx:156` re-sends every prior message's `content`
to `/api/chat` on each turn. The existing comment at `src/lib/agent/graph.ts:234`
records why `summarizeSpec` was made compact in the first place: a full spec dump
there meant every later turn carried a blob it had no use for. If the full
thinking transcript lived in `content`, that cost would compound per turn.
`transcript` is display-only and never leaves the browser.

`MessageRow` gains `transcript`, `gates`, `status` and `runId`. No IndexedDB
version bump is required — rows are schemaless objects, no new store or index is
involved, and old rows simply lack the fields. (Unrelated but worth recording:
`upgrade(db)` at `src/lib/storage/thread-storage.ts:100` calls
`createObjectStore` unguarded, so any *future* version bump will throw
`ConstraintError` on existing databases.)

### Server-side streaming

`agent.invoke()` is replaced by `agent.stream(input, { streamMode: ['updates', 'messages', 'custom'] })`
in both `/api/chat` and `/api/chat/resume`.

- `updates` drives section open and close at node boundaries.
- `messages` carries real token deltas from `drafterNode` and `fixCode`, the two
  nodes that emit prose.
- `custom` carries server-composed markdown, written from inside a node via
  `config.writer` (`LangGraphRunnableConfig.writer`, confirmed present at
  `node_modules/@langchain/langgraph/dist/graph/types.d.ts:56`).

Of the ten nodes, only `drafterNode` and `fixCode` reliably produce streamable
prose.
`architectNode` and `visualCritic` go through `withStructuredOutput` and emit JSON
fragments. `validateCode`, `specGate`, `acceptGate` and `respondToUser` make no
LLM call at all. The `custom` channel is what gives the latter six a voice.

All of this was verified by spike against langgraph 1.4.12, on both a minimal
graph and the real `createCadAgent` (2026-09-14):

- With `streamMode` given as an array, chunks arrive as `[mode, payload]` tuples.
- `interrupt()` surfaces as an `updates` chunk shaped
  `{ __interrupt__: [{ id, value }] }`, where `value` is the full `GatePayload`.
  No `getState()` call is needed to read it.
- `Command({ resume })` drives `.stream()` exactly as it drives `invoke()`, and a
  second gate later in the same run surfaces through the identical
  `__interrupt__` shape.
- `config.writer` output arrives as a `custom` chunk *during* node execution —
  before that node's own `updates` chunk — so server-composed markdown streams
  live rather than landing at the node boundary.
- `messages` chunks arrive as `[chunk, metadata]`, and the metadata carries
  `langgraph_node`. **Section attribution therefore comes free**: token deltas
  are self-labelling and do not need to be correlated against `updates` events.
  This holds whether the node calls `model.invoke()` or `model.stream()`.

### Structured output → markdown, incrementally

Probed against the live gateway on 2026-09-16 with the production path —
`getChatModel(...).withStructuredOutput(assemblySpecRequestSchema(), { name: 'assembly_spec' }).stream()`:

`deepseek-v4-flash` streams **382 chunks**, and each chunk is a
**progressively-complete parsed object**, not a raw JSON fragment. LangChain's
cumulative output parser already does the partial-JSON work, so
`parsePartialJson` is **not needed** — the node can diff consecutive chunks and
emit markdown for whatever became newly complete. Top-level fields settled at:

| field | first seen |
|---|---|
| `assemblyName` | 1.65 s |
| `boundingBox` | 1.65 s |
| `components` | 1.84 s |
| `stressPoints` | 7.2 s |
| `assumptions` | 9.5 s |
| `openQuestions` | 10.7 s |
| complete | 13.9 s |

That is a ~14-second window currently showing a static spinner, which is
precisely what this design fills.

The plain prose lane (`model.stream()`, the drafter and repair path) streams
normally: 43 chunks, first at 1.3 s.

One guard remains mandatory: **emit a value only once its chunk shows it
structurally settled**. Diffing partial objects means a half-decoded number can
appear as a legitimate-looking value in an intermediate chunk, and a line that
rewrites itself as the user reads it is worse than one that arrives late.

A value that settles but is implausible — a dimension outside any sane millimetre
range, the signature of a degenerate decode — is **rendered with a warning label,
not dropped**. Silently discarding it would hide from the user that the model
produced something wrong, which is exactly the failure mode where they most need
to see it. The label is the mechanism; suppression is not.

Raw parse errors go to `console.error` only. The progress line at
`src/lib/agent/graph.ts:559` becomes
`Mechanical Architect: no valid Assembly Spec after 3 attempts.` This matters
more than it first appeared — see below.

### Recorded: the multipleOf incompatibility

The probe also explained the original "Gemini gate produces outputs" report, and
the cause was not degenerate decoding. `withStructuredOutput` against
`gemini-3.6-flash` failed outright in 442 ms with HTTP 400:

```
Unknown name "multipleOf" at 'generation_config.response_schema...'
```

`boundNumbers` (`src/lib/agent/assembly-spec.ts`) stamps `multipleOf: 0.01` onto
every `{"type": "number"}` node. Google's `response_schema` is an OpenAPI 3.0
subset with no `multipleOf`, so it rejected the request before generating a
token — on every architect attempt. Bounding the schema, which took the gateway
model from 6/10 to 8/10 valid, had broken the Google lane to 100% failure.

**This is now moot as a bug.** cadai went single-provider on the Experiential
Labs gateway and `main` has already removed the Google lane, so the failure is
resolved by deletion rather than by a fix. It is recorded here for one reason:
the same class of incompatibility will bite again if a second provider is ever
added, because `boundNumbers` emits JSON Schema keywords that not every
provider's constrained-decoding subset accepts.

What does still need fixing is the leak it exposed: `lastError.slice(0, 200)`
prints the head of a provider error payload straight into the progress feed,
whatever the provider.

### Gates

A gate pauses the graph mid-stream. The sequence:

1. The node's section closes; a `gate` event carries `{ id, runId, payload }`.
2. The client writes a `GateRecord` into `message.gates[id]`, appends
   `<!--gate:g1-->` to the transcript, sets `message.status = 'awaiting_input'`
   and persists the message.
3. **Controls dock above the composer**, not inline. The dock renders the
   open-question option chips and free-text inputs, a comment box, and
   Deny / Revise / Approve. `Cancel` is relabelled **Deny**; the wire action stays
   `'cancel'`.
4. On decision, the client patches the `GateRecord` and POSTs to
   `/api/chat/resume`, which continues appending to the *same* message.
5. The gate marker then renders in place as a receipt — `✓ Approved · 14:32 ·
   2 answers recorded` plus the comment.

Because the rich read-only detail — bounding box, components, assumptions, stress
points, measured geometry, violations — is now server-rendered
markdown in the transcript, roughly 200 lines of read-only JSX in
`GateInlineUI` disappear. What remains is a small `GateDock`: answers, comment,
three buttons.

A null spec still opens a gate, with empty details and the same three buttons.
The only change is that the raw parse error no longer leaks into the feed.

### Message lifecycle

The assistant message is now **created when the stream opens and mutated as it
grows**, rather than assembled in `onFinalize`. A turn's transcript spans two HTTP
requests whenever a gate intervenes, so the partial message must persist across
that boundary.

Persistence is debounced — writing to IndexedDB on every token delta would
thrash it. The message is flushed on section close, on every gate event, and at
stream end.

### Reload behaviour

An open gate survives a reload: the `GateRecord` and `runId` are persisted, and
the server checkpoint is already keyed `threadId::runId`
(`src/lib/agent/checkpointer.ts:132`), so the user can leave and come back to
approve. A reload *during generation* freezes the partial transcript with
`status: 'interrupted'` and a marker in the UI; the user resends.

This is a deliberate asymmetry. A gate is where a human walks away from the
screen, so it must be durable. A mid-generation reload is rare and cheap to redo,
and reattaching would require a server-side run registry and replay buffer —
which `/tmp` checkpoints, being per-instance on Vercel, would undermine anyway.

### Final message

`respondToUser` emits `result.summary`: a composed recap naming the assembly,
its measured dimensions against spec, repairs made, violations waived, and spec
edits applied. The raw model prose stops being concatenated into `explanation` at
`src/lib/agent/graph.ts:670` and 946.

`MessageBubble` renders `transcript` as collapsible sections, then `content` as
the summary, then `message.code` behind a collapsed "View code" disclosure. Both
`'Model generation completed.'` and `'Model generation resumed and completed.'`
fallbacks are deleted — with a composed summary they cannot fire, and an empty
message is then a bug to surface rather than paper over.

## Implementation order

1. **Reproduce the empty explanation.** One gated DeepSeek run with the `ready`
   payload logged on both ends. The `'Model generation resumed and completed.'`
   fallback is visible in the code, but the path that empties `explanation` is
   not yet identified — candidates are a checkpoint miss (`FileCheckpointSaver`
   is a per-process singleton over `/tmp`) and the `ready` event not flushing
   before `writer.close()`. Fix the cause; do not let the redesign mask it.
2. **Message shape and persistence.** `ChatMessage`, `GateRecord`, `MessageRow`,
   the to/from mappers, and create-on-open with debounced flush.
3. **Gates as records plus dock.** Delete the three `pending*` state vars and the
   standalone render at `src/components/chat/chat-panel.tsx:526`; add `GateDock`;
   reduce `GateInlineUI` to the receipt renderer.
4. **Stream protocol.** New event union, `readStream` rewritten as a section
   state machine, `.stream()` in both routes.
5. **Server-side markdown.** `config.writer` in every node; incremental
   structured-output rendering with both guards; suppress the raw error leak.
6. **Final message.** Composed summary, collapsed code disclosure, fallbacks
   removed.

Steps 2 and 3 land first because the stream has to resume into the message a
gate interrupted.

## Testing

- `parsePartialJson` → markdown composer: terminated-value-only emission, and
  the numeric sanity guard rejecting a degenerate decode. Table-driven over
  recorded token sequences, including a captured degenerate-decode trace.
- Transcript section parser: round-trip, unclosed section, section containing a
  fenced code block, gate marker with no matching record.
- Gate record reducer: open → approved / revised / denied, and the receipt
  rendering for each.
- `thread-storage` round-trip for a message carrying `transcript`, `gates` and
  `status`, plus a legacy row with none of them.
- `graph-hil.test.ts` extended: a resumed run emits a non-empty `result.summary`,
  and a second gate on the same run appends to the same message.
- `history` mapper: only `content` is POSTed; `transcript` never leaves the
  browser.

Vitest is already configured (`vitest.config.mts`, `npm test`).

## Risks

**Rebased onto `main` on 2026-09-17**, so the file references here are current.
Three shape changes from the base this was first written against are already
folded in: edge treatments are gone from the spec and gate UI, `visualCritic` is
off unless `CADAI_VISUAL_CRITIC=on`, and the graph now carries ten nodes with a
**third gate kind** — `researchGate`, whose payload is `{ kind: 'research';
brief: DesignBrief }` and which is on by default. Every mechanism here applies to
it unchanged; it simply means the dock renders three gate kinds rather than two.

`main` also added a generation eval harness, which is likely a better home for
some of the streaming assertions than the unit suites listed above.

**Streaming is no longer a risk.** Both the langgraph questions (spike,
2026-09-14) and the provider questions (probe, 2026-09-16) are settled against
the real production code path.

**Section markers are a parsing contract.** If the server ever writes a literal
`<!--/s-->` inside content, the client's split breaks. The composer must escape
the sequence on the way out.

**Streaming raises per-run token cost only marginally** — the same completions
are already being generated; they are simply being forwarded incrementally. But
`custom` writes from the deterministic nodes are new output that did not exist
before, and they are server-composed, so they cost nothing at the model.
