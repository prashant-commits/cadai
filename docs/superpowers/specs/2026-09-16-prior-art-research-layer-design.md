# Prior-Art Research Layer — Design

**Date:** 2026-09-16
**Status:** agreed in conversation; implementation plan to follow
**Assumes:** the Gemini removal in progress on a separate branch has landed. Everything below is written for the single-lane codebase that results: one `ChatOpenAI` client through the Experiential Labs gateway, no `apiKey` parameter on `createCadAgent`, no Google JSON-Schema subset to respect.

## Problem

The Architect commits to a construction — which bodies exist, how they join, how the thing prints — from model recall alone. Nothing in the pipeline looks at how this class of part is normally built, so the first draft's approach is whatever the model reaches for first, and there is no point before dimensions are fixed at which a human can choose between approaches. A wrong approach survives every downstream check: the spec gate reviews numbers, the placement audit measures numbers, and the visual critic critiques the rendering of an approach nobody chose.

The request: one more layer before the final geometry is decided that searches the web for better options, so the Architect produces more accurate output.

## Decisions

1. **A research node runs before the Architect.** `START → researchNode → researchGate → architectNode → specGate → …`. Research shapes the *approach*; the Architect still decides every number.
2. **It searches for prior-art construction approaches** — how this class of part is normally built (bracket topologies, closure schemes, hinge styles). It does not look up hardware dimensions or print/material rules; both are parked as candidate later nodes.
3. **The search backend is Tavily's free tier** (1,000 requests/month, no card) behind a `SearchProvider` seam, called with plain `fetch` — no new npm dependency. Nebius is acquiring Tavily, so the seam is the one file to swap if terms change.
4. **The brief is structured, not prose.** A `DesignBrief` carries 2–3 `approaches`, each with an `id`, `name`, `construction`, `strengths`, `weaknesses`, `sources` and a `grounding` label, plus `partClass`, `recommendedId` and the `searchQueries` that were run. The same failure that turned prose stress mitigations into structured gussets applies: a prose brief gets ignored.
5. **No approach is ever dropped; grounding is labelled.** After parsing, code sets `grounding: 'cited'` on an approach when at least one of its source URLs matches a URL the search actually returned, and `'recalled'` otherwise. The gate shows every approach, cited first, with recalled ones visibly marked. `recommendedId` is the model's own ranking and is independent of grounding, so a well-argued recalled approach can still be the recommendation. Source URLs that match no search hit are removed from that approach's `sources` (a link to nowhere is worse than no link); the approach itself stays.
6. **A human picks at a new gate.** `researchGate` calls `interrupt()` with `kind: 'research'`, the same mechanism as `specGate`. Approve carries `chosenApproachId`; revise carries a comment and triggers one more search pass (`MAX_RESEARCH_REVISIONS = 1`); cancel ends the run.
7. **The Architect is bound by prompt, not by schema.** The chosen approach is injected into `architectNode` as a `HumanMessage` block in the same position and style as the Design Contract block, and `ARCHITECT_PREAMBLE` gains one instruction to build that construction and record any deviation in `assumptions[]`. `AssemblySpecSchema` is not changed: provenance lives in graph state and the explanation, never in a field the constrained decoder must emit.
8. **Research uses the same model as every other node** via `getChatModel()`. Two structured-output calls per pass: query generation, then brief synthesis. Both request schemas pass through the exported `boundNumbers()` from `assembly-spec.ts`, because the decoder degeneration it guards against was reproduced on DeepSeek and is not a Gemini artefact.
9. **Research degrades to today's behaviour and never fails a run.** A missing `TAVILY_API_KEY`, a provider error or timeout, zero usable hits, or a brief that fails validation after bounded retries all skip straight to `architectNode`, with the reason in a `thinking` progress event and in `researchSkipReason` on state. `CADAI_RESEARCH=off` disables the node, mirroring `CADAI_MAX_ATTEMPTS` and `CADAI_VISUAL_CRITIC`.
10. **Research runs once per thread.** A follow-up turn in a thread that already holds a `designBrief` skips research (reason `already_researched`) unless it arrived through the revise loop. The earlier brief and choice stay in state, so every later Architect pass in that thread remains bound to the approach chosen once. A user who wants fresh prior art starts a new thread. No content heuristic decides whether a request "deserves" research in v1; the gate's one-click approve of the recommendation is the skip.
11. **One new branch in the gate card, nothing else in the UI.** `GatePayload` gains `{ kind: 'research'; brief: DesignBrief; revisionCount: number }` and `GateDecision` gains `chosenApproachId?: string`. `gate-inline-ui.tsx` renders approach cards with a radio selection, source links and the grounding mark. `chat-panel.tsx` needs no change: `showGateGeometry` already ignores every kind but `accept`.
12. **The final answer names the approach.** When a brief was used, `respondToUser` prepends one markdown line to the explanation — the chosen approach's name and its source links — so the sources reach the streamed chat message, rendered by the server like every other model output.
13. **Measured before it is called an improvement.** `eval/generation/run.ts` gains `--research on|off` and two new rates, `researchRan` and `citedApproachChosen`. The existing auto-approve loop already resumes every interrupt with `{ action: 'approve' }`; with no `chosenApproachId` the gate falls back to `recommendedId`, so no eval-specific gate code is needed. Rates are recorded before and after, as the placement work was.

## Module layout

New directory `src/lib/research/`, mirroring how `src/lib/design/` holds deterministic placement code apart from the graph.

| File | Responsibility |
|---|---|
| `search-provider.ts` | `SearchProvider` interface, `SearchHit`, `tavilyProvider(apiKey)`, `stubProvider(hits)`, and `resolveSearchProvider()` which returns the Tavily provider when `TAVILY_API_KEY` is set and `null` otherwise. URL normalisation helper used by grounding. |
| `design-brief.ts` | zod `DesignBriefSchema`, `ApproachSchema`, `SourceSchema`; the two bounded request schemas (`queryPlanRequestSchema()`, `briefRequestSchema()`); `groundApproaches(approaches, hits)` which sets `grounding` and prunes unmatched source URLs; `effectiveApproach(brief, chosenId)`. |
| `research-prompts.ts` | `RESEARCHER_PREAMBLE`, the query-plan prompt and the brief-synthesis prompt. Kept out of `system-prompt.ts` so the Architect and Drafter prompts do not grow. |
| `research-node.ts` | `runResearch({ prompt, contract, feedback, provider, model, onProgress })` returning `{ brief, queries, skipReason }`. Pure with respect to graph state so it is testable without LangGraph. |

`graph.ts` gains the `researchNode` and `researchGate` node functions, two routing functions, four state fields, and the Architect binding block. `gate-policy.ts` is unchanged.

## Data

### `SearchHit`

```ts
interface SearchHit { title: string; url: string; content: string; score?: number }
```

Tavily returns `content` as extracted page text. The provider truncates each hit's `content` to 1,200 characters and returns at most 5 hits per query; after de-duplication by normalised URL the node keeps at most 12 hits in total, so the synthesis prompt stays bounded regardless of what the search returns.

### `DesignBrief`

```ts
type Grounding = 'cited' | 'recalled';

interface Source { title: string; url: string }

interface Approach {
  id: string;             // stable slug the gate decision references, e.g. "a1"
  name: string;
  construction: string;   // 2–4 sentences: what bodies, how they join, how it prints
  strengths: string[];
  weaknesses: string[];
  sources: Source[];      // may be empty after pruning
  grounding: Grounding;   // set by code, absent from the request schema
}

interface DesignBrief {
  partClass: string;      // e.g. "wall-mounted L-bracket"
  approaches: Approach[]; // zod .min(2).max(3)
  recommendedId: string;  // must name an approach; code repairs it if not
  searchQueries: string[];// what was actually sent to the provider; set by code
}
```

`grounding` and `searchQueries` are never requested from the model. The request schema for brief synthesis is the zod schema minus those two fields, converted to JSON Schema and passed through `boundNumbers()`; the zod schema (with them) validates what code assembles. If `recommendedId` names no approach, code sets it to the first cited approach, or the first approach when none is cited, and logs the repair.

### Grounding

Two URLs match when they are equal after normalisation: lowercase scheme and host, `www.` stripped, fragment dropped, trailing slash dropped, query string kept. An approach is `cited` if any of its sources matches any hit; unmatched sources are removed. Approaches are then sorted cited-first, stable within each group, so the gate and the eval see the same order.

### Graph state additions

```ts
designBrief:          DesignBrief | null   // replace reducer, default null
chosenApproachId:     string | null        // replace reducer, default null
researchRevisionCount: number              // replace reducer, default 0
researchSkipReason:   string | null        // replace reducer, default null; null means research ran
```

`gateAction` and `gateFeedback` are reused. `researchNode` clears both on return, exactly as `architectNode` does, so a research-gate revise cannot resurface at the spec gate as if the human had just said it.

## Control flow

### `researchNode`

1. Compute the skip reason, in this order: `CADAI_RESEARCH=off` → `disabled`; no provider → `no_provider`; `state.designBrief` already set and `state.gateAction !== 'revise'` → `already_researched`. On any skip, return `{ designBrief: state.designBrief, researchSkipReason, gateAction: null, gateFeedback: null }` and emit a `thinking` event naming the reason.
2. Emit `thinking`: "Design Researcher: planning searches…". Call the model with the query-plan schema on the first human message plus the Design Contract's standing constraints and, on a revise pass, the gate feedback. Output: `{ partClass, queries }` with 2–4 queries. Bounded to 2 attempts; on failure skip with `query_plan_failed`.
3. Run every query through the provider in parallel with a 15 s `AbortController` timeout each. A query that errors or times out contributes no hits and is logged; only when *every* query fails is the pass skipped with `search_failed`. De-duplicate, cap at 12 hits. Zero hits → skip with `no_hits`.
4. Emit `thinking`: "Design Researcher: comparing N sources…". Call the model with the brief-synthesis schema on the request, `partClass` and the numbered hits. Bounded to 2 attempts; on failure skip with `brief_failed`.
5. `groundApproaches`, repair `recommendedId`, attach `searchQueries`, validate with the full zod schema. Return `{ designBrief, researchSkipReason: null, gateAction: null, gateFeedback: null }`.

Every skip leaves `designBrief` as it was (null on a fresh thread), so the routing below sends the run to the Architect with nothing else changed.

### `researchGate`

Interrupts with `{ kind: 'research', brief, revisionCount }`. On resume:

- `cancel` → `{ gateAction: 'cancel' }`.
- `revise` → `{ gateAction: 'revise', gateFeedback: comment || 'The user asked for different approaches but did not say what.', researchRevisionCount: +1 }`.
- `approve` → `{ gateAction: 'approve', chosenApproachId: decision.chosenApproachId if it names an approach, else brief.recommendedId }`. An unknown id falls back rather than rejecting the approval, matching how `specGate` treats a malformed edited spec.

### Routing

```
START ─→ researchNode ─┬─ designBrief && !researchSkipReason ─→ researchGate
                       └─ otherwise ─────────────────────────→ architectNode

researchGate ─┬─ cancel ───────────────────────────────────→ respondToUser
              ├─ revise && researchRevisionCount <= 1 ─────→ researchNode
              └─ otherwise (approve, or revise exhausted) ─→ architectNode
```

When revise is exhausted, `chosenApproachId` is null and the Architect binds to `recommendedId` through `effectiveApproach`, the same fallback the eval relies on.

### Architect binding

`architectNode` computes `effectiveApproach(state.designBrief, state.chosenApproachId)`. When non-null it pushes, after the Design Contract block and before the revise-feedback block:

```
Design Approach (chosen by the user from prior-art research):
Name: <name>
Construction: <construction>
Strengths: <strengths, one per line>
Weaknesses to design around: <weaknesses, one per line>
Sources: <urls, or "none retrieved">
Build this construction: the same bodies and the same joining scheme. If a physical constraint forces a deviation, record it in assumptions[] with its rationale.
```

`ARCHITECT_PREAMBLE` gains, directly under DESIGN CONTRACT:

> DESIGN APPROACH. When a chosen approach is given, its construction is the topology you build: the same bodies and the same joining scheme. Deviate only for a physical constraint, and record every deviation in assumptions[].

The block is rebuilt on every Architect pass from state, so a spec-gate revise stays bound to the same approach, and nothing is appended to `messages` — the same reasoning that keeps the spec out of `messages` today.

## UI

`gate-inline-ui.tsx` gains a `kind === 'research'` branch, title "Choose a Design Approach". Each approach is a card: name, a `cited`/`recalled` chip, construction, strengths and weaknesses as two short lists, and source titles as external links. One radio group across the cards, preselected on `recommendedId`, with the recommended card labelled. Actions: **Approve** (sends `chosenApproachId`), **Search again** (opens the existing comment field and sends `revise`; hidden once `revisionCount` reaches `MAX_RESEARCH_REVISIONS`), **Cancel**. The `thinking-indicator` needs no change; research events reuse `type: 'thinking'`.

## Testing

Test-first, in the style of the existing suites; no test makes a live search or model call.

| Suite | Proves |
|---|---|
| `search-provider.test.ts` | Tavily adapter maps a canned response body to `SearchHit[]`, truncates content, caps at 5, throws on non-2xx, aborts on timeout; `resolveSearchProvider()` returns null with no key; URL normalisation cases. |
| `design-brief.test.ts` | Request schemas contain no `grounding`/`searchQueries`, are bounded, and stay in sync with the zod schema (field-set equality); `groundApproaches` labels cited/recalled, prunes unmatched URLs, never drops an approach, sorts cited-first stably; `recommendedId` repair; `effectiveApproach` fallback. |
| `research-node.test.ts` | Each skip reason in order; parallel search with one failing query still yields a brief; all failing → `search_failed`; bounded retries on both model calls; hit cap of 12. |
| `graph-research.test.ts` | Modelled on `graph-hil.test.ts` with queued canned model replies and a stub provider: node order and exact model-call counts; the chosen approach reaches the Architect prompt exactly once and survives a spec-gate revise; unknown `chosenApproachId` falls back to the recommendation; revise loop stops after one; missing key skips research and the run still reaches the Drafter; `already_researched` on a second turn; cancel routes to `respondToUser`; `gateAction`/`gateFeedback` are cleared. |
| `system-prompt.test.ts` (extend) | The DESIGN APPROACH instruction is present and edge-treatment rules are unchanged. |
| `eval/generation/metrics.test.ts` (extend) | `researchRan` and `citedApproachChosen` rates. |

## Cost per design run

2–4 Tavily requests, 2 gateway model calls, one human pause. At the free tier's 1,000 requests/month that is roughly 250–500 runs.

## Out of scope (parked)

- Looking up hardware dimensions or standards (M3, 608ZZ, NEMA 17) — a later node feeding numbers, not approach.
- Print and material guidance lookups — belongs with the parked slicer/print-prep node.
- Fetching full pages beyond what the search returns; Firecrawl-style scraping.
- Any content heuristic for skipping research on "simple" requests; add only if the eval shows waste.
- Persisting briefs across threads or a research cache.
- Changing `AssemblySpecSchema` to record provenance.
- The Gemini removal itself and the dead `apiKey` chain it leaves (`app-store.ts` → header dialog → `chat-panel.tsx` → both API routes → `createCadAgent`) — separate branch.
