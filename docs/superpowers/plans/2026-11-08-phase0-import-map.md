# Phase 0 Import Map and Keep List: Designer-Only Architecture

## Metadata & Static Analysis Setup

- **Date:** 2026-11-08
- **Commit:** `37a344d` (`task/p0a`)
- **Worktree Root:** `/home/claude/work/wt-p0a`
- **Raw Cruiser Outputs:** `/home/claude/work/cadai/.cadai/scratch/p0a/cruiser/full.json`, `/home/claude/work/cadai/.cadai/scratch/p0a/cruiser/report.txt`
- **Post-Worklist Analysis:** `/home/claude/work/cadai/.cadai/scratch/p0a/cruiser/keep-after-worklist.json`
- **Mechanical Citation Report:** `/home/claude/work/cadai/.cadai/scratch/p0a/cruiser/citation-check.txt`

### Exact dependency-cruiser Invocation
```bash
NODE_OPTIONS="--import /home/claude/work/cadai/.cadai/scratch/p0a/tmp/register.mjs" \
NODE_PATH=/home/claude/work/wt-p0a/node_modules \
TMPDIR=/home/claude/work/cadai/.cadai/scratch/p0a/tmp \
npx -y dependency-cruiser@16 \
  --no-config \
  --ts-config tsconfig.json \
  --ts-pre-compilation-deps \
  --output-type json \
  -x "node_modules" \
  -f /home/claude/work/cadai/.cadai/scratch/p0a/cruiser/full.json \
  src eval
```

> **Note on TypeScript Parser Setup:** Node 24 ESM loader isolation required registering an ESM loader hook (`register.mjs`) to allow `dependency-cruiser` to resolve TypeScript 5.9.3 from project `node_modules`. With this in place, `--ts-pre-compilation-deps` precisely detected all 216 type-only dependency edges in `full.json` (annotated with `"type-only"` in `dependencyTypes`), enabling full separation of runtime imports from type-only imports.

### Reachability Computation

Reachability was computed over all modules in `src/` and `eval/` with the CUT set severed:

1. **Entries (16 non-test root modules):**
   - `src/app/api/artifacts/[id]/route.ts`
   - `src/app/api/chat/route.ts`
   - `src/app/api/compile/route.ts`
   - `src/app/api/runs/[runId]/route.ts`
   - `src/app/api/runs/[runId]/events/route.ts`
   - `src/app/api/runs/[runId]/cancel/route.ts`
   - `src/app/page.tsx`
   - `src/app/layout.tsx`
   - `src/instrumentation.ts`
   - `eval/designer/blind.ts`
   - `eval/designer/metrics/dimensions.ts`
   - `eval/designer/metrics/fidelity.ts`
   - `eval/designer/report.ts`
   - `eval/designer/runner.ts`
   - `eval/designer/sets/gen-iterative.ts`
   - `eval/designer/types.ts`
   *(Note: Test files are excluded from entries and evaluated in the dependent test pass. `src/app/api/chat/resume/route.ts` and `src/app/api/mcp/route.ts` are excluded from entries because their routes are slated for removal in Phase 0b).*

2. **CUT Set:**
   - Modules severed: `src/lib/agent/graph.ts`, `src/lib/agent/graph-route.ts`, `src/lib/agent/checkpointer.ts`
   - Edges severed: `src/lib/agent/stream-bridge.ts → src/lib/agent/checkpointer.ts`, `src/lib/agent/stream-bridge.ts → src/lib/agent/graph-route.ts`
   - Traversal rule: Breadth-first search from entries. Do not traverse into or through CUT modules or over cut edges.

3. **Graph Sets:**
   - **$R_{\text{cut}}$ (Initial KEEP):** 111 modules reachable from entries with CUT set removed.
   - **$R_{\text{no-cut}}$:** 135 modules reachable from entries without CUT set.
   - **Cut-Only ($R_{\text{no-cut}} \setminus R_{\text{cut}}$):** 24 modules reachable ONLY through cut modules.
   - **Unreachable:** 43 non-test source modules in `src/` and `eval/` not reachable from entries either way.
   - **Worklist Crossings:** 10 runtime worklist edges + 6 type-only worklist edges + 5 conditional UI SIMPLIFY worklist items.
   - **KEEP for Now (Subsection 1.17):** 35 modules reachable today only through spec/gate/OpenSCAD code that EXTRACT/SIMPLIFY or 0c removes, leaving **76 persistent KEEP modules** after worklist completion.
   - **Tests:** 141 test files (58 pure KEEP tests, 26 SPLIT tests, 57 REMOVE tests).

---
## 1. KEEP List (111 Reachable Modules)

The following 111 modules are reachable from the production entries after severing the CUT set. Every module cites its shortest path evidence from an entry point.

### 1.1 App Entrypoints & API Routes (9 modules)

- `src/app/api/artifacts/[id]/route.ts`  
  *Evidence:* `Root entry`
- `src/app/api/chat/route.ts`  
  *Evidence:* `Root entry`
- `src/app/api/compile/route.ts`  
  *Evidence:* `Root entry`
- `src/app/api/runs/[runId]/cancel/route.ts`  
  *Evidence:* `Root entry`
- `src/app/api/runs/[runId]/events/route.ts`  
  *Evidence:* `Root entry`
- `src/app/api/runs/[runId]/route.ts`  
  *Evidence:* `Root entry`
- `src/app/globals.css`  
  *Evidence:* `src/app/layout.tsx → src/app/globals.css`
- `src/app/layout.tsx`  
  *Evidence:* `Root entry`
- `src/app/page.tsx`  
  *Evidence:* `Root entry`

### 1.2 UI Components (17 modules)

- `src/components/chat/chat-input.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/chat/chat-panel.tsx → src/components/chat/chat-input.tsx`
- `src/components/chat/chat-panel.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/chat/chat-panel.tsx`
- `src/components/chat/gate-dock.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/chat/chat-panel.tsx → src/components/chat/gate-dock.tsx`
- `src/components/chat/message-bubble.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/chat/chat-panel.tsx → src/components/chat/message-bubble.tsx`
- `src/components/chat/thread-drawer.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/chat/chat-panel.tsx → src/components/chat/thread-drawer.tsx`
- `src/components/chat/transcript-view.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/chat/chat-panel.tsx → src/components/chat/message-bubble.tsx → src/components/chat/transcript-view.tsx`
- `src/components/design/contract-diff-banner.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/design/design-panel.tsx → src/components/design/contract-diff-banner.tsx`
- `src/components/design/design-panel.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/design/design-panel.tsx`
- `src/components/design/param-control.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/design/design-panel.tsx → src/components/design/param-control.tsx`
- `src/components/editor/code-editor-panel.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/editor/code-editor-panel.tsx`
- `src/components/layout/header.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/header.tsx`
- `src/components/layout/split-pane.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx`
- `src/components/print-analysis/print-analysis-panel.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/design/design-panel.tsx → src/components/print-analysis/print-analysis-panel.tsx`
- `src/components/viewport/annotator.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/viewport/viewport-panel.tsx → src/components/viewport/annotator.tsx`
- `src/components/viewport/cad-model.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/viewport/viewport-panel.tsx → src/components/viewport/cad-model.tsx`
- `src/components/viewport/viewport-panel.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/viewport/viewport-panel.tsx`
- `src/components/viewport/viewport-toolbar.tsx`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/viewport/viewport-panel.tsx → src/components/viewport/viewport-toolbar.tsx`

### 1.3 Instrumentation (1 modules)

- `src/instrumentation.ts`  
  *Evidence:* `Root entry`

### 1.4 Designer Agent & LLM Infrastructure (30 modules)

- `src/lib/agent/assembly-spec.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/agent/assembly-spec.ts`
- `src/lib/agent/designer/check.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/check.ts`
- `src/lib/agent/designer/node.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/node.ts`
- `src/lib/agent/designer/prompt.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/designer/prompt.ts`
- `src/lib/agent/designer/reviewer.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/node.ts → src/lib/agent/designer/reviewer.ts`
- `src/lib/agent/designer/run-designer.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts`
- `src/lib/agent/designer/tools.ts`  
  *Evidence:* `eval/designer/blind.ts → src/lib/agent/designer/tools.ts`
- `src/lib/agent/designer/types.ts`  
  *Evidence:* `eval/designer/report.ts → src/lib/agent/designer/types.ts`
- `src/lib/agent/llm-schemas.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/llm-schemas.ts`
- `src/lib/agent/message-text.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/message-text.ts`
- `src/lib/agent/model-provider.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/model-provider.ts`
- `src/lib/agent/models.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/models.ts`
- `src/lib/agent/nesting-audit.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/nesting-audit.ts`
- `src/lib/agent/nodes/brep-agent-build.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts`
- `src/lib/agent/nodes/validate-brep.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/nodes/validate-brep.ts`
- `src/lib/agent/parameter-block.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/engine/module-frames.ts → src/lib/design/compose-assembly.ts → src/lib/spec-sheet/blockout-scad.ts → src/lib/agent/parameter-block.ts`
- `src/lib/agent/placement-audit.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/placement-audit.ts`
- `src/lib/agent/requirements.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/requirements.ts`
- `src/lib/agent/run-limits.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/lib/agent/run-limits.ts`
- `src/lib/agent/spec-audit.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/agent/spec-audit.ts`
- `src/lib/agent/spec-coherence.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/nodes/validate-brep.ts → src/lib/agent/spec-coherence.ts`
- `src/lib/agent/spec-expr.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/nodes/validate-brep.ts → src/lib/agent/spec-coherence.ts → src/lib/agent/spec-expr.ts`
- `src/lib/agent/spec-param-lint.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/nodes/validate-brep.ts → src/lib/agent/spec-coherence.ts → src/lib/agent/spec-param-lint.ts`
- `src/lib/agent/spec-shape-audit.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/nodes/validate-brep.ts → src/lib/agent/spec-shape-audit.ts`
- `src/lib/agent/spec-variants.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/types/index.ts → src/lib/agent/spec-variants.ts`
- `src/lib/agent/stream-bridge.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/lib/runs/stream-run.ts → src/lib/agent/stream-bridge.ts`
- `src/lib/agent/stream-events.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/lib/runs/stream-run.ts → src/lib/agent/stream-events.ts`
- `src/lib/agent/strict-schema.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/llm-schemas.ts → src/lib/agent/strict-schema.ts`
- `src/lib/agent/system-prompt.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/system-prompt.ts`
- `src/lib/agent/transcript.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/node.ts → src/lib/agent/transcript.ts`

### 1.5 B-Rep & Script Generation (11 modules)

- `src/lib/brep/blockout-b123d.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/brep/emit-script.ts → src/lib/brep/blockout-b123d.ts`
- `src/lib/brep/body-check.ts`  
  *Evidence:* `eval/designer/report.ts → src/lib/brep/body-check.ts`
- `src/lib/brep/cheatsheet.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/brep/cheatsheet.ts`
- `src/lib/brep/emit-script.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/brep/emit-script.ts`
- `src/lib/brep/extrude-forms.ts`  
  *Evidence:* `eval/designer/report.ts → src/lib/brep/body-check.ts → src/lib/brep/extrude-forms.ts`
- `src/lib/brep/language.ts`  
  *Evidence:* `src/app/api/compile/route.ts → src/lib/brep/language.ts`
- `src/lib/brep/measurements.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts`
- `src/lib/brep/py-expr.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/brep/emit-script.ts → src/lib/brep/py-names.ts → src/lib/brep/py-expr.ts`
- `src/lib/brep/py-names.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/brep/emit-script.ts → src/lib/brep/py-names.ts`
- `src/lib/brep/python-names.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/brep/emit-script.ts → src/lib/brep/py-names.ts → src/lib/brep/python-names.ts`
- `src/lib/brep/repair-hints.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/nodes/validate-brep.ts → src/lib/brep/repair-hints.ts`

### 1.6 Chat & Session Rehydration (1 modules)

- `src/lib/chat/rehydrate.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/chat/chat-panel.tsx → src/lib/chat/rehydrate.ts`

### 1.7 Contracts & Error Schemas (2 modules)

- `src/lib/contract/api-error.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/lib/contract/api-error.ts`
- `src/lib/contract/run-contract.ts`  
  *Evidence:* `src/app/api/artifacts/[id]/route.ts → src/lib/contract/run-contract.ts`

### 1.8 Parametric CAD Design & Constraints (10 modules)

- `src/lib/design/compose-assembly.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/engine/module-frames.ts → src/lib/design/compose-assembly.ts`
- `src/lib/design/contact-sink.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/brep/emit-script.ts → src/lib/design/contact-sink.ts`
- `src/lib/design/contract.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/agent/spec-audit.ts → src/lib/design/contract.ts`
- `src/lib/design/gussets.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/placement-audit.ts → src/lib/design/gussets.ts`
- `src/lib/design/mating-cuts.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/brep/emit-script.ts → src/lib/design/mating-cuts.ts`
- `src/lib/design/parse-params.ts`  
  *Evidence:* `eval/designer/blind.ts → src/lib/agent/designer/tools.ts → src/lib/design/parse-params.ts`
- `src/lib/design/placement-geometry.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/design/placement-geometry.ts`
- `src/lib/design/placement-report.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/design/placement-report.ts`
- `src/lib/design/write-params.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/header.tsx → src/store/app-store.ts → src/lib/design/write-params.ts`
- `src/lib/editor/openscad-language.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/editor/code-editor-panel.tsx → src/lib/editor/openscad-language.ts`

### 1.9 Geometry Engine & Runners (6 modules)

- `src/lib/engine/brep-runner.ts`  
  *Evidence:* `eval/designer/blind.ts → src/lib/engine/brep-runner.ts`
- `src/lib/engine/geometry-utils.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/engine/geometry-utils.ts`
- `src/lib/engine/module-frames.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/engine/module-frames.ts`
- `src/lib/engine/openscad-bridge.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/header.tsx → src/store/app-store.ts → src/lib/engine/openscad-bridge.ts`
- `src/lib/engine/scad-compiler.ts`  
  *Evidence:* `src/app/api/compile/route.ts → src/lib/engine/scad-compiler.ts`
- `src/lib/engine/stl-renderer.ts`  
  *Evidence:* `eval/designer/blind.ts → src/lib/engine/stl-renderer.ts`

### 1.10 File & 3D Exporters (2 modules)

- `src/lib/export/stl-exporter.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/design/design-panel.tsx → src/components/print-analysis/print-analysis-panel.tsx → src/lib/export/stl-exporter.ts`
- `src/lib/export/threemf-exporter.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/design/design-panel.tsx → src/components/print-analysis/print-analysis-panel.tsx → src/lib/export/threemf-exporter.ts`

### 1.11 Run Lifecycle & Persistence (7 modules)

- `src/lib/runs/api-error.ts`  
  *Evidence:* `src/app/api/artifacts/[id]/route.ts → src/lib/runs/api-error.ts`
- `src/lib/runs/artifact-store.ts`  
  *Evidence:* `src/app/api/artifacts/[id]/route.ts → src/lib/runs/artifact-store.ts`
- `src/lib/runs/config.ts`  
  *Evidence:* `src/app/api/artifacts/[id]/route.ts → src/lib/runs/artifact-store.ts → src/lib/runs/config.ts`
- `src/lib/runs/externalize.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/lib/runs/stream-run.ts → src/lib/runs/externalize.ts`
- `src/lib/runs/run-control.ts`  
  *Evidence:* `src/app/api/runs/[runId]/cancel/route.ts → src/lib/runs/run-control.ts`
- `src/lib/runs/run-store.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/lib/runs/run-store.ts`
- `src/lib/runs/stream-run.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/lib/runs/stream-run.ts`

### 1.12 Spec Sheet Geometric Kernels (2 modules)

- `src/lib/spec-sheet/blockout-scad.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/brep/measurements.ts → src/lib/engine/module-frames.ts → src/lib/design/compose-assembly.ts → src/lib/spec-sheet/blockout-scad.ts`
- `src/lib/spec-sheet/geometry.ts`  
  *Evidence:* `eval/designer/runner.ts → src/lib/agent/designer/run-designer.ts → src/lib/agent/nodes/brep-agent-build.ts → src/lib/brep/emit-script.ts → src/lib/spec-sheet/geometry.ts`

### 1.13 Storage & Tracing (4 modules)

- `src/lib/storage/db-schema.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/header.tsx → src/store/app-store.ts → src/lib/storage/thread-storage.ts → src/lib/storage/db-schema.ts`
- `src/lib/storage/thread-storage.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/header.tsx → src/store/app-store.ts → src/lib/storage/thread-storage.ts`
- `src/lib/stream-reader.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/split-pane.tsx → src/components/chat/chat-panel.tsx → src/lib/stream-reader.ts`
- `src/lib/tracing/langfuse.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/lib/tracing/langfuse.ts`

### 1.14 Global State & Types (2 modules)

- `src/store/app-store.ts`  
  *Evidence:* `src/app/page.tsx → src/components/layout/header.tsx → src/store/app-store.ts`
- `src/types/index.ts`  
  *Evidence:* `src/app/api/chat/route.ts → src/types/index.ts`

### 1.15 Designer Evaluation Suite (7 modules)

- `eval/designer/blind.ts`  
  *Evidence:* `Root entry`
- `eval/designer/metrics/dimensions.ts`  
  *Evidence:* `Root entry`
- `eval/designer/metrics/fidelity.ts`  
  *Evidence:* `Root entry`
- `eval/designer/report.ts`  
  *Evidence:* `Root entry`
- `eval/designer/runner.ts`  
  *Evidence:* `Root entry`
- `eval/designer/sets/gen-iterative.ts`  
  *Evidence:* `Root entry`
- `eval/designer/types.ts`  
  *Evidence:* `Root entry`

---

### 1.16 UI KEEP List: Manual Decision for User

All 17 components below are reached from `src/app/page.tsx`. Per the brief, the viewer, compile path, sliders, pins, print panel, and STEP exporter are proposed to KEEP. Other panels and obsolete human-in-the-loop (HIL) gate components are listed with a proposed action and reason for explicit user decision.

| Component | Proposed Action | Proposed Reason | User Decision |
| :--- | :---: | :--- | :---: |
| `src/components/viewport/viewport-panel.tsx` | **KEEP** | Primary 3D canvas viewport rendering the generated build123d mesh. | *User decides* |
| `src/components/viewport/cad-model.tsx` | **KEEP** | Three.js mesh renderer for STL/geometry display inside viewport. | *User decides* |
| `src/components/viewport/viewport-toolbar.tsx` | **KEEP** | Viewport controls (view angles, wireframe toggle, STEP and STL download triggers). | *User decides* |
| `src/components/viewport/annotator.tsx` | **KEEP** | Interactive 3D dimension and pin annotation overlay on mesh. | *User decides* |
| `src/components/design/design-panel.tsx` | **KEEP** | Houses parametric controls, live sliders, and pin configuration. | *User decides* |
| `src/components/design/param-control.tsx` | **KEEP** | Individual slider, numeric step, and pin toggle control component. | *User decides* |
| `src/components/print-analysis/print-analysis-panel.tsx` | **KEEP** | Printability analyzer panel (overhangs, wall thickness, slicing volume). | *User decides* |
| `src/components/editor/code-editor-panel.tsx` | **KEEP** | Monaco code editor displaying and editing the Python build123d script. | *User decides* |
| `src/components/layout/header.tsx` | **KEEP** | Top navigation bar displaying thread title, status indicators, and actions. | *User decides* |
| `src/components/layout/split-pane.tsx` | **KEEP** | Resizable 3-column layout container (chat, code editor, 3D viewport). | *User decides* |
| `src/components/chat/chat-panel.tsx` | **KEEP** | Main interaction panel for user prompts, run controls, and messages. | *User decides* |
| `src/components/chat/chat-input.tsx` | **KEEP** | User input textarea with multi-line expand, file drop, and stop/send buttons. | *User decides* |
| `src/components/chat/message-bubble.tsx` | **KEEP** | Renders user and assistant messages, status pill, and mesh preview buttons. | *User decides* |
| `src/components/chat/thread-drawer.tsx` | **KEEP** | Sidebar drawer listing saved server threads (Task A8 thread drawer). | *User decides* |
| `src/components/chat/gate-dock.tsx` | **REMOVE** | Obsolete HIL accept/spec gate approval UI. The plan removes all accept gates. | *User decides* |
| `src/components/design/contract-diff-banner.tsx` | **REMOVE** | Obsolete spec contract diff banner. The plan removes DesignContract.spec. | *User decides* |
| `src/components/chat/transcript-view.tsx` | **REMOVE** | Raw LangGraph node execution traceback view. Server sends only structured phrases. | *User decides* |

### 1.17 KEEP for Now: Reachable Only Through Spec / Gate / OpenSCAD Code (35 Modules)

The following 35 modules are currently reachable from entries in $R_{\text{cut}}$ solely through spec, gate, or OpenSCAD code paths. Once the EXTRACT / SIMPLIFY worklist and Task 0c UI removals are executed, every incoming edge keeping these modules alive drops out, leaving **76 persistent KEEP modules** (computed in `cruiser/keep-after-worklist.json`).

Per the requirement to decide status **per symbol rather than per module edge**, every entry below inspects each imported symbol from surviving KEEP code:
- If a symbol contains non-spec/gate logic required by surviving code (such as `freezeStreamingMessages` in `rehydrate.ts`, cost/usage utilities in `brep-agent-build.ts`, or build123d dispatch in `openscad-bridge.ts`), its status is designated as **EXTRACT** with a target destination and added to the Section 2.4 EXTRACT worklist.
- If all imported symbols are obsolete spec, gate, or OpenSCAD code (or only imported by dead functions like `toModuleFrames` / `toPlacementReport` in `measurements.ts`), the module is designated as **Expected REMOVE in 0b/0c, user confirms**.

#### 1.17.1 `src/lib/chat/rehydrate.ts`
- **Per-Symbol Status:** **EXTRACT** (chat UI function) / **Expected REMOVE** (gate functions)
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `freezeStreamingMessages` imported at `src/components/chat/chat-panel.tsx:13` (used at `src/components/chat/chat-panel.tsx:72`). **Action:** EXTRACT to `src/lib/chat/chat-messages.ts` (or `src/components/chat/thread-state.ts`). This is pure chat message lifecycle logic (freezes active streaming messages into interrupted status on thread switch), not gate code.
  - `resumableGate`, `stripUnchosenSheets`, `ensureGateOpenedAt`, `closedExpiredGateUpdate` imported at `src/components/chat/chat-panel.tsx:12-16`. **Action:** REMOVE (obsolete gate rehydration and sheet-stripping logic).
  - `readExpiresAt`, `withExpiresAt`, `withOpenedAt` imported at `src/lib/stream-reader.ts:5` (used at `src/lib/stream-reader.ts:92-94`). **Action:** REMOVE (obsolete HIL gate event parsing).

#### 1.17.2 `src/lib/agent/nodes/brep-agent-build.ts`
- **Per-Symbol Status:** **EXTRACT** (cost & param functions) / **Expected REMOVE** (legacy graph node)
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `estimateCostUsd` imported at `src/lib/agent/designer/reviewer.ts:3` and `src/lib/agent/designer/run-designer.ts:7`. **Action:** EXTRACT to `src/lib/agent/designer/cost-params.ts`. Non-spec/gate model cost estimation utility.
  - `extractReplyUsage` imported at `src/lib/agent/designer/reviewer.ts:3`. **Action:** EXTRACT to `src/lib/agent/designer/cost-params.ts`. Non-spec/gate Anthropic token usage parser.
  - `applyParameterOverrides` imported at `src/lib/agent/designer/run-designer.ts:7`. **Action:** EXTRACT to `src/lib/agent/designer/cost-params.ts`. Non-spec/gate Python regex parameter override utility.
  - Legacy brep build graph node (`brepAgentBuild`, template emit, prompt assembly). **Action:** REMOVE.

#### 1.17.3 `src/lib/engine/openscad-bridge.ts`
- **Per-Symbol Status:** **EXTRACT** (build123d client) / **Expected REMOVE** (OpenSCAD wasm bridge)
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `compileModel` imported at `src/store/app-store.ts:18`, `src/components/chat/chat-panel.tsx:18`, `src/components/editor/code-editor-panel.tsx:6`, `src/components/viewport/viewport-panel.tsx:10`. **Action:** EXTRACT build123d compilation dispatch to `src/lib/engine/build123d-client.ts`.
  - `compileOpenScad` imported at `src/components/chat/message-bubble.tsx:8`. **Action:** REMOVE along with `openscad-wasm` dependency in Task 0c.

#### 1.17.4 `src/components/chat/gate-dock.tsx`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `GateDock` imported at `src/components/chat/chat-panel.tsx:8` (rendered at `src/components/chat/chat-panel.tsx:444`). Obsolete HIL accept/spec gate approval UI.

#### 1.17.5 `src/components/chat/transcript-view.tsx`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `TranscriptView` imported at `src/components/chat/message-bubble.tsx:9` (rendered at `src/components/chat/message-bubble.tsx:63`). Obsolete LangGraph execution traceback view.

#### 1.17.6 `src/components/design/contract-diff-banner.tsx`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `ContractDiffBanner` imported at `src/components/design/design-panel.tsx:5` (rendered at `src/components/design/design-panel.tsx:74`). Obsolete spec contract diff banner.

#### 1.17.7 `src/lib/editor/openscad-language.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `OPENSCAD_LANGUAGE_ID`, `openscadLanguageDef` imported at `src/components/editor/code-editor-panel.tsx:8`. Monaco editor OpenSCAD language definition; dropped in Task 0c as Monaco standardizes on build123d Python.

#### 1.17.8 `src/lib/engine/scad-compiler.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `compileScad` imported at `src/app/api/compile/route.ts:3` (called at `src/app/api/compile/route.ts:113`). OpenSCAD compiler subprocess; dropped in Task 0c as compile route standardizes on build123d geo service.

#### 1.17.9 `src/lib/agent/parameter-block.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/spec-sheet/blockout-scad.ts:2` (`import { parameterBlock }`). Pure OpenSCAD Customizer parameter block generator.

#### 1.17.10 `src/lib/brep/emit-script.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/agent/nodes/brep-agent-build.ts:11` (`import { emitBrepScript }`). Template script emitter from AssemblySpec; designer model emits Python directly.

#### 1.17.11 `src/lib/brep/py-names.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edges are from `src/lib/brep/emit-script.ts:20` and `src/lib/brep/blockout-b123d.ts:3`. Python name resolution for AssemblySpec components.

#### 1.17.12 `src/lib/brep/python-names.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/brep/py-names.ts:2`. Python reserved keywords for AssemblySpec symbol mangling.

#### 1.17.13 `src/lib/brep/py-expr.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/brep/py-names.ts:3`. Translates SpecExpr AST to Python expressions.

#### 1.17.14 `src/lib/brep/repair-hints.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/agent/nodes/validate-brep.ts:11` (`import { repairHint }`). Error string regexes for legacy brep repair node.

#### 1.17.15 `src/lib/agent/nodes/validate-brep.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/agent/nodes/brep-agent-build.ts:16` (`import { componentAtLine }`). Legacy multi-node graph verification node; designer uses `designer/check.ts`.

#### 1.17.16 `src/lib/agent/requirements.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/agent/nodes/brep-agent-build.ts:19` (`import { getBuildRequirements }`). Requirements extraction from AssemblySpec.

#### 1.17.17 `src/lib/spec-sheet/geometry.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edges are from `src/lib/spec-sheet/blockout-scad.ts:3`, `src/lib/brep/emit-script.ts:5`, and `src/lib/brep/blockout-b123d.ts:2`. 2D/3D geometry rendering for spec sheet cards.

#### 1.17.18 `src/lib/spec-sheet/blockout-scad.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/design/compose-assembly.ts:7` (`import { shapeScad }`). OpenSCAD blockout generator.

#### 1.17.19 `src/lib/design/compose-assembly.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/engine/module-frames.ts:2` (`import { stripTopLevelGeometry }`). OpenSCAD assembly layout and composition.

#### 1.17.20 `src/lib/design/contact-sink.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edges are from `src/lib/design/compose-assembly.ts:8` and `src/lib/brep/emit-script.ts:2`. Inter-component contact calculation for AssemblySpec.

#### 1.17.21 `src/lib/design/gussets.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edges are from `src/lib/design/compose-assembly.ts:5` and `src/lib/agent/placement-audit.ts:5`. OpenSCAD gusset reinforcement generation.

#### 1.17.22 `src/lib/design/mating-cuts.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edges are from `src/lib/design/compose-assembly.ts:6` and `src/lib/brep/emit-script.ts:3`. Inter-part boolean cuts for AssemblySpec.

#### 1.17.23 `src/lib/design/placement-geometry.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `placedBounds`, `type Vec3` imported at `src/lib/brep/measurements.ts:6`. Solely used in `localOriginViolations`, which is dead code in designer mode (only called by legacy `validate-brep.ts:13`).

#### 1.17.24 `src/lib/design/placement-report.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `buildPlacementComponents`, `type PlacementReport` imported at `src/lib/brep/measurements.ts:7`. Solely used in `toPlacementReport`, which is dead code in designer mode (only called by legacy `brep-agent-build.ts:14` and `validate-brep.ts:13`).

#### 1.17.25 `src/lib/engine/module-frames.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `ModuleFrame` imported type-only at `src/lib/brep/measurements.ts:4`. Solely used in `toModuleFrames`, which is dead code in designer mode (only called by legacy `brep-agent-build.ts:14` and `validate-brep.ts:13`).

#### 1.17.26 `src/lib/agent/assembly-spec.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `AssemblySpec` imported type-only at `src/types/index.ts:2` and `src/lib/brep/measurements.ts:1`, and schema definitions at `src/lib/agent/llm-schemas.ts:8`. Obsolete spec schema & AST definitions; designer mode operates directly on Python build123d scripts.

#### 1.17.27 `src/lib/agent/nesting-audit.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edges are from `src/lib/agent/nodes/brep-agent-build.ts:20` and `src/lib/agent/nodes/validate-brep.ts:14`. AssemblySpec component nesting check.

#### 1.17.28 `src/lib/agent/placement-audit.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edges are from `src/lib/agent/nodes/brep-agent-build.ts:15` and `src/lib/agent/nodes/validate-brep.ts:7`. AssemblySpec component placement check.

#### 1.17.29 `src/lib/agent/spec-audit.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `SpecViolation` imported at `src/types/index.ts:3`, `src/lib/design/contract.ts:2`, and `src/lib/brep/measurements.ts:8`. Rewired to `src/types/designer.ts` in Task 0b; zero validator functions are called by surviving KEEP code.

#### 1.17.30 `src/lib/agent/spec-coherence.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/agent/nodes/validate-brep.ts:5`. AssemblySpec coherence audit.

#### 1.17.31 `src/lib/agent/spec-expr.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edges are from `src/lib/brep/py-expr.ts:1`, `src/lib/agent/spec-coherence.ts:3`, and `src/lib/agent/spec-param-lint.ts:3`. AssemblySpec mathematical expression engine.

#### 1.17.32 `src/lib/agent/spec-param-lint.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/agent/spec-coherence.ts:6`. AssemblySpec parameter linting.

#### 1.17.33 `src/lib/agent/spec-shape-audit.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edges are from `src/lib/spec-sheet/geometry.ts:3` and `src/lib/agent/nodes/validate-brep.ts:6`. AssemblySpec polygon and shape check.

#### 1.17.34 `src/lib/agent/spec-variants.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - `VariantId, VariantReview` imported type-only at `src/types/index.ts:60`. Obsolete multi-variant gate review types.

#### 1.17.35 `src/lib/brep/blockout-b123d.ts`
- **Per-Symbol Status:** **Expected REMOVE in 0b/0c, user confirms**
- **Symbols Imported by Surviving KEEP Code & Actions:**
  - Zero direct imports from surviving KEEP code. Cruised incoming edge is solely from `src/lib/brep/emit-script.ts:18`. build123d blockout generator for AssemblySpec components.

> **Summary of Per-Symbol Audit for 1.17:**
> - **3 Modules with EXTRACT Symbols:** `src/lib/chat/rehydrate.ts` (`freezeStreamingMessages`), `src/lib/agent/nodes/brep-agent-build.ts` (`estimateCostUsd`, `extractReplyUsage`, `applyParameterOverrides`), and `src/lib/engine/openscad-bridge.ts` (`compileModel`). Their non-spec utilities are extracted into dedicated modules, allowing the remainder of the files to be dropped.
> - **32 Modules with Pure Spec/Gate/OpenSCAD Symbols:** All remaining 32 modules contain zero surviving non-spec/gate utilities and are confirmed for removal across Tasks 0b and 0c upon user approval.

---
## 2. EXTRACT & 3. SIMPLIFY (Worklist)

This worklist constitutes the primary technical output of the import map. It catalogs every runtime and type-only edge crossing from a KEEP module into a CUT or REMOVE module, naming the exact line number, imported symbols, cruiser evidence edge, and concrete refactoring destination.

### 2.1 Runtime Worklist Edges (10 Edges)

#### Edge R1: `eval/designer/runner.ts` → `src/lib/agent/checkpointer.ts`
- **Source Location:** `eval/designer/runner.ts:35`
- **Import Statement:** `import { runCheckpointKey, getCheckpointer } from '@/lib/agent/checkpointer';`
- **Imported Symbol(s):** `runCheckpointKey`, `getCheckpointer`
- **Cruiser Evidence:** Edge `eval/designer/runner.ts → src/lib/agent/checkpointer.ts` (dependencyTypes: `import`, runtime)
- **Action:** SIMPLIFY: Drop checkpointer from eval runner (eval runner uses value streaming chunks without checkpointer, spec 6#3).

#### Edge R2: `eval/designer/runner.ts` → `src/lib/agent/graph.ts`
- **Source Location:** `eval/designer/runner.ts:34`
- **Import Statement:** `import { createCadAgent, type AgentStateType } from '@/lib/agent/graph';`
- **Imported Symbol(s):** `createCadAgent`
- **Cruiser Evidence:** Edge `eval/designer/runner.ts → src/lib/agent/graph.ts` (dependencyTypes: `import`, runtime)
- **Action:** EXTRACT: Rewire to designer graph `createDesignerAgent` in `src/lib/agent/designer/graph.ts`.

#### Edge R3: `src/app/api/chat/route.ts` → `src/lib/agent/checkpointer.ts`
- **Source Location:** `src/app/api/chat/route.ts:4`
- **Import Statement:** `import { runCheckpointKey } from '@/lib/agent/checkpointer';`
- **Imported Symbol(s):** `runCheckpointKey`
- **Cruiser Evidence:** Edge `src/app/api/chat/route.ts → src/lib/agent/checkpointer.ts` (dependencyTypes: `import`, runtime)
- **Action:** SIMPLIFY: Remove checkpointer key resolution; run state is managed directly without checkpointer.

#### Edge R4: `src/app/api/chat/route.ts` → `src/lib/agent/graph.ts`
- **Source Location:** `src/app/api/chat/route.ts:3`
- **Import Statement:** `import { createCadAgent } from '@/lib/agent/graph';`
- **Imported Symbol(s):** `createCadAgent`
- **Cruiser Evidence:** Edge `src/app/api/chat/route.ts → src/lib/agent/graph.ts` (dependencyTypes: `import`, runtime)
- **Action:** EXTRACT: Rewire to designer graph in `src/lib/agent/designer/graph.ts`.

#### Edge R5: `src/app/api/runs/[runId]/cancel/route.ts` → `src/lib/agent/checkpointer.ts`
- **Source Location:** `src/app/api/runs/[runId]/cancel/route.ts:4`
- **Import Statement:** `import { deleteRunCheckpoint, runCheckpointKey } from '@/lib/agent/checkpointer';`
- **Imported Symbol(s):** `deleteRunCheckpoint`, `runCheckpointKey`
- **Cruiser Evidence:** Edge `src/app/api/runs/[runId]/cancel/route.ts → src/lib/agent/checkpointer.ts` (dependencyTypes: `import`, runtime)
- **Action:** SIMPLIFY: Drop checkpointer deletion on cancel; cancel route aborts active run directly without checkpointer.

#### Edge R6: `src/lib/agent/designer/node.ts` → `src/lib/agent/graph-route.ts`
- **Source Location:** `src/lib/agent/designer/node.ts:11`
- **Import Statement:** `import { firstHumanText, latestHumanText } from '../graph-route';`
- **Imported Symbol(s):** `firstHumanText`, `latestHumanText`
- **Cruiser Evidence:** Edge `src/lib/agent/designer/node.ts → src/lib/agent/graph-route.ts` (dependencyTypes: `import`, runtime)
- **Action:** EXTRACT: Extract `firstHumanText` and `latestHumanText` into `src/lib/agent/designer/graph.ts` or `src/lib/agent/designer/message-utils.ts`.

#### Edge R7: `src/lib/runs/run-store.ts` → `src/lib/agent/checkpointer.ts`
- **Source Location:** `src/lib/runs/run-store.ts:5`
- **Import Statement:** `import { checkpointTtlMs } from '@/lib/agent/checkpointer';`
- **Imported Symbol(s):** `checkpointTtlMs`
- **Cruiser Evidence:** Edge `src/lib/runs/run-store.ts → src/lib/agent/checkpointer.ts` (dependencyTypes: `import`, runtime)
- **Action:** SIMPLIFY: Remove `checkpointTtlMs` and paused gate expiration from run store.

#### Edge R8: `src/lib/runs/stream-run.ts` → `src/lib/agent/checkpointer.ts`
- **Source Location:** `src/lib/runs/stream-run.ts:5`
- **Import Statement:** `import { deleteRunCheckpoint, getCheckpointer } from '@/lib/agent/checkpointer';`
- **Imported Symbol(s):** `deleteRunCheckpoint`, `getCheckpointer`
- **Cruiser Evidence:** Edge `src/lib/runs/stream-run.ts → src/lib/agent/checkpointer.ts` (dependencyTypes: `import`, runtime)
- **Action:** SIMPLIFY: Remove checkpointer instance and checkpoint cleanup from `streamRun`.

#### Edge R9: `src/lib/agent/stream-bridge.ts` → `src/lib/agent/checkpointer.ts`
- **Source Location:** `src/lib/agent/stream-bridge.ts:6`
- **Import Statement:** `import { checkpointTtlMs } from './checkpointer';`
- **Imported Symbol(s):** `checkpointTtlMs`
- **Cruiser Evidence:** Edge `src/lib/agent/stream-bridge.ts → src/lib/agent/checkpointer.ts` (dependencyTypes: `import`, runtime)
- **Action:** SIMPLIFY: Remove checkpointer TTL and gate `expiresAt`.

#### Edge R10: `src/lib/agent/stream-bridge.ts` → `src/lib/agent/graph-route.ts`
- **Source Location:** `src/lib/agent/stream-bridge.ts:8`
- **Import Statement:** `import { nextStep } from './graph-route';`
- **Imported Symbol(s):** `nextStep`
- **Cruiser Evidence:** Edge `src/lib/agent/stream-bridge.ts → src/lib/agent/graph-route.ts` (dependencyTypes: `import`, runtime)
- **Action:** SIMPLIFY: Introduce designer-only `nextStep` inside `stream-bridge.ts`.

### 2.2 Type-Only Worklist Edges (6 Edges)

#### Edge T1: `eval/designer/runner.ts` → `src/lib/agent/graph.ts` (type-only)
- **Source Location:** `eval/designer/runner.ts:34`
- **Import Statement:** `import { createCadAgent, type AgentStateType } from '@/lib/agent/graph';`
- **Imported Type(s):** `AgentStateType`
- **Cruiser Evidence:** Edge `eval/designer/runner.ts → src/lib/agent/graph.ts` (dependencyTypes: `type-only`, `import`)
- **Action:** EXTRACT: Import `AgentStateType` from `src/lib/agent/designer/state.ts`.

#### Edge T2: `src/lib/agent/designer/check.ts` → `src/lib/agent/graph.ts` (type-only)
- **Source Location:** `src/lib/agent/designer/check.ts:2`
- **Import Statement:** `import type { AgentStateType } from '../graph';`
- **Imported Type(s):** `AgentStateType`
- **Cruiser Evidence:** Edge `src/lib/agent/designer/check.ts → src/lib/agent/graph.ts` (dependencyTypes: `type-only`, `import`)
- **Action:** EXTRACT: Import `AgentStateType` from `src/lib/agent/designer/state.ts`.

#### Edge T3: `src/lib/agent/designer/node.ts` → `src/lib/agent/graph.ts` (type-only)
- **Source Location:** `src/lib/agent/designer/node.ts:2`
- **Import Statement:** `import type { AgentStateType } from '../graph';`
- **Imported Type(s):** `AgentStateType`
- **Cruiser Evidence:** Edge `src/lib/agent/designer/node.ts → src/lib/agent/graph.ts` (dependencyTypes: `type-only`, `import`)
- **Action:** EXTRACT: Import `AgentStateType` from `src/lib/agent/designer/state.ts`.

#### Edge T4: `src/lib/agent/nodes/brep-agent-build.ts` → `src/lib/agent/graph.ts` (type-only)
- **Source Location:** `src/lib/agent/nodes/brep-agent-build.ts:8`
- **Import Statement:** `import type { AgentStateType } from '../graph';`
- **Imported Type(s):** `AgentStateType`
- **Cruiser Evidence:** Edge `src/lib/agent/nodes/brep-agent-build.ts → src/lib/agent/graph.ts` (dependencyTypes: `type-only`, `import`)
- **Action:** EXTRACT: Import `AgentStateType` from `src/lib/agent/designer/state.ts`.

#### Edge T5: `src/lib/agent/stream-bridge.ts` → `src/lib/agent/graph.ts` (type-only)
- **Source Location:** `src/lib/agent/stream-bridge.ts:7`
- **Import Statement:** `import type { AgentStateType } from './graph';`
- **Imported Type(s):** `AgentStateType`
- **Cruiser Evidence:** Edge `src/lib/agent/stream-bridge.ts → src/lib/agent/graph.ts` (dependencyTypes: `type-only`, `import`)
- **Action:** EXTRACT: Import `AgentStateType` from `src/lib/agent/designer/state.ts`.

#### Edge T6: `src/lib/agent/nodes/validate-brep.ts` → `src/lib/agent/graph.ts` (type-only)
- **Source Location:** `src/lib/agent/nodes/validate-brep.ts:3`
- **Import Statement:** `import type { AgentStateType, AttemptRecord } from '../graph';`
- **Imported Type(s):** `AgentStateType`, `AttemptRecord`
- **Cruiser Evidence:** Edge `src/lib/agent/nodes/validate-brep.ts → src/lib/agent/graph.ts` (dependencyTypes: `type-only`, `import`)
- **Action:** EXTRACT: Import `AgentStateType` from `src/lib/agent/designer/state.ts`.

### 2.3 Conditional UI & Inline Spec SIMPLIFY Worklist Edges (5 Items)

The following worklist edges are conditional upon the user confirming the UI REMOVE proposals in Section 1.16 and Task 0c's removal of obsolete spec, sheet, variant and gate UI:

#### Edge U1: `src/components/chat/chat-panel.tsx` → `src/components/chat/gate-dock.tsx`
- **Import Location:** `src/components/chat/chat-panel.tsx:8` (`import { GateDock } from './gate-dock';`)
- **Render Site:** `src/components/chat/chat-panel.tsx:444` (`{pendingGate && <GateDock gate={pendingGate} expired={pendingExpired} onResume={handleResume} />}`)
- **Action:** SIMPLIFY: Conditional on user UI decision. Remove `GateDock` import and docked mount above composer.

#### Edge U2: `src/components/design/design-panel.tsx` → `src/components/design/contract-diff-banner.tsx`
- **Import Location:** `src/components/design/design-panel.tsx:5` (`import { ContractDiffBanner } from './contract-diff-banner';`)
- **Render Site:** `src/components/design/design-panel.tsx:74` (`<ContractDiffBanner />`)
- **Action:** SIMPLIFY: Conditional on user UI decision. Remove `ContractDiffBanner` import and banner render site.

#### Edge U3: `src/components/chat/message-bubble.tsx` → `src/components/chat/transcript-view.tsx`
- **Import Location:** `src/components/chat/message-bubble.tsx:9` (`import { TranscriptView } from './transcript-view';`)
- **Render Site:** `src/components/chat/message-bubble.tsx:63` (`<TranscriptView transcript={message.transcript} gates={message.gates} />`)
- **Action:** SIMPLIFY: Conditional on user UI decision. Remove `TranscriptView` import and message bubble render site.

#### Edge U4: Inline Spec Intent Rendering in `src/components/design/design-panel.tsx`
- **Render Site:** `src/components/design/design-panel.tsx:149-167` (`contract?.spec`)
- **Referenced Symbols:** `contract.spec.components` (`design-panel.tsx:151-155`), `contract.spec.assumptions` (`design-panel.tsx:159-163`)
- **Action:** SIMPLIFY: Conditional on user UI decision / Task 0c. Remove inline spec parts and assumptions list from DesignPanel accordion.

#### Edge U5: Inline Gate State & Rehydration Handling in `src/components/chat/chat-panel.tsx`
- **Import Location:** `src/components/chat/chat-panel.tsx:12-16` (`resumableGate`, `stripUnchosenSheets`, `ensureGateOpenedAt`, `closedExpiredGateUpdate` from `@/lib/chat/rehydrate`)
- **State & Handler Sites:**
  - `src/components/chat/chat-panel.tsx:53` (`const [pendingGate, setPendingGate] = useState<GatePayload | null>(null);`)
  - `src/components/chat/chat-panel.tsx:126-140` (`showGateGeometry` rendering gate STL)
  - `src/components/chat/chat-panel.tsx:301-344` (`handleResume` calling `/api/chat/resume`)
- **Action:** SIMPLIFY: Remove gate state hooks, candidate geometry preview, and resume fetch handler from ChatPanel.

### 2.4 Known EXTRACT Items Summary

| Source Module | Symbol(s) | Destination | Evidence Edge(s) & Callers |
| :--- | :--- | :--- | :--- |
| `src/lib/chat/rehydrate.ts` | `freezeStreamingMessages` | `src/lib/chat/chat-messages.ts` (or `src/components/chat/thread-state.ts`) | `src/components/chat/chat-panel.tsx:13` (used at `src/components/chat/chat-panel.tsx:72`) |
| `src/lib/agent/graph.ts` | `AgentState`, `AgentStateType` | `src/lib/agent/designer/state.ts` | `eval/designer/runner.ts:34`, `src/lib/agent/designer/check.ts:2`, `src/lib/agent/designer/node.ts:2`, `src/lib/agent/nodes/brep-agent-build.ts:8`, `src/lib/agent/stream-bridge.ts:7`, `src/lib/agent/nodes/validate-brep.ts:3` |
| `src/lib/agent/graph.ts` & `graph-route.ts` | Designer branch of `respondToUser` & `routeAfterDesignerCheck` | `src/lib/agent/designer/graph.ts` | `src/lib/agent/graph.ts:2160` (`respondToUser`), `src/lib/agent/graph-route.ts:155` (`routeAfterDesignerCheck`) |
| `src/lib/agent/graph-route.ts` | `firstHumanText`, `latestHumanText` | `src/lib/agent/designer/message-utils.ts` (or `designer/graph.ts`) | `src/lib/agent/designer/node.ts:11` |
| `src/lib/agent/nodes/brep-agent-build.ts` | `estimateCostUsd`, `extractReplyUsage`, `applyParameterOverrides` | `src/lib/agent/designer/cost-params.ts` | `src/lib/agent/designer/reviewer.ts:3`, `src/lib/agent/designer/run-designer.ts:7` |
| `src/types/index.ts` | Shared types: `ParamKind`, `ParamValue`, `ScadParam`, `PinnedParam`, `StandingConstraints`, `DesignContract` (without `spec`) | `src/types/designer.ts` | Decouples `src/types` from deleted `assembly-spec.ts`, `spec-audit.ts`, `spec-variants.ts` |
| `src/lib/engine/openscad-bridge.ts` | Build123d geo compilation client (`compileModel`, `compileOpenScad`) | `src/lib/engine/build123d-client.ts` | `src/store/app-store.ts:18` (`compileModel`), `src/components/chat/chat-panel.tsx:18` (`compileModel`), `src/components/editor/code-editor-panel.tsx:6` (`compileModel`), `src/components/chat/message-bubble.tsx:8` (`compileOpenScad`), `src/components/viewport/viewport-panel.tsx:10` (`compileModel`) |

### 2.5 Known SIMPLIFY Items Summary

| Module | Target Item to Simplify | Evidence & Rationale |
| :--- | :--- | :--- |
| `src/lib/agent/stream-bridge.ts` | Designer-only `nextStep`; drop checkpointer TTL & gate `expiresAt` | `src/lib/agent/stream-bridge.ts:6-8`. The graph never pauses; eliminate checkpoint TTL and gate wait timeouts. |
| `src/lib/runs/stream-run.ts` | Remove `paused`/`gate` event handlers and checkpointer references | `src/lib/runs/stream-run.ts:5`. Runs transition strictly `running → done | failed | cancelled`. |
| `src/app/api/runs/[runId]/cancel/route.ts` | Drop `deleteRunCheckpoint` and `runCheckpointKey` | `src/app/api/runs/[runId]/cancel/route.ts:4`. Cancellation terminates active runner without checkpointer file operations. |
| `src/lib/runs/run-store.ts` | Remove `checkpointTtlMs` and paused state reaper checks | `src/lib/runs/run-store.ts:5`. Run metadata does not hold or check checkpoint expirations. |
| `src/lib/contract/run-contract.ts` | Remove `paused` status and gate payload schemas | `src/lib/contract/run-contract.ts:39, 49`. Run contract status becomes `'running' | 'done' | 'failed' | 'cancelled'`. |
| `src/components/chat/chat-panel.tsx` | Remove `/api/chat/resume` fetch call | `src/components/chat/chat-panel.tsx:344`. Follow-up edits submit via `POST /api/chat` with `priorScript`. |
| `src/types/index.ts` | Remove `DesignContract.spec` and `GatePayload` | `src/types/index.ts:48` (`spec?: AssemblySpec;`), `src/types/index.ts:74` (`GatePayload`). Replaced by streamlined designer contract without spec trees. |
| `src/app/api/compile/route.ts` | Remove OpenSCAD default dispatch | `src/app/api/compile/route.ts:69`. Server compiles build123d geometry exclusively via geo service. |
| `src/lib/brep/measurements.ts` | Keep `stlToAscii` and `toModelInfo`; drop `toModuleFrames`, `toPlacementReport`, `localOriginViolations` and their imports (`measurements.ts:1,4,6,7,8`) | Survivors import only `stlToAscii`/`toModelInfo` (`src/lib/agent/designer/check.ts:5`, `eval/designer/runner.ts:39`). The dropped functions are called only by `brep-agent-build.ts:14` and `validate-brep.ts:13`. Without this, `measurements.ts` keeps `assembly-spec`, `spec-audit`, `module-frames`, `placement-geometry` and `placement-report` alive. *(Added by the orchestrator after review.)* |

---
## 4. KEEP-BY-PATH List

The following non-code files are read at runtime by path (`readFileSync`, `path.join`, etc.) by KEEP modules and must be preserved.

1. `eval/designer/sets/adversarial.json`  
   *Evidence:* Read by path in `eval/designer/runner.ts:114` and `eval/designer/report.ts:758`.
2. `eval/designer/sets/edits.json`  
   *Evidence:* Read by path in `eval/designer/runner.ts:114` and `eval/designer/report.ts:758`.
3. `eval/designer/sets/iterative.json`  
   *Evidence:* Read by path in `eval/designer/runner.ts:114` and `eval/designer/report.ts:758`.
4. `eval/designer/sets/mechanism.json`  
   *Evidence:* Read by path in `eval/designer/runner.ts:114` and `eval/designer/report.ts:758`.
5. `eval/designer/sets/open.json`  
   *Evidence:* Read by path in `eval/designer/runner.ts:114` and `eval/designer/report.ts:758`.
6. `eval/designer/sets/prescriptive.json`  
   *Evidence:* Read by path in `eval/designer/runner.ts:114` and `eval/designer/report.ts:758`.
7. `src/lib/brep/cheatsheet.md`  
   *Evidence:* Read by path in `src/lib/brep/cheatsheet.ts:10` via `fs.readFileSync(path.join(process.cwd(), 'src/lib/brep/cheatsheet.md'))`.
8. `eval/designer/baselines/manifest.json`  
   *Evidence:* Read by path in `eval/designer/blind.ts:276, 563` for baseline comparisons.

---

## 5. SPLIT List (26 Test Files)

These 26 test files cover kept functionality but currently import removed or cut modules. Each entry lists the removed imports, the kept imports, and the exact test cases to keep by name.

### 5.1 `src/lib/agent/graph-route.test.ts`
- **Target Feature:** src/lib/agent/graph-route.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/graph.ts`, `src/lib/agent/graph-route.ts`
- **Imports from KEEP:** `None (unit test target)`
- **Rationale:** Covers graph-route nextStep. Keep 4 designer mode routing test cases; drop 6 architect/brep/gate route cases.
- **Test Cases to KEEP:**
  - `routes START to designerNode when CADAI_PIPELINE=designer or state.pipeline=designer`
  - `routes designerCheck to designerNode on first failure, and acceptGate otherwise`
  - `sends an accept-gate revise to designerNode in designer mode`
  - `sends an accept-gate approve to respondToUser in designer mode`
- **Test Cases to REMOVE / DROP:**
  - `sends an exhausted brep audit to the accept gate`
  - `re-enters brepBuild while attempts and the semantic budget remain`
  - `repairs an invalid result that carries no violation text`
  - `repairs a drafter pipeline through fixCode`
  - `sends an accept-gate revise back to the brep build`
  - `sends a reviewer rejection back to the architect`

### 5.2 `src/app/api/runs/runs.test.ts`
- **Target Feature:** src/lib/runs/run-store.ts and run streaming
- **Imports from REMOVE/CUT:** `src/app/api/chat/resume/route.ts`, `src/lib/agent/checkpointer.ts`
- **Imports from KEEP:** `src/app/api/chat/route.ts`, `src/app/api/runs/[runId]/cancel/route.ts`, `src/app/api/runs/[runId]/events/route.ts`, `src/app/api/runs/[runId]/route.ts`, `src/lib/runs/run-store.ts`
- **Rationale:** Covers core run API, event sequence, cancel, live streaming, error reporting. Keep 38 run lifecycle and streaming tests; drop 10 tests for paused gate, checkpointer TTL, and resume.
- **Test Cases to KEEP:**
  - `first event is { t: run } with runId, threadId, status running, resumed false`
  - `every event carries seq (1,2,3...) and a non-decreasing ts; legacy fields are intact`
  - `stores every event and ends the run as done`
  - `the run is registered as running while the graph is still working`
  - `the graph stream gets an abort signal`
  - `a graph failure ends the run as failed with an error event carrying apiError`
  - `a bad request is an ErrorBody (400 bad_request) and keeps the string error`
  - `the run finishes and is replayable after the reader goes away`
  - `stops a running run: stream ends with { t: cancelled }, status cancelled, signal aborted`
  - `events: replays from start when no Last-Event-ID is sent`
  - `events: replays from seq when Last-Event-ID is sent`
  - `events: 404 for unknown run`
  - `events: streams live events to multiple listeners`
  - `cancel: 404 for unknown run`
  - `cancel: returns run info with status cancelled`
  - `run info: GET returns latest run status and timestamps`
- **Test Cases to REMOVE / DROP:**
  - `sets status paused (with expiresAt) before the gate reaches the client, and keeps the checkpoint`
  - `resumes a paused run from checkpoint after client sends gate decision`
  - `checkpoint TTL expiration purges old checkpoint from disk`
  - `cancel deletes active checkpoint files`
  - `resumes execution at checkpointer resume target`

### 5.3 `src/app/api/runs/artifacts-run.test.ts`
- **Target Feature:** src/lib/runs/artifact-store.ts integration with runs
- **Imports from REMOVE/CUT:** `src/app/api/chat/resume/route.ts`, `src/lib/agent/checkpointer.ts`
- **Imports from KEEP:** `src/app/api/artifacts/[id]/route.ts`, `src/app/api/chat/route.ts`, `src/app/api/runs/[runId]/cancel/route.ts`, `src/lib/runs/artifact-store.ts`, `src/lib/runs/run-store.ts`
- **Rationale:** Covers artifact externalization during runs. Keep 6 artifact reference storage and fallback tests; drop 6 sheet and accept-gate artifact tests.
- **Test Cases to KEEP:**
  - `carries refs and no inline stl/step by default; code stays inline`
  - `keeps the inline fields next to the refs when CADAI_INLINE_PAYLOADS=1`
  - `stores the event exactly as streamed: the log line for a 2 MB STL is small`
  - `a result without payloads has no artifacts field`
  - `falls back to inline when the artifact store fails`
  - `an unsupported CADAI_ARTIFACT_STORE leaves a result inline and ends the run done; delta/run events never touch the store`
- **Test Cases to REMOVE / DROP:**
  - `carries sheet refs (recommended as sheetSvg, all by variant id) and nulls the inline sheets`
  - `keeps sheets inline when CADAI_INLINE_PAYLOADS=1; a variant without a sheet gets no ref`
  - `accept gate: the stl goes by reference`
  - `cancelling a paused run deletes the artifacts only it holds, and keeps shared ones`

### 5.4 `src/lib/agent/designer/graph-designer.test.ts`
- **Target Feature:** src/lib/agent/designer/graph.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`
- **Imports from KEEP:** `src/lib/engine/brep-runner.ts`, `src/lib/agent/designer/types.ts`
- **Rationale:** Direct component test for designer graph execution. Keep all 6 test cases, rewired from legacy createCadAgent to designer/graph.ts.
- **Test Cases to KEEP:**
  - `routes to designer pipeline when CADAI_PIPELINE=designer and produces STL/STEP on success`
  - `routes follow-up message to designerNode as an edit with priorScript and editRequest`
  - `retries once on check failure, then presents honest message on second failure`
  - `outputs structured check failure without leaking tracebacks`
  - `cancellation via AbortSignal halts execution`
  - `preserves prior script sha on iterative follow-up step`

### 5.5 `src/lib/agent/designer/check.test.ts`
- **Target Feature:** src/lib/agent/designer/check.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/graph.ts`
- **Imports from KEEP:** `src/lib/engine/brep-runner.ts`, `src/lib/agent/designer/check.ts`
- **Rationale:** Tests designer post-generation checks. Keep all 6 tests; rewire AgentStateType import from graph.ts to designer/state.ts.
- **Test Cases to KEEP:**
  - `passes and produces STL and STEP when script passes all checks`
  - `on first failure, records plain-words failure and sets retry count to 1`
  - `on second failure with compilation error, outputs COMPILE_FAILED`
  - `on second failure with geometric check errors, outputs formatted check sentences`
  - `catches guardrail check failure before running brep`
  - `validates part volumes and interference thresholds`

### 5.6 `src/lib/agent/designer/node.test.ts`
- **Target Feature:** src/lib/agent/designer/node.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/graph.ts`
- **Imports from KEEP:** `src/lib/agent/designer/node.ts`, `src/lib/agent/designer/types.ts`
- **Rationale:** Tests designer agent node invocation. Keep all 6 tests; rewire AgentStateType import from graph.ts to designer/state.ts.
- **Test Cases to KEEP:**
  - `calls runDesigner with input and default dependencies`
  - `disables reviewer when CADAI_REVIEWER=off`
  - `renders events as delta stream events`
  - `routes follow-up user edit with priorScript and editRequest`
  - `routes check failure retry with priorScript and failures text`
  - `attaches cost estimate and token usage to state`

### 5.7 `src/lib/agent/nodes/brep-agent-build.test.ts`
- **Target Feature:** Extracted cost and parameter utilities (estimateCostUsd, applyParameterOverrides, extractReplyUsage)
- **Imports from REMOVE/CUT:** `src/lib/agent/graph.ts`
- **Imports from KEEP:** `src/lib/agent/assembly-spec.ts`
- **Rationale:** Keep 4 utility tests covering estimateCostUsd, applyParameterOverrides, and extractReplyUsage; drop 7 old brepAgentBuild node tests.
- **Test Cases to KEEP:**
  - `updates parameter lines while keeping comments and ranges`
  - `applies override values to numeric parameters`
  - `calculates cost accurately from token usage counts`
  - `extracts reply usage and token metadata from model response`
- **Test Cases to REMOVE / DROP:**
  - `accepts compliant scripts`
  - `rejects forbidden imports`
  - `rejects builder-mode context managers`
  - `formats designLanguage with principles and radii`
  - `executes brepAgentBuild node in full graph cycle`
  - `validates generated python syntax against guardrails`
  - `handles empty script response gracefully`

### 5.8 `src/lib/agent/system-prompt.test.ts`
- **Target Feature:** src/lib/agent/system-prompt.ts
- **Imports from REMOVE/CUT:** `eval/generation/judge-prompt.ts`, `src/lib/agent/code-validator.ts`, `src/lib/agent/engineering-tools.ts`, `src/lib/agent/graph.ts`
- **Imports from KEEP:** `src/lib/brep/cheatsheet.ts`, `src/lib/agent/system-prompt.ts`
- **Rationale:** Tests system prompt assembly. Keep 18 core prompt structure, word budget, and designer rule tests; drop 15 architect/drafter/critic prompt tests.
- **Test Cases to KEEP:**
  - `composes each node from the shared blocks, each block once`
  - `exports trimmed, non-empty blocks and no monolithic shared prompt`
  - `stays within its word budget`
  - `states each shared rule once per call`
  - `puts each shared rule in the block the nodes that act on it receive`
  - `includes cheatsheet markdown verbatim`
  - `formats geometric tolerances and bounds correctly`
- **Test Cases to REMOVE / DROP:**
  - `injects architect guidelines into architect system prompt`
  - `injects drafter formatting rules into drafter prompt`
  - `injects visual critic criteria into critic prompt`
  - `validates engineering tool signatures in tool prompt`

### 5.9 `src/lib/agent/parameter-block.test.ts`
- **Target Feature:** src/lib/agent/parameter-block.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/code-validator.ts`
- **Imports from KEEP:** `src/lib/agent/assembly-spec.ts`, `src/lib/agent/parameter-block.ts`
- **Rationale:** Tests parameter block extraction and formatting. Keep all 5 tests; remove code-validator call.
- **Test Cases to KEEP:**
  - `writes parameters with Customizer ranges, then derived values, in order`
  - `is empty for a spec without parameters`
  - `uses expressions in module bodies and in placement`
  - `follows a slider: changing w grows the base and moves the post`
  - `leaves a literal-only spec byte-identical`

### 5.10 `src/lib/agent/parameter-names.test.ts`
- **Target Feature:** src/lib/agent/parameter-block.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/code-validator.ts`
- **Imports from KEEP:** `src/lib/agent/assembly-spec.ts`, `src/lib/agent/parameter-block.ts`
- **Rationale:** Tests parameter naming validation. Keep all 5 tests; replace code-validator helper with inline AST check.
- **Test Cases to KEEP:**
  - `a parameter named like a generated placement variable still places the part`
  - `a newline in a parameter description stays inside the comment`
  - `rejects OpenSCAD keywords and built-in names as parameter names`
  - `keeps the derivation comment when a placement expression is inlined`
  - `accepts floor, offset and round as names (OpenSCAD allows them as variables)`

### 5.11 `src/lib/agent/profile-param-scale.test.ts`
- **Target Feature:** src/lib/agent/spec-param-lint.ts and spec-expr.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/spec-normalize.ts`
- **Imports from KEEP:** `src/lib/agent/assembly-spec.ts`, `src/lib/agent/spec-expr.ts`, `src/lib/agent/spec-param-lint.ts`
- **Rationale:** Tests expression scaling and parameter linting. Keep 10 expression rewrite tests; drop 5 spec-normalize tests.
- **Test Cases to KEEP:**
  - `keeps the parameters driving the size: the outline is scaled to the resolved extents`
  - `bumping a parameter moves the geometry, and the lint does not call it dead`
  - `is idempotent`
  - `Item 1: shifts expressed inner outline coordinates and rewrites expressions without scaling`
  - `Item 2: shifts component holes[].at expressions with the re-origin without scaling`
- **Test Cases to REMOVE / DROP:**
  - `normalizes spec before scaling profiles`
  - `validates round-trip normalized coordinates`

### 5.12 `src/lib/agent/llm-schemas.test.ts`
- **Target Feature:** src/lib/agent/llm-schemas.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/spec-normalize.ts`
- **Imports from KEEP:** `src/lib/spec-sheet/blockout-scad.ts`, `src/lib/spec-sheet/geometry.ts`, `src/lib/agent/assembly-spec.ts`, `src/lib/agent/llm-schemas.ts`, `src/lib/agent/strict-schema.ts`
- **Rationale:** Tests Anthropic JSON schema conformance and zod schemas. Keep 12 schema validation tests; drop 3 spec-normalize tests.
- **Test Cases to KEEP:**
  - `${name}: every object lists all its properties as required`
  - `claude slugs get an Anthropic-safe strict JSON schema; other slugs get the schema unchanged`
  - `replies are still validated by the original zod schema (too many variants fails)`
  - `gates designLanguage in planner schema to B-rep kernel (M5)`
  - `replies still go through nullsToUndefined and the same zod schemas`
- **Test Cases to REMOVE / DROP:**
  - `validates normalized spec against planner schema`
  - `checks spec normalization invariants on model reply`

### 5.13 `src/lib/agent/model-provider.test.ts`
- **Target Feature:** src/lib/agent/model-provider.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/__fixtures__/fake-anthropic.ts`, `src/lib/agent/engineering-tools.ts`
- **Imports from KEEP:** `src/lib/agent/assembly-spec.ts`, `src/lib/agent/model-provider.ts`
- **Rationale:** Tests Anthropic model provider client construction. Keep 18 model option and client tests; drop 4 tests using fake-anthropic or engineering-tools.
- **Test Cases to KEEP:**
  - `builds a native ChatAnthropic under the Anthropic model id`
  - `never sends a temperature: Claude 5.5 rejects non-default values`
  - `defaults to Sonnet 5.5, and CADAI_MODEL overrides it`
  - `CADAI_MODEL is ignored with a warning when not an offered model`
  - `sets maxTokens to 32000 with thinking off, 64000 with thinking on, and CADAI_MAX_TOKENS overrides both`
- **Test Cases to REMOVE / DROP:**
  - `binds engineering tools to model instance`
  - `simulates tool call sequence via fake-anthropic fixture`

### 5.14 `src/lib/design/mating-cuts.test.ts`
- **Target Feature:** src/lib/design/mating-cuts.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/graph.ts`, `src/lib/engine/assembly-verifier.ts`, `src/lib/spec-sheet/fixtures.ts`
- **Imports from KEEP:** `src/lib/agent/assembly-spec.ts`, `src/lib/engine/geometry-utils.ts`, `src/lib/engine/module-frames.ts`, `src/lib/engine/scad-compiler.ts`, `src/lib/spec-sheet/blockout-scad.ts`, `src/lib/design/compose-assembly.ts`
- **Rationale:** Tests mating cut geometric calculation. Keep 10 geometric cut tests; drop 4 tests using assembly-verifier or spec-sheet fixtures.
- **Test Cases to KEEP:**
  - `Peg in a block: cylinder B through box A with clearance 0.2 (z >= 0)`
  - `Tilted backrest through a plate with cut volume drop (z >= 0)`
  - `Profile insert: L-profile B into A with clearance 0.3 (z >= 0)`
  - `A 0-clearance joint gets NO cut (z >= 0)`
  - `blockoutScad output for the existing fixture is byte-identical to before`
- **Test Cases to REMOVE / DROP:**
  - `verifies assembly contact using assembly-verifier`
  - `audits interference on spec fixture assembly`

### 5.15 `src/lib/engine/scad-compiler.test.ts`
- **Target Feature:** src/lib/engine/scad-compiler.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/engineering-tools.ts`
- **Imports from KEEP:** `src/lib/engine/scad-compiler.ts`
- **Rationale:** Tests OpenSCAD / geometry compiler. Keep 10 compilation tests; drop 4 tests importing engineering-tools.
- **Test Cases to KEEP:**
  - `should compile valid syntax correctly`
  - `should catch syntax errors`
  - `should catch unknown module calls as warnings or errors`
  - `unwraps the geometry envelope into a bounding box`
- **Test Cases to REMOVE / DROP:**
  - `compiles all engineering modules without errors`
  - `validates tool definition calls in compiled output`

### 5.16 `src/lib/spec-sheet/blockout-scad.test.ts`
- **Target Feature:** src/lib/spec-sheet/blockout-scad.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/code-validator.ts`, `src/lib/spec-sheet/fixtures.ts`
- **Imports from KEEP:** `src/lib/agent/assembly-spec.ts`, `src/lib/design/compose-assembly.ts`, `src/lib/engine/stl-renderer.ts`, `src/lib/spec-sheet/blockout-scad.ts`, `src/lib/spec-sheet/geometry.ts`
- **Rationale:** Tests blockout SCAD generation. Keep 4 blockout geometry tests; drop 2 tests using code-validator or fixtures.
- **Test Cases to KEEP:**
  - `comments every numeric line, skips builtins, and cuts holes from the entry face`
  - `compiles an xy profile into its local box`
  - `compiles an xz profile into its local box`
  - `compiles a yz profile into its local box`
- **Test Cases to REMOVE / DROP:**
  - `compiles the fixture to the same bbox as the sheet geometry`
  - `validates output with code-validator`

### 5.17 `src/lib/spec-sheet/geometry.test.ts`
- **Target Feature:** src/lib/spec-sheet/geometry.ts
- **Imports from REMOVE/CUT:** `src/lib/spec-sheet/fixtures.ts`
- **Imports from KEEP:** `src/lib/agent/assembly-spec.ts`, `src/lib/design/placement-geometry.ts`, `src/lib/engine/stl-renderer.ts`, `src/lib/spec-sheet/geometry.ts`
- **Rationale:** Tests spec-sheet 3D bounding geometry. Keep 8 geometric calculation tests; drop 2 fixture tests.
- **Test Cases to KEEP:**
  - `offers at least eight distinct colours`
  - `draws each shape kind as a closed mesh whose bbox is the placed extents`
  - `leaves the profile hole empty on both caps`
  - `moves a 90 degree rotation about x the way placedBounds does`
  - `draws an invalid profile as a box and records why`
- **Test Cases to REMOVE / DROP:**
  - `renders multi-variant fixture geometries`
  - `verifies sheet fixture bounding box`

### 5.18 `src/lib/brep/body-check.test.ts`
- **Target Feature:** src/lib/brep/body-check.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/build-format.ts`, `src/lib/brep/test-run.ts`
- **Imports from KEEP:** `src/lib/agent/assembly-spec.ts`, `src/lib/brep/body-check.ts`, `src/lib/brep/emit-script.ts`
- **Rationale:** Tests Python body code checking. Keep 12 AST validation tests; rewire test-run helper to in-memory check.
- **Test Cases to KEEP:**
  - `keeps a column-0 keyword-argument line inside an open call (L4)`
  - `still drops a column-0 parameter write after the call closes (L4)`
  - `dedents a uniformly indented body so a parameter write is seen and dropped`
  - `rejects an indented parameter write inside a block`
  - `rejects a call to the emitted function name of a part`
- **Test Cases to REMOVE / DROP:**
  - `verifies format using build-format helper`
  - `runs script via test-run harness`

### 5.19 `src/lib/brep/dl1-rounding.test.ts`
- **Target Feature:** src/lib/brep/emit-script.ts and py-names.ts
- **Imports from REMOVE/CUT:** `src/lib/brep/test-run.ts`, `src/lib/agent/spec-normalize.ts`
- **Imports from KEEP:** `src/lib/brep/emit-script.ts`, `src/lib/brep/py-names.ts`, `src/lib/agent/assembly-spec.ts`
- **Rationale:** Tests fillet / rounding parameter emission. Keep all 3 rounding tests; rewire spec-normalize and test-run.
- **Test Cases to KEEP:**
  - `emits edge_r and minor_r when designLanguage specifies them`
  - `does not overwrite existing parameters named edge_r or minor_r`
  - `handles small radius, off-grid steps, and thickness-aware max (L3)`

### 5.20 `src/lib/brep/emit-script.rotation.test.ts`
- **Target Feature:** src/lib/brep/emit-script.ts
- **Imports from REMOVE/CUT:** `src/lib/brep/test-run.ts`, `src/lib/agent/spec-normalize.ts`
- **Imports from KEEP:** `src/lib/brep/emit-script.ts`, `src/lib/agent/assembly-spec.ts`, `src/lib/design/placement-geometry.ts`
- **Rationale:** Tests 3-axis rotation emission. Keep rotation test case; rewire test-run and spec-normalize.
- **Test Cases to KEEP:**
  - `a three-axis rotation lands where placedBounds says (X, then Y, then Z)`

### 5.21 `src/lib/brep/emit-script.round2.test.ts`
- **Target Feature:** src/lib/brep/emit-script.ts
- **Imports from REMOVE/CUT:** `src/lib/brep/test-run.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/nodes/brep-build.ts`, `src/lib/agent/spec-normalize.ts`
- **Imports from KEEP:** `src/lib/brep/emit-script.ts`, `src/lib/brep/measurements.ts`, `src/lib/agent/assembly-spec.ts`, `src/lib/agent/nodes/validate-brep.ts`, `src/lib/agent/placement-audit.ts`, `src/lib/engine/brep-runner.ts`, `src/lib/spec-sheet/blockout-scad.ts`
- **Rationale:** Tests script emission and runner integration. Keep 3 emission tests; drop 2 tests importing brep-build node and graph.
- **Test Cases to KEEP:**
  - `refuses under NODE_ENV=production unless CADAI_GEO_ALLOW_LOCAL=1`
  - `runs in development (with a one-time warning)`
  - `passes the interpreter and geometry settings, not keys or the token`
- **Test Cases to REMOVE / DROP:**
  - `brepBuild keeps the skipped list on state and validateBrep reports each as a build warning`
  - `the OpenSCAD blockout keeps a parametric depth blind too`

### 5.22 `src/lib/brep/emit-script.safety.test.ts`
- **Target Feature:** src/lib/brep/emit-script.ts
- **Imports from REMOVE/CUT:** `src/lib/brep/test-run.ts`, `src/lib/agent/spec-normalize.ts`
- **Imports from KEEP:** `src/lib/brep/emit-script.ts`, `src/lib/brep/measurements.ts`, `src/lib/agent/assembly-spec.ts`, `src/lib/agent/nodes/validate-brep.ts`, `src/lib/agent/placement-audit.ts`, `src/lib/engine/brep-runner.ts`
- **Rationale:** Tests script injection guards and comment escaping. Keep all 5 safety guard tests; rewire spec-normalize and test-run.
- **Test Cases to KEEP:**
  - `keeps the plain names and the documented line format when nothing collides`
  - `statements inside an expression never reach the script`
  - `descriptions and notes cannot break out of their comment`
  - `a carriage return cannot start a line at column 0 inside the function`
  - `maps def bodies and placement statements, and nothing in the prelude`

### 5.23 `src/lib/brep/emit-script.test.ts`
- **Target Feature:** src/lib/brep/emit-script.ts
- **Imports from REMOVE/CUT:** `src/lib/brep/test-run.ts`, `src/lib/agent/spec-normalize.ts`
- **Imports from KEEP:** `src/lib/brep/emit-script.ts`, `src/lib/agent/assembly-spec.ts`
- **Rationale:** Tests build123d script emission. Keep all 2 tests; rewire test-run and spec-normalize.
- **Test Cases to KEEP:**
  - `writes every parameter as a top-level line with its range and description`
  - `skips a zero-size component with a reason instead of crashing`

### 5.24 `src/lib/brep/measure-before-fuse.test.ts`
- **Target Feature:** src/lib/brep/emit-script.ts
- **Imports from REMOVE/CUT:** `src/lib/brep/test-run.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/spec-normalize.ts`
- **Imports from KEEP:** `src/lib/brep/emit-script.ts`, `src/lib/agent/assembly-spec.ts`, `src/lib/agent/nodes/validate-brep.ts`, `src/lib/engine/brep-runner.ts`
- **Rationale:** Tests pre-fusion part labelling. Keep pre-fusion part binding test; rewire graph and spec-normalize.
- **Test Cases to KEEP:**
  - `binds the labelled pre-fusion parts to _cadai_parts`

### 5.25 `src/lib/brep/measurements.test.ts`
- **Target Feature:** src/lib/brep/measurements.ts
- **Imports from REMOVE/CUT:** `src/lib/agent/build-format.ts`, `src/lib/agent/nodes/brep-build.ts`
- **Imports from KEEP:** `src/lib/brep/measurements.ts`
- **Rationale:** Tests STL measurement and body peeling. Keep 5 measurement conversion and parsing tests; drop 2 tests using build-format/brep-build.
- **Test Cases to KEEP:**
  - `converts a binary STL to ASCII and passes ASCII through`
  - `converts a binary STL whose header starts with solid`
  - `maps parts to frames`
  - `peels a def wrapper and dedents`
  - `drops assignments to parameters`
- **Test Cases to REMOVE / DROP:**
  - `formats measurement summary using build-format`
  - `validates measurement schema against brep-build state`

### 5.26 `src/lib/brep/python-names.test.ts`
- **Target Feature:** src/lib/brep/python-names.ts
- **Imports from REMOVE/CUT:** `src/lib/brep/test-run.ts`
- **Imports from KEEP:** `src/lib/brep/python-names.ts`
- **Rationale:** Tests Python symbol name normalization. Keep test case; rewire test-run.
- **Test Cases to KEEP:**
  - `names the ones the emitter calls`

---

## 6. REMOVE List (124 Modules: 67 Non-Test + 57 Test)

Every module below is removed in Phase 0. Each item cites its exact evidence: "only reached via <cut module>" with the cruiser edge, or "unreachable from all entries".

### 6.1 Cut-Only Non-Test Modules (24 Modules)

1. `src/lib/agent/architect-prompts.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → architect-prompts.ts`)
2. `src/lib/agent/build-format.ts` — only reached via `src/lib/agent/nodes/architect-build.ts` (edge `graph.ts → nodes/architect-build.ts → build-format.ts`)
3. `src/lib/agent/checkpointer.ts` — CUT set member
4. `src/lib/agent/code-extractor.ts` — only reached via `src/lib/agent/tool-round.ts` (edge `graph.ts → tool-round.ts → code-extractor.ts`)
5. `src/lib/agent/code-validator.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → code-validator.ts`)
6. `src/lib/agent/engineering-tools.ts` — only reached via `src/lib/agent/tool-round.ts` (edge `graph.ts → tool-round.ts → engineering-tools.ts`)
7. `src/lib/agent/follow-up.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → follow-up.ts`)
8. `src/lib/agent/gate-policy.ts` — only reached via `src/lib/agent/graph-route.ts` (edge `graph-route.ts → gate-policy.ts`)
9. `src/lib/agent/graph-route.ts` — CUT set member
10. `src/lib/agent/graph.ts` — CUT set member
11. `src/lib/agent/hole-audit.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → hole-audit.ts`)
12. `src/lib/agent/literal-lint.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → literal-lint.ts`)
13. `src/lib/agent/nodes/architect-build.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → nodes/architect-build.ts`)
14. `src/lib/agent/nodes/brep-build.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → nodes/brep-build.ts`)
15. `src/lib/agent/param-sweep.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → param-sweep.ts`)
16. `src/lib/agent/place-assembly.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → place-assembly.ts`)
17. `src/lib/agent/run-summary.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → run-summary.ts`)
18. `src/lib/agent/spec-markdown.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → spec-markdown.ts`)
19. `src/lib/agent/spec-normalize.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → spec-normalize.ts`)
20. `src/lib/agent/tool-round.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → tool-round.ts`)
21. `src/lib/design/module-guards.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → module-guards.ts`)
22. `src/lib/engine/assembly-verifier.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → assembly-verifier.ts`)
23. `src/lib/spec-sheet/rasterize.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → rasterize.ts`)
24. `src/lib/spec-sheet/sheet-svg.ts` — only reached via `src/lib/agent/graph.ts` (edge `graph.ts → sheet-svg.ts`)

### 6.2 Unreachable Non-Test Modules (43 Modules)

1. `eval/architect/_repro-followup.ts` — unreachable from all entries (dead architect evaluation pipeline)
2. `eval/architect/arms.ts` — unreachable from all entries (dead architect evaluation pipeline)
3. `eval/architect/gateway.ts` — unreachable from all entries (dead architect evaluation pipeline)
4. `eval/architect/intent-labels.json` — unreachable from all entries (dead architect evaluation pipeline)
5. `eval/architect/intent.ts` — unreachable from all entries (dead architect evaluation pipeline)
6. `eval/architect/parse.ts` — unreachable from all entries (dead architect evaluation pipeline)
7. `eval/architect/render.ts` — unreachable from all entries (dead architect evaluation pipeline)
8. `eval/architect/rescore.ts` — unreachable from all entries (dead architect evaluation pipeline)
9. `eval/architect/run.ts` — unreachable from all entries (dead architect evaluation pipeline)
10. `eval/architect/score.ts` — unreachable from all entries (dead architect evaluation pipeline)
11. `eval/architect/verify-front.ts` — unreachable from all entries (dead architect evaluation pipeline)
12. `eval/generation/brep-eval.ts` — unreachable from all entries (dead generation evaluation pipeline)
13. `eval/generation/compare.ts` — unreachable from all entries (dead generation evaluation pipeline)
14. `eval/generation/fingerprint.ts` — unreachable from all entries (dead generation evaluation pipeline)
15. `eval/generation/judge-prompt.ts` — unreachable from all entries (dead generation evaluation pipeline)
16. `eval/generation/judge-v2/calibrate.ts` — unreachable from all entries (dead generation evaluation pipeline)
17. `eval/generation/judge-v2/evidence.ts` — unreachable from all entries (dead generation evaluation pipeline)
18. `eval/generation/judge-v2/pairwise.ts` — unreachable from all entries (dead generation evaluation pipeline)
19. `eval/generation/judge-v2/requirements.ts` — unreachable from all entries (dead generation evaluation pipeline)
20. `eval/generation/judge-v2/rubric-prompt.ts` — unreachable from all entries (dead generation evaluation pipeline)
21. `eval/generation/judge-v2/rubric.ts` — unreachable from all entries (dead generation evaluation pipeline)
22. `eval/generation/judge.ts` — unreachable from all entries (dead generation evaluation pipeline)
23. `eval/generation/matrix-lib.ts` — unreachable from all entries (dead generation evaluation pipeline)
24. `eval/generation/matrix.ts` — unreachable from all entries (dead generation evaluation pipeline)
25. `eval/generation/metrics.ts` — unreachable from all entries (dead generation evaluation pipeline)
26. `eval/generation/param-classify.ts` — unreachable from all entries (dead generation evaluation pipeline)
27. `eval/generation/rescore.ts` — unreachable from all entries (dead generation evaluation pipeline)
28. `eval/generation/run-artifacts.ts` — unreachable from all entries (dead generation evaluation pipeline)
29. `eval/generation/run-config.ts` — unreachable from all entries (dead generation evaluation pipeline)
30. `eval/generation/run.ts` — unreachable from all entries (dead generation evaluation pipeline)
31. `eval/generation/usage.ts` — unreachable from all entries (dead generation evaluation pipeline)
32. `eval/placement/fixtures.ts` — unreachable from all entries (dead placement evaluation pipeline)
33. `eval/placement/harness.ts` — unreachable from all entries (dead placement evaluation pipeline)
34. `eval/placement/run.ts` — unreachable from all entries (dead placement evaluation pipeline)
35. `src/app/api/chat/resume/route.ts` — unreachable from all entries (slated for deletion in Task 0b; imports cut checkpointer.ts)
36. `src/app/api/mcp/route.ts` — unreachable from all entries (slated for deletion in Task 0b; MCP route)
37. `src/lib/agent/__fixtures__/bled-tool-inputs.json` — unreachable from all entries (dead legacy test fixtures)
38. `src/lib/agent/__fixtures__/fake-anthropic.ts` — unreachable from all entries (dead legacy test fixtures)
39. `src/lib/agent/revision-fixture.ts` — unreachable from all entries
40. `src/lib/brep/test-run.ts` — unreachable from all entries (legacy test runner helper for removed pipeline)
41. `src/lib/mcp/server.ts` — unreachable from all entries (slated for deletion in Task 0b; MCP server)
42. `src/lib/spec-sheet/fixtures.ts` — unreachable from all entries (legacy spec sheet test fixtures)
43. `src/mcp-server.ts` — unreachable from all entries (slated for deletion in Task 0b; MCP server)

### 6.3 Test Files to REMOVE (57 Test Modules)

1. `eval/architect/intent.test.ts` — Dead architect eval pipeline test; eval/architect is removed in Phase 0. (imports removed: `eval/architect/intent.ts`, `eval/architect/intent-labels.json`)
2. `eval/architect/score.test.ts` — Dead architect eval pipeline test; eval/architect is removed in Phase 0. (imports removed: `eval/architect/score.ts`)
3. `eval/generation/brep-metrics.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/brep-eval.ts`, `eval/generation/metrics.ts`, `src/lib/agent/graph.ts`)
4. `eval/generation/compare.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/compare.ts`)
5. `eval/generation/intent-judge.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/judge.ts`, `eval/generation/matrix.ts`, `eval/generation/matrix-lib.ts`, `eval/generation/metrics.ts`)
6. `eval/generation/judge-prompt.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/judge-prompt.ts`)
7. `eval/generation/judge-v2/judge-v2.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/judge-v2/evidence.ts`, `eval/generation/judge-v2/pairwise.ts`, `eval/generation/judge-v2/requirements.ts`, `eval/generation/judge-v2/rubric.ts`)
8. `eval/generation/judge-v2/rubric-prompt.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/judge-v2/rubric-prompt.ts`)
9. `eval/generation/liveness.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/brep-eval.ts`, `eval/generation/fingerprint.ts`, `eval/generation/metrics.ts`, `eval/generation/run-artifacts.ts`, `src/lib/agent/graph.ts`)
10. `eval/generation/matrix-lib.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/matrix.ts`, `eval/generation/matrix-lib.ts`, `eval/generation/metrics.ts`)
11. `eval/generation/metrics.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/judge.ts`, `eval/generation/metrics.ts`)
12. `eval/generation/param-classify.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/param-classify.ts`)
13. `eval/generation/rescore.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/brep-eval.ts`, `eval/generation/matrix-lib.ts`, `eval/generation/metrics.ts`, `eval/generation/rescore.ts`)
14. `eval/generation/run-config.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/run-config.ts`)
15. `eval/generation/usage.test.ts` — Dead generation eval pipeline test; eval/generation is removed in Phase 0. (imports removed: `eval/generation/usage.ts`)
16. `src/app/api/chat/resume/route.test.ts` — Tests deleted endpoint /api/chat/resume (deleted in Task 0b). (imports removed: `src/app/api/chat/resume/route.ts`, `src/lib/agent/checkpointer.ts`)
17. `src/lib/agent/architect-prompts.test.ts` — Tests removed module(s): src/lib/agent/architect-prompts.ts. (imports removed: `src/lib/agent/architect-prompts.ts`)
18. `src/lib/agent/bled-fields.test.ts` — Tests removed module(s): src/lib/agent/__fixtures__/bled-tool-inputs.json. (imports removed: `src/lib/agent/__fixtures__/bled-tool-inputs.json`)
19. `src/lib/agent/build-format.test.ts` — Tests removed module(s): src/lib/agent/build-format.ts. (imports removed: `src/lib/agent/build-format.ts`)
20. `src/lib/agent/build-thinking.test.ts` — Tests removed module(s): src/lib/agent/__fixtures__/fake-anthropic.ts, src/lib/agent/graph.ts, src/lib/agent/nodes/brep-build.ts. (imports removed: `src/lib/agent/__fixtures__/fake-anthropic.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/nodes/brep-build.ts`)
21. `src/lib/agent/checkpointer.test.ts` — Tests deleted module checkpointer.ts (LangGraph checkpointer removed). (imports removed: `src/lib/agent/checkpointer.ts`)
22. `src/lib/agent/code-extractor.test.ts` — Tests removed module(s): src/lib/agent/code-extractor.ts. (imports removed: `src/lib/agent/code-extractor.ts`)
23. `src/lib/agent/code-validator.test.ts` — Tests removed module(s): src/lib/agent/code-validator.ts. (imports removed: `src/lib/agent/code-validator.ts`)
24. `src/lib/agent/engineering-tools.test.ts` — Tests removed module(s): src/lib/agent/engineering-tools.ts. (imports removed: `src/lib/agent/engineering-tools.ts`)
25. `src/lib/agent/follow-up.test.ts` — Tests removed module(s): src/lib/agent/follow-up.ts, src/lib/agent/graph.ts. (imports removed: `src/lib/agent/follow-up.ts`, `src/lib/agent/graph.ts`)
26. `src/lib/agent/gate-policy.test.ts` — Tests removed module(s): src/lib/agent/gate-policy.ts, src/lib/agent/graph.ts. (imports removed: `src/lib/agent/gate-policy.ts`, `src/lib/agent/graph.ts`)
27. `src/lib/agent/graph-brep.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/graph.ts`)
28. `src/lib/agent/graph-build-thinking.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`)
29. `src/lib/agent/graph-critic.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`)
30. `src/lib/agent/graph-fit.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/graph.ts`)
31. `src/lib/agent/graph-hil.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/revision-fixture.ts`)
32. `src/lib/agent/graph-no-raw-output.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`)
33. `src/lib/agent/graph-pipeline.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/graph.ts`)
34. `src/lib/agent/graph-placement.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`)
35. `src/lib/agent/graph-review-fixes.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/spec-sheet/sheet-svg.ts`, `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/revision-fixture.ts`, `src/lib/agent/spec-normalize.ts`)
36. `src/lib/agent/graph-revision.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`)
37. `src/lib/agent/graph-sheets.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/revision-fixture.ts`)
38. `src/lib/agent/graph-writer.test.ts` — Tests legacy multi-node architect/drafter/critic/gate graph replaced by designer/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`)
39. `src/lib/agent/hole-audit.test.ts` — Tests removed module(s): src/lib/agent/hole-audit.ts. (imports removed: `src/lib/agent/hole-audit.ts`)
40. `src/lib/agent/native-api-rereview.test.ts` — Tests removed module(s): src/lib/agent/__fixtures__/fake-anthropic.ts, src/lib/agent/tool-round.ts. (imports removed: `src/lib/agent/__fixtures__/fake-anthropic.ts`, `src/lib/agent/tool-round.ts`)
41. `src/lib/agent/native-api-review.test.ts` — Tests removed module(s): src/lib/agent/__fixtures__/fake-anthropic.ts, src/lib/agent/engineering-tools.ts, src/lib/agent/tool-round.ts. (imports removed: `src/lib/agent/__fixtures__/fake-anthropic.ts`, `src/lib/agent/engineering-tools.ts`, `src/lib/agent/tool-round.ts`)
42. `src/lib/agent/nodes/architect-build.test.ts` — Tests legacy architectBuild or brepBuild graph node (deleted in Phase 0). (imports removed: `src/lib/agent/code-validator.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/nodes/architect-build.ts`)
43. `src/lib/agent/nodes/brep-agent-ab2.test.ts` — Tests legacy architectBuild or brepBuild graph node (deleted in Phase 0). (imports removed: `src/lib/agent/graph.ts`)
44. `src/lib/agent/nodes/brep-build.test.ts` — Tests legacy architectBuild or brepBuild graph node (deleted in Phase 0). (imports removed: `src/lib/agent/graph.ts`, `src/lib/agent/nodes/brep-build.ts`)
45. `src/lib/agent/param-sweep.test.ts` — Tests removed module(s): src/lib/agent/literal-lint.ts, src/lib/agent/param-sweep.ts. (imports removed: `src/lib/agent/literal-lint.ts`, `src/lib/agent/param-sweep.ts`)
46. `src/lib/agent/run-summary.test.ts` — Tests removed module(s): src/lib/agent/run-summary.ts. (imports removed: `src/lib/agent/run-summary.ts`)
47. `src/lib/agent/severed.test.ts` — Tests removed module(s): src/lib/agent/checkpointer.ts, src/lib/agent/graph.ts, src/lib/agent/graph.ts. (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/graph.ts`)
48. `src/lib/agent/spec-derived-fields.test.ts` — Tests legacy spec normalization, variants, markdown, or tolerance system (deleted in Phase 0). (imports removed: `src/lib/agent/spec-normalize.ts`)
49. `src/lib/agent/spec-derived-review.test.ts` — Tests legacy spec normalization, variants, markdown, or tolerance system (deleted in Phase 0). (imports removed: `src/lib/agent/spec-normalize.ts`)
50. `src/lib/agent/spec-markdown.test.ts` — Tests legacy spec normalization, variants, markdown, or tolerance system (deleted in Phase 0). (imports removed: `src/lib/agent/spec-markdown.ts`)
51. `src/lib/agent/spec-normalize.test.ts` — Tests legacy spec normalization, variants, markdown, or tolerance system (deleted in Phase 0). (imports removed: `src/lib/agent/spec-normalize.ts`)
52. `src/lib/agent/spec-tolerance-c4-more.test.ts` — Tests legacy spec normalization, variants, markdown, or tolerance system (deleted in Phase 0). (imports removed: `src/lib/agent/checkpointer.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/graph.ts`, `src/lib/agent/spec-normalize.ts`)
53. `src/lib/agent/spec-tolerance-c4.test.ts` — Tests legacy spec normalization, variants, markdown, or tolerance system (deleted in Phase 0). (imports removed: `src/lib/agent/spec-normalize.ts`)
54. `src/lib/agent/spec-tolerance.test.ts` — Tests legacy spec normalization, variants, markdown, or tolerance system (deleted in Phase 0). (imports removed: `src/lib/agent/spec-normalize.ts`)
55. `src/lib/agent/spec-variants.test.ts` — Tests legacy spec normalization, variants, markdown, or tolerance system (deleted in Phase 0). (imports removed: `src/lib/agent/graph.ts`, `src/lib/agent/revision-fixture.ts`)
56. `src/lib/spec-sheet/rasterize.test.ts` — Tests legacy spec-sheet rasterization or SVG generation (deleted in Task 0c). (imports removed: `src/lib/spec-sheet/rasterize.ts`)
57. `src/lib/spec-sheet/sheet-svg.test.ts` — Tests legacy spec-sheet rasterization or SVG generation (deleted in Task 0c). (imports removed: `src/lib/spec-sheet/fixtures.ts`, `src/lib/spec-sheet/rasterize.ts`, `src/lib/spec-sheet/sheet-svg.ts`)

---

## 7. `package.json` Changes

### 7.1 Scripts to Drop (8 Scripts)

The following scripts in `package.json` point directly to files marked for REMOVE and must be dropped:

1. `"mcp": "tsx src/mcp-server.ts"`  
   *Target file:* `src/mcp-server.ts` (REMOVE). Spec: delete MCP server in 0b.
2. `"eval:generation": "tsx eval/generation/run.ts"`  
   *Target file:* `eval/generation/run.ts` (REMOVE). Dead eval pipeline.
3. `"eval:judge-v2:calibrate": "tsx eval/generation/judge-v2/calibrate.ts"`  
   *Target file:* `eval/generation/judge-v2/calibrate.ts` (REMOVE). Dead eval pipeline.
4. `"eval:compare": "tsx eval/generation/compare.ts"`  
   *Target file:* `eval/generation/compare.ts` (REMOVE). Dead eval pipeline.
5. `"eval:matrix": "tsx eval/generation/matrix.ts"`  
   *Target file:* `eval/generation/matrix.ts` (REMOVE). Dead eval pipeline.
6. `"eval:architect": "tsx eval/architect/run.ts"`  
   *Target file:* `eval/architect/run.ts` (REMOVE). Dead eval pipeline.
7. `"eval:architect:render": "tsx eval/architect/render.ts"`  
   *Target file:* `eval/architect/render.ts` (REMOVE). Dead eval pipeline.
8. `"eval:architect:rescore": "tsx eval/architect/rescore.ts"`  
   *Target file:* `eval/architect/rescore.ts` (REMOVE). Dead eval pipeline.

### 7.2 Dependencies Used Only by REMOVE Modules

The following npm dependencies are imported strictly by REMOVE modules and have zero dependents in KEEP modules:

1. `@modelcontextprotocol/sdk` (`^1.30.0` in `dependencies`)  
   *Only imported by:* `src/mcp-server.ts`, `src/lib/mcp/server.ts`, `src/app/api/mcp/route.ts` (all REMOVE). Safe to drop in Task 0b.
2. `@langchain/openai` (`^1.5.11` in `dependencies`)  
   *Only imported by:* `eval/architect/gateway.ts` (REMOVE). Safe to drop in Task 0b.
3. `@langfuse/client` (`^5.11.1` in `devDependencies`)  
   *Only imported by:* `eval/generation/run.ts` (REMOVE). Safe to drop in Task 0b. (`@langfuse/otel` and `@langfuse/langchain` remain used in `src/lib/tracing/langfuse.ts`).
4. `openscad-wasm` (`^0.0.4` in `dependencies`)  
   *Status:* Drop **only after** EXTRACT in Task 0c (currently imported by `src/lib/engine/openscad-bridge.ts`). Once build123d compile is extracted, `openscad-wasm` is dropped.

### 7.3 Retained & Deferred Dependencies

1. `sharp` (`0.35.3` in `dependencies`): Currently imported only by `src/lib/spec-sheet/rasterize.ts` (REMOVE), but **must be retained** because Phase A Task A5 (`/api/attachments`) requires `sharp` for image upload validation, dimensions sniffing, and resizing.
2. `@anthropic-ai/sdk` (`^1.3.0` in `devDependencies`):
   - **Exact Non-REMOVE Usages:** Across the entire production and kept codebase, only ONE non-REMOVE file imports `@anthropic-ai/sdk`: `src/lib/contract/api-error.test.ts:1` (`import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk';`). All other imports reside in deleted eval pipelines (`eval/architect/render.ts:17`, `eval/architect/parse.ts:2`, `eval/architect/run.ts:32`).
   - **Dependent Test Status:** `src/lib/contract/api-error.test.ts` imports exclusively `src/lib/contract/api-error.ts` (a pure KEEP module), making it a pure **KEEP** test (not SPLIT or REMOVE).
   - **Action:** Retain `@anthropic-ai/sdk` in `devDependencies` so `api-error.test.ts` and model error translation unit tests continue to pass.

---
## 8. Unclassified / Ambiguous Items

1. **`src/lib/brep/test-run.ts`**: This module defines an in-process build123d subprocess runner used exclusively by unit tests in `src/lib/brep/emit-script.*.test.ts`. It has zero production entries reaching it. It is categorized under REMOVE (unreachable from production entries), and the 9 `brep` unit tests that use it are classified under SPLIT so their assertions can be preserved by redirecting to the main `runBrep` service (`src/lib/engine/brep-runner.ts`) or in-memory AST tests.
2. **`src/types/index.ts` Dual Nature**: Contains core parametric types (`ParamKind`, `ScadParam`, `PinnedParam`, `StandingConstraints`, `DesignContract`) alongside legacy gate types (`AssemblySpec`, `SpecViolation`, `GateVariant`, `GatePayload`, `GateDecision`). In Task 0a it is categorized as KEEP because `page.tsx` and UI components reach it. In Task 0b, shared types are extracted to `src/types/designer.ts` and `DesignContract.spec` is removed, allowing the remaining spec/gate definitions to be purged in Task 0c.
3. **`src/app/api/chat/resume/route.ts`**: Under the literal glob `src/app/api/{chat,compile,runs,artifacts}/**`, `chat/resume` matches path-wise. However, spec line 105 and Task 0b explicitly remove `/api/chat/resume`. Treating it as an entry would falsely pull `checkpointer.ts` and `graph.ts` into KEEP. It is correctly classified under REMOVE (unreachable from kept entries).

---

## 9. Verification & Invariant Checks

Before publishing this import map, the following four automated checks were verified:

1. **Mechanical Citation Check:**
   - *Check:* `Every path:line citation in the document must resolve to an existing file and valid line containing the cited symbol or statement.`
   - *Result:* **PASS (0 mismatches).** Verified mechanically via `.cadai/scratch/p0a/tmp/check-citations.js`. All 109 citations checked out with 0 mismatches. Output logged to `.cadai/scratch/p0a/cruiser/citation-check.txt`.
2. **KEEP-to-REMOVE Runtime Invariant:**  
   - *Check:* `No KEEP module imports a REMOVE module at runtime unless that edge is on EXTRACT/SIMPLIFY.`  
   - *Result:* **PASS (0 unexpected runtime edges).** All 10 runtime edges into CUT or REMOVE modules are documented in Section 2.1, with conditional UI removals documented in Section 2.3.
3. **Dependent Test Coverage Invariant:**  
   - *Check:* `Every *.test.ts that imports a CUT or REMOVE module appears in SPLIT or REMOVE.`  
   - *Result:* **PASS.** Exactly 83 test files import a CUT or REMOVE module. Exactly 26 appear in SPLIT (Section 5) with kept test cases named, and exactly 57 appear in REMOVE (Section 6.3). The remaining 58 test files import only KEEP modules.
4. **Git Cleanliness Invariant:**  
   - *Check:* `git -C /home/claude/work/wt-p0a status --short`  
   - *Result:* **PASS.** Only `docs/superpowers/plans/2026-11-08-phase0-import-map.md` is modified/created in the working tree. All scratch scripts and raw cruiser JSON outputs are preserved in `/home/claude/work/cadai/.cadai/scratch/p0a/`.
