# Architect Single Author (P0–P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind `CADAI_PIPELINE=architect`, replace the Drafter and Repair with a relational spec whose parameters are live in the blockout, plus a post-gate `architectBuild` call that writes component bodies, with blockout fallback per component.

**Architecture:** The spec gains `parameters`/`derived`/`relations` and per-field expression strings; `spec-expr.ts` resolves them to numbers for every existing consumer and keeps the strings in `component.expr` for emission. Code emits the parameter block, module headers and expression-based placement. A new node writes bodies as `@body` text for the chosen variant; validateCode's error route goes back to it instead of `fixCode`. P3 (unified findings, best build) and P4 (flip and delete) get their own plan once P2's A/B is in.

**Tech Stack:** TypeScript, Next.js 16, LangGraph JS, zod 4, openscad-wasm, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-architect-single-author-design.md`

## Global Constraints

- The Drafter pipeline stays the default and unchanged; every new path is reached only when `state.pipeline === 'architect'`.
- `state.pipeline` is set once, on a thread's first `architectNode` entry, from `process.env.CADAI_PIPELINE` (`'architect'` → architect, anything else → drafter), and never changes for that thread.
- Expression grammar: numbers, parameter/derived names `^[a-z][a-z0-9_]*$`, `+ - * /`, unary minus, parentheses, `min`, `max`, `sqrt`. Nothing else.
- Every literal code writes keeps its derivation comment (existing rule); every expression code writes is the Architect's string verbatim.
- Nothing below z = 0; no chamfers or fillets; no printing language in any prompt.
- Strict structured output stays off for Claude slugs (`structuredFor`); bodies never travel inside JSON.
- New code goes in new files under `src/lib/agent/` (and `src/lib/agent/nodes/`); `graph.ts` only gains wiring.

## Review Focus

1. An expression naming an undeclared parameter → spec rejected with a message naming it, fed to the existing coherence retry (Task 1).
2. A parameter at ±20% that breaks compile or floor → reported as a sweep failure for that parameter, never a crash (Task 4).
3. A body that includes a `module` header, `translate(...)` at top level or a parameter assignment → stripped before assembly (Task 5).
4. A reply cut off mid-body → the incomplete body is dropped and that component uses its blockout (Task 5).
5. `CADAI_PIPELINE` changed while a thread is paused at a gate → the thread resumes on its original pipeline (Task 7).

---

### Task 1: Expression evaluator and spec resolution

**Files:**
- Create: `src/lib/agent/spec-expr.ts`
- Modify: `src/lib/agent/assembly-spec.ts` (schema fields), `src/lib/agent/spec-normalize.ts` (call `resolveSpec`)
- Test: `src/lib/agent/spec-expr.test.ts`

**Interfaces:**
- Produces:
  - `type Expr = string`
  - `evalExpr(expr: Expr, scope: Record<string, number>): number` — throws `ExprError` with the unknown name or the parse position.
  - `resolveSpec(raw: AssemblySpec): { spec: AssemblySpec; errors: string[] }` — evaluates `derived` in order, then every numeric field that holds a string; writes numbers into the field and the original string into `component.expr[field]`; `errors` lists unknown names and non-finite results.
  - Schema additions on `AssemblySpecSchema`: `parameters?: { name, value, min, max, step?, unit: 'mm'|'deg'|'count', description }[]`, `derived?: { name, expr }[]`, `relations?: { expr, why }[]`; component `expr?: { localExtents?: (Expr|null)[]; position?: (Expr|null)[]; rotation?: (Expr|null)[]; innerD?: Expr; wall?: Expr; holes?: { d?: Expr; at?: (Expr|null)[]; depth?: Expr }[] }`.
  - Request schemas (`variantSpecRequestSchema`, `claudeVariantSpecSchema`) accept `number | string` in those numeric fields and expose `parameters`, `derived`, `relations`.

- [ ] **Step 1: Write the failing tests** in `spec-expr.test.ts`:
  - `evalExpr('2*wall + max(a, 3)', { wall: 2, a: 1 })` → `7`; `evalExpr('-(h)/2', { h: 10 })` → `-5`.
  - `evalExpr('foo + 1', {})` throws `ExprError` whose message contains `foo`; `evalExpr('x; system()', { x: 1 })` throws.
  - `resolveSpec` on a spec with `parameters: [{ name: 'w', value: 80, ... }]`, `derived: [{ name: 'half', expr: 'w/2' }]` and a component `localExtents: ['w', 'half', 6]` returns `localExtents [80, 40, 6]` and `expr.localExtents ['w', 'half', null]`, `errors []`.
  - `resolveSpec` with `position: ['missing', 0, 0]` returns `errors` containing `missing`.
  - `AssemblySpecSchema.parse` of a pre-change spec (no parameters, all numbers) still succeeds unchanged (regression).
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/spec-expr.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** a hand-written recursive-descent parser in `spec-expr.ts` (no `eval`, no `Function`); add the schema fields; call `resolveSpec` first inside `normalizeSpec` and append its errors to the coherence errors `architectNode` already feeds back (`auditSpecCoherence` path).
- [ ] **Step 4: Run** `npx vitest run src/lib/agent` → all pass, including the existing schema count test (update its expected optional-path list only for the new optional fields and say so in the test).
- [ ] **Step 5: Commit** `feat(agent): relational spec fields and expression evaluator`

### Task 2: Parametric blockout and expression placement

**Files:**
- Modify: `src/lib/spec-sheet/blockout-scad.ts`, `src/lib/design/compose-assembly.ts` (`instantiationFor`)
- Create: `src/lib/agent/parameter-block.ts`
- Test: `src/lib/spec-sheet/blockout-scad.test.ts`, `src/lib/design/compose-assembly.test.ts`

**Interfaces:**
- Consumes: `Expr`, `component.expr`, `spec.parameters`, `spec.derived` (Task 1).
- Produces:
  - `parameterBlock(spec: AssemblySpec): string` — `name = value; // [min:step:max] description` per parameter, then `name = expr;` per derived, in declaration order; empty string when there are none.
  - `blockoutScad(spec)` uses `component.expr` strings in place of literals wherever present (extents, innerD, wall, holes); output starts with `parameterBlock(spec)`.
  - `instantiationFor(spec, name, frames)` emits `translate([<expr or literal>…]) rotate([<expr or literal>…])`; literals keep their derivation comment.

- [ ] **Step 1: Write the failing tests:**
  - A spec with parameter `w = 80` and a box `localExtents ['w', 40, 6]`: `blockoutScad(spec).code` contains `w = 80; // [` and `cube([w, 40, 6])`.
  - A component with `expr.position ['w + 2', null, null]`: `instantiationFor` output contains `translate([w + 2, ` .
  - Compile test (existing harness style, `validateOpenScadCode`): the blockout of that spec compiles, and its bbox x grows by 16 when the code's `w = 80;` is replaced by `w = 96;`.
  - Regression: a literal-only spec produces byte-identical blockout output to before (snapshot the current output first).
- [ ] **Step 2: Run** the two test files → new tests FAIL.
- [ ] **Step 3: Implement**, keeping literal-only output unchanged.
- [ ] **Step 4: Run** `npx vitest run` → all pass.
- [ ] **Step 5: Commit** `feat(design): parametric blockout and expression placement`

### Task 3: Architect prompt asks for a relational spec

**Files:**
- Modify: `src/lib/agent/system-prompt.ts` (`SPEC_FIELDS`, `ARCHITECT_VARIANT_PREAMBLE`)
- Test: `src/lib/agent/system-prompt.test.ts`

**Interfaces:**
- Consumes: field names from Task 1.
- Produces: the variant preamble instructs: declare every user-adjustable size as a parameter with a range; write sizes and positions as expressions over parameter names; put derived values in `derived`; state relations the design must keep. The word budgets in `system-prompt.test.ts` may grow by at most 60 words for `variant`.

- [ ] **Step 1: Write the failing tests:** `ARCHITECT_VARIANT_PREAMBLE` contains `parameters[]`, `derived[]`, `relations[]` and `expression`; `SPEC_FIELDS` defines the expression grammar in one line; no new text matches the existing fabrication-terms guard.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the prompt text.
- [ ] **Step 4: Run** `npx vitest run src/lib/agent` → pass. Then measure on Haiku with the existing eval, no new code: `npm run eval:architect -- --model claude-haiku-5-5 --samples 3 --prompts eval/architect/prompts-round2.json --tag p0` and compare with `r2-a0` via `npm run eval:architect:rescore -- --results p0 --intent-only`. Record parse rate, truncation (`max_tokens` failures) and output-token cost in the commit message. P0 exit: parse and truncation no worse than `r2-a0`, cost ≤ +15%.
- [ ] **Step 5: Commit** `feat(agent): Architect writes a relational spec`

### Task 4: Liveness audits (literal lint and parameter sweep)

**Files:**
- Create: `src/lib/agent/param-sweep.ts`, `src/lib/agent/literal-lint.ts`
- Modify: `src/lib/agent/graph.ts` (`validateCode`: run both on every pipeline, as warnings, so the Drafter gets a baseline; add violations of kind `dead_parameter` / `sweep_failure` / `literal_param`)
- Test: `src/lib/agent/param-sweep.test.ts`, `src/lib/agent/literal-lint.test.ts`

**Interfaces:**
- Consumes: `parseParams(code)` from `src/lib/design/parse-params.ts` (the design panel's own parser, so the sweep sees exactly the sliders the user sees), `validateOpenScadCode`, `analyzeStl`.
- Produces:
  - `sweepParameters(code: string, opts: { factor?: number; budgetMs: number }): Promise<{ dead: string[]; failures: { name: string; reason: string }[]; skipped: string[] }>` — takes the numeric parameters from `parseParams(code)`, rewrites each `name = value;` line to value×(1±factor) clamped to its range when it has one; dead when bbox and volume are unchanged within 0.01; skipped when the budget runs out.
  - `literalLint(code: string)` — per module body of `code`, against the values from `parseParams(code)`: returns `{ component: string; literal: number; param: string }[]`; ignores 0, 1, 2, 90, 180, 360 and `$fn` assignments.
  - `SpecViolation.kind` gains `'dead_parameter' | 'sweep_failure' | 'literal_param'` (severity `warning` for P2).

- [ ] **Step 1: Write the failing tests:** a script whose module uses `w` → `dead: []`; one that declares `h` but hard-codes its value → `dead: ['h']`; a parameter whose +20% pushes a part below z = 0 → `failures[0].name` is that parameter and the call resolves (no throw); `budgetMs: 0` → every parameter in `skipped`. Lint: code `w = 40;\nlen = 80;\nmodule plate() { cube([80, w, 6]); }` → one hit `{ component: 'plate', literal: 80, param: 'len' }`; `rotate(90)` → no hit.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; in `validateCode`, run the sweep only when the base audits have no errors and at least 60 s of the run deadline remains.
- [ ] **Step 4: Run** `npx vitest run` → pass. Baseline: add `deadParams` to `eval/generation/metrics.ts` from the new violations and run `npm run eval:generation -- --model claude-haiku-5.5 --limit 3 --no-langfuse --tag p1-drafter` with `CADAI_PIPELINE` unset, to record today's dead-parameter rate.
- [ ] **Step 5: Commit** `feat(agent): parameter liveness audits`

### Task 5: Build-reply format

**Files:**
- Create: `src/lib/agent/build-format.ts`
- Test: `src/lib/agent/build-format.test.ts`

**Interfaces:**
- Consumes: `stripTopLevelGeometry` (`src/lib/design/compose-assembly.ts`), `blockoutScad` per-component output (Task 2; expose `blockoutModule(spec, name): string` from `blockout-scad.ts` in this task if not already separable).
- Produces:
  - `parseBuild(text: string, componentNames: string[]): { bodies: Record<string, string>; keepBlockout: string[]; addressed: string[]; dropped: string[] }` — a section without `@end` is dropped; names not in `componentNames` are dropped.
  - `sanitizeBody(body: string): string` — removes `module x() {` wrappers, top-level `translate`/`rotate`/`mirror` wrappers around the whole body, and `name = value;` lines.
  - `assembleScript(spec: AssemblySpec, parsed: ReturnType<typeof parseBuild>): string` — `parameterBlock(spec)` + one `module <name>() { … }` per component: the sanitized body, else the blockout module body.

- [ ] **Step 1: Write the failing tests:** two complete sections and one truncated → two bodies, `dropped: [third]`; `@body plate blockout` → `keepBlockout: ['plate']`; a body wrapped in `module plate() { ... }` and `translate([0,0,5]) {...}` comes back unwrapped; `w = 3;` inside a body is removed; `assembleScript` output has exactly one `module` per component and starts with the parameter block; `@addressed F2` is collected.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib/agent/build-format.test.ts` → pass.
- [ ] **Step 5: Commit** `feat(agent): @body build format with blockout fallback`

### Task 6: `architectBuild` node and build prompt

**Files:**
- Create: `src/lib/agent/nodes/architect-build.ts`
- Modify: `src/lib/agent/system-prompt.ts` (new `PromptNode` `'build'`: `CORE + SPEC_FIELDS + OPENSCAD_RULES + ARCHITECT_BUILD_PREAMBLE`), `src/lib/agent/stream-bridge.ts` (label `architectBuild: 'Mechanical Architect · Build'`)
- Test: `src/lib/agent/nodes/architect-build.test.ts`, `src/lib/agent/system-prompt.test.ts`

**Interfaces:**
- Consumes: `parseBuild`, `assembleScript` (Task 5), `requiredChanges` (`architect-prompts.ts`), `getChatModel`.
- Produces: `makeArchitectBuild(model: CadChatModel): (state: AgentStateType, config?: RunnableConfig) => Promise<Partial<AgentStateType>>` returning `{ currentCode, attemptCount, buildFallbacks }`, where `buildFallbacks: number` is a new state field (`Annotation<number>`, default 0) holding the count of components that fell back to their blockout (`parsed.dropped` plus components with no section). The user message holds: the chosen spec skeleton and sheet, the parameter and derived names, each component's blockout body, and — on a repeat visit — `requiredChanges(findings, notes)` built from `state.specViolations` errors and `state.gateFeedback`, asking for bodies of the named components only (others answered `@body <name> blockout` or carried over from the previous build).
- `ARCHITECT_BUILD_PREAMBLE` says: write module bodies only, local frame, min corner at the origin, parameter names instead of numbers, no `translate`/`rotate` of the whole part, no parameter assignments, no module headers; answer every `[HUMAN]` line with `@addressed`.

- [ ] **Step 1: Write the failing tests** (fake model returning fixed text, as `graph-revision.test.ts` does): first visit sends no `REQUIRED CHANGES`; a reply with one body and one truncated body yields `currentCode` containing the body and the blockout for the other; a repeat visit with an `extents` violation on `plate` sends `REQUIRED CHANGES` naming `plate` and carries the other component's previous body unchanged; the system prompt for `'build'` passes the fabrication-terms guard.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; max tokens and timeout come from the existing model config.
- [ ] **Step 4: Run** `npx vitest run src/lib/agent` → pass.
- [ ] **Step 5: Commit** `feat(agent): architectBuild node`

### Task 7: Pipeline flag and routing

**Files:**
- Modify: `src/lib/agent/graph.ts` (state field, node, routes)
- Test: `src/lib/agent/graph-pipeline.test.ts`

**Interfaces:**
- Consumes: `makeArchitectBuild` (Task 6).
- Produces: state `pipeline: Annotation<'drafter' | 'architect' | null>` (default null, set in `architectNode` when null). Routes when `pipeline === 'architect'`: `specGate` approve, `routeAfterArchitect` and `routeAfterReviewer` targets `drafterNode` → `architectBuild`; `architectBuild` → `validateCode`; `checkValidationRoute` `fixCode` → `architectBuild`; `checkAcceptRoute` `fixCode` → `architectBuild`. Drafter routes unchanged otherwise.

- [ ] **Step 1: Write the failing tests** with the fake-model harness: with `CADAI_PIPELINE=architect`, a run that approves at the spec gate calls no drafter tool and reaches `validateCode` with code from `architectBuild`; an audit error loops to `architectBuild`, not `fixCode`; a thread started with the flag unset, paused at the spec gate, then resumed after setting `CADAI_PIPELINE=architect`, still calls the Drafter.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the wiring; register `architectBuild` with `addNode` and add it to every conditional-edge map that can now reach it.
- [ ] **Step 4: Run** `npx vitest run` (full suite) and `npx next build` → pass.
- [ ] **Step 5: Commit** `feat(agent): CADAI_PIPELINE=architect routes builds to the Architect`

### Task 8: A/B on the generation eval

**Files:**
- Modify: `eval/generation/run.ts` (flag `--pipeline drafter|architect` setting `CADAI_PIPELINE`), `eval/generation/metrics.ts` (`deadParams`, `paramCount`, `blockoutFallbacks`, `buildMs`)
- Test: `eval/generation/metrics.test.ts`

**Interfaces:**
- Consumes: violation kinds from Task 4; `state.buildFallbacks` from Task 6.

- [ ] **Step 1: Write the failing test:** `metricsFromState` on a state with two `dead_parameter` violations and `parameters` of length 5 reports `deadParams 2`, `paramCount 5`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass.
- [ ] **Step 5: Run the A/B** (gateway, Haiku, original 10 prompts): `npm run eval:generation -- --model claude-haiku-5.5 --pipeline drafter --tag ab-drafter --no-langfuse` and the same with `--pipeline architect --tag ab-architect`; then `npm run eval:compare`. P2 exit, recorded in the commit message: build p95 < 240 s, ≥ 90% parameters live, audit-clean ≥ drafter, no more than 10% of components on blockout fallback.
- [ ] **Step 6: Commit** `test(eval): pipeline A/B metrics` with the numbers.
