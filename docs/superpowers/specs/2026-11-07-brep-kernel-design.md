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
2. **Generated Python runs in a separate geometry service** (user decision 2026-11-07). `geo/` is a FastAPI app in a container with build123d preinstalled, deployed on its own host. Each request is two children forked from a zygote that imported build123d once at boot. The untrusted child runs the script and may only write BREP into a scratch directory. When the service is root that child's uid is killed before the trusted child runs, and the output directory is never writable by that uid. Without root the process logs `no isolation: local dev only` and only the process group is killed. A second child loads those files, measures them, and writes `result.json` and the exports into a service-chosen directory the script is not given. The helper is exec'd with an empty environment and never receives the token. The one-shot CLI still starts a fresh interpreter and measures in-process; it is the local tool, not this sandbox. The Next.js app calls the service over HTTPS with a shared-secret header (`CADAI_GEO_URL`). The token is read only from `CADAI_GEO_TOKEN_FILE`. If `CADAI_GEO_TOKEN` is set, the service refuses to start (an environment value stays visible in `/proc/<pid>/environ`). Local development and evals can use the same CLI through a venv. One interface, `runBrep(script)`, hides which is used. Model-written Python never runs in the Next.js process. What the code confines, and what only the container host can confine, is listed under "Geometry service sandbox".
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

## Geometry service sandbox

A model-written script is hostile. Some limits are enforced by `geo/` itself. Others only exist if the container host sets them. The temp directory and the scrubbed child environment are defense in depth, not a jail.

Code enforces:

- Two stages. The untrusted child runs the script and may only serialize `result` and each part (label + shape) as BREP into a scratch directory. A second child opens that directory with `O_NOFOLLOW`, reads each BREP through a file descriptor, checks it is a regular file under the size cap, measures it, and writes `<outdir>/result.json`, `model.step`, and `model.stl`. The outdir is a different directory, mode `0700`, and it is never owned by the run uid. Stdout and stderr are pipes capped at 4 KB in memory; the service does not open a path the script can write. A forged `result.json` or a copy of another file is not the measurement: foreign bytes fail to parse (`ok: false`, error `measure`), and a real BREP is remeasured. The capped stream is the error string only when no BREP was produced.
- STEP and STL are read only from `<outdir>/model.step` and `<outdir>/model.stl`, opened with `O_NOFOLLOW` and checked with `fstat` on that descriptor. Symlinks are not followed.
- The shared secret comes only from `CADAI_GEO_TOKEN_FILE` (mode `0400`, owned by the service user). If `CADAI_GEO_TOKEN` is set, the service refuses to start. Deleting the variable from `os.environ` does not remove it from `/proc/<pid>/environ`, so the environment is not a token source. The untrusted child's environment is `PATH`, `HOME` (the script home), `TMPDIR` when set, and a one-thread cap for OpenBLAS, OpenMP, MKL, NUMEXPR, and VECLIB so the process cap stays usable on a many-core host. The trusted child's `HOME` is the outdir. The token is not in either environment.
- At boot the service execs a zygote with an empty environment. The zygote imports build123d once, stays single-threaded, and is never given the token or the token-file path. It accepts up to `CADAI_GEO_CONCURRENCY` runs at once (default 4). Each run forks a supervisor (new session) which forks the two stages (rlimits, stdout and stderr on pipes). The service kills the supervisor's process group on timeout and starts a new zygote if the helper dies. `python -I -m cadai_geo` does not use the zygote.
- When the service is root, the untrusted stage calls `setgroups([])`, `setgid`, and `setuid` to one uid from the pool `CADAI_GEO_UID_BASE`..`+CADAI_GEO_CONCURRENCY-1` (image users `cadairun0`..`cadairun3`, default base 10100). After that stage, including on error or timeout, every process of that uid is killed before the trusted stage and before the uid is reused. The trusted stage runs as `geotrust` when that user exists. The script then cannot read the service uid's `/proc/<pid>/environ` or the token file, and a `setsid` survivor cannot write the outdir. Startup as root fails if `CAP_SETUID`, `CAP_SETGID`, `CAP_KILL`, `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, or `CAP_FOWNER` is missing, or if a pool uid does not exist. Local pytest is not root, so it does not drop and it logs `no isolation: local dev only`; the uid-split tests are skipped unless they are run as root in the image. The image checks are listed in `geo/README.md` under "Before hosting".
- On timeout the service sends `SIGKILL` to the supervisor's process group, not only the direct pid, and when root also reaps the run uid.
- `RLIMIT_AS` (default 2 GB, `CADAI_GEO_RLIMIT_AS`), `RLIMIT_CPU` (timeout + 5 s), `RLIMIT_FSIZE` (256 MB), `RLIMIT_NPROC` (64 for the run uid; outside the container, a small headroom above this uid's existing threads), and `RLIMIT_CORE` 0. The untrusted child is also marked non-dumpable.
- Each export must be at most 64 MB (`CADAI_GEO_MAX_EXPORT_BYTES`) or the run returns `output too large`.
- `timeout_s` is clamped to 1..120 seconds. A script over 256 KB is rejected with HTTP 413. Traceback text has `/tmp` paths, `model.py`, and the `TMPDIR` prefix removed.
- `GET /healthz` needs no token and returns `{"ok": true}`.

The host must enforce (this process cannot):

- **Egress.** The script shares the service network namespace. Block outbound traffic from the container except what the service needs to accept inbound calls on `PORT`. `--network none` also blocks those calls, so it is not the right control by itself.
- **Cgroup cpu, memory, and pids** (`--cpus`, `--memory`, `--pids-limit`). `RLIMIT_NPROC` is not a pids cgroup, and `RLIMIT_AS` counts virtual address space.
- **Read-only root filesystem** and a tmpfs for `/tmp` (`--read-only --tmpfs /tmp`). The per-request directory is only a working directory.
- **Capability bounding:** `--cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER`. The image is root so it can drop to a per-run uid and to `geotrust`, kill that uid, and chown or remove the work trees. `SETUID` and `SETGID` alone cannot do those steps.
- **`hidepid` on `/proc`**, as defense in depth behind the uid split.

```
docker run --rm \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --read-only --tmpfs /tmp \
  --pids-limit 128 --memory 3g --cpus 1 \
  -v /path/geo-token:/run/secrets/geo-token:ro \
  -e CADAI_GEO_TOKEN_FILE=/run/secrets/geo-token \
  -e PORT=8000 -p 8000:8000 \
  cadai-geo
```

The token file is mode `0400` and owned by root. Do not pass the token in the environment.

## Open questions for the user

1. Decided: a separate Python service. Still open: the host (Fly.io, Cloud Run, Render, AWS), chosen at deploy time; the container is host-agnostic.
2. Decided: the work is on branch `feat/brep`. OpenSCAD's fate is decided at cut-over.
3. Slider round-trip latency: B-rep runs take about 1–3 s against about 1 s today. Acceptable?
