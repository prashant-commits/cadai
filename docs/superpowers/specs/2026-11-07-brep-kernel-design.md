# B-rep kernel (build123d) with STEP export: design

Status: draft for review, 2026-11-07. Requirement from the user: real STEP export, which means moving geometry generation from OpenSCAD (meshes only) to a B-rep kernel.

## Evidence this design rests on

Spike on 2026-11-07, Haiku 5.5, scored by code. Notes are in memory under brep-vs-openscad-spike-2026-11-07.

**Generation**, 10 prompts × 3 samples:

| Kernel | Correct |
|---|---|
| OpenSCAD | 29/30 |
| build123d, no help | 25/30 (invented API calls) |
| build123d with a verified 400-word cheat sheet and 1 traceback retry | 27/30 (0 API errors; the remaining failures are sizes) |

**Edits** (phone front lip):

| Path | Correct |
|---|---|
| Direct code edit, OpenSCAD | 7/8 |
| Direct code edit, build123d | 6/8 |
| Today's JSON-spec revision path | 0/5 |

So build123d is viable for Haiku with a cheat sheet and a retry, and edits should be direct code edits.

## Decisions

1. **The agent stays in TypeScript.** LangGraph, the graph, the spec, the gates, streaming, storage and UI are all reused. Only the geometry layer changes language.
2. **Generated Python runs in a separate geometry service** (user decision 2026-11-07). `geo/` is a FastAPI app in a container with build123d preinstalled, deployed on its own host. Each request runs the script in a fresh subprocess with a CPU/memory/time limit, no network, and a throwaway working directory. The Next.js app calls it over HTTPS with a shared-secret header (`CADAI_GEO_URL`, `CADAI_GEO_TOKEN`). Local development and evals can use the same CLI through a venv. One interface, `runBrep(script)`, hides which is used. Model-written Python never runs in the Next.js process.
3. **The work happens on the branch `feat/brep`**, cut from `main` (user decision 2026-11-07). `main` and production stay on OpenSCAD until cut-over. On the branch, `CADAI_KERNEL=openscad|brep` remains so the A/B evals can run both kernels from one checkout.
4. **The spec stays the source of truth for generation.** Code emits the build123d script from the spec, just as it emits OpenSCAD today:
   - parameters become a Python variable block;
   - each component becomes a function returning a Part in its local frame;
   - placement uses `Pos`/`Rot` from the same expressions;
   - anchors become variables.

   The Architect Builder writes only component bodies (`@body` sections, in Python now). An unwritten body falls back to the code-drawn blockout.
5. **Follow-up edits become direct code edits** in phase 3. The model gets the current build123d script and returns a minimal edit. Code re-runs it, audits it, and checks that unchanged parts stayed unchanged.
6. **The cheat sheet is part of the product.** `src/lib/brep/cheatsheet.md` goes into the build and edit prompts. A CI test executes every example in it against the pinned build123d version.
7. **Output.** Every run returns STEP, an STL for the viewer, and measurements: per-part box, validity, solid count, volume. STEP and STL/3MF are downloadable.

## Reuse map

| Area | Reuse | Notes |
|---|---|---|
| Agent graph, routing, gates, checkpointing, run limits, streaming, transcript, follow-up detection | **As is** | The build/validate nodes swap their callee by flag |
| Planner, spec writer, spec schemas, `resolveSpec`/`normalizeSpec`, anchors, dead-parameter lint, coherence, shape and ground audits, spec variants | **As is** | Kernel-independent |
| Concept sheet (`spec-sheet/geometry.ts`, `sheet-svg.ts`, rasterize), sheet reviewer | **As is** | Drawn from the spec, not from OpenSCAD |
| UI: chat, gates, design panel and sliders, viewer (STL), annotator, storage, model picker | **As is** | Sliders already round-trip through the server (`/api/compile`) |
| Spec audits (`spec-audit`, `placement-audit`, `hole-audit`, interference) | **Adapt inputs** | They consume per-module frames and model info; the B-rep runner returns the same shapes (adapter) |
| `build-format.ts` (`@body` parsing, sanitizing, assembling) | **Adapt** | Section format kept; the sanitizer gets Python rules |
| `parameter-block`, `literal-lint`, `param-sweep`, `write-params`/`parse-params` | **Adapt** | Python syntax (`name = 1.0  # [min:step:max] doc`) |
| `compose-assembly`, `contact-sink`, `mating-cuts`, `gussets` | **Port** | Same logic emitting Python; the contact sink stays (tangent contacts are fragile in B-rep too) |
| `blockout-scad.ts` | **Port** to `blockout-b123d.ts` | box, cylinder, tube, shell, profile, holes |
| Build and repair prompts | **Rewrite the OpenSCAD-specific parts** | Plus the cheat sheet |
| `engine/scad-compiler`, `module-frames`, `openscad-bridge`, editor language | **Replace behind the flag** | New `brep-runner.ts`, Python language mode |
| Evals: `verify-front`, edit eval, generation eval | **Reuse** | Add a kernel flag |
| **New** | Python `geo/` package (runner, measurement, export), sandbox image, STEP download, cheat sheet and its CI | |

Rough share: about 60% as is, 25% adapted or ported, 15% new.

## Phases and exit criteria

- **P1 Foundation** (about 1 week):
  - geometry runner (local and sandbox);
  - spec → build123d emitter;
  - measurement adapter;
  - `/api/compile` kernel switch;
  - STEP download.

  **Exit:** every saved clean spec emits a script that runs, and each part's box equals its `localExtents` within 0.1 mm (verify-front on B-rep).
- **P2 Builder** (about 1 week):
  - the Architect Builder writes build123d bodies, with the cheat sheet and a traceback retry;
  - audits wired;
  - param-sweep and literal-lint in Python.

  **Exit:** 20-build A/B on Haiku: B-rep audit-clean ≥ OpenSCAD path, live parameters ≥ 90%, p95 build < 240 s.
- **P3 Edits** (about 4–5 days): direct code-edit path for follow-ups, with a check that unchanged parts stayed unchanged.

  **Exit:** edit eval phone_lip ≥ 6/8 and the other three cases still pass.
- **P4 Cut-over** (about 3 days):
  - production flag on;
  - OpenSCAD kept as a fallback for one release, then removed.

Total is about 3–4 weeks, matching the earlier estimate. P1 alone already delivers STEP for code-drawn blockouts.

## Open questions for the user

1. Decided: a separate Python service. Still open: the host (Fly.io, Cloud Run, Render, AWS), chosen at deploy time; the container is host-agnostic.
2. Decided: the work is on branch `feat/brep`. OpenSCAD's fate is decided at cut-over.
3. Slider round-trip latency: B-rep runs take about 1–3 s against about 1 s today. Acceptable?
