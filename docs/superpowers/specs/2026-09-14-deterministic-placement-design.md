# Deterministic Placement and Generation Eval — Design

**Date:** 2026-09-14
**Status:** agreed in conversation; implemented by `docs/superpowers/plans/2026-09-14-deterministic-placement-generation-eval.md`

## Problem

Generated assemblies have parts floating in mid-air or hanging below the ground plane. Measured over the 5 checkpointed runs in `.cadai/checkpoints.json` that produced code:

| Finding | Count |
|---|---|
| Runs where the deterministic placer (`composeAssembly`) actually fired | 0 / 5 |
| Multi-part specs with no `position` fields (Architect wrote "print_layout" in assumptions instead) | 3 / 4 |
| Runs with positions where the Drafter still wrote its own top-level assembly (`model_wrote_assembly`, silently discarded) | 1 / 1 |
| Runs whose compiled model has min z < 0 (a part hangs below the floor) | 4 / 5 |
| Modules honouring the "origin at min corner" contract | 3 / 14 |
| Interference probes that unioned with the model's own top-level geometry (phantom 314,523 mm³ vs 91,302 mm³ real) | 1 / 1 |

Root cause: placement is still written by the LLM in every real run, and nothing measures "resting on the floor" or "touching a neighbour". The viewer lifts the whole mesh by `-bbox.min.z`, which hides a part hanging below the floor and makes every other part appear to float.

## Decisions

1. **Positions are always the assembled pose.** The Architect gives every component a `position` (request schema marks it required; validation tolerates omission and defaults to `[0,0,0]`). The "print layout" option is removed from the prompts.
2. **Placement is enforced, never declined.** If the Drafter writes top-level geometry, the composer strips it and places from the spec. `model_wrote_assembly` no longer exists as a skip reason.
3. **The local frame is measured and auto-corrected.** Each component module is compiled alone once; its bounding-box minimum becomes a `translate(-min)` correction inside the placement call. The LLM no longer has to get the origin right.
4. **One pose rule for the Drafter.** Assembly pose, z = 0 is the floor, origin at the min corner. The "single part in print pose" rule is deleted; `bedFace` stays in the spec for the later slicer node only.
5. **Floor and contact are measured.** `floor`: nothing is ever below the build plate (z = 0). A component whose placed bounds go below z = 0 is an error naming that part and the depth; without a placement report the whole-model min z is checked instead, and a model hovering above z = 0 is also a `floor` error. `floating`: a support graph over per-part assembly-pose bounding boxes; any part not reachable from the floor is a violation with its gap. `extents`: each module's measured size must match the spec's `localExtents`. The rule "nothing below the plate" is also stated verbatim in the Architect and Drafter prompts.
6. **Parametric intent is preserved in comments.** Placement literals are emitted as named scalar parameters (`<name>_pos_<axis> = 6.4;`) with the Architect's `positionNote` as the comment, so a later parametric swap is a one-token edit.
7. **Spec gets structure, not prose.** `localExtents [x,y,z]` (required in the request) replaces the ambiguous optional `dimensions` object on components; `form` and `useModules` are optional hints; component names are normalised to snake_case after parsing.
8. **Repair loop and visual critic are parked.** `CADAI_MAX_ATTEMPTS` defaults to 1 and `CADAI_VISUAL_CRITIC` to off. Human-requested revision at the accept gate still works. Both are re-enabled by env.
9. **Interference probe is fixed.** It runs on module-only code (all top-level geometry stripped) with the same frame correction as the placement.
10. **The engineering registry gains orientation idioms**, each test-guarded to compile, be manifold, and have its min corner at the origin. Keyed lookup stays; no vector retrieval below ~50 entries.
11. **Measure before and after.** An eval harness (`eval/generation`) runs 10 multi-part prompts through the graph with gates auto-approved and no repair, reports composed / floor / floating / local-frame / extents rates, and records each run as a Langfuse experiment with those rates as scores. It runs once before the generation changes (baseline) and once after.

## Out of scope (parked)

- Improving the repair prompts or repair budget logic.
- The visual critic.
- Print orientation, per-part print layout, slicer analysis, overhang/support checks (future `printPrep` node).
- Exact pairwise contact via `intersection()` compiles; AABB contact is accepted for now (it can miss contact between L-shaped parts whose boxes overlap, but never misses a real gap).
