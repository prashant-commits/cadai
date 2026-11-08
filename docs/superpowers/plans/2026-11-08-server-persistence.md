# Server-side persistence and designer follow-ups: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a follow-up in designer mode edits the thread's current design. Thread designs, run checkpoints and artifacts live server-side: Postgres (Neon via the Vercel Marketplace) and private Vercel Blob. Fix the four bugs found in the user's designer runs at the same time.

**Architecture:**
- **Run checkpoints:** stay one per run (`runCheckpointKey(threadId, runId)`, the existing deliberate choice that avoids replaying history the client re-sends), but move to LangGraph's `PostgresSaver` when `DATABASE_URL` is set, so `interrupt()` and resume survive instance changes.
- **Thread memory:** a new `designs` table, versioned per thread. A run loads the latest version at start and saves a new one when a designer build is accepted.
- **Artifacts:** STL, STEP and render binaries go to a `BlobArtifactStore` behind the existing `ArtifactStore` interface.
- **Local and eval setups:** everything has file/local implementations, selected by env, so they work without a database.

**Tech stack:**
- Next.js 16 (read `node_modules/next/dist/docs/` before route or proxy code; `middleware.ts` is `proxy.ts` here);
- LangGraph JS 1.4 with `@langchain/langgraph-checkpoint-postgres` (PostgresSaver on `pg`);
- `pg`;
- `@vercel/blob` (private store);
- Anthropic API only.

**Spec (decisions taken in conversation, 2026-11-08):**
- The user chose Postgres with a Postgres checkpointer plus a blob store.
- Designer mode is the direction (`docs/superpowers/plans/2026-11-08-designer-mode.md`).
- Four bugs were found in the user's runs (`.cadai/scratch/runs-dz`):
  1. follow-ups lose the design, because every message is a fresh run and the client re-sends only `designContract` (spec + pins);
  2. raw designer model text streams into the chat;
  3. every build's first `run_script` fails the guardrail because the model rewrites the prelude;
  4. questions ("What is this?") start a new design.
- The eval runner must use the same per-message path as the app.

## Global Constraints
- **UI text:** never raw model output, code, tool JSON or tracebacks in stream events. All text is fixed phrases or rendered markdown (the R2 tests in `graph-no-raw-output.test.ts`).
- **Secrets:** never print them. Pull Vercel env into `.env.vercel`, NEVER `.env.local`, which holds local keys `vercel env pull` would overwrite. Load both in dev.
- **Anthropic API only.** Never send `temperature`. Sonnet/Opus 5.5 reject a forced `tool_choice`, so use the JSON-schema output method the other nodes use.
- **Graceful fallback:** with no `DATABASE_URL` or no blob credentials, everything falls back to the existing file stores. Unit tests never need network or a database.
- **No floor (z = 0) rule anywhere.** Slider ranges on dimensions stay parked.
- Keep task/ab2's security: `checkPythonScript` before every `runBrep` of model-written code, and the 256 KiB cap.
- **Ownership:** every thread and design read checks the owner id. An artifact read checks that its run belongs to the owner.
- **Machine:** 7.6 GB RAM and 2 CPUs. `--maxWorkers=2`, one vitest process at a time, nothing in /tmp.

## Review Focus
1. **A follow-up arriving while the previous run is still streaming** or awaiting a gate: it must edit the last ACCEPTED version, never a half-built one. Tested in Task 4.
2. **Two browser tabs on the same thread** sending follow-ups: versions must not collide; `(thread_id, version)` stays unique with a retry. Tested in Task 7.
3. **The database is unreachable mid-run:** the build still finishes and the user gets the result; saving the version fails with a logged warning, not a failed run. Tested in Task 7.
4. **An artifact URL from another owner's run:** 404, not the file. Tested in Task 9.
5. **A "question" that is really an edit** ("can you make it taller?"): classify it as an edit; questions only for things that need no geometry change. Tested in Task 5.

---

### Task 1: Stop designer model text from reaching the chat (bug 2)
**Files:** Modify `src/lib/agent/designer/run-designer.ts`, `src/lib/agent/designer/tools.ts`. Test: `src/lib/agent/graph-no-raw-output.test.ts`.

- [ ] **Step 1: Write the failing test** `designer mode streams no designer model text`. A mocked designer model emits AIMessageChunks containing "I need to keep the prelude exactly as given." during a designer run. Assert that no `delta` event contains that string, and that deltas contain only fixed phrases or reviewer markdown.
- [ ] **Step 2: Run it.** `npx vitest run src/lib/agent/graph-no-raw-output.test.ts -t "designer mode streams"`. Expected: FAIL.
- [ ] **Step 3: Tag every designer model invocation `nostream`.** Merge into the `RunnableConfig` passed to `invoke`, as the reviewer does in `reviewer.ts`, so the graph's message stream skips them.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(designer): designer model output never streams to the chat`.

### Task 2: The tool owns the prelude (bug 3)
**Files:** Modify `src/lib/agent/designer/tools.ts` and `src/lib/agent/designer/prompt.ts`. Test: `src/lib/agent/designer/tools.test.ts`.

**Interfaces:** Produces `withGeneratedPrelude(script: string): string`, exported from `tools.ts`:
- with no `PRELUDE_SENTINEL`: return `GENERATED_PRELUDE + '\n' + PRELUDE_SENTINEL + '\n' + script`;
- with a sentinel: drop everything up to and including the sentinel line and re-prepend the generated prelude.

- [ ] **Step 1: Write the failing tests:**
  - `withGeneratedPrelude adds the prelude to a body-only script`;
  - `withGeneratedPrelude replaces a modified prelude`;
  - `run_script accepts a body-only script on the first call` (mocked `runBrep`; assert `checkPythonScript` passes and `runBrep` received the generated prelude).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Apply `withGeneratedPrelude` in `run_script`, `render` and `finish`** before `checkPythonScript`. Change the prompt: "Write only the design code. The tool adds the fixed prelude (imports, `_round`, `_bevel`, `_cadai_notes`) itself; do not include or modify it."
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(designer): tools prepend the generated prelude; the model writes only the design`.

### Task 3: Design store interface and local implementation
**Files:** Create `src/lib/designs/types.ts`, `src/lib/designs/local-design-store.ts`, `src/lib/designs/index.ts`. Test: `src/lib/designs/local-design-store.test.ts`.

**Interfaces (produces):**
```ts
export interface DesignVersion {
  threadId: string; ownerId: string; version: number; runId: string;
  request: string; script: string; summary: string;
  facts: DesignerFacts; flags: Array<ReviewFlag & { round: number; final: boolean }>;
  stlRef: string | null; stepRef: string | null; createdAt: string;
}
export interface DesignStore {
  latest(threadId: string, ownerId: string): Promise<DesignVersion | null>;
  save(v: Omit<DesignVersion, 'version' | 'createdAt'>): Promise<DesignVersion>; // assigns version = latest + 1
  list(threadId: string, ownerId: string): Promise<DesignVersion[]>;
}
export function getDesignStore(): DesignStore; // Postgres when DATABASE_URL is set (Task 7), else LocalDesignStore
```
`LocalDesignStore` writes `<CADAI_RUN_DIR>/designs/<threadId>.jsonl`, appending one version per line.

- [ ] **Step 1: Write the failing tests:**
  - `save assigns increasing versions`;
  - `latest returns the newest version`;
  - `latest returns null for another owner`;
  - `latest returns null for an unknown thread`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `LocalDesignStore` and `getDesignStore()`. For now it returns the local store when `DATABASE_URL` is unset.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(designs): design store interface with a local implementation`.

### Task 4: Thread memory in the graph (bug 1)
**Files:**
- Modify: `src/app/api/chat/route.ts`, `src/lib/agent/graph.ts` (designer routing, a `priorDesign` state field, respondToUser), `src/lib/agent/designer/node.ts`.
- Test: `src/lib/agent/graph-designer.test.ts`.

**Interfaces:**
- **Consumes** `DesignStore` (Task 3).
- **Produces** the state field `priorDesign: DesignVersion | null` (default null) and `ownerId: string` in the graph input.

**Behaviour:**
- **Load:** the route calls `getDesignStore().latest(threadId, ownerId)` before starting the run and passes it as `priorDesign`.
- **Route:** in designer mode with `priorDesign`, routing goes through `classifyFollowUp` (Task 5). An edit calls `designerNode` with `priorScript = priorDesign.script` and `editRequest = last human message`.
- **Save:** when `designerCheck` passes and the result is accepted, `respondToUser` calls `save(...)` with the artifact refs. Only accepted results are saved.

- [ ] **Step 1: Write the failing tests:**
  - `a follow-up in a new run edits the saved design`: two graph runs with different runIds and the same threadId; the second run's `runDesigner` mock receives `priorScript` equal to the first run's accepted script;
  - `a failed build is not saved as a version`;
  - `a run with no prior design starts fresh`;
  - `a follow-up while the previous run is unfinished edits the last accepted version`: run 2 is paused at a gate and unsaved, then run 3 starts; run 3's `priorScript` is run 1's script.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the load in the route, the state field, the routing and the save.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(designer): follow-ups edit the thread's last accepted design`.

### Task 5: Follow-up classifier and answers (bug 4)
**Files:** Create `src/lib/agent/designer/follow-up.ts`. Modify `src/lib/agent/graph.ts` to add the node `designerAnswer`. Test: `src/lib/agent/designer/follow-up.test.ts`.

**Interfaces (produces):**
- `classifyFollowUp(text: string, prior: DesignVersion, signal?: AbortSignal): Promise<'edit' | 'question' | 'new'>`
  - one Haiku 5.5 call, JSON schema `{ kind }`, `nostream`;
  - prompt: "edit = any request to change, add, remove or resize anything, including questions phrased as requests ('can you make it taller?'); question = asks about the current design and needs no geometry change; new = asks for a different object";
  - on error it returns `'edit'`.
- `designerAnswer` node: one Sonnet 5.5 call with the prior script, summary and facts. It answers in markdown, makes no build, and leaves the design version unchanged.

- [ ] **Step 1: Write the failing tests** (mocked model):
  - `"make it 20 mm taller" → edit`;
  - `"can you add a cable hole?" → edit`;
  - `"what is this?" → question`;
  - `"now make me a lamp" → new`;
  - `classifier error → edit`;
  - `a question routes to designerAnswer and runs no build`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the classifier, the node and the route.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(designer): questions get answers, edits edit, new requests start fresh`.

### Task 6: The eval runner uses the app's per-message path
**Files:** Modify `eval/designer/runner.ts`. Test: `eval/designer/runner.test.ts`.

- [ ] **Step 1: Write the failing test** `each follow-up is a fresh run on the same thread and edits the saved design`: assert a new runId per message and `priorDesign` loaded from the `DesignStore`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Change the runner** to start a fresh graph run per message, exactly as `/api/chat` does: same threadId, a new runId, `priorDesign` from `getDesignStore()`, a fixed eval `ownerId`.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `eval(designer): runner follows the app's per-message path`.

### Task 7: Provision Neon and Blob; Postgres design store and checkpointer
**Files:**
- Create: `db/migrations/0001_threads_designs.sql`, `scripts/db-migrate.ts`, `src/lib/designs/postgres-design-store.ts`, `src/lib/db/pool.ts`.
- Modify: `src/lib/agent/checkpointer.ts`, `src/lib/designs/index.ts`, `package.json`.
- Test: `src/lib/designs/postgres-design-store.test.ts` (runs only when `DATABASE_URL_TEST` is set).

**Provisioning** (needs the user: Vercel login). Install the CLI and put the npm global bin on PATH. The user runs `vercel login`. Then:
```bash
vercel integration add neon --yes --no-claim
vercel blob create-store cadai-artifacts --access private
vercel env pull .env.vercel --yes
```
Use a Neon dev/preview branch for local work and tests.

**Schema:**
- `threads(id text primary key, owner_id text not null, created_at timestamptz default now(), updated_at timestamptz default now())`;
- `designs(id uuid primary key default gen_random_uuid(), thread_id text not null references threads(id), version int not null, run_id text not null, request text not null, script text not null, summary text not null, facts jsonb not null, flags jsonb not null, stl_ref text, step_ref text, created_at timestamptz default now(), unique(thread_id, version))`;
- index `designs(thread_id, version desc)`.

**Pool:** `getPool(): Pool` creates one lazy `pg` Pool. No top-level connect, so `next build` is safe without env.

**Checkpointer:** `getCheckpointer()` returns `PostgresSaver.fromConnString(...)` (run `setup()` once in `db-migrate.ts`) when `DATABASE_URL` is set, else `FileCheckpointSaver`. Run keys are unchanged.

- [ ] **Step 1: Write the failing tests** (gated on `DATABASE_URL_TEST`; they use a schema-per-test-run):
  - `save and latest round-trip`;
  - `concurrent saves on one thread get distinct versions` (two parallel `save()` calls, retry on unique violation);
  - `latest hides other owners`;
  - `a save failure is reported, not thrown, by the graph's save wrapper`.
- [ ] **Step 2: Run them** with `DATABASE_URL_TEST` set. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, the pool, `PostgresDesignStore` and the checkpointer selection.
- [ ] **Step 4: Run them.** Expected: PASS. Also run the full suite without the env var; it should pass with the file stores.
- [ ] **Step 5: Commit** `feat(db): Postgres design store and run checkpointer (Neon)`.

### Task 8: Keep binaries out of state
**Files:** Modify `src/lib/agent/graph.ts` (respondToUser, designer path) and `src/lib/runs/externalize.ts`. Test: `src/lib/runs/externalize.test.ts` or a new graph test.

- [ ] **Step 1: Write the failing test** `designer respond stores STL and STEP as artifacts and clears them from state`: after `respondToUser`, `state.stlContent` and `state.stepContent` are null, and the result event carries artifact refs. With `CADAI_INLINE_PAYLOADS=1` the stream still inlines payloads for local dev.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Put the binaries through `getArtifactStore().put`, store the refs in the design version and the result event, and null the state fields.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(runs): designer binaries live in the artifact store, not in checkpoints`.

### Task 9: Private Blob artifact store and owner checks
**Files:**
- Create: `src/lib/runs/blob-artifact-store.ts`, `src/lib/owner.ts`.
- Modify: `src/lib/runs/config.ts` (store selection), the artifacts route under `src/app/api/artifacts/`, and `src/app/api/chat/route.ts` (owner cookie).
- Test: `src/lib/runs/blob-artifact-store.test.ts` (mocked `@vercel/blob`), `src/lib/owner.test.ts`.

**Interfaces:**
- `BlobArtifactStore implements ArtifactStore`:
  - stores at pathname `runs/<runId>/<id>.<kind>` with `put(..., { access: 'private' })`;
  - `get(id)` streams `get(pathname, { access: 'private' })`, returning undefined on null;
  - `deleteForRun` lists by prefix and deletes.
  - Selected when Blob credentials are present.
- `getOwnerId(request: Request): { ownerId: string; setCookie?: string }` reads or mints an httpOnly, SameSite=Lax cookie `cadai_owner` (a random UUID). The chat route writes the thread row with this owner.
- The artifacts route checks that the artifact's run belongs to the owner and returns 404 otherwise.

- [ ] **Step 1: Write the failing tests:**
  - `blob store put/get/delete round-trip` (mocked);
  - `getOwnerId mints and then reuses the cookie`;
  - `artifact of another owner's run is 404`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(runs): private Blob artifact store and per-owner access`.

---

## Execution
- **Lane order:**
  - Tasks 1, 2, 3 and 5 touch separate files and can run in parallel.
  - Task 4 needs 3 and 5.
  - Task 6 needs 4.
  - Task 7 needs 3 and the user's Vercel login.
  - Tasks 8 and 9 need 7 for real credentials but can be written against the mocks first.
- **Gate per lane:**
  - `npx tsc --noEmit`;
  - `npx vitest run --exclude '**/.cadai/**' --maxWorkers=2`, once;
  - eslint on changed files.
- **End checks:**
  - a live smoke in the browser: build, then two follow-ups, then a question;
  - the iterative eval set re-run with the per-message runner (Task 6).
