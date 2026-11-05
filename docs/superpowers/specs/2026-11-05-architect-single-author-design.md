# Architect as single author (Drafter removal): design

Status: decided by the user on 2026-11-04 (single author) and designed by a herdr council on 2026-11-05. Of three seats, only Claude Opus produced a design (Grok returned no answer, Gemini timed out); the one reviewer ranked it first. Council run: `~/.config/herdr/plugins/config/prashant-commits.herdr-council/runs/20261105-125010-*`.

## Intent

The Drafter copies spec sizes as literals, so most design-panel parameters are dead (13 of 17 in the Haiku baselines). The Architect already writes specs that compile cleanly as blockouts (95-100% audit-clean), and a spike where it wrote a relational spec plus the bodies made parameters live (43 of 44). The product's purpose is parametric design, so one author should own the parameters, the spec and the bodies, and code should own everything that can be computed.

## Decisions

1. **Parameters are live before the gate.** The spec becomes relational: top-level `parameters` (name, value, min, max, step, unit, description), `derived` (name, expr) and `relations` (expr, why). Numeric fields on components (localExtents, position, rotation, hole d/at/depth, tube innerD, shell wall) may hold an expression string over parameter names. Code evaluates every expression (for the sheet, coherence and audits) and emits the same expression into OpenSCAD. The gate render is therefore already parametric.
2. **Bodies are written after the gate, for the chosen variant only,** by a new `architectBuild` node: the same Architect role, a second call. Bodies before the gate would be wasted on unpicked variants and would worsen Haiku truncation. The resume after the gate is a fresh 300 s request.
3. **Body format is delimited text, not JSON:** `@body <component>` ... `@end`, or `@body <component> blockout` to keep the code-generated body, plus `@addressed <finding id>` lines. Bodies are module bodies only, in the component's local frame, using parameter names.
4. **Code owns** the parameter block (with Customizer annotations `name = value; // [min:step:max]`), derived assignments, module headers and placement (`translate`/`rotate` from the spec's expressions). The Architect never writes them; the parser strips them if it does.
5. **Every component has a guaranteed floor:** a missing, truncated or still-failing body falls back to that component's blockout, which is known to compile with zero audit errors.
6. **One findings channel:** audit errors, reviewer findings and human comments are findings; human ones are mandatory and must be answered with `@addressed`. Repairs patch only the components findings name. A build replaces the best build only when it scores strictly better (compiles > audit errors > dead parameters > warnings).
7. **Liveness is measured:** a literal lint (a body number equal to a parameter's value) and a ±20% parameter sweep (dead parameter = bbox and volume unchanged; failure = compile, manifold, floor or interference breaks).
8. **Migration is flagged and per-thread:** `CADAI_PIPELINE=drafter|architect`, written into graph state on a thread's first turn. One graph factory with conditional edges; no fork of `graph.ts`. The Drafter is deleted only after the A/B passes.

## Non-goals and anti-goals

- No bodies for unpicked variants; no spec and bodies in one call.
- No OpenSCAD inside a strict JSON schema; strict mode stays off for Claude.
- No whole-script regeneration on repair; no build that ends with nothing valid.
- The vision reviewer judges likeness only, once, and never dimensions.
- The sweep never runs on every repair round or pushes a request past about 240 s.

## Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| P0 | Relational spec + parametric blockout and placement | Spec parse and truncation rates no worse; blockout audit-clean at defaults and at ±20%; output tokens ≤ +15% |
| P1 | Liveness audits | Baseline dead-parameter rate on today's pipeline; sweep p95 time |
| P2 | `architectBuild` behind the flag | Build request p95 < 240 s; ≥ 90% parameters live; audit-clean ≥ Drafter; judge quality within noise |
| P3 | Unified findings, `@addressed`, best build, model reviewer | Mandatory findings 100% addressed; builds never regress |
| P4 | Flip default, delete Drafter and Repair after ~2 weeks clean | No live regression |
