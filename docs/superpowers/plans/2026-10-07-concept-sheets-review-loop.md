# Concept sheets + reviewer loop: exact shapes, variants A/B/C, one vision model

**Workspace:** worktree `.claude/worktrees/spec-images-review-loop`, branch `claude/spec-images-review-loop`. It was cut from local `main` at 5158e6f, which includes the streaming-transcript merge. Baseline is 386/386 tests green. `origin/main` is 62 commits behind, so never base on it.

## Context

Output quality is still low, and two causes are visible in the code:

1. **The Drafter has no drawing.** Its whole picture of a part is `components[].description`, one prose string. Boxes (`localExtents`) can't express a wedge, a 30° back, an A-frame, a ring or a tray.
2. **Spec errors stay invisible until after drafting.** `spec-coherence.ts` says it directly: a wrong Architect spec gets built faithfully and confirmed. The only visual check, the Visual Critic, runs after compile and is parked.

The fix follows the shared `create-2d-product-concepts` skill: **"do not replace geometry with an attractive image."**

- The Architect proposes up to 3 structurally different variants. Each variant has a free-form sheet and a strict skeleton, in which every part has an exact, code-readable shape.
- Code draws each variant as a dimensioned concept sheet.
- A 2D reviewer checks every sheet against the request and sends failing variants back to the Architect, up to 5 times each.
- At the spec gate, the user picks a variant while looking at the sheets.
- The Drafter receives the chosen variant's sheet, skeleton and image, plus a starting script generated from its exact shapes.

## Decisions (2026-10-07)

- **No image-generation model.** Sheets are drawn deterministically by code, so the Gemini-via-gateway question is moot.
- **Each component gets a shape:** `box | cylinder | tube | shell | profile`, where profile is a 2D outline with optional holes, extruded along an axis.
- **`guides[]`** are dashed reference geometry that is drawn but never built. Examples:
  - held objects (phone, laptop, spool, Pi board)
  - tilt or angle lines
  - wall and desk planes
  - cable routes
  - clearance zones
- **Up to 3 variants**, picked at the spec gate.
- **The research node and research gate are removed.** The Architect, together with the 2D reviewer loop, replaces them.
- **Hybrid spec**: strict where code reads the value, free-form where only models read it.
- **One vision model for every node.** The picker lists only vision-capable slugs.
- **Retries:** the first attempt plus up to 5 retries per variant (`CADAI_SPEC_REVIEW_RETRIES=5`).
  - On Vercel, a wall-clock budget also applies (`CADAI_SPEC_REVIEW_BUDGET_MS`, default 240 s), because each request has `maxDuration = 300` (`api/chat/route.ts:14`, `resume/route.ts:13`).
  - Locally there is no time cap.

## Execution: Herdr multi-agent flow

This session is the orchestrator. It runs in Herdr pane `w4:p1`; `HERDR_ENV=1` was verified, and Herdr is 0.9.3.

**The orchestrator's job:**
- writes the task briefs
- starts and prompts the agents
- verifies every hand-off itself (`npm test`, `npx tsc --noEmit`, `npm run lint`) instead of trusting agent reports
- merges branches
- runs the evals

It writes no feature code, apart from resolving merge conflicts.

**Agents.** Each runs in a sibling pane in the current tab, created with `herdr pane split --current --direction right|down --cwd <worktree> --no-focus`. Each implementer gets its own git worktree, branched from `claude/spec-images-review-loop`, plus `npm ci` and a copy of `.env`.

| name | kind / model | worktree / branch | permission mode |
|---|---|---|---|
| `agy-impl` | `agy --model gemini-3.1-pro-high` | `.claude/worktrees/spec-images-agy`, `claude/spec-images-agy` | `--dangerously-skip-permissions` |
| `grok-impl` | `grok -m grok-4.7` | `.claude/worktrees/spec-images-grok`, `claude/spec-images-grok` | `--always-approve` |
| `opus-review` | `claude --model opus` (fresh context) | the integrated feature worktree, read-only review | default |
| `runner` | plain shell pane | the feature worktree | used for baseline and eval runs |

- **Auto-approve is limited to each agent's own worktree by instruction only; nothing enforces it.** Approving this plan is your consent to that. Briefs tell agents:
  - never push
  - stay inside their worktree
  - commit only to their own branch
  - never run repo-wide formatters
- **Briefs** are written to `.cadai/tasks/<stage>.md` in the agent's worktree. That path is gitignored. Each brief contains:
  - the plan phase text
  - file ownership
  - acceptance tests
  - "finish with: commit hash, files changed, test output"
- **Driving an agent.** `herdr agent prompt <name> "Read .cadai/tasks/<stage>.md and complete it." --wait --timeout 3600000`. If the agent ends up blocked or times out, run `herdr agent read`; anything ambiguous gets asked of you, never answered blindly.

**Stages**, with no file overlapping between agents running in parallel:

- **S0, orchestrator.** Run the Phase 0 spike (scratchpad script) and baseline arm A in `runner`. Report the table, and stop only if no model qualifies.
- **S1a, agy.** Land the spec v2 schema contract from Phase 3: `assembly-spec.ts` shape/guides/sheet, the trims, `spec-shape-audit.ts`, and tests. The orchestrator verifies it, merges it into the feature branch, and merges it into grok's branch.
- **S1b, in parallel.**
  - agy: Phase 1 (remove research), then Phase 2 (vision model), then the rest of Phase 3 (planner, parallel variants, prompts). One commit per phase.
  - grok: the Phase 4 rendering library (`spec-sheet/geometry.ts`, the `stl-renderer` refactor, `sheet-svg.ts`, `rasterize.ts`, `blockout-scad.ts`) with tests.
- **S2, in parallel after S1 is merged.**
  - agy: server integration.
    - Commit the `GatePayload` / `GateDecision` types first.
    - Then: the illustrator and reviewer nodes, loop state, routing, `gate-policy.ts`, variant `specGate`, the multimodal drafter with the starting script, the sheet in `fixCode` and the critic, the flags and `.env.example`.
  - grok, starting after agy's types commit: the variant cards in `gate-dock.tsx`, `chat-panel.tsx` decision stripping, rehydration of legacy payloads, and the Phase 6 eval flags and metrics.
- **S3, orchestrator.** Merge, then run full verification. Run an API-level smoke test: POST `/api/chat` to the dev server in `runner` and read the SSE stream. Then run eval arms B and C in `runner`.
- **S4, review.** `opus-review` reviews `git diff main...claude/spec-images-review-loop` against this plan. The orchestrator triages the findings and sends fixes back to the agent that owns each file, then re-verifies.
  - Final report to you: the eval table, the review outcome, and anything left open.
- **Cleanup.** Close the panes and remove the agent worktrees this flow created, once their branches are merged.

## Strict vs dynamic: hybrid (reasoning)

The rule: strict where code reads the value, dynamic where only a model reads the text.

- **Why not fully dynamic.** Neither an image nor prose can be checked to the millimetre. Dropping the skeleton would also drop every mechanism built for a measured failure:
  - deterministic placement
  - the coherence, hole, extents and interference checks
  - code-built gussets
  - gate question answering
  - now, the sheets themselves
- **Why not fully strict.** Fields no code reads still cost constrained decoding (about 0.8 valid per attempt, 78 s on average), and they force every object into the same slots.
- **What stays strict:**
  - `shape`, which code tessellates, renders, audits and turns into the starting script
  - `guides`, which code renders
  - `assemblyName`, `boundingBox`, `components{ name, description(one line), shape, localExtents, position, rotation, positionNote, holes, bedFace }`, `jointContracts{type, clearance, partA, partB}`, `stressPoints`, `assumptions`, `openQuestions`
- **What becomes free-form.** `sheet` is markdown whose structure the model chooses, with one requirement: part names must match `components[].name`. It is the first property of each variant's structured call, so the model reasons before it commits numbers.
- **Removed fields:** `form`, `useModules`, `matingFaces`, `jointContracts[].dimensions`, and the request-side `specApprovedAt`. A value the model emitted there would make audits trust an unapproved spec (`spec-audit.ts:198`, `placement-audit.ts:62`).

## Target flow

```text
START → architectNode ─(planner: brief + variant ideas; then variants A/B/C in parallel)─→ specIllustrator (draw sheets)
          ↑                                                                                       │
          └──── variants with major findings, retries (+budget) left ←──── specReviewer (2D, per variant, parallel)
                                                                                │ all pass | budget spent (labelled)
                                                                                ▼
                                             specGate (pick variant, answer questions, revise/deny) → drafterNode → validateCode → …
```

## Phase 0: Spike + baseline (measure before building)

The spike is one throwaway scratchpad script, run as a single batch for under $3. Stop and report if no model qualifies.

1. **Node-model probe.** Run with `getChatModel`'s exact params on the real call paths. Candidates:
   - `gpt-5.6-luna`
   - `gpt-6-luna`
   - `qwen3-vl-235b-a22b-instruct`
   - `kimi-k2.6`
   - `glm-5v-turbo`
   - `gpt-5.4-mini`

   For each candidate, check:
   - image input
   - `bindTools` together with an image
   - plain-JSON `withStructuredOutput(...).stream()` on the variant schema, with flat shape fields and `Vec2[]` profiles
   - zod `withStructuredOutput` with images
   - 3 concurrent calls, to check rate limits

   LangChain sends `strict:true` only for zod schemas (`@langchain/openai/dist/utils/output.js`), so strictness on the plain-JSON path must be probed, not assumed.
2. **Variant-schema quality.** Run `laptop_stand_30`, `hair_dryer_holder` and `spool_holder` on the top 2 models, 2 samples each. Record:
   - validity
   - latency
   - profile sanity (simple polygon, bbox matches extents)
   - total wall time before the gate, including a planner and 3 parallel variants
3. **Rasterizing text.** Check that `sharp` renders SVG `<text>` correctly on Windows. Note what it would need on Vercel Linux. If fonts fail, the fallback is stroke-font glyph paths.
4. **Baseline arm A.** Run `npm run eval:generation -- --tag baseline-A` on the unmodified worktree with deepseek-v4-flash and research off.
   - Optionally also run arm A′, which is the same with `--model <winner>`, to isolate the model effect.

**Exit:** a table that picks `DEFAULT_MODEL`, says whether a strict-schema adapter is needed, and settles the text-rasterizing approach.

## Phase 1: Remove research

- Delete `src/lib/research/` (node, design-brief, search-provider, prompts, tests) and `graph-research.test.ts`.
- `graph.ts`:
  - drop `researchNode`, `researchGate` and `noteResearchSkip`
  - drop the `designBrief` and `researchSkipReason` state fields
  - drop the `approachBlock` usage
  - drop `checkResearchRoute` and `checkResearchGateRoute`
  - drop their edges; `START` → `architectNode`
- `stream-bridge.ts` `NODE_LABELS`: drop the research entries.
- Types: drop GatePayload `'research'`, `GateDecision.chosenApproachId` and `DesignContract.researchApproach`. Old persisted contracts still parse.
- `run-summary.ts`: drop the `approach` param.
- `gate-dock.tsx`: drop the research branch. Its radio-card markup is reused for variants in Phase 5.
- `eval/generation/run.ts` and `metrics.ts`: drop `--research`, `researchRan` and `citedApproachChosen`.
- `vitest.setup.ts` and `.env.example`: drop `CADAI_RESEARCH*` and `TAVILY_API_KEY`.

## Phase 2: One vision model

- `models.ts`:
  - rename `DEFAULT_TEXT_MODEL` → `DEFAULT_MODEL`, set to the spike winner. Callers: both routes, `header.tsx`, `thread-storage.ts`, `app-store.ts`, tests.
  - `GATEWAY_MODELS` keeps only probe-passing slugs.
  - add `isVisionModel(slug)`. `CADAI_MODEL` can name any slug; a non-vision model skips sheets with a transcript note. drafterNode has no try/catch, so this guard is load-bearing.
  - drop `DEFAULT_VISION_MODEL`.
- `model-provider.ts`: remove `getVisionModel`; the critic uses `model`.
- **Strict adapter, only if the spike needs it.** It goes in `strict-schema.ts`:
  - optional properties become `anyOf[T, null]`
  - `default` keywords are stripped
  - order: `requireComponentFields` → strict → `boundNumbers`
  - `nullsToUndefined` runs before every `safeParse`

## Phase 3: Spec v2 (shapes, guides, sheet) and planner + parallel variants

- **`assembly-spec.ts`:**
  - Add `sheet` first, as `z.string().default('')`.
  - Add `components[].shape`, a flat object refined per kind (decoder-friendlier than `anyOf`):
    - **box** uses `localExtents`.
    - **cylinder** takes `axis`. Its diameter comes from the two equal cross extents.
    - **tube** takes `axis` and `innerD`.
    - **shell** takes `wall` and `openFace`.
    - **profile** takes `plane`, `points: Vec2[]` and optional `holes: Vec2[][]`. It is extruded along the remaining axis over that axis's extent. `Vec2` is a length-2 array, never a tuple.
  - Add `guides[]`: `{ label, kind: 'envelope'|'line', shape?, localExtents?, position?, rotation?, points?: Vec3[] }`.
  - Drop the trimmed fields.
  - The zod schema stays lenient: no shape means a box, so old specs still parse.
- **Shape audit, new `spec-shape-audit.ts`.** It runs inside the Architect's per-variant retry loop, next to coherence, and feeds its errors back. It checks:
  - cylinder cross extents are equal
  - `innerD` < outer
  - `2·wall` < cross extents
  - a profile's bbox equals its plane extents (±0.5 mm)
  - polygons are simple
  - holes sit inside the outline
  - guides are excluded from bbox coherence and audits
- **`architectNode`:**
  1. **Planner.** One structured call, tagged `nostream`. It returns:
     - `{ brief (markdown, streamed as deltas via write()) }`
     - `assumptions`
     - `openQuestions`
     - `variants: [{ id, name, idea }]` (1–3)
     - `recommendedId`

     A fully specified request gets 1 variant, which keeps "build what was asked for".
  2. **Variant specs.** Calls run in parallel, all tagged `nostream`. Each takes the request, the contract, the brief and that variant's idea. Shared requirements are identical across variants.
     - Each variant gets the existing 3-attempt validity, coherence and shape loop.
     - The sheet markdown and numeric summary are written as one block per variant when it completes. Parallel token streams would interleave inside one section.
  3. **Revision mode.** Only variants flagged `needsRevision` are regenerated. Each revision call gets the previous sheet, the skeleton and the sheet image, plus the reviewer findings and `humanSpecNotes`.
- **`spec-normalize.ts`.** Apply the component rename map (`:29-33`) to the sheet as well.
- **Prompts in `system-prompt.ts`:**
  - Vocabulary: `shape`, `guides`, `sheet`.
  - `ARCHITECT_PLANNER_PREAMBLE`: variants must differ structurally, not just in colour.
  - `ARCHITECT_VARIANT_PREAMBLE`: sheet rules are free structure, every number stated, matching names, geometry-only framing, nothing below z = 0, no edge treatments. Then transcribe the numbers into the skeleton.
  - Remove `form`, `useModules` and `matingFaces` text.

## Phase 4: Deterministic concept sheets + 2D reviewer loop

- **`src/lib/spec-sheet/geometry.ts`.** Turns shapes into triangles, with no wasm and well under a second.
  - Primitives are tessellated; a profile uses `THREE.ShapeUtils.triangulateShape` (`three` is already a dependency).
  - Holes are drawn as dark discs on their entry and exit faces.
  - Placement uses `rotatePoint` + `position` (`design/placement-geometry.ts`), which is the same transform order `composeAssembly` emits.
  - Each part carries a colour index.
- **`engine/stl-renderer.ts`.** Refactor it so it can:
  - render triangle lists with per-triangle RGB (an RGB PNG encoder)
  - return its camera parameters (center, scale, basis per view) for overlays

  `renderStlViews` keeps its API for the critic.
- **`spec-sheet/sheet-svg.ts`.** One SVG per variant, 2×2 views (front, right, top, iso) at about 320 px. Overlays:
  - dashed guides
  - overall W×D×H dimension bands
  - part colour legend
  - title `A — name`
  - up to 3 notes
  - a legend line

  All model text is XML-escaped.
- **`spec-sheet/rasterize.ts`.** SVG → PNG via `sharp`, for models only. `sharp` is promoted to a direct dependency; Next already installs it. Use the glyph-path fallback if the spike requires it.
- **`spec-sheet/blockout-scad.ts`.** Turns shapes into `module <name>()` with holes cut: through holes are full-extent cylinders, blind holes are bored inward from the face that `at` lies on. Builtin names are guarded. This is the Drafter's starting script.
  - A unit test compiles it and matches its bbox against `geometry.ts`.
- **Nodes `specIllustrator` and `specReviewer`.** Add them to `NODE_LABELS` as 'Concept Sheets' and 'Sheet Reviewer'.
  - **specIllustrator** draws the variants whose version changed.
  - **specReviewer** runs `model.withStructuredOutput(SheetReviewSchema).withConfig({tags:['nostream']})` once per changed variant, in parallel.
    - Inputs:
      - request
      - `humanSpecNotes`
      - contract pins
      - variant idea and sheet
      - skeleton summary
      - sheet PNG
    - Zod schema, all fields required: `{ matchesRequest, findings:[{issue, severity:'minor'|'major'}] }`.
    - The prompt asks it to judge:
      - arrangement and counts
      - angles (against guides)
      - proportions
      - fit against guide envelopes
      - parts touching where they join
      - hole faces
      - z = 0

      It should be conservative, the way `CRITIC_PREAMBLE` is. A failed call marks the variant not validated with a note, and the run continues.
- **Loop state.** It is written by the reviewer, because routing functions can't write state.
  - A variant is marked `needsRevision` when it has major findings, its `retries < CADAI_SPEC_REVIEW_RETRIES`, and it is within the budget (`process.env.VERCEL` only).
  - If any variant needs revision, route to `architectNode`; otherwise go to the gate.
  - Variants still failing at the end go forward labelled "not validated" with their findings. Labelled, never dropped.
- **State:**
  - `specBrief{markdown, assumptions, openQuestions, recommendedId}`
  - `specVariants[{ id, name, idea, spec, version, sheetSvg, review{validated, findings, attempts}, retries, needsRevision, error? }]`
  - `reviewDeadline`
  - `humanSpecNotes`
  - Sheet PNGs are generated on demand from the SVG and never stored. Storing them would bloat checkpoints, because `FileCheckpointSaver` rewrites the whole file every step.
- **Gate policy (`gate-policy.ts`).** Always gate when there is more than one variant, any variant is not validated, or after a human revise. Otherwise apply today's rules.
- **Flags:** `CADAI_SPEC_SHEETS=on|off` (on by default, off in `vitest.setup.ts`), `CADAI_SPEC_REVIEW_RETRIES`, `CADAI_SPEC_REVIEW_BUDGET_MS`, `CADAI_MAX_VARIANTS=3`, all documented in `.env.example`.
  - With sheets off, the planner still runs, but there are 0 reviews.

## Phase 5: Variant gate + multimodal drafter

- **Types (`src/types/index.ts`):**
  - The spec GatePayload becomes `{ kind:'spec', brief, variants:[{id, name, idea, spec, sheetSvg, review}], recommendedId, openQuestions, contract, revisionCount }`.
  - `GateDecision` gains `chosenVariantId`.
  - The dock treats a legacy payload with `spec` as a single variant.
- **`specGate`:**
  - **Approve:** `assemblySpec` = the chosen variant, merged with the shared assumptions and questions. Answered questions become assumptions, as today.
  - **Revise:** keep only the chosen variant, append the comment and answers to `humanSpecNotes`, reset its retries and the deadline, and go back to `architectNode`.
  - **Cancel:** unchanged.
- **`gate-dock.tsx`:**
  - variant radio cards, with the sheet rendered via `<img src="data:image/svg+xml;base64,…">` (scripts never run) and click-to-enlarge
  - a review badge per variant, plus its major findings
  - the shared open questions
  - comment, Deny, Revise, Approve
- **`chat-panel.tsx` `handleResume` (`:295-308`).** When it records the decision, keep only the chosen variant's `sheetSvg`, so IndexedDB stays small. The reload-restore of an open gate (fa041a5) still has everything.
- **`drafterNode` (chosen variant, vision model).** The `HumanMessage` contains:
  - the sheet markdown
  - the skeleton JSON
  - the contract lines
  - guides marked "context, never model these"
  - the open findings, when not validated
  - the starting script, framed as: "modules already have exact base shapes and holes; add the features the sheet names; keep base dimensions; no top-level placement"
  - the sheet PNG `image_url`

  The tool-round synthesis call re-sends the image, which is accepted. Images never enter `messages`. The node clears `specVariants` and `specBrief` afterwards.
  - Flag: `CADAI_DRAFTER_START=blockout|scratch`, so the eval can measure the effect.
- **`fixCode` and `criticSpecSummary`.** Both get the sheet alongside the trimmed skeleton.

## Phase 6: Eval

- **`run.ts` flags:** `--sheets on|off`, `--drafter-start blockout|scratch`, `--critic on`. The critic uses a fixed judge (`CADAI_CRITIC_MODEL`) so every arm is scored the same way. Auto-approve picks `recommendedId`.
- **New metrics:**
  - `variantCount`
  - `variantsValidated`
  - `reviewRounds`
  - `chosenValidated`
  - `visualMatch`
- **Arms** (10 prompts each):
  - A: baseline, from Phase 0
  - A′: optional, model effect
  - B: new pipeline, `--drafter-start scratch`
  - C: new pipeline, `--drafter-start blockout`
- Report x/10 rates, cost and wall time. Make no claims from single samples, and say plainly if any arm is worse than A.

## Expected test fallout

**To update:**
- `model-provider.test.ts:29,51-68`
- the `graph-critic.test.ts` vision fallback
- the `DEFAULT_MODEL` rename sites, including `thread-storage.test.ts:352-363`
- `assembly-spec.test.ts:16,38,48,148-156,190-193`
- `spec-normalize.test.ts:21-30`
- `system-prompt.test.ts:100,135`
- `graph-hil.test.ts`: the architect is now planner + variant calls, so `invokeMock` counts change; update them deliberately
- `spec-markdown.test.ts`
- `eval/placement/fixtures.ts` (`form`)
- research-related assertions in `run-summary`, rehydrate and `gate-dock` tests

**New tests:**
- shape tessellation per kind and profile triangulation with holes
- the shape audit
- the blockout SCAD compiles, with its bbox equal to the TS geometry
- the sheet SVG escapes text and includes dimensions and guides
- the reviewer loop table: pass, revise subset, retries spent, Vercel budget, reviewer error
- parallel variants with one failing generation leave the others intact
- gate approve, revise and cancel with `chosenVariantId`
- `humanSpecNotes` survive a reviewer round
- the drafter sends the image and the starting script, keeps images out of `messages`, and clears state
- a non-vision model skips sheets
- `nostream` tags are present
- `handleResume` strips the unchosen sheets

## Verification

- `npm test`, `npx tsc --noEmit`, `npm run lint`.
- **Manual.** Run `npm run dev` with "laptop stand with a 30 degree tilt". Expect:
  - the brief streams
  - variants A/B/C arrive as blocks
  - Concept Sheets and Sheet Reviewer sections appear, including revision rounds if any
  - the dock shows 3 sheets with dimensions, colour legend and a dashed laptop guide
  - picking B, then Approve, compiles a model that follows B's profiles
  - no raw JSON appears in the transcript
- **Eval:** run arms A–C. Present the table before claiming any improvement.

## Cost and latency (confirm in Phase 0)

- **Typical:** planner + 3 parallel variants + 3 reviews. The models are cheap ($0.20/$1.20 per M tokens class), so this costs cents, and adds roughly 30–60 s compared with today.
- **Worst case:** 5 revision rounds. Locally that is unbounded in time; on Vercel the 240 s budget applies.

## Out of scope

- Images in `fixCode` (parked).
- The Visual Critic in the product; it is an eval metric only.
- Feeding prior turns' sheets to the next turn.
- Fully code-generated module bodies; the starting script is a hint the Drafter refines.

## Housekeeping (after approval)

- Save the design and plan to `docs/superpowers/{specs,plans}/2026-10-07-concept-sheets-review-loop*.md`.
- Update memory:
  - deterministic drawings over AI images
  - research node removed in favour of Architect + reviewer
  - one vision model everywhere
  - gateway Gemini image slugs acceptable if image generation ever returns
  - implementation goes through the Herdr flow: agy and grok implement, and Claude Opus reviews at the end

## Results (2026-10-08)

Eval: 10 prompts, 1 sample each. `visual` is an independent judge on the compiled model (critic pinned to gpt-5.6-luna). Single samples show direction, not proof.

| Arm | Pipeline | Error-free | Visual match | Avg wall |
|---|---|---|---|---|
| A | baseline (deepseek, no sheets) | 1/10 | – | – |
| B3 | sheets + reviewer, drafter from scratch | 9/10 | – | – |
| C3 | sheets + reviewer, drafter from blockout | 10/10 | – | – |
| C4 | C3 + findings-win revisions, mating cuts, fused joints | 10/10 | 9/10 | 73 s |

Model comparison on the hard set (phone_stand, cable_clip, spool_holder), pipeline C4. For Opus the sheet reviewer was pinned to gpt-5.6-luna.

| Model | Error-free | Visual match | Avg wall |
|---|---|---|---|
| gpt-5.6-luna (default) | 3/3 | 2/3 (cable_clip failed) | 86 s |
| gpt-6-sol | 3/3 | 3/3 | 132 s |
| claude-opus-5.5 | 3/3 | 3/3 | 149 s |

Claude through the gateway needed four changes on the variant-spec call:
- no `maxItems` or numeric bounds
- no nullable unions (cap 16)
- at most 24 optional parameters
- non-strict tool calling, because strict mode's compiled grammar was too large for the spec

The planner, reviewer and critic keep strict json_schema. The default model stays gpt-5.6-luna; sol and Opus are paid picker options.
