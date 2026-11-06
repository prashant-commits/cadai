# B-rep Kernel P1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind `CADAI_KERNEL=brep`, compile any spec to a build123d script that runs in a sandbox and returns STEP, STL and per-part measurements, so that the viewer, the audits and a STEP download work on B-rep, with the OpenSCAD path untouched.

**Architecture:**
- A Python package `geo/` runs a build123d script and returns exports and measurements.
- `src/lib/engine/brep-runner.ts` calls it, either through a local venv (dev and evals) or the separate geometry service over HTTPS (production).
- `src/lib/brep/emit-script.ts` turns a normalized AssemblySpec into a build123d script: a parameter block, one function per component, placement, and a labelled Compound.
- An adapter maps measurements onto the shapes today's audits already consume.

**Tech Stack:** build123d 0.13 (pinned), Python 3.12, FastAPI + uvicorn (geometry service, Docker), pytest, TypeScript/Next 16, vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-brep-kernel-design.md`

## Global Constraints
- `build123d==0.13.0` pinned in `geo/requirements.txt`. Units are mm. z = 0 is the floor and nothing goes below it. No fillets or chamfers in generated geometry.
- Model-written Python never runs in the Next.js process. Production calls the geometry service, where each run is a fresh subprocess with time, memory and network limits. Dev and evals spawn `geo/.venv/bin/python -I`, or the interpreter named by `CADAI_GEO_PYTHON`.
- Work happens on branch `feat/brep`, cut from `main`.
- `CADAI_KERNEL` accepts `openscad` (default) or `brep`. With `openscad` every existing test and behaviour is unchanged.
- The emitted script stays parametric: every parameter is a top-level `name = value  # [min:step:max] description` line, and every size and position is an expression over them.
- A run returns within 60 s or fails with `timeout`.

## Review Focus
- A spec with a profile on each plane (xy, xz, yz) and a rotated component: per-part boxes must equal `localExtents`, and placement must match `placedBounds` (Task 3 tests).
- Parts in contact: they must fuse into one solid unless they are separate parts (jointContract partB, lid, drawer). The emitter keeps separate parts as separate solids in the Compound (Task 3 test).
- A script that raises: the error comes back as `{ok:false, error}` with the last traceback line, never a hung request or a 500 (Task 2 test).
- A huge or degenerate spec (40 components, zero-size extent): it times out or reports cleanly (Task 2 timeout test, Task 3 zero-size test).
- Old threads that carry OpenSCAD code: with `CADAI_KERNEL=brep` the viewer still renders them through the OpenSCAD path, selected by the code's language (Task 5 test).

---

### Task 1: Python geometry package `geo/`

**Files:**
- Create: `geo/requirements.txt`, `geo/cadai_geo/run.py`, `geo/cadai_geo/__main__.py`, `geo/cadai_geo/service.py` (FastAPI `POST /run` {script} -> the same JSON plus base64 `stl`/`step`; header `x-cadai-geo-token` must equal env `CADAI_GEO_TOKEN`; each request runs `python -I -m cadai_geo` in a temp dir with a 60 s timeout and a 2 GB RLIMIT_AS), `geo/Dockerfile`, `geo/tests/test_run.py`, `geo/tests/test_service.py`, `geo/README.md`

**Interfaces:**
- Produces: CLI `python -I -m cadai_geo <script.py> <outdir>`, which prints one JSON line to stdout: `{"ok": bool, "error"?: str, "parts": [{"label": str, "valid": bool, "volume": float, "min": [x,y,z], "max": [x,y,z]}], "solids": int, "bbox": {"min": [...], "max": [...]}, "stl": "<outdir>/model.stl", "step": "<outdir>/model.step"}`. The script must assign `result` (a Part or a Compound); child labels come from `part.label`.

- [ ] **Step 1: Write the failing tests:**
  - `test_runs_labelled_compound`: two labelled boxes, so `parts` has both labels with correct boxes, and `step` and `stl` exist;
  - `test_reports_error`: the script raises `TypeError`, so `ok` is false and `error` ends with `TypeError: ...`;
  - `test_no_result`: no `result` assigned, so the error says "assign result".
- [ ] **Step 2:** `cd geo && python -m pytest -q`, expected to FAIL.
- [ ] **Step 3:** Implement `run(script_path, outdir) -> dict` in `run.py`: `runpy.run_path`, take `result`, `export_step`, `export_stl`, and measure every `solids()` plus top-level labelled children. Have `__main__.py` print `json.dumps`.
- [ ] **Step 4:** pytest passes.
- [ ] **Step 5:** Commit `feat(geo): build123d runner with STEP/STL export and per-part measurements`.

### Task 2: `brep-runner.ts`, with local venv and HTTP service

**Files:**
- Create: `src/lib/engine/brep-runner.ts`, `src/lib/engine/brep-runner.test.ts`
- Modify: `package.json` (script `geo:setup` to create `geo/.venv` and install requirements)

**Interfaces:**
- Consumes: the Task 1 CLI.
- Produces: `runBrep(script: string, opts?: { timeoutMs?: number }): Promise<BrepResult>`, where `BrepResult = { ok: boolean; error?: string; parts: BrepPart[]; solids: number; bbox?: {min: Vec3; max: Vec3}; stl?: string /* ascii or base64 */; step?: string /* base64 */; ms: number }`. The backend is `http` when `CADAI_GEO_URL` is set (POST `/run` with `x-cadai-geo-token`), else `local`.

- [ ] **Step 1: Write the failing tests** (local backend, skipped when `geo/.venv` is missing):
  - `runs a two-part script and returns parts and STEP`;
  - `returns ok:false with the traceback tail`;
  - `kills a script that sleeps past timeoutMs`, expecting `error` = `timeout`.
- [ ] **Step 2:** Run vitest, expected to FAIL.
- [ ] **Step 3:** Implement. The local backend writes a temp dir, spawns `geo/.venv/bin/python -I -m cadai_geo` with a timeout, and reads the files back. The http backend POSTs the script and decodes the base64 outputs. Test it against the Task 1 service started on a random port.
- [ ] **Step 4:** Tests pass. Also record the run time of one script for each backend in the PR description.
- [ ] **Step 5:** Commit `feat(engine): runBrep - local venv and HTTP geometry service backends`.

### Task 3: Spec → build123d emitter

**Files:**
- Create: `src/lib/brep/emit-script.ts`, `src/lib/brep/blockout-b123d.ts`, `src/lib/brep/emit-script.test.ts`

**Interfaces:**
- Consumes: `normalizeSpec` output (AssemblySpec with `expr`), anchors, `contactSinks(spec)`, `matingCuts`.
- Produces:
  - `emitBrepScript(spec: AssemblySpec, bodies?: Record<string, string>): { script: string; skipped: {name: string; reason: string}[] }`. `bodies` maps a component name to a Python body that returns a Part in the local frame; when it's absent, `blockoutBody` is used.
  - `blockoutBody(comp: Component): string`, ported from `blockout-scad.ts`'s `shapeScad`: box, cylinder, tube, shell (openFace), profile (plane xy/xz/yz with holes), and component holes with cutters overshooting 0.02 mm.

- [ ] **Step 1: Write the failing tests** (they run `runBrep`, skipped without the venv):
  - `every primitive kind`: one spec per shape kind; each part's measured box equals `localExtents` ±0.1;
  - `placement and rotation match placedBounds`;
  - `anchors become variables and bumping a parameter moves the child`: emit, edit the parameter line, re-run, and the child's min moves;
  - `jointContract partB stays a separate solid, touching parts fuse`;
  - `zero-size extent is skipped with a reason, not a crash`.
- [ ] **Step 2:** Run, expected to FAIL.
- [ ] **Step 3:** Implement the emitter:
  - parameter block lines `name = value  # [min:step:max] description`;
  - derived values as assignments in order;
  - anchors as variables (reuse the a1 anchor resolution order);
  - `def <name>():` per component;
  - placement as `Pos(...) * Rot(...) * <name>()` with the contact-sink offsets;
  - fuse the parts that are not separate;
  - set `result = Compound([...])` with labels.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(brep): emit a parametric build123d script from the spec`.

### Task 4: Measurement adapter and B-rep verify-front

**Files:**
- Create: `src/lib/brep/measurements.ts`, `src/lib/brep/measurements.test.ts`
- Modify: `eval/architect/verify-front.ts` (add a `--kernel brep` compile branch)

**Interfaces:**
- Consumes: `BrepResult`.
- Produces: `toModuleFrames(r: BrepResult): ModuleFrame[]` and `toModelInfo(r: BrepResult): ModelInfo`. These are the exact types `spec-audit.ts`, `placement-audit.ts` and `hole-audit.ts` take today: `isManifold` = all parts valid, `shellCount` = solids, `dimensions` from the bbox.

- [ ] **Step 1: Write the failing tests:**
  - adapter unit tests on a fixed `BrepResult`;
  - `auditSpec(spec, toModelInfo(r))` yields no extents violations for a correct two-part run.
- [ ] **Step 2:** Run, expected to FAIL.
- [ ] **Step 3:** Implement. In verify-front, `--kernel brep --compile N` emits and runs N relational specs, then checks module-size, assembly-box and floor.
- [ ] **Step 4:** Tests pass, and `npx tsx eval/architect/verify-front.ts --kernel brep --compile 60` reports 0 failures. **This is the P1 exit criterion.**
- [ ] **Step 5:** Commit `feat(brep): measurement adapter; verify-front runs on B-rep`.

### Task 5: Kernel switch at the compile route, the viewer and STEP download

**Files:**
- Modify: `src/app/api/compile/route.ts`, `src/lib/engine/openscad-bridge.ts` (rename the export to `compileModel`, keeping `compileOpenScad` as an alias), `src/components/viewport/viewport-toolbar.tsx` (a "STEP" download button), `src/types/index.ts` (`CompileResult.step?: string`, `language: 'openscad' | 'build123d'`)
- Test: `src/app/api/compile/route.test.ts`

**Interfaces:**
- Consumes: `runBrep`, and `toModelInfo` from Task 4.
- Produces: `POST /api/compile` with body `{ code, language? }`. A request whose `language` is `'build123d'`, or whose code starts with a build123d import, goes to `runBrep`. Everything else goes to OpenSCAD, so old threads keep working.

- [ ] **Step 1: Write the failing tests:**
  - OpenSCAD code goes to `compileScad` as today;
  - build123d code goes to `runBrep` and the response includes `step`;
  - a build123d error returns 422 with the traceback tail.
- [ ] **Step 2:** Run, expected to FAIL.
- [ ] **Step 3:** Implement. The STEP button appears when `step` is present and downloads `<assemblyName>.step`.
- [ ] **Step 4:** Tests pass. Run `npx next build`.
- [ ] **Step 5:** Commit `feat: compile route and viewer serve build123d; STEP download`.

### Task 6: Cheat sheet with CI verification

**Files:**
- Create: `src/lib/brep/cheatsheet.md` (from the spike, with no aliases such as MIN3, and with the math imports), `geo/tests/test_cheatsheet.py` (executes every example block from the markdown)

**Interfaces:**
- Produces: `cheatsheet.md`, which P2's build prompt includes verbatim.

- [ ] **Step 1:** Write `test_cheatsheet_examples_run`, which extracts every fenced python block and `exec`s it in a fresh namespace. Add `test_cylinder_has_no_axis_kwarg`.
- [ ] **Step 2:** Run, expected to FAIL (no file yet).
- [ ] **Step 3:** Add the sheet.
- [ ] **Step 4:** pytest passes.
- [ ] **Step 5:** Commit `feat(brep): verified build123d cheat sheet`.

---

Next plans (written when P1 merges): P2 Builder (the Architect writes Python bodies; build-format Python sanitizer; param-sweep and literal-lint for Python; 20-build A/B), P3 Edits (direct code-edit path), P4 Cut-over.
