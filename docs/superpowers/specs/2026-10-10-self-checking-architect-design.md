# Self-Checking Architect: remove the Drafter — Design

**Date:** 2026-10-11 (first draft 2026-10-10)
**Status:** approved in chat on 2026-10-11. Reviewed by Gemini 3.1 Pro and grok-4.7 (review D1, 2026-10-11); their fixes are folded in. Waiting for the user's OK before the implementation plan.
**Base:** `claude/spec-images-review-loop` at `fc48937`. That commit includes R16:
- code computes `boundingBox`;
- spec validation feedback is complete;
- the eval honours the sheet reviewer;
- every `claude-*` route runs at temperature 1.

**Spike code** (gitignored, in the `wt-S3` worktree, `.cadai/spike/`):

| File | What it is |
|---|---|
| `s4-gateway-architect.ts` | author loop, Luna reviewer, feedback |
| `s3-tools.ts` | check, build, 9-shot renders |
| `s3abl/architect-system.md` | author prompt with the BODY rules |
| `s4-example-spec.json` | the checked example |

S11, the parameter check, is in this worktree's `.cadai/spike/s11*`.

## Summary

The Drafter is removed. The Architect already has two steps, the planner and the specifier. It gains a third, the **author**. The author writes an OpenSCAD body for every component of the approved spec, and fixes the spec itself when a build shows a problem.

On every build:
1. Code composes, places, compiles, checks and renders the build.
2. A hybrid reviewer scores the build against a checklist the planner wrote, using gpt-6-luna-decisions.
3. The run's own model explains each failed item.
4. You see the renders, the checks, the checklist and the findings. You accept, revise with instructions, or cancel.

## Decisions (approved 2026-10-11)

| # | Topic | Decision |
|---|---|---|
| 1 | Drafter | Removed completely, with the repair node, the visual critic and the old accept gate. No A/B flag. |
| 2 | Variants | Kept: planner → up to 3 variant specs → code-drawn sheets → sheet reviewer → spec gate, all unchanged. The build loop runs on the chosen variant. |
| 3 | Spec format | Numeric now (today's `localExtents`, `position`, `rotation`). The relational spec is the next change. |
| 4 | Reviewer | Deterministic checks, plus Luna Decisions predicates over the planner's checklist, plus a chat explanation of each failed item. |
| 5 | Human gate | After every build. |
| 6 | Names | The Architect has three steps: **planner**, **specifier** and **author**. |

The LLM council of 2026-10-10 advised measuring relational first builds before building any loop. On 2026-10-11 the user chose to remove the Drafter now and keep the relational spec as the next change. The success test (section 12) measures whether this change pays off.

## Problem

The graph runs: planner, variant specs, sheets, sheet reviewer, your pick, the Drafter writes the OpenSCAD, compile. The intent is lost at the Drafter hand-off:

- **A literal Drafter.** In the real-graph Countach run, the Drafter built the spec literally. It skipped the wheel arches and door shut lines "because the spec gives no coordinates", and flagged the conflict with the revision notes instead of resolving it.
- **Mostly dead parameters (S11).** The Drafter declares design-panel parameters, then hard-codes the same numbers in the modules. In the R16 Haiku baselines, 13 of the 17 declared parameters are never referenced, and 5 of the 6 tested slider edits changed nothing.
- **Nothing looks at the result.** Repair is off by default and the visual critic is advisory, so no step compares a build with the request and sends that back to the step that can change it.

Single-author sessions did better because they could read the schema, inspect their own renders and iterate. The spike reproduced that loop through the gateway (evidence below).

## Evidence

### 1. Models as a self-checking author (Countach, original S4 harness)

Each model writes the full spec, including each part's OpenSCAD `body`. Code checks and builds it and sends back the check text and renders. Scores are blind fidelity (0–10) from a frozen Opus judge; earlier rounds are in brackets. The judge's noise is at least 1 point.

| Model | Score | Cost | Time |
|---|---|---|---|
| Sonnet in a Claude Code session (reference) | 6 [7, 6] | subscription | — |
| deepseek-v4.1-flash | 5 | $0.56 | 44 min |
| glm-5.3-flash | 4 | $0.10 | 42 min |
| claude-sonnet-5.5, 4 builds | 4 [5] | $0.78 | 8 min |
| gpt-6-sol | 3 [4, 4] | $0.53 | 8 min |
| claude-haiku-5.5 | 3 [3] | $0.05 | 6 min |
| gpt-5.6-luna | 2 | $0.07 | 7 min |

### 2. Trace reviews (Opus high, Grok high) and fixes 1 and 2

Most of the gap to the reference session was the harness, not the models:
- the prompt never showed the JSON schema;
- the `boundingBox.width` trap;
- incomplete feedback;
- a prompt that contradicts itself on joint cavities.

The fixes:
- **Fix 1:** the schema plus a checked example go in the prompt, and code computes `boundingBox`.
- **Fix 2:** complete feedback: every issue, ignored keys, "nothing was built", warnings, and a flag on repeats.

With both fixes, Haiku's first build compiled clean on the phone stand and on the Countach, where 2–3 builds had been lost to format before. But Haiku then declared DONE after 1–2 builds, so quality barely moved. Both fixes are in the product's specifier since R16.

### 3. Reviewer loop (Haiku author, fixes on, cap 8 builds)

| Task | Reviewer | Major findings per build | Outcome | Time | Cost |
|---|---|---|---|---|---|
| Phone stand | Haiku (chat) | 1, 2, 2, 2, 2, 0 | accepted at build 5 | 10 min | $0.07 |
| Countach | Haiku (chat) | 4, 4, 3, 2, 4, 0 | accepted at build 5 | 18 min | $0.13 |
| Phone stand | gpt-6-luna-decisions | 2, 2, 1, 0 | accepted at build 3 | 6 min | $0.04 |
| Countach | gpt-6-luna-decisions | 11, 9, 7, 5, 6, 8, 6, 8 | cap, not accepted | 16 min | $0.12 |

- **The loop fixes specific checklist items.** The Countach got wheels in cut arches, and the phone stand's "cable can exit" probability went 0.16 → 0.57.
- **It also regresses.** Every revision rewrote the whole spec, and Haiku could not hold every constraint at once. In the Luna Countach run, ride height went 0.63 → 0.06 while the periscope went 0.07 → 0.95. This is why revisions here are patches.
- **It does not lift aesthetics.** Both reviewers accepted plain-slab phone stands.

How the two reviewers compared:
- **Luna:** strict on function, gives no explanations, a few seconds and about 0.05¢ per review.
- **Haiku chat reviewer:** lenient, explains, about 0.2–0.5¢ per review.

That pairing is why the design uses both.

### 4. Relational spec (S10) and parameter check (S11)

Haiku first builds, each scored blind 3 times in the same round:

| Prompt | Today's graph | Relational |
|---|---|---|
| Countach | 3.3 | 3.0 |
| hair dryer holder | 3.7 | 3.7 |
| drawer unit | 6.7 | 6.0 |

- **Quality:** no difference within noise.
- **Parameters:** relational output was clearly more parametric. Only 1 of 44 relational parameters was dead, against 13 of 17 in the graph, and its failed slider edits were caught by checks.

### 5. The bar to beat

R16 baseline: the fixed graph with claude-haiku-5.5, scored blind 3 times by Opus medium.

| Prompt | Mean score |
|---|---|
| Countach | 3.0 |
| hair_dryer_holder | 4.3 |
| drawer_unit | 7.3 |

The hair dryer ring was built as a horizontal sleeve, and the sheet review missed it.

### 6. Gateway facts

- **Reasoning eats the output budget.** It is 85–92% of a first full-spec call's output tokens, so 32k truncates and `max_tokens` must be at least 64k.
- **`claude-*` routes** accept only temperature 1 and do not enforce the schema strictly.
- **Streaming works.** Chunks keep arriving during hidden reasoning.
- **`gpt-6-luna-decisions`** is `POST /v1/decisions`. It takes at most 32 typed questions, bills input only and does not stream.
- **Compiles are cheap.** The manifold backend took a median 0.3 s (p90 0.6 s, max 5.7 s) across 115 spike builds.

## Design

### 1. Flow

```
request
 → architectNode    planner: brief, open questions, variant ideas, checklist (new)
                    specifier: one spec per variant                    [unchanged]
 → specIllustrator → specReviewer  (↺ architectNode while findings)   [unchanged]
 → specGate         pick a variant, answer questions, approve          [unchanged]
 → authorNode       bodies + spec patch (new)
 → buildNode        merge, validate, compose, place, compile, check, render (new)
       ↺ authorNode when nothing was built (at most 2 automatic retries per round)
 → buildReviewer    Luna checklist, explanations, verdict (new)
 → designGate       you: accept | revise with instructions | cancel (replaces acceptGate)
       revise → authorNode;   accept → respondToUser;   cancel → resume route ends the run
```

**When the spec gate is skipped** (`shouldGateSpec` is false), `architectNode` hands over to `authorNode`, as it hands over to the Drafter today.

**With no usable spec at all,** the author writes the whole spec plus bodies, which is the spike's mode.

### 2. Planner: the checklist

- `ArchitectPlanSchema` gains `checklist: [{ name, statement, severity: 'major' | 'minor', fix }]`.
  - At most 32 items, the Decisions API limit.
  - Names are snake_case and unique; code enforces both and labels any item it trims.
- **What goes in:**
  - one item per feature the request names;
  - the functional checks the request implies, such as "the hair dryer can slide into and out of the ring";
  - each item is a visible predicate: a statement someone can judge true or false by looking at the renders.
- **What stays out:**
  - anything code measures. That covers floor contact, floating parts, z ≥ 0, extents, holes and interference, which remain deterministic checks;
  - any feature smaller than about 2 px in the 1200 px close-up. On a 250 mm assembly that is about 1 mm, so a 0.3 mm detail is left out.
- **Lifetime:**
  - written before any variant exists, so it is a contract on the request rather than on a design;
  - **rewritten on a spec-gate revise,** from the request plus `humanSpecNotes`. Otherwise Luna keeps failing an item, such as "the cable can exit", that the user's revision removed (review D1);
  - it does not change at the design gate.
- **Fallback:** if the planner fails or writes no checklist, there is one major item, "The object matches the request and functions as described."

### 3. Author step (`authorNode`)

**Inputs.** The prompt is rebuilt from state every round; nothing is appended to `messages`. It carries:
- the user's request and the Design Contract lines;
- the current spec as JSON, with its bodies and parameters. That is the approved spec on the first build, then the last good build's spec;
- **on the first build:** the chosen variant's sheet image and its open sheet-review findings;
- **on a revision:**
  - the last build's complete feedback (section 5);
  - the reviewer's findings;
  - your latest instruction, as REQUIRED CHANGES;
  - your earlier instructions, labelled "already applied; keep satisfied";
  - the last build's two renders, for vision models.

**Output.** One ```json block holding a patch:

```json
{
  "notes": ["cut wheel arches into body; moved wheels into them"],
  "parameters": [{ "name": "wheel_d", "value": 14, "description": "wheel diameter" }],
  "removeParameters": [],
  "components": [{ "name": "wheel_fl", "position": [12, -1, 0], "body": "..." }],
  "remove": [],
  "jointContracts": [],
  "guides": [],
  "stressPoints": []
}
```

**Merge rules (code):**
- **`components` merge by name.** Each field given replaces that field, and `shape`, `holes` and `localExtents` are replaced whole.
- **Extents and body travel together.** A patch that changes a component's `localExtents` or `shape` must also give its `body`. Otherwise it is a validation error and nothing is built, because the old body would be checked against new extents and a new cavity.
- **A new name adds a component.** It must be complete: `description`, `shape`, `localExtents`, `position` and `body`.
- **`remove` deletes components by name.**
- **Dangling references are errors.** A joint or stress point that names a missing component makes the build fail with nothing built, never a silent drop. Today `checkAssemblyFit` silently skips a missing part (`graph.ts:255`).
- **`parameters` merge by name;** `removeParameters` deletes.
- **List fields:**
  - an omitted key keeps the previous list;
  - `jointContracts` merge by `(partA, partB, type)`, `guides` by `label`, and `stressPoints` by `(component, location)`;
  - a list field gains a `remove…` companion (`removeJoints`, `removeGuides`, `removeStressPoints`) that names the entries to delete;
  - so a patch that touches one joint no longer drops the others (review D1).
- **Ignored fields.** Anything outside the patch schema is ignored, and each such key is named back to the author. That includes `sheet`, `assumptions`, `openQuestions`, `boundingBox` and `assemblyName`.
- **Exception: no spec.** With no spec, `assemblyName` is accepted and every component must be complete.
- **Bodies.** After the first build's merge, every component must have a body.

**Body rules.** The prompt states them once, and code checks what it can:
- **Scope and frame.** A body is the OpenSCAD statements for ONE component in its local frame: min corner at the origin, filling `localExtents` exactly.
- **Parameters.** Dimensions come from the top-level parameters by name. Derived values go in local assignments or `let()`.
- **Code-owned features.** Code cuts every declared hole, cuts the host's cavity for every clearance joint, and unions gussets from `stressPoints[].gusset`. The body never models these.
  - This keeps today's spec convention.
  - It also settles the joint-cavity contradiction that the trace reviews found in the spike prompt. Do not copy the spike's BODY sentence that says the body cuts the cavity (`architect-system.md:61`). The spike also zeroed clearance before compose (`s3-tools.ts:139-142`).
  - **The cavity is the inserted part's `shape` envelope,** grown by the clearance (`compose-assembly.ts:436`), not its body. A shell or a missing shape becomes a box (`blockout-scad.ts:104-105`, `assembly-spec.ts:45`). The prompt says so: the inserted part's `shape` is the solid that gets removed from the host. A clearance joint whose inserted part has no `shape` is a validation error (review D1).
- **Allowed:** cube, cylinder, sphere, polygon, square, circle, linear_extrude, rotate_extrude, translate, rotate, union, difference, intersection, `for` (literal range, at most 64 steps), let, assignments, arithmetic and trigonometry.
- **Not allowed:** minkowski, hull, offset, import, surface, text, projection, render, children, module or function definitions, mirror, scale, include and use. Code rejects a body that uses one.
- **Geometry hygiene.**
  - Cutters overshoot 0.01 mm, matching `OVERSHOOT` in `blockout-scad.ts:15`.
  - Fused solids overlap 0.01 mm.
  - `$fn` stays between 32 and 64. Code emits a top-level `$fn = 48`, as the spike did.
  - No edge treatments.
- **No shadowing.** A body may not assign to a name that is a top-level parameter. OpenSCAD would shadow the slider while a text scan still saw the name, which hides a dead parameter.

**Call settings:**
- **Model:** the run's model, `max_tokens` 64k (`CADAI_AUTHOR_MAX_TOKENS`).
- **Temperature:** the first build uses the base rule. Revisions use `REVISION_TEMPERATURE` (0.6, `graph.ts:74`). `claude-*` routes stay at 1.
- **Streaming:** the reply is streamed and aggregated on the server, which keeps the gateway connection alive.
  - The raw JSON never reaches the UI.
  - The transcript gets a markdown summary of the notes and the changed components.
  - **Heartbeat:** while the author streams, the server emits a progress line about every 15 s, such as "writing bodies… 12k tokens". Without it the client stream carries no bytes for a minute or more, and a proxy may close it (review D1).
- **Timeout:** the run deadline's remainder minus the reserve (section 9), with `maxRetries: 0`. The author does not start with less than the planner's minimum call time (`MIN_CALL_MS`) left.

**Prompt.** It is built from:
- CORE, with its pipeline line updated;
- SPEC_FIELDS;
- PLACEMENT_RULES;
- a new AUTHOR block: the role, the patch format, the body rules and what code measures;
- the patch's JSON Schema;
- one checked example: the pen caddy, converted to the patch format with live parameters.

A test proves the example parses, merges, composes and compiles.

### 4. Parameters

- **Sliders.** The patch's `parameters` become top-level assignments above the modules, in their own `/* [Design] */` group: `name = value; // [lo:hi] description`.
  - `parseParams` only makes a slider from a `[min:max]` annotation. Without one it shows a plain number box (`parse-params.ts:100-146`).
  - Code writes the range: `lo` is a quarter of the value and `hi` is four times it, rounded. The author may give its own `min` and `max` in the patch.
- **Pins win.** A pinned Design Contract value overrides the author's value, and the author is told when the two differed. Code emits every pinned parameter, even one the author did not declare.
- **New check: `auditParameters`.**
  - **Scope:** only the author's `/* [Design] */` block. The `name_pos_x/y/z` placement parameters that `composeAssembly` emits (`compose-assembly.ts:385-388`) are left out, so a raised part never fails the check. An author parameter named `*_pos_[xyz]` is rejected.
  - **Error:** a declared parameter is dead when no body references it, directly or through another live parameter's expression. So `slot_w = base_w - 2 * margin` keeps `base_w` and `margin` live. Dead parameters are what S11 found in the graph's output, and as errors they keep the verdict from accepting a build that has them.
  - **Exception:** an unused pinned parameter is only a warning. Pins carry over from the previous design, and the new one may not use them.
  - **Feedback** names each dead parameter.
  - **Warning:** a body is told to name its design dimensions as parameters when it has more than three numeric literals. The literals 0, 1, 2, 0.01, 0.02, 90, 180, 270 and 360, and `$fn` values, don't count.
- **Known limit.** Placement stays literal until the relational spec. A slider resizes its part, but the other parts don't move to follow it.

### 5. Build step (`buildNode`)

1. **Parse.** Extract the json block. On failure, nothing is built. The feedback gives the parse error, and says when the reply hit `max_tokens`.
2. **Merge and validate.**
   - Merge the patch into the current spec.
   - Validate it exactly as specifier specs are validated today: `withComputedBoundingBox` → `AssemblySpecSchema` → `normalizeSpec` → coherence, shape and ground audits.
   - Also check for missing bodies, forbidden body functions, dangling references and ignored keys.
3. **Compose.**
   - The parameter block comes first.
   - Then, for each component: `module <name>() { difference() { union() { <body> } <hole cutters> } }`.
   - The hole cutters come from `blockout-scad`'s hole geometry. `holeLine` is private today (`blockout-scad.ts:303`), and the spike scraped its output text. Instead, export a helper `holeCuttersScad(component): string[]` that works from `holes` and `localExtents` alone. Then a component that `classifyComponent` would turn into a placeholder still gets its cutters.
4. **Place and compile.** `placeAssembly` measures the module frames. `composeAssembly` then adds translate and rotate, gussets and mating cavities. Then compile.
5. **Check.**
   - Today's `validateCode` audits move unchanged into a reusable function: `auditSpec`, `auditSpecCoherence`, `auditSpecShapes`, `auditModuleGuards` and `auditPlacement`.
   - `checkAssemblyFit` and `auditHoles` run on a clean compile.
   - `auditParameters` is added.
6. **Render.** `src/lib/design/render-shots.ts` is ported from `s3-tools.ts`.
   - Each part is compiled alone in its placed pose and given its palette colour.
     - The spike compiled a part as `{ ...spec, components: [c], jointContracts: [] }`, which loses the host's mating cavities. The port composes the full spec, with joints and gussets, and instantiates only `c` (review D1).
     - **Inside the time reserve** (section 9), per-part compiles are skipped and the renders use one colour from the assembly STL.
   - The output is a 3×3 sheet of 480 px shots: iso from four corners, side, both ends, top and underside. Plus one 1200 px iso close-up.
   - Guides are dashed orange, and a legend names the parts.
   - When a part fails to compile alone, the render falls back to one colour from the full STL.
   - Model inputs get PNG. The gate gets JPEG, to keep transcripts small.
7. **Write the feedback** for the next author call (fix 2):
   - every validation issue, uncapped;
   - ignored keys, named, with hints;
   - "nothing was built", and why;
   - compile errors with line numbers;
   - every check error and warning;
   - renders mentioned only when they are attached;
   - a flag when the patch changed nothing.

**Outcomes:**
- **Built** (a valid compile, even with check errors):
  - the new spec, code, STL, model info, violations and renders become the current build;
  - `buildCount` goes up by one;
  - the reviewer runs next.
- **Nothing built** (a parse, validation or compile failure, or `composeAssembly` returning `composed: false`, for example on `missing_modules` (`compose-assembly.ts:364-366`)):
  - the last good build stays current;
  - the failure becomes the feedback;
  - **retry:** the author runs again if fewer than 2 automatic retries were used this round and the last author call's duration still fits the time left;
  - **otherwise, gate:** the design gate opens on the last good build with the note "revision N did not build: <reason>";
  - **no good build yet:** the gate shows the failure, and Accept is disabled.
- **`autoRetries`** is reset to 0 only when the design gate continues on Revise, so every round gets its own 2 retries and no round gets more.

### 6. Reviewer (`buildReviewer`)

- **Luna.**
  - One `POST ${EXPLABS_BASE_URL}/decisions` per build. `EXPLABS_BASE_URL` already ends in `/v1` (`models.ts:13`). The body copies the spike's: `input_text`, `input_image`, and `questions[].type: 'predicate'` (`s4-gateway-architect.ts:415-429`).
  - On an error it retries once. A second failure means "review unavailable".
  - The input carries:
    - the request;
    - a check summary;
    - a note that faceting is expected;
    - the two renders;
    - the checklist, as predicate questions.
  - An item fails when its probability is below 0.5 or missing.
- **Explanations.**
  - **When:** at least one item failed and at least 30 s remain.
  - **The call:** one call to the run's model, or to `CADAI_REVIEWER_MODEL` when set, as with the sheet reviewer. It gets the renders, the failed items with their probabilities and fix hints, and the check errors.
  - **The reply:** `{ findings: [{ name, issue, view, fix }] }`. Every field is required, because a strict route rejects an optional field.
  - **Without an explanation** (the call fails, or time is short), each finding reads "Not met (p=0.23): <statement>. Suggested fix: <the planner's fix>".
- **Verdict.** Accepted means all three:
  - the build compiled;
  - no check has error severity;
  - no major item failed.
- **Luna unavailable.** The build is not accepted and carries the note "review unavailable". The gate still opens.
- **Run model without vision.** Luna still judges, since it has its own vision. The explainer and the author get text only.

### 7. Design gate (`designGate`)

- **Payload.** It stays `kind: 'accept'`, extended backward-compatibly so old transcripts still render.
  - **Kept:** `modelInfo`, `violations`, `code`, `stl`, `revisionCount`.
  - **Added, all optional:** `build`, `maxBuilds`, `renders { sheet, closeup }`, `checklist [{ name, statement, severity, probability, passed }]`, `findings`, `accepted`, `note`.
- **Accept.** The current build is the result, and the run goes to `respondToUser`.
- **Revise.**
  - Your comment becomes the next author call's REQUIRED CHANGES.
  - The findings and check failures always go with it.
  - It starts a new request, with a fresh time budget.
- **Cancel.** The resume route keeps today's short-circuit: it deletes the checkpoint and returns "Generation cancelled by user." without re-entering the graph (`resume/route.ts:61-72`). The current build stays in the editor, because the client already shows the gate's STL (`chat-panel.tsx:125-134`). The graph needs no cancel edge.
- **Cap.**
  - `CADAI_MAX_BUILDS` (default 8) **design-gate visits** per design. A gate visit counts whether or not the round built anything, so a design that never compiles still reaches the cap (review D1).
  - At the cap the gate offers only Accept, when a good build exists, and Cancel.
  - A revise that arrives anyway is refused with a message.
- **Recursion limit.** `graphRecursionLimit` becomes `3 × (specRetries + 1) + 8 × maxBuilds + 15`: four nodes per round, plus two author-and-build retries. A test proves a run of `maxBuilds` rounds fits.

### 8. State

- **New:** `checklist`, `buildCount` (good builds), `gateVisits` (counts toward the cap), `designNotes` (your instructions, in order), `buildFeedback`, `buildRenders`, `buildReview`, `autoRetries`, and the pending patch.
- **Kept, now holding the current build:** `assemblySpec`, `currentCode`, `stlContent`, `modelInfo`, `specViolations`, `placementReport`, `validation`, `isValid`.
- **Removed:** `attemptHistory`, `attemptCount`, `maxAttempts`, `failureKind`, `compileFailures`, `semanticFailures`, `acceptRevisionCount`.
- **Deadlines.**
  - Today only spec-gate revise clears `runDeadline` (`graph.ts:2081`). Approve does not (`graph.ts:2167-2172`), and neither does `acceptGate`. After an approve, the stored deadline is already past, and `withBudget` floors the remainder at 5 s (`graph.ts:161-168`).
  - **Fix:** both gates store `runDeadline: null` on every continuing decision (approve and revise).
  - `authorNode` sets the deadline only when it is null, in the same way `architectNode` does (`graph.ts:948-950`). On the skip path it keeps the value `architectNode` set.
  - Today `drafterNode` runs with no budget at all (`graph.ts:1515`).
- **Known limit: one warm instance.** On Vercel the checkpoint lives in `/tmp` (`checkpointer.ts:15-17`). A resume that lands on another instance gets "not found" (`resume/route.ts:79-84`), and a gate after every build makes that more likely. v1 keeps today's error and adds no durable store.

### 9. Vercel budget (`maxDuration` 300 s)

- **Request 1.** The planner, variants, sheets and sheet reviews run as today: a 240 s soft limit and 300 s hard.
  - The spec gate may be due to be skipped while less than `CADAI_AUTHOR_ROUND_MS` (default **240 s**) remains on the **hard** clock, `runDeadline`. It then opens anyway, so the build starts in a fresh request with 300 s.
  - Measure against `runDeadline`, not `reviewDeadline` (start + 240 s, `graph.ts:944-946`). Both reviewers showed 180 s is too short: with 180 s left and a 60 s reserve, the author gets about 120 s (review D1).
  - Off Vercel, `remainingCallMs` returns null (`graph.ts:162`), and the skip follows `shouldGateSpec` alone.
- **Each later request.** One round each.
  - Spike rounds took 1.5–3 min with Haiku, and those were full rewrites; patches are smaller.
  - **Reserve:** the author call's timeout leaves 60 s for the build and the review. A build's compiles fit easily: a median of 0.3 s each, one per part, plus at most 8 hole probes (`hole-audit.ts:51-55`).
  - **Inside the reserve:** per-part render colours are skipped, the explainer is skipped when less than 30 s remain, and the gate opens on the assembly STL.
- **Checkpoints** hold one set of renders (two images), not a history.
- **Off Vercel** (local and eval), there are no deadlines.

### 10. What is removed

- **`graph.ts` nodes:** `drafterNode`, `validateCode` (its audits move into the build-check function), `fixCode`, `visualCritic` and `acceptGate`.
- **`graph.ts` routes and helpers:**
  - the routes `checkValidationRoute`, `checkCriticRoute` and `checkAcceptRoute`;
  - `drafterModel` and `criticModel`;
  - the repair hints, `criticSpecSummary`, `AttemptRecord` and `MAX_ACCEPT_REVISIONS`.
- **`system-prompt.ts`:**
  - **Removed:** the drafter, placement-contract, repair and critic prompts.
  - **Added:** the `author` and `explainer` nodes.
  - **Updated:** CORE's pipeline line. The frozen eval judge prompt is untouched.
- **Agent gate policy:** `shouldGateAccept` goes, because the design gate always opens.
- **Env vars:** `CADAI_DRAFTER_START`, `CADAI_MAX_ATTEMPTS`, `CADAI_VISUAL_CRITIC` and `CADAI_CRITIC_MODEL` go.
  - **New:** `CADAI_MAX_BUILDS`, `CADAI_AUTHOR_MAX_TOKENS`, `CADAI_AUTHOR_ROUND_MS` and `CADAI_DECISIONS_MODEL` (default `gpt-6-luna-decisions`).
  - `docs/environment.md` is updated.
- **Recursion limit:** `graphRecursionLimit` counts build rounds instead of repair attempts (section 7).
- **Eval flags:** `--drafter-start`, `--critic` and `--critic-model` go.
- **Placement harness:** the tier `drafter` is renamed `script`.
- **Kept:**
  - the engineering-tools registry, which the MCP server uses;
  - `blockout-scad`, for the sheets and hole cutters;
  - `VisualCritiqueSchema`, which the eval judge uses;
  - the frozen judge.

### 11. UI

The design gate card replaces "Review Compiled Model". Before editing it, read the Next.js 16 docs in `node_modules/next/dist/docs/`, per AGENTS.md. The card shows:
- **Title:** "Design review — build N of 8".
- **Renders:** the sheet and the close-up; click to enlarge.
- **Verdict badge:** accepted by the reviewer, not accepted, or review unavailable.
- **Checklist:** each statement with its probability and pass or fail.
- **Findings:** check errors first, then reviewer findings, each with its view and fix.
- **Actions:**
  - Accept;
  - Revise, with an optional instruction box;
  - Cancel.
- **At the cap,** Revise is hidden. With no good build, Accept is disabled.

The 3D viewer keeps showing the gate's STL, as it does today.

Transcript section labels (`stream-bridge.ts`):

| Node | Label |
|---|---|
| `authorNode` | "Architect (author)" |
| `buildNode` | "Build and checks" |
| `buildReviewer` | "Design Reviewer" |
| `designGate` | "Design Review" |

`authorNode` and `buildReviewer` join the structured nodes whose raw output is never streamed.

### 12. Eval and success test

- **Eval gate policy:**
  - **Spec gate:** unchanged (R16).
  - **Today:** `evalGateDecision` approves every non-spec gate (`eval/generation/gate-policy.ts:17-19`). It now takes `gateVisits` and `maxBuilds` from the payload.
  - **Design gate:** approve when the build is accepted. Otherwise revise with the findings, majors first, until `--max-builds` (default 4) gate visits. After that, approve with `approvedUnaccepted: true`.
  - **Review unavailable:** a build whose review was unavailable and that has no check errors is approved and counted as `reviewUnavailable`, so a Luna outage does not burn builds.
  - **Nothing built:** a gate with no good build revises until the cap, then cancels. That prompt scores 0.
  - **Termination:** every branch ends by `maxBuilds` gate visits, and a test drives the policy to the cap.
- **Flags:**
  - `--judge on|off` and `--judge-model` replace `--critic` for the standalone frozen judge (the `visualMatch` metric);
  - `--max-builds` is added.
- **Metrics:**
  - builds;
  - final verdict;
  - `approvedUnaccepted`;
  - checklist pass rate per build;
  - final check errors;
  - dead parameters in the final code.
- **Vision for Haiku.** Today `isVisionModel` is true only for the `GATEWAY_MODELS` (`models.ts:31-45`), and Haiku is not one of them.
  - So with sheets on, `sheetsModelError` refuses Haiku (`run-config.ts:13-15`).
  - With sheets off, the illustrator and the sheet reviewer are skipped (`graph.ts:2218-2224`).
  - The author and the explainer would then get text only, which defeats the test (review D1).
  - **Fix:** add `claude-haiku-5.5` to `GATEWAY_MODELS` as a vision model. The S4 spike already sent Haiku renders through the gateway. This also puts it in the model picker, with a "(paid)" label like the other `claude-*` entries.
- **Success test (paid, after merge):**
  - **Runs:** claude-haiku-5.5 with sheets on, on Countach, hair_dryer_holder and drawer_unit, up to 4 builds each, about 30–50¢.
  - **Scoring:** the final builds are blind-scored 3 times by Opus subagents, in the same round as the saved R16 baseline meshes, which are rescored in that round. The published 3.0 / 4.3 / 7.3 came from a different judge pass, so they are not the comparison.
  - **Caveat:** the R16 baseline ran Haiku without sheets. A gain therefore credits sheets and the loop together. That is acceptable, because the test asks whether the new path beats the old one.
  - **Report:** score, builds, wall time, cost and dead parameters per prompt.
  - **Bar:** a gain of more than 1 point over the baseline is an improvement; anything smaller is noise.

### 13. Testing

- **Unit tests:**
  - patch parsing and merging (by name, remove, completeness of new components, parameters, list merge by key with omitted lists kept, an extent change without a body rejected, dangling references as errors, a clearance joint without an inserted `shape`);
  - the body guard;
  - script composition, including hole cutters and parameters;
  - `auditParameters` (placement parameters excluded, transitive use, pins, shadowing);
  - slider range annotations parse as `kind: 'range'`;
  - the feedback builder (every issue, ignored keys, nothing built, warnings, repeats);
  - `render-shots` (image sizes and labels on a small fixture);
  - the decisions client, against a mocked `fetch`: request shape, the 32-question cap, the p < 0.5 rule, errors meaning "unavailable";
  - explainer parsing;
  - the verdict;
  - the eval gate policy.
- **Graph tests** with mocked models, following today's `invokeMock` pattern:
  - spec gate approve → author → build → review → design gate;
  - revise carries the findings and your instruction;
  - nothing built → at most 2 retries → gate on the last good build, and the next round gets 2 retries again;
  - the cap counts gate visits, including a design that never builds;
  - spec-gate approve and revise both clear `runDeadline`;
  - the checklist is rewritten after a spec-gate revise;
  - the no-spec path;
  - Vercel deadline routing (240 s on `runDeadline`);
  - a run of `maxBuilds` rounds fits `graphRecursionLimit`.
- **No paid calls in tests.**
- **Manual check.** Run `npm run dev`, ask for a phone stand with a cable cut-out, and go through both gates. No raw JSON should appear in the transcript.

## Review D1 (2026-10-11)

Gemini 3.1 Pro and grok-4.7 reviewed this design independently against the code. Both said "ready for the plan after these fixes". Those fixes are folded into the sections above, and each one is marked "(review D1)" where it is not obvious. The reviews are in `.cadai/tasks/D1-review-{gemini,grok}.md`. I checked their critical claims against the code before adopting them.

| Finding | Source | Where it landed |
|---|---|---|
| Haiku is not a vision model, so the success test would run blind | grok | §12, Haiku added to `GATEWAY_MODELS` |
| A design that never compiles has no cap; `autoRetries` is never reset; recursion limit | grok, Gemini | §5, §7, §8 (`gateVisits`) |
| Spec-gate approve keeps an expired `runDeadline` | both | §8 |
| The 180 s skip rule is too short and measured on the wrong clock | both | §9 (240 s on `runDeadline`) |
| List fields replaced whole; extents changed without the body; dangling references | grok, Gemini | §3 merge rules |
| `auditParameters` would flag placement parameters, transitive parameters and shadowing | both | §4, §3 |
| Sliders need `[min:max]` annotations | Gemini | §4 |
| The cavity is the inserted part's `shape` envelope | grok | §3 body rules |
| Per-part renders lost the mating cavities | Gemini | §5 step 6 |
| Hole cutters are private; overshoot is 0.01 | both | §5 step 3, §3 |
| No SSE bytes while the author streams | Gemini | §3 heartbeat |
| Checklist is stale after a spec revise, and sub-pixel items | grok | §2 |
| Eval gate approves every non-spec gate today | Gemini | §12 |
| Cancel never reaches `respondToUser` | both | §7. Kept as is, since the mesh is already in the viewer |
| `/tmp` checkpoint on one warm instance | grok | §8, known limit |
| Decisions URL, strict explainer schema, revision temperature, `$fn` | grok | §6, §3 |

Not adopted: Gemini's cap of 10–12 components for the first author call. The streaming heartbeat and the 240 s rule cover the timeout, and the success test will show whether large assemblies need a cap.

## Risks and open questions for the reviewers

The reviewers' answers are summarised under each question.

1. **Patches vs. regressions.** Is a shallow per-field merge enough to stop the regressions the spike saw with full rewrites? The spike did not test patches.
2. **The author ignores renders.** Haiku declared DONE early in the spike. Here the human gate decides instead of the author's DONE. Will revisions actually use the renders, or polish the checklist?
3. **Checklist quality.** A planner-written checklist has not been compared with the spike's hand-written ones. Small features (0.3 mm Countach details) may not resolve in 480 px shots; the close-up helps.
4. **Luna is lenient on looks.** The verdict can accept plain slabs, and an aesthetics reviewer is out of scope.
5. **Dead parameters as errors.** Can this cause churn on trivial designs? The alternative is a warning, but warnings did not change S11's outcome.
6. **The first author call on large assemblies.** Bodies for more than 15 parts could exceed about 200 s. The mitigations are streaming and the 180 s routing rule.
7. **Spec-gate skip.** A design with no spec gate goes straight to an author round in request 1. Is the 180 s rule the right threshold?

**Answers (D1):**
1. A shallow merge holds position, rotation, holes and bodies. It did not hold list fields, or an extent change made without a body; both are now fixed in §3. The success test is the evidence.
2. The human gate replaces DONE. Bind REQUIRED CHANGES to the explainer's findings, and keep an earlier instruction listed until the checklist item it maps to passes.
3. Use visible predicates, rewrite the checklist after a spec revise, and drop sub-pixel items (§2).
4. Accept the leniency. The human gate checks the looks, and the badge says only that the reviewer accepted the checklist. Luna gets one retry.
5. Keep dead parameters as errors for author parameters only, with the placement and pin exceptions and the transitive rule. Two automatic retries bound the churn.
6. and 7. Measure 240 s on the hard clock and give the author `maxRetries: 0` (§9).

## Out of scope

- The relational spec (the next change), and the 1.1× parameter-change check, which arrives with it.
- Going back to an earlier build, editing the checklist at the gate, model tiers, an aesthetics reviewer, and an automatic loop without the human gate.
- Printability, edge treatments, and any provider other than the Experiential Labs gateway.

## Execution

- **Implementation plan:** written after this review, at `docs/superpowers/plans/2026-10-11-self-checking-architect.md`.
- **Herdr flow:**
  - grok-4.7 implements in task worktrees.
  - Claude Opus (high effort) and Gemini 3.1 Pro review each task.
  - The orchestrator (this session) verifies each task and merges it into the integration branch `claude/self-check-architect`, cut from `fc48937`.
  - `claude/spec-images-review-loop` is fast-forwarded only after your OK.
