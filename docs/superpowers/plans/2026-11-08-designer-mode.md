# Designer mode (direct designer + live reviewer)

**Decision (user, 2026-11-08):** a blind test of 6 requests compared three ways of building: the current plan-then-build pipeline, a "direct designer" (one model, no plan or spec, writes build123d, looks at renders, revises), and the designer with an independent live reviewer. The user ranked the designer + reviewer best.
- The harness that was tested is `eval/designer/run.ts` in worktree `/home/claude/work/wt-dd1` (commit 91a689f).
- Its results are in `wt-dd1/eval/designer/out/`.

**Goal:** a new build mode `CADAI_PIPELINE=designer` in the app.

```
request ──▶ designerNode ──▶ designerCheck ──▶ acceptGate ──▶ respondToUser
               │  (one agent loop: run_script, render, finish;            │
               │   reviewer after each render and at finish)              │
               ▲                                                          │
follow-up ─────┴──────────────── (edit: prior script + edit request) ◀────┘
```

There are no architect, spec, sheet or spec-gate nodes in this mode. The other pipelines (architect/oneshot/agent) stay unchanged.

## Contract
`src/lib/agent/designer/types.ts` defines `RunDesignerFn`, `ReviewFn`, `DesignerFacts`, `DesignerEvent`, `DesignerResult`. Every lane builds against it. Do not change it in a lane; if you need a change, say so in your reply and work around it with a local adapter.

## Product rules for this mode
- **Named dimensions:** the key sizes are top-level variables (`name = value  # description`), and geometry is derived from them; nothing is placed with hard-coded numbers.
- **No slider ranges on dimensions for now:** ranges are parked and will come back later as a separate step.
- **Moving parts:** each moving part keeps one pose parameter (`*_deg` or `*_travel`) WITH a range `# [min:step:max]`. Its default is the closed position (the range min). This is needed to test motion.
- **No floor or z = 0 rule** of any kind. Parts may be sub-components of something else. Stability matters only when the request implies the object stands on a surface; that is the designer's judgement.
- **Hard checks:**
  - the script compiles and every part is a valid solid;
  - no disconnected parts;
  - no closed-pose interference;
  - a moving part actually moves, with no interference at its open value.
- **Rounded edges are allowed and encouraged** (B-rep kernel).
- **UI text:** fixed or rendered phrases only. Never raw model text, code, tool JSON or tracebacks in stream events (see the R2 contract tests in `graph-no-raw-output.test.ts`).
- **Security:**
  - `checkPythonScript` runs before every `runBrep` of model-written code;
  - keep the 256 KiB script cap;
  - keep task/ab2's runtime hardening.

## Lanes (parallel, separate files)
| Lane | Agent | Branch / worktree | Owns |
|---|---|---|---|
| core | Claude Code Sonnet | task/dz-core, `wt-dz-core` | `designer/run-designer.ts`, `designer/prompt.ts`, `designer/tools.ts` (+ tests) |
| reviewer | Grok | task/dz-rev, `wt-dz-rev` | `designer/reviewer.ts` (+ tests) |
| graph | agy Gemini | task/dz-graph, `wt-dz-graph` | `designer/node.ts`, `designer/check.ts`, routing and state in `graph.ts`, follow-up routing, respondToUser for this mode (+ tests) |

The orchestrator merges the three into task/dz, then runs the gate and a live smoke.

## Gate per lane (run the full gate ONCE, at the end)
- `npx tsc --noEmit`
- `npx vitest run --exclude '**/.cadai/**' --maxWorkers=2`
- eslint on changed files
- No live model calls in tests.

The machine has 7.6 GB RAM and 2 CPUs: never run two vitest processes at once. Nothing in /tmp: TMPDIR and scratch go under `<worktree>/.cadai/tasks/tmp/`.
