# Model-First Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **In this project, tasks run in herdr lanes:** an Opus (medium, fast) orchestrator per lane, and a Gemini implementer. The chairman merges into `task/dz` and gates each merge.

**Goal:** Turn cadai into a 3D-modeling-first app.
- a landing page and projects;
- the layout B workspace in the glass style;
- the first direct modeling tools (Text, Texture, Hole/cut, Measure, Section), with layers.

Every manual edit stays parametric build123d code.

**Architecture:**
- **Phase 1** rebuilds the client shell around a full-screen viewport with floating panels, and adds a `projects` entity on the server.
- **Phase 2** adds:
  - B-Rep topology from the geo service (face ids per triangle, exact face, edge and hole data);
  - a pure-TS tool-op layer that writes delimited `# cadai:op` blocks into the body;
  - an Apply endpoint that saves a `user_edit` version;
  - the tool UIs on one shared settings/preview/Apply pattern.

**Tech Stack:**
- Next.js 16.3, React 19.2, Tailwind CSS v4;
- shadcn/ui on Radix (new), lucide-react, Inter (new) with Geist Mono;
- three.js, React Three Fiber and drei;
- Zustand, Monaco;
- Postgres or PGlite through the existing `DbRunStore` layer;
- the build123d geo service (Python).

**Spec:** `docs/superpowers/specs/2026-11-09-model-first-workspace-design.md`. Read it first, with its mockups: `style-a-glass-v2.html`, `landing-v3.html` and `tool-engrave.html` in `.cadai/scratch/pa/brainstorm-ui/.superpowers/brainstorm/531507-1794189903/content/`. The review page is https://claude.ai/artifact/97Cw4rBbKdrUukvgueUsg4.

## Global Constraints
- **Desktop only:** no phone or tablet layout work.
- **Every UI string is a fixed phrase or server-rendered markdown.** No raw model output. No emoji anywhere in the UI: icons are `lucide-react` only.
- **Fonts:** Inter for the UI (`next/font/google`), Geist Mono for code and numbers.
- **Style A, "graphite glass" (v2):**
  - background: dark graphite (`#0c0f15` to `#1a2230`), a soft blue/violet/cyan glow, and a faint grid that fades at the edges;
  - glass panels: a white tint of about 11% to 7%, `backdrop-filter: blur(28px) saturate(160%)`, a hairline border with a lighter top edge, a soft large shadow, a ~24 px panel radius, and pill-shaped bars, buttons and chips;
  - accent: the gradient `#6b9bff` to `#a08bff`.
- **All colors, radii, blur and shadows are tokens in `src/app/globals.css`.** The glass surface is one shared utility, `glass`. No literal colors in components.
- **Component library:** shadcn/ui on Radix for every dropdown, menu, dialog, popover, tooltip, slider, tab and toggle. Toasts use Sonner, and motion uses `tw-animate-css` plus CSS transitions.
- **Next.js:** read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (AGENTS.md).
- **Migrations are additive only.** New files start at `db/migrations/0003_*`; `0002_u1.sql` exists. Each migration is owned by one task: 0003 (Task 2), 0004 (Task 10), 0005 (Task 11), 0006 (Task 17).
- **The server owns history.** Every write goes through store functions that take a `Queryable` first, and lifecycle writes run inside `db.transaction` (`requireTransaction`). The lock order is threads, then runs.
- **Generated code must pass `checkPythonScript`** (`src/lib/brep/body-check.ts`). Tool code never adds imports.
- **Parametric intent:** every number a tool writes is a named parameter in its block.
- **Tests:**
  - vitest with `--maxWorkers=2`, under `flock /home/claude/work/cadai/.cadai/scratch/test.lock`;
  - the `unit` project, plus `pg` for DB tasks;
  - node environment: component tests render with `react-dom/server` `renderToStaticMarkup` and drive store actions. No jsdom or testing-library (follow `src/components/client-versions.test.tsx`).
  - Python tests: `pytest` in `geo/tests`.
- **"Can it fail":** every new test is shown red against a hand mutation of the behavior it guards. Record the pair in the lane report.

## Review Focus
1. **A tool Apply while an AI run is active on the same thread.** Expect 409 `RUN_ACTIVE` with the fixed phrase. The Apply button shows it, and the design is not changed. Test in Task 11.
2. **An AI edit after a manual op.** The designer must keep the `# cadai:op` block and its parameters: no lost engraving, and a re-run keeps the op. Test in Task 17 (prompt) and Task 11 (parse round-trip after a body rewrite that keeps the block).
3. **Face picking on a model whose topology is missing** (an old version with no `topology` artifact). Tools that need a face are disabled with the fixed phrase "Rebuild this version to use modeling tools." Test in Task 12.
4. **Deleting the project that is open, or the last project.** Confirm first. After deletion, land on `/` with the list refreshed, and no dangling thread. Test in Task 4 (store) and Task 2 (archive cascades to threads).
5. **A brand-new owner opens `/`**, with no projects and legacy null-project threads. Exactly one "My designs" project is created, the old threads move into it, and calling twice never makes two. Test in Task 2.

---

## File Structure

**Phase 1 (server):**
- `db/migrations/0003_projects.sql`
- `src/lib/persist/projects.ts` (`ProjectStore`)
- `src/app/api/projects/route.ts`
- `src/app/api/projects/[id]/route.ts`
- `src/app/api/projects/[id]/threads/route.ts`
- changes to `src/lib/runs/db-run-store.ts` (`start`) and `src/lib/persist/types.ts` (`ChatRequest`).

**Phase 1 (client):**
- **Theme and stack:**
  - `src/app/globals.css` (tokens, `glass`);
  - `src/app/layout.tsx` (Inter);
  - `components.json`;
  - `src/components/ui/*` (shadcn).
- **Routes:**
  - `src/app/page.tsx` (landing);
  - `src/app/p/[projectId]/page.tsx` (workspace; the thread is in `?t=`).
- **Landing:** `src/components/landing/{landing-page,start-input,starter-ideas,project-grid}.tsx`, plus `starter-ideas.ts`.
- **Workspace:**
  - `src/components/workspace/{workspace,app-header,project-menu,floating-panel,export-menu,code-drawer}.tsx`;
  - `src/components/chat/{chat-panel,chat-input,threads-menu,message-bubble}.tsx`;
  - `src/components/inspector/{inspector,layers-section,properties-section,versions-section,model-info}.tsx`;
  - `src/components/viewport/{viewport-panel,viewport-toolbar,view-presets}.tsx`.
- **State:** `src/store/projects-slice.ts`; `src/lib/client/server-projects.ts`.
- **Deleted:**
  - `src/components/layout/{header,split-pane}.tsx`;
  - `src/components/chat/{thread-drawer,version-list}.tsx`;
  - `src/components/design/design-panel.tsx` (its controls move to the inspector);
  - the demo-thread bootstrap in `thread-storage.ts`.

**Phase 2:**
- **geo:** `geo/cadai_geo/topology.py`, `geo/cadai_geo/fonts/*.ttf`, and `geo/tests/test_topology.py`.
- **TS:**
  - `src/lib/geometry/topology.ts`;
  - `src/lib/tools/{ops,op-text,op-texture,op-hole,op-material,layers,phrases}.ts`;
  - `src/app/api/threads/[id]/versions/route.ts`;
  - `db/migrations/0004_topology.sql`, `0005_tool_edits.sql`, `0006_message_layer.sql`.
- **UI:**
  - `src/components/tools/{tool-registry,tool-settings-panel,face-picker,op-preview,text-tool,texture-tool,hole-tool,measure-tool,section-tool}.tsx`;
  - `src/store/tools-slice.ts`.

---

# Phase 1: landing, projects, workspace, style

**Lane order:**
1. Task 1 ∥ Task 2.
2. Task 3.
3. Task 4 ∥ Task 5.
4. Task 6 ∥ Task 7 ∥ Task 8.
5. Task 9.

The chairman gates and merges after each step.

### Task 1: Stack, theme tokens and the glass surface

**Files:**
- Modify: `package.json`, `src/app/globals.css`, `src/app/layout.tsx`
- Create: `components.json`, `src/components/ui/{button,dropdown-menu,dialog,alert-dialog,popover,tooltip,slider,tabs,toggle-group,input,textarea,sonner}.tsx`, `src/lib/utils.ts` (`cn`, if missing)
- Test: `src/app/theme.test.ts`, `src/components/no-emoji.test.ts`

**Interfaces:**
- Produces:
  - the CSS tokens `--bg`, `--bg-glow-1..3`, `--glass-tint-top`, `--glass-tint-bottom`, `--glass-border`, `--glass-border-top`, `--glass-blur`, `--radius-panel`, `--accent-from`, `--accent-to`, `--fg`, `--fg-muted`;
  - the Tailwind utility `glass` (`@utility glass`);
  - `--font-inter` and `--font-geist-mono`;
  - the shadcn components above, themed by the tokens.

- [ ] **Step 1: Write the failing tests**
  - `theme.test.ts`:
    - `globals.css defines the style A tokens`: reads the file, and every token named above is declared.
    - `the glass utility uses the tokens`: the `@utility glass` block contains `backdrop-filter`, `var(--glass-blur)` and `var(--radius-panel)`.
  - `no-emoji.test.ts`: `no emoji in UI source`. It scans `src/components/**/*.tsx`, `src/app/**/*.tsx` and `src/lib/storage/*.ts` for `/\p{Extended_Pictographic}/u` and expects zero matches. Audit #8.
- [ ] **Step 2:** Run `npx vitest run --project unit src/app/theme.test.ts src/components/no-emoji.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Run `npx shadcn@latest init` for Tailwind v4, Next and the `new-york` style. Add the components above.
  - Add `tw-animate-css` and `sonner`.
  - Load Inter in `layout.tsx` with `next/font/google`, keeping Geist Mono.
  - Put the style A values from Global Constraints into tokens, and map shadcn's `--background`, `--primary`, … to them.
  - Replace every emoji in source with Lucide icons or plain text.
- [ ] **Step 4:** Rerun the tests: PASS. Then tsc and the full unit suite.
- [ ] **Step 5:** Commit: `feat(ui): style A tokens, glass surface, shadcn/Radix, Inter`.

### Task 2: Projects on the server

**Files:**
- Create: `db/migrations/0003_projects.sql`, `src/lib/persist/projects.ts`, `src/app/api/projects/route.ts`, `src/app/api/projects/[id]/route.ts`, `src/app/api/projects/[id]/threads/route.ts`
- Modify: `src/lib/persist/types.ts` (`ChatRequest.projectId?: string`), `src/lib/runs/db-run-store.ts` (`start`), `src/app/api/chat/route.ts` (validation), `src/lib/persist/threads.ts` (list by project)
- Test: `src/lib/persist/projects.test.ts`, `src/lib/persist/projects.pg.test.ts`, `src/app/api/projects/route.test.ts`, additions to `src/app/api/chat/route.test.ts`

**Interfaces:**
- **The migration:**
  - `projects(id uuid primary key, owner_key text not null, name text not null, created_at, updated_at, archived_at)`, with an index on `(owner_key, updated_at desc) where archived_at is null`;
  - `alter table threads add column project_id uuid references projects(id)`, with an index on `(project_id, updated_at desc)`.
- **`ProjectStore`** (every method takes a `Queryable` first):
  - `create(q, ownerKey, name): Promise<ProjectRow>`;
  - `list(q, ownerKey, { search?, limit?, before? }): Promise<ProjectSummary[]>`;
  - `get(q, ownerKey, id): Promise<ProjectRow | null>`;
  - `rename(q, ownerKey, id, name)`;
  - `archive(q, ownerKey, id)`: transactional; it also archives the project's threads, and refuses with 409 `RUN_ACTIVE` while any of them has an active run;
  - `ensureDefault(q, ownerKey): Promise<string>`: transactional and idempotent; it creates "My designs" only when the owner has threads with a null `project_id`, and moves them into it.
- **`ProjectSummary`:** `{ id, name, updatedAt, threadCount, thumbnailArtifactId: string | null }`. The thumbnail is the newest design's `stl_artifact` across its threads; the client renders it.
- **Routes:**
  - `GET /api/projects?search=&limit=&before=` (calls `ensureDefault` first);
  - `POST /api/projects {name}` → 201 `{project}`;
  - `PATCH` and `DELETE /api/projects/:id`;
  - `GET /api/projects/:id/threads`.
- **`start` and `ChatRequest.projectId`:**
  - when the thread is new, `start` inserts it with `project_id = projectId`;
  - the project must be the owner's: otherwise 404, phrase `NOT_FOUND`;
  - a missing `projectId` on a new thread gives 400 `BAD_REQUEST` "A new thread needs a project.";
  - for an existing thread, `projectId` must match its project: otherwise 400.

- [ ] **Step 1: Write the failing tests.**
  - `create then list returns the project with threadCount 0`.
  - `list filters by a case-insensitive search on name`.
  - `ensureDefault moves null-project threads into one "My designs" project and is idempotent`: call it twice, and assert one project and the same id.
  - `ensureDefault creates nothing for an owner without legacy threads`.
  - `archive archives the project's threads`.
  - `archive refuses while a thread has an active run (409 RUN_ACTIVE)`.
  - `another owner's project is 404 on GET, PATCH and DELETE`.
  - `chat: a new thread without projectId is 400`.
  - `chat: a new thread is created in the given project`.
  - `chat: a projectId that differs from the thread's project is 400`.
  - pg: `two concurrent ensureDefault calls create one project`.
- [ ] **Step 2:** Run them (`--project unit` for the files above, and `--project pg` for the projects pg file). Expect FAIL.
- [ ] **Step 3: Implement** the migration, `ProjectStore`, the routes and the `start` changes. Routes follow the error shapes of `src/app/api/threads/[id]/route.ts`.
- [ ] **Step 4:** Rerun: PASS. Then tsc, unit and pg.
- [ ] **Step 5:** Commit: `feat(projects): projects entity, routes, threads scoped to a project`.

### Task 3: Client routing, the projects slice and empty new threads

**Files:**
- Create: `src/lib/client/server-projects.ts`, `src/store/projects-slice.ts`, `src/app/p/[projectId]/page.tsx`
- Modify:
  - `src/app/page.tsx` (it becomes the landing route; the shell lands in Task 4);
  - `src/store/app-store.ts`: threads are scoped to `activeProjectId`; `sendMessage` sends `projectId`; remove the demo bootstrap;
  - `src/lib/storage/thread-storage.ts`: remove `createInitialThread`'s demo and `DEFAULT_CODE` as the starting model.
- Test: `src/store/projects-slice.test.ts`, additions to `src/components/client-threads.test.tsx`

**Interfaces:**
- `server-projects.ts`: `listProjects(opts)`, `createProject(name)`, `renameProject(id, name)`, `deleteProject(id)`, `listProjectThreads(id)`. They throw `ServerError { status, code, message }`, as `server-thread.ts` does.
- `projects-slice.ts`:
  - state: `projects`, `activeProjectId`, `projectsStatus`;
  - actions: `loadProjects(search?)`, `openProject(id)`, `startProject(prompt, { attachments, model })`, `newThread()`, `deleteProject(id)`, `renameProject(id, name)`.
- `startProject` creates the project, named from the prompt's first 60 characters trimmed at a word boundary. It routes to `/p/<id>?t=<newThreadId>` and calls `sendMessage` with `projectId`.
- **`newThread()`:** the thread starts with `messages = [WELCOME]`, where `WELCOME` is a fixed phrase in `src/lib/persist/phrases.ts`: "Describe a part to start, or attach a sketch." It has an empty viewport (`geometry = null`, `code = ''`) and no versions. Audit #12.

- [ ] **Step 1: Write the failing tests.**
  - `startProject creates a project, routes to it and sends the first message with projectId`.
  - `newThread shows only the welcome message and an empty viewport`.
  - `the first load never shows a legacy banner or a disabled input`: audit #1.
  - `sendMessage on a thread includes projectId`.
  - `deleteProject of the open project routes to / and refreshes the list`: Review Focus 4.
- [ ] **Step 2:** Run them. FAIL.
- [ ] **Step 3: Implement.** Routing uses `next/navigation` (read `node_modules/next/dist/docs/` for the App Router navigation API). `src/app/p/[projectId]/page.tsx` renders the workspace with `ssr: false`, as today's split pane does.
- [ ] **Step 4:** Rerun: PASS. Then tsc and unit.
- [ ] **Step 5:** Commit: `feat(client): project routes, projects slice, empty new threads`.

### Task 4: Landing page

**Files:**
- Create: `src/components/landing/landing-page.tsx`, `start-input.tsx`, `project-grid.tsx`, `starter-ideas.ts`
- Modify: `src/app/page.tsx`
- Test: `src/components/landing/landing.test.tsx`, `src/components/landing/starter-ideas.test.ts`

**Interfaces:**
- `STARTER_IDEAS: readonly string[]`: at least 10 hardware-level ideas. It includes these five verbatim, the rest in the same register:
  - "NEMA 17 motor mount with belt tensioner"
  - "Raspberry Pi 5 enclosure with fan and port cutouts"
  - "608 bearing pillow block, M5 bolts"
  - "2020 extrusion corner bracket"
  - "Hinged electronics box with cable gland"
- `pickTwo(rand: () => number): [string, string]`.
- `StartInput` props: `{ onStart(prompt, { attachments, model }) }`. It contains the image button and the model selector inside the box (the same components the chat input uses, from Task 6).
- `ProjectGrid`: cards with a thumbnail (`/api/artifacts/<thumbnailArtifactId>` rendered by a small static three canvas, or a placeholder icon when null), the name, "N threads" and a relative edited time. It has a search field and "Show all".
- **Layout:**
  - the logo and "cadai" sit top-left;
  - "What do you want to make?" and the input sit **centered on screen**;
  - two idea chips sit under the input;
  - the project grid sits **below**.

- [ ] **Step 1: Write the failing tests.**
  - `pickTwo returns two different ideas from STARTER_IDEAS`.
  - `STARTER_IDEAS has at least 10 entries and no emoji`.
  - `the landing renders the heading, the input with an image button and a model selector, two ideas and the project grid`.
  - `clicking an idea fills the input` (store/state-level).
  - `search filters the grid by name`.
  - `Start with empty text is disabled`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement**, matching `landing-v3.html` and the style A tokens.
- [ ] **Step 4:** PASS. Then tsc and unit.
- [ ] **Step 5:** Commit: `feat(landing): centered start input, two hardware ideas, project grid`.

### Task 5: Workspace shell (layout B)

**Files:**
- Create: `src/components/workspace/workspace.tsx`, `app-header.tsx`, `project-menu.tsx`, `floating-panel.tsx`
- Delete: `src/components/layout/header.tsx`, `src/components/layout/split-pane.tsx`
- Test: `src/components/workspace/workspace.test.tsx`

**Interfaces:**
- **`FloatingPanel`:** props `{ side: 'left' | 'right'; collapsed: boolean; onToggle(); widthPx: number; children }`. It is a glass panel that collapses into its own side's edge only, with a slim tab to expand. The collapsed state is remembered per viewer in `localStorage`, behind try/catch.
- **`Workspace`:**
  - the viewport fills the window (`position: fixed; inset: 0`);
  - **header** (top-left): the logo, "cadai" and the `ProjectMenu` (the project name, which opens switch/new/rename/delete, with delete behind an `AlertDialog`);
  - **chat**: a `FloatingPanel side="left"`;
  - **tool bar**: top center;
  - **Export**: top right;
  - **inspector**: a `FloatingPanel side="right"`.
  - The header shows nothing else (audit #13).

- [ ] **Step 1: Write the failing tests.**
  - `the header shows only the logo, "cadai" and the project menu`: no "Engine", "Units", "AGENTIC" or model selector text.
  - `the chat panel is on the left and collapses to the left edge`.
  - `the inspector is on the right`.
  - `deleting a project from the menu asks for confirmation first`: audit #6.
  - `the collapsed state survives a remount when localStorage works and defaults to open when it throws`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement** with the shadcn `DropdownMenu` and `AlertDialog` and the `glass` utility.
- [ ] **Step 4:** PASS. Then tsc and unit.
- [ ] **Step 5:** Commit: `feat(workspace): full-screen viewport shell with floating panels and minimal header`.

### Task 6: Chat panel

**Files:**
- Create: `src/components/chat/threads-menu.tsx`
- Modify: `src/components/chat/chat-panel.tsx`, `chat-input.tsx`, `message-bubble.tsx`, `transcript-view.tsx`
- Delete: `src/components/chat/thread-drawer.tsx`, `src/components/chat/version-list.tsx`
- Test: `src/components/chat/chat-panel.test.tsx`

**Interfaces:**
- **`ThreadsMenu`:** the current thread's title, a list of the project's threads, "+ New thread", and rename/delete (delete behind an `AlertDialog`).
- **The `ChatInput` box contains:**
  - the selected-layer chip (wired in Task 17);
  - attachment chips (U1 states);
  - the textarea;
  - a bottom row with the image button (`ImagePlus`), the **model selector** (moved from the header) and Send, which becomes **the only Stop** while running (audit #9).
- **Messages** use pill and rounded glass styling. The Steps block stays as U1 built it. A `tool_edit` message renders as a small inline line, not a bubble (Task 11 produces them).
- **Prompt chips** show only in an empty thread.

- [ ] **Step 1: Write the failing tests.**
  - `the input box contains the image button, the model selector and Send`.
  - `there is exactly one Stop control while a run streams`.
  - `the threads menu lists the project's threads and New thread`.
  - `deleting a thread asks for confirmation first`.
  - `there is no version list in the chat panel`.
  - `a tool_edit message renders as an inline line`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS. Then tsc and unit.
- [ ] **Step 5:** Commit: `feat(chat): threads menu, selector and image button in the input, single Stop`.

### Task 7: Inspector (Layers, Properties, Versions)

**Files:**
- Create: `src/components/inspector/inspector.tsx`, `layers-section.tsx`, `properties-section.tsx`, `versions-section.tsx`, `model-info.tsx`
- Modify: `src/components/design/param-control.tsx`
- Delete: `src/components/design/design-panel.tsx`
- Test: `src/components/inspector/inspector.test.tsx`

**Interfaces:**
- **Layers (Phase 1):** one row per part label from the compile/`facts` parts (`BrepPart.label`). Selecting a row sets `selectedLayerId` in the store and highlights that part's mesh.
- **Properties:** **all model parameters**, from `parseParams(code)`, in every state. It moves the param controls from `design-panel.tsx`. The pin indicator and reset are always visible and keyboard-reachable (audit #11).
- **Versions:** the list moved from the chat ("v3 · Your edit · now", "v2 · Designer"). Selecting one calls `selectVersion(n)` and **scrolls to and highlights the chat message whose `design_version` is n** (audit #5).
- **Model info:** collapsed by default. It shows the bounding box, volume and part count from today's print-analysis data, read-only.

- [ ] **Step 1: Write the failing tests.**
  - `layers list the model's part labels`.
  - `selecting a part layer keeps Properties showing all parameters`: the user's decision.
  - `the pin indicator is visible without hover`.
  - `selecting a version highlights the message that made it`.
  - `model info is collapsed by default`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS. Then tsc and unit.
- [ ] **Step 5:** Commit: `feat(inspector): layers, properties, versions linked to chat`.

### Task 8: Viewport tool bar, view presets, export menu and code drawer

**Files:**
- Create: `src/components/viewport/view-presets.tsx`, `src/components/workspace/export-menu.tsx`, `src/components/workspace/code-drawer.tsx`
- Modify: `src/components/viewport/viewport-panel.tsx`, `viewport-toolbar.tsx`, `src/components/editor/code-editor-panel.tsx`
- Delete: the STL/3MF buttons in `src/components/print-analysis/print-analysis-panel.tsx`
- Test: `src/components/viewport/viewport.test.tsx`, `src/components/workspace/export-menu.test.ts`

**Interfaces:**
- **The tool bar** is a pill bar at the top center. In Phase 1 it holds: select, wireframe, edges, the view presets menu and markup (pen). Phase 2 adds tools through `ToolRegistry` (Task 12).
- **`setViewPreset(preset: 'top' | 'front' | 'right' | 'iso'): void`:** frames the model with the camera on that axis (iso is +X+Y+Z).
- **`exportFileName(designTitle: string, version: number | null, ext: 'stl' | 'step' | '3mf'): string`:** produces a slug, then `-v<n>.<ext>`, for example `motor-mount-v3.step`, and `-draft` when the version is null. Audit #3.
- **`ExportMenu`:** STL, STEP and 3MF for the viewed version.
- **`CodeDrawer`:** Monaco with the body and the prelude note, opened from the inspector's "Code" button. It slides up from the bottom over the viewport and keeps the inspector visible. The Monaco markers are set from the compile error line (`BrepResult.line`) (audit #7).
- **Three.js:** use `THREE.Timer`, and no `PCFSoftShadowMap` (audit #16).

- [ ] **Step 1: Write the failing tests.**
  - `exportFileName("Motor mount", 3, "step") is "motor-mount-v3.step"`.
  - `exportFileName with a null version ends in -draft`.
  - `the export menu offers STL, STEP and 3MF`.
  - `view presets place the camera on the expected axis` (pure camera-position function).
  - `a compile error sets a Monaco marker on the error line` (pure marker builder).
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS. Then tsc and unit.
- [ ] **Step 5:** Commit: `feat(viewport): tool bar, view presets, one export menu, code drawer`.

### Task 9: Phase 1 integration gate
- [ ] tsc, unit and pg under the lock; eslint on the changed files.
- [ ] `next build` in `/home/claude/work/wt-dz-a3`, detached at the merged commit, under the lock.
- [ ] **Delete dead code:** `react-resizable-panels` if unused, and the print-analysis download code paths.
- [ ] **The chairman's browser smoke** on the dev server:
  - landing → Start → build → edit;
  - a new thread is empty;
  - project switch, rename and delete (confirm);
  - export names;
  - view presets;
  - the code drawer;
  - the version → message highlight.
- [ ] Commit any fix: `fix(phase1): …`.

---

# Phase 2: topology, tool ops, tools, layers

**Lane order:**
1. Task 10 ∥ Task 11.
2. Task 12.
3. Task 13 ∥ Task 14 ∥ Task 15 ∥ Task 16.
4. Task 17.
5. Task 18.

### Task 10: B-Rep topology from the geo service

**Files:**
- Create: `geo/cadai_geo/topology.py`, `geo/tests/test_topology.py`, `src/lib/geometry/topology.ts`, `src/lib/geometry/topology.test.ts`
- Modify: `geo/cadai_geo/run.py` (a `--topology` flag), `geo/cadai_geo/service.py` (the option), `src/lib/engine/brep-runner.ts` (`RunBrepOptions.topology`, `BrepResult.topology`), `src/app/api/compile/route.ts` (requests topology), the designer commit path (saves `topology` as an artifact of kind `topo`)

**Interfaces:**
- **Python:** `export_topology(result, parts) -> dict`. The tessellation is per B-Rep face (`face.tessellate(tolerance=0.05, angular_tolerance=0.2)`). It returns:
  - `{ "mesh": { "positions": [...], "indices": [...], "faceIds": [...] } }`, with one face id per triangle;
  - `"faces": [{ "id", "part", "kind": "plane|cylinder|cone|sphere|torus|other", "area", "center": [x,y,z], "normal"?: [..], "axis"?: [..], "radius"?: r }]`;
  - `"edges": [{ "id", "kind": "line|circle|other", "length", "radius"?, "center"?, "faces": [a, b] }]`.
- **TS:** `type Topology = { mesh: { positions: Float32Array; indices: Uint32Array; faceIds: Uint32Array }; faces: TopoFace[]; edges: TopoEdge[] }`, `decodeTopology(json): Topology`, and `faceAtTriangle(topo, triIndex): TopoFace`.
- **The artifact:** the `artifacts.kind` comment gains `topo` (JSON, gzipped). **Task 10 owns `db/migrations/0004_topology.sql`:** `alter table designs add column topo_artifact text references artifacts(id)`. The thread GET returns `version.topo`.

- [ ] **Step 1: Write the failing tests.**
  - pytest:
    - `a 20 mm cube has 6 plane faces and 12 line edges of length 20`;
    - `a Ø10 through hole yields a cylinder face with radius 5.0 and circle edges with radius 5.0`;
    - `every triangle has a face id that exists in faces`;
    - `faces carry the part label from _cadai_parts`.
  - TS:
    - `decodeTopology round-trips typed arrays`;
    - `faceAtTriangle returns the face of that triangle`.
- [ ] **Step 2:** Run `cd /home/claude/work/<lane-worktree>/geo && /home/claude/work/cadai/.cadai/scratch/venv-dz/bin/python -m pytest tests/test_topology.py -q` and `npx vitest run --project unit src/lib/geometry/topology.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Keep the output under `_max_export_bytes()`. When it is over, skip the topology and set `notes: ['topology skipped: too large']`.
- [ ] **Step 4:** PASS. Then the geo test suite, tsc and unit.
- [ ] **Step 5:** Commit: `feat(geo): B-Rep topology export (face ids per triangle, faces, edges)`.

### Task 11: Tool ops core and the Apply endpoint

**Files:**
- Create: `src/lib/tools/ops.ts`, `src/lib/tools/op-hole.ts`, `src/lib/tools/op-text.ts`, `src/lib/tools/op-texture.ts`, `src/lib/tools/op-material.ts`, `src/lib/tools/layers.ts`, `src/lib/tools/phrases.ts`, `src/app/api/threads/[id]/versions/route.ts`, `db/migrations/0005_tool_edits.sql`
- Modify: `src/lib/runs/db-run-store.ts` (`commitUserEdit`), `src/lib/persist/run-input.ts` (`tool_edit` in history)
- Test: `src/lib/tools/ops.test.ts`, `src/lib/tools/op-hole.test.ts`, `src/app/api/threads/[id]/versions/route.test.ts`, `src/lib/runs/db-run-store.pg.test.ts` (an addition)

**Interfaces:**
- **Types** (`FontId` is defined here; Task 13 supplies the font files):
  ```ts
  type FontId = 'inter-bold' | 'roboto-mono-bold' | 'oswald-semibold';
  type FacePlane = { origin: [number, number, number]; normal: [number, number, number]; xDir: [number, number, number] };
  type OpBase = { id: string; part: string; plane: FacePlane; offset: [number, number]; rotationDeg: number };
  type ToolOp =
    | (OpBase & { kind: 'text'; text: string; font: FontId; sizeMm: number; mode: 'engrave' | 'emboss'; depthMm: number; color?: string })
    | (OpBase & { kind: 'texture'; pattern: 'knurl' | 'hex' | 'ribs' | 'dimples'; pitchMm: number; depthMm: number; areaMm: [number, number] })
    | (OpBase & { kind: 'hole'; size: 'M3' | 'M4' | 'M5' | 'M6' | 'M8' | 'custom'; diameterMm: number; head: 'none' | 'counterbore' | 'countersink'; depthMm: number | 'through' })
    | (OpBase & { kind: 'cut-rect'; widthMm: number; heightMm: number; cornerRadiusMm: number; depthMm: number | 'through' })
    | { kind: 'material'; id: string; target: string | 'model'; material: 'brushed-metal' | 'matte-plastic' | 'wood' | 'color'; color: string };
  ```
- **`renderOpBlock(op: ToolOp): string`:**
  - starts with `# cadai:op <kind> id=<id> <json>` and ends with `# cadai:end <id>`;
  - every number is a named parameter (`<id>_depth = 1.0  # depth mm`, …);
  - it rebinds the target part (`<part> = <part> - <cutter>` or `+`);
  - material blocks hold only the marker lines (no geometry).
- **`applyOp(body: string, op: ToolOp): string`:** inserts the block after the target part's last assignment and before the `_cadai_parts` line. It throws `OpTargetError` when the part is not in `_cadai_parts`.
- **`parseOpBlocks(body: string): ParsedOp[]`**, with `ParsedOp = { op: ToolOp; start: number; end: number }`. It reads the parameter lines back over the JSON, so slider and AI edits win.
- **`listLayers(body: string, parts: string[]): Layer[]`**, with `Layer = { id: string; name: string; kind: 'part' | ToolOp['kind'] }`.
- **The hole presets** (ISO 273 medium clearance; ISO 4762 counterbore; ISO 10642 countersink 90°):
  - M3: clearance 3.4, counterbore Ø6.5 × 3.4 deep, countersink Ø6.3;
  - M4: clearance 4.5, counterbore Ø8.0 × 4.4, countersink Ø8.4;
  - M5: clearance 5.5, counterbore Ø10.0 × 5.4, countersink Ø10.4;
  - M6: clearance 6.6, counterbore Ø11.0 × 6.4, countersink Ø12.6;
  - M8: clearance 9.0, counterbore Ø14.5 × 8.4, countersink Ø17.3.
- **`toolEditPhrase(op: ToolOp, version: number): string`**, in `phrases.ts`, is a fixed template. For example:
  - "You added Hole M5 · v4";
  - "You engraved "CADAI" · v5";
  - "You added Knurl texture · v6";
  - "You set Brushed metal on lid · v7";
  - "You added Cut-out 20 × 10 · v8".
- **The migration (`0005_tool_edits.sql`):**
  - message `kind` gains `tool_edit` (it's a comment only, since kind is text);
  - `designs.ops jsonb not null default '[]'` caches the parsed ops.
- **`POST /api/threads/:id/versions`:**
  - body: `{ clientMessageId, baseVersion: number, body: string, op: ToolOp }`;
  - steps:
    1. check the owner;
    2. lock the thread;
    3. return 409 `RUN_ACTIVE` with the existing phrase when a run is active (Review Focus 1);
    4. check that `baseVersion` exists;
    5. run `checkPythonScript`;
    6. call `runBrep(withGeneratedPrelude(body, prelude), { topology: true, partMeshes: true })`; a failure returns 422 with the compile error;
    7. store the STL, STEP and topology artifacts;
    8. insert a `designs` row (`origin 'user_edit'`, `parent_version` = baseVersion, `edits` = the parent's, `ops` = `parseOpBlocks`);
    9. insert a `messages` row (`role 'user'`, `kind 'tool_edit'`, `content` = `toolEditPhrase`, `design_version`).
  - Steps 7–9 run in one transaction. The same `clientMessageId` twice returns 409 `duplicate_message`.
  - Response: 201 `{ version }`.
- **`run-input`:** the history maps a `tool_edit` message to a user line, so the AI sees "You added Hole M5 · v4".

- [ ] **Step 1: Write the failing tests.**
  - `renderOpBlock output passes checkPythonScript for every op kind`.
  - `applyOp rebinds the target part before _cadai_parts`.
  - `applyOp throws OpTargetError for an unknown part`.
  - `parseOpBlocks round-trips renderOpBlock`.
  - `a parameter line edited after rendering wins over the marker json`: Review Focus 2.
  - `a body rewritten around an intact block still parses the op`: Review Focus 2.
  - `M5 counterbore uses Ø10.0 × 5.4`.
  - `toolEditPhrase("hole M5", 4) is "You added Hole M5 · v4"`.
  - `versions route: 201 creates a user_edit version and a tool_edit message`.
  - `versions route: 409 RUN_ACTIVE while a run is active`.
  - `versions route: 422 with the compile error when the body fails`.
  - `versions route: another owner's thread is 404`.
  - `versions route: a duplicate clientMessageId is 409`.
  - pg: `an apply and a chat start on two connections never both win`.
  - `run-input includes tool_edit lines in history`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.** For geometry in algebra mode:
  - **cutter placement:** `Plane(origin, z_dir=normal, x_dir=xDir) * Pos(offset) * Rot(0, 0, rotationDeg) * shape`;
  - **holes:** `Cylinder` cutters, plus a second `Cylinder` (counterbore) or a `Cone` (countersink);
  - **text:** `extrude(Text(...), amount)`, using the font file path under the prelude-provided font dir constant `CADAI_FONTS` (Task 13 supplies the fonts; until then, test with the default font).
- [ ] **Step 4:** PASS. Then tsc, unit and pg.
- [ ] **Step 5:** Commit: `feat(tools): op blocks in the body, layers, Apply endpoint for user_edit versions`.

### Task 12: Tool framework UI (picking, settings, preview, Apply)

**Files:**
- Create: `src/store/tools-slice.ts`, `src/components/tools/tool-registry.tsx`, `tool-settings-panel.tsx`, `face-picker.tsx`, `op-preview.tsx`
- Modify: `src/components/viewport/viewport-panel.tsx` (it renders the topology mesh with a `faceId` attribute when present), `viewport-toolbar.tsx`, `src/components/inspector/layers-section.tsx` (op layers), `src/components/inspector/properties-section.tsx` (a tool layer shows its own settings)
- Test: `src/store/tools-slice.test.ts`, `src/components/tools/tool-framework.test.tsx`

**Interfaces:**
- **`ToolDef`:**
  ```ts
  { id: 'text' | 'texture' | 'hole' | 'measure' | 'section';
    icon: LucideIcon;
    label: string;
    needsFace: boolean;
    modifies: boolean;
    Settings: React.FC<{ draft; onChange }>;
    initialDraft(face: TopoFace, plane: FacePlane): ToolOp | null }
  ```
  - `TOOLS: ToolDef[]`. Phase 2 tasks 13–16 register into it.
- **`tools-slice` state:** `activeToolId`, `pickedFace`, `draftOp`, `preview: { status: 'idle' | 'compiling' | 'ready' | 'error'; geometry?; error? }`.
- **`tools-slice` actions:**
  - `selectTool(id)`: collapses the chat (`FloatingPanel`) and opens `ToolSettingsPanel` in place of the inspector;
  - `pickFace(triIndex)`;
  - `updateDraft(patch)`: a debounced 400 ms preview, via `POST /api/compile` with `applyOp(body, draft)`;
  - `apply()`: calls the versions route, then `loadServerThread(threadId, version)`, a Sonner "Applied", and clears the tool;
  - `cancel()`: clears the tool with no network call and no change.
- **Gizmo:** drei `PivotControls`, constrained to the face plane. It updates `offset` and `rotationDeg`.
- **No topology on the viewed version:** tools with `needsFace` are disabled, with the fixed phrase "Rebuild this version to use modeling tools." (Review Focus 3).

- [ ] **Step 1: Write the failing tests.**
  - `selecting a tool collapses the chat and opens its settings on the right`.
  - `picking a face creates a draft op on that face's plane`.
  - `updateDraft debounces one preview compile per 400 ms burst`.
  - `apply posts the op and loads the new version`.
  - `apply shows the RUN_ACTIVE phrase on 409 and keeps the draft`.
  - `cancel makes no request and leaves the design unchanged`.
  - `face tools are disabled with the rebuild phrase when topology is missing`.
  - `an op layer's Properties show that op's parameters`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS. Then tsc and unit.
- [ ] **Step 5:** Commit: `feat(tools): tool framework (pick face, settings, live preview, Apply/Cancel)`.

### Task 13: Text tool
**Files:**
- Create: `src/components/tools/text-tool.tsx`, `geo/cadai_geo/fonts/` (OFL TTFs: Inter Bold, Roboto Mono Bold, Oswald SemiBold, with their licenses)
- Modify: `geo/cadai_geo/run.py` (it exposes `CADAI_FONTS` to the script namespace), `src/lib/tools/op-text.ts`
- Test: `geo/tests/test_text_op.py`, `src/components/tools/text-tool.test.tsx`

**Interfaces:**
- **Fonts:** one file per `FontId` from Task 11, at `geo/cadai_geo/fonts/<FontId>.ttf`.
- **The settings, in this order:**
  - Text;
  - Font;
  - Size (mm);
  - Mode (Engrave ↓ or Emboss ↑, a `ToggleGroup`);
  - Depth (mm);
  - Color (it creates a paired `material` op on this layer);
  - Align (left/center/right);
  - Rotation (°).

- [ ] **Step 1: Write the failing tests.**
  - pytest: `engraving "AB" 1 mm deep on a 40×20×5 plate reduces its volume`, and `embossing increases it`.
  - TS:
    - `the text tool shows Text, Font, Size, Mode, Depth, Color, Align and Rotation`;
    - `an empty text disables Apply`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(tools): Text engrave/emboss`.

### Task 14: Texture tool (surface and material)
**Files:**
- Create: `src/components/tools/texture-tool.tsx`
- Modify: `src/lib/tools/op-texture.ts`, `src/lib/tools/op-material.ts`, `src/lib/export/threemf-exporter.ts` (per-part color), `geo/cadai_geo/run.py` (STEP part colors from the material markers, best effort)
- Test: `src/lib/tools/op-texture.test.ts`, `src/lib/export/threemf-exporter.test.ts` (an addition), `geo/tests/test_texture_op.py`

**Interfaces:**
- **Surface:**
  - `pattern`, `pitchMm` (default 2.0), `depthMm` (default 0.4) and `areaMm`, clamped to the face;
  - **at most 400 features per op**; over that, the settings show "Too dense: raise the pitch or shrink the area." and Apply is disabled.
- **Material:**
  - `brushed-metal`, `matte-plastic`, `wood` or a plain `color`;
  - its target is a layer or the whole model;
  - it maps to a viewer `MeshStandardMaterial` preset (metalness, roughness, color);
  - it is written into the 3MF `<basematerials>`, and into STEP colors when the geo export supports them. It never appears in the STL.

- [ ] **Step 1: Write the failing tests.**
  - `a knurl op over 400 features is rejected with the density phrase`.
  - `a hex op renders a block that passes checkPythonScript`.
  - pytest: `a 0.4 mm rib texture changes the face area`.
  - `the 3MF export writes the material color for its part`.
  - `the material op adds no geometry`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(tools): surface textures and materials`.

### Task 15: Hole and cut-out tool
**Files:**
- Create: `src/components/tools/hole-tool.tsx`
- Modify: `src/lib/tools/op-hole.ts`
- Test: `src/components/tools/hole-tool.test.tsx`, `geo/tests/test_hole_op.py`

**Interfaces:**
- **The settings:**
  - Type (Round hole or Rectangular cut-out);
  - Size (M3–M8 presets or Custom);
  - Head (None, Counterbore or Countersink);
  - Depth (Through or a value);
  - for cut-outs: Width, Height and Corner radius.
- **The presets** are as in Task 11.

- [ ] **Step 1: Write the failing tests.**
  - pytest:
    - `an M5 through hole in a 10 mm plate leaves a cylinder face of radius 2.75`;
    - `a counterbore adds a second cylinder face of radius 5.0`.
  - TS:
    - `choosing M5 fills Ø5.5`;
    - `a counterbore shows its fixed Ø and depth`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(tools): holes (M3–M8, counterbore, countersink) and rectangular cut-outs`.

### Task 16: Measure and Section (view-only)
**Files:**
- Create: `src/components/tools/measure-tool.tsx`, `src/components/tools/section-tool.tsx`, `src/lib/geometry/measure.ts`
- Test: `src/lib/geometry/measure.test.ts`, `src/components/tools/section-tool.test.tsx`

**Interfaces:**
- **`measure(topo, pick)`:**
  - two points → a distance in mm, to 0.01;
  - an edge → its exact length, or `radius × 2` for a circle;
  - a cylinder face → "Ø <2r>" from `face.radius`.
  - The result renders as an overlay label. Nothing is written to the body.
- **Section:** a `THREE.Plane` clip on the model material.
  - Axis: X, Y, Z, or a free plane dragged with `PivotControls`.
  - It has a "Flip" toggle.
  - It is view-only, with no Apply.

- [ ] **Step 1: Write the failing tests.**
  - `measuring a Ø10 hole reads Ø 10.00`, from topology data rather than the mesh.
  - `the point-to-point distance on a 20 mm cube edge reads 20.00`.
  - `section sets one clipping plane on the X axis and clears it on close`.
  - `measure and section never call the versions route`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(tools): exact Measure and view-only Section`.

### Task 17: The AI and layers (keep op blocks, selected-layer context)
**Files:**
- Modify:
  - `src/lib/agent/designer/prompt.ts`;
  - `src/lib/persist/types.ts` (`ChatRequest.layer?: { id: string; name: string }`);
  - `src/lib/runs/db-run-store.ts` (stores it);
  - `db/migrations/0006_message_layer.sql` (`messages.layer jsonb`);
  - `src/lib/persist/run-input.ts`;
  - `src/components/chat/chat-input.tsx` (the layer chip);
  - `src/components/chat/message-bubble.tsx`.
- Test: `src/lib/agent/designer/prompt.test.ts`, `src/app/api/chat/route.test.ts`, `src/components/chat/chat-panel.test.tsx`

**Interfaces:**
- **The designer prompt adds, verbatim:**

  > "Blocks between `# cadai:op` and `# cadai:end` lines are the user's manual edits. Keep each block and its marker lines. To change one, edit its parameter values; never delete or rewrite a block unless the user asks."
- **With `layer` set,** the first user message adds: "The user selected the layer "<name>"; apply the request to it."
- **The layer chip** shows in the input when a layer is selected, and in the sent bubble from `messages.layer`.

- [ ] **Step 1: Write the failing tests.**
  - `the designer prompt contains the op-block rule`.
  - `a selected layer reaches the designer as the fixed sentence`.
  - `the route stores layer on the message and GET returns it`.
  - `the user bubble shows the layer chip`.
  - `the route rejects a layer with an empty name (400)`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS. Then tsc, unit and pg.
- [ ] **Step 5:** Commit: `feat(designer): keep manual op blocks; selected layer as context`.

### Task 18: Phase 2 integration gate and live check
- [ ] tsc, unit and pg; the geo pytest suite; eslint; `next build` (as in Task 9).
- [ ] **Live check, capped at $1.50, at most 2 attempts:** through the app path, build a 60×40×5 plate, then Apply an M5 hole and engrave "CADAI" through the versions route. Then send "make the plate 80 mm long".
  - Pass: the AI's v4 still contains both op blocks, and `parseOpBlocks` returns them with unchanged parameters.
- [ ] **The chairman's browser smoke:**
  - each tool: preview, drag, Apply, Cancel;
  - Measure on a hole;
  - Section on X/Y/Z;
  - a layer chip sent to the AI;
  - a manual edit line in the chat;
  - the version highlight;
  - exports carrying the material in 3MF.
- [ ] Commit any fix: `fix(phase2): …`.
