# Designer-only app with server-side persistence: implementation plan (v4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Designer mode (designer + live reviewer) becomes the ONLY mode; the old pipelines are removed.
- A follow-up edits the design the user is looking at.
- Threads, messages, runs, designs and artifacts live on the server, in Postgres and an S3-compatible object store.
- The browser reconnects, stops and reloads from server state.
- The backend is host-agnostic (not Vercel). Branch task/dz becomes the new main.

**Architecture:**
- **Graph:** `START → designerTriage? → designerNode | designerAnswer → designerCheck → respondToUser`.
- **No gates anywhere.** Nothing pauses, so each run uses its own in-memory checkpointer, discarded when the run ends; there is NO durable LangGraph checkpointer.
- **The server owns history.** The client sends only the new message, the thread id, the version it views, its pins and the model.
- **The save is the run's single atomic commit point.** Every store is selected by an explicit knob; the defaults are local files.

**Tech stack:**
- Next.js 16 (read `node_modules/next/dist/docs/`; `proxy.ts` replaces middleware; cookies cannot be set after streaming starts);
- LangGraph JS 1.4 (MemorySaver per run);
- `pg`;
- `@aws-sdk/client-s3`;
- build123d geo service;
- Anthropic API only.

**Spec (user decisions, 2026-11-08):**
- **Designer mode is the only mode:** remove the old pipelines and clean up the graph; this branch becomes the new main.
- **Storage:**
  - Postgres;
  - an object store;
  - the full schema;
  - `run_events` is a reconnect buffer only;
  - persist before done;
  - blob retention follows the design version.
- **Hosting:** the backend is NOT on Vercel; the host is decided later.
- **Design rules:**
  - no accept gate;
  - no floor (z = 0) rule;
  - slider ranges parked, named dimensions kept.

**Review provenance:**
- Opus v1 and v2 (`review-plan-persistence*.md`);
- v3 by Opus, Gemini and Grok (`review-plan-v3-{opus,gemini,grok}.md`), cited as O/G/K + id, e.g. `K-H3`.
- The user's PostgresSaver request lapses because nothing pauses after Phase 0. The `checkpoints` tables are not created (`O-H5`, `G-H3`, `K-H10`).

**Bugs from the user's runs:**
1. follow-ups lose the design, and a second edit reverts the first (eval ms1);
2. designer model text streams into the chat;
3. the model rewrites the prelude;
4. questions start new designs.

## Global Constraints
- **UI text:** fixed phrases or server-rendered markdown only. Never raw model text, code, tool JSON or tracebacks (the R2 tests). Designer nodes are in `STRUCTURED_NODES` and tagged `nostream`.
- **Config** from env:
  - `DATABASE_URL`, `DATABASE_URL_MIGRATE`, `PG_POOL_MAX`;
  - `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`;
  - `SWEEP_SECRET`, `CADAI_RUN_MAX_MS`.
  Never print secrets.
- **Knobs:** `CADAI_STORE=local|postgres` (threads, messages, runs, designs) and `CADAI_ARTIFACT_STORE=local|s3`. Both default to local and double as rollback switches.
- **Anthropic API only.** No `temperature`. Use the JSON-schema method rather than forced `tool_choice`.
- **Owner:**
  - `proxy.ts` mints `cadai_owner` on page loads and `/api/*`;
  - the value must be UUID-shaped, else it is re-minted;
  - the proxy ALSO sets it on the forwarded request (`K-H1`, `G-H2`, `O-M7`) and strips any incoming `x-cadai-owner`;
  - routes fail closed only when it is still missing;
  - `ownerKey = sha256(cookie)`, and the owner lives on `threads` only;
  - another owner's id returns 404.
- **Thread ids:** server mode accepts only UUID thread ids. Non-UUID ids (the `thread-<ms>` scheme) are legacy (`K-H5`, `O-M5`).
- **Security:**
  - `checkPythonScript` runs before every `runBrep`;
  - a replayed body is re-checked and framed as data;
  - the 256 KiB cap stays;
  - `/api/mcp` is removed or disabled in Phase 0.
- **Deadline:** `CADAI_RUN_MAX_MS` (default 600 000) bounds the whole run. Every run ends with a terminal status. A dead process is reaped by heartbeat.
- **Machine:** 7.6 GB RAM and 2 CPUs. `--maxWorkers=2`, one vitest at a time, nothing in /tmp.

## Schema (`db/migrations/0001_init.sql`; additive-only afterwards)
```sql
create table threads   (id uuid primary key, owner_key text not null, title text,
                        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
                        archived_at timestamptz);
create index on threads(owner_key, updated_at desc);
create table runs      (id text primary key, thread_id uuid not null references threads(id),
                        status text not null,                 -- running | done | failed | cancelled
                        model text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
                        heartbeat_at timestamptz, deadline_at timestamptz, last_seq int not null default 0,
                        cancel_requested boolean not null default false, error jsonb,
                        cost_usd numeric(10,4) not null default 0, wall_ms int, turns int,
                        base_version int, design_version int, follow_up_kind text, save_status text, ended_at timestamptz);
create index on runs(thread_id, created_at desc);
create index on runs(status, heartbeat_at);                    -- reaper
create table run_events(run_id text not null references runs(id) on delete cascade, seq int not null,
                        ts timestamptz not null default now(), type text not null, payload jsonb not null,  -- refs only
                        primary key(run_id, seq));
create table messages  (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id),
                        seq int not null, role text not null, kind text,
                        content text not null, run_id text references runs(id), design_version int,
                        attachments jsonb not null default '[]',  -- artifact ids of user images
                        created_at timestamptz not null default now(), unique(thread_id, seq));
create table designs   (thread_id uuid not null references threads(id), version int not null, parent_version int,
                        run_id text not null references runs(id),
                        base_request text not null, edits jsonb not null default '[]',
                        body text not null, prelude_version text not null,
                        summary text not null, facts jsonb not null, flags jsonb not null,
                        stl_artifact text, step_artifact text, created_at timestamptz not null default now(),
                        primary key(thread_id, version));
create index on designs(run_id);
create table artifacts (owner_key text not null, id text not null, thread_id uuid references threads(id),
                        run_id text, kind text not null, bytes int not null, object_key text not null,
                        created_at timestamptz not null default now(), primary key(owner_key, id));
create index on artifacts(thread_id);
create index on artifacts(created_at);
```
**Retention** (`O-H4`, `K-H8`, `G-F6`):
- `runs` rows are never deleted. They are small, and designs and messages reference them, so no foreign key ever cascades.
- `run_events` are deleted 10 min after `ended_at`.
- An artifact is **referenced** when it is in `designs.stl_artifact`, `designs.step_artifact`, or any `messages.attachments`. Unreferenced artifacts are deleted after 24 h.
- Archived threads: their artifacts and rows are deleted 30 days after `archived_at`.

## Run lifecycle (one place, every task follows it)
**Commit:**
1. one transaction:
   - lock the thread row;
   - insert the design version (when there is one) and the assistant message;
   - `UPDATE runs SET design_version=$v, status='done' WHERE id=$r AND status='running' AND design_version IS NULL`.
   If 0 rows update, roll back and drop the result (`O-H1`, `K-H3`).
2. write the result event (carrying `designVersion`) to `run_events`.

**Terminal transitions:**
- `cancelled` and `failed` (from Stop, an error, the deadline or the reaper) apply only `WHERE status='running' AND design_version IS NULL`.
- Run cleanup never deletes an artifact; only the sweep deletes, and only unreferenced ones.

**Branches** (`K-H4`, `G-F10`, `O-M3`):
| `followUpKind` | Prior design | `designRequest` | Writes |
| --- | --- | --- | --- |
| none (first message) | — | the latest message | a design version |
| `edit` | the viewed version (else latest) with pins applied | `base_request` + edits | a design version |
| `new` | none | the latest message | a design version, `parent_version` null |
| `question` | — | — | an assistant message (`kind=answer`) only |

- A failed build writes an assistant message (`kind=error`) and no version.
- An edit that changes nothing writes a message saying so ("No change was needed"), not a new version.

**`staleParent`** (`K-M3`): true only when a version newer than this run's `base_version` was saved by ANOTHER run after this run loaded its base. An intentional edit of an older version is not stale.

**Pins** (`K-M2`, `O-M4`):
- applied to the viewed version's named dimensions before the edit;
- pose parameters (`*_deg`, `*_travel`) are never pins;
- a pinned name that no longer exists is dropped with a note.

---

## Phase 0: designer-only cleanup (first, sequential)

### Task 0a: Remove the old pipelines from the server
**Remove:**
- the architect, drafter, one-shot and agentic builds: `nodes/{architect-build,brep-build,brep-agent-build,validate-brep}.ts`;
- spec, sheets and the sheet reviewer (`architect-prompts`, `assembly-spec`, `spec-*`, `place-assembly`, `placement-audit`, `hole-audit`, `nesting-audit`, `param-sweep`, …);
- the spec and accept gates (`gate-policy`, `acceptGate`, `interrupt()`), `api/chat/resume`, and the OpenSCAD kernel (`engine/openscad-bridge.ts`, `scad-compiler.ts`, the `openscad-wasm` dep);
- the old eval matrix pieces that only served those (`eval/generation/*`, except what `eval/designer` imports);
- `api/mcp` (or disable it behind a knob);
- `CADAI_PIPELINE`, `CADAI_KERNEL` and `CADAI_BUILD_MODE`.

**Keep:**
- the designer, reviewer and triage modules, plus `designerCheck`;
- `brep-runner`, `body-check`, the cheat sheet and the geo service;
- the run store, artifact store, stream bridge and stream events;
- `respondToUser`, and the `compile` route for user code edits (build123d);
- model routing and `stl-renderer`.

**Method:**
- Remove from the graph first (one designer path), then delete modules that nothing imports anymore. Use `tsc` plus an unused-file pass such as `npx knip` or `ts-prune`, which may run via npx without being added to deps.
- Move shared helpers that still have users (e.g. `estimateCostUsd` and `applyParameterOverrides` from `brep-agent-build.ts`) into `designer/` first.
- [ ] **Step 1: Write the failing test** `the graph has exactly the designer nodes`, by inspecting the compiled graph's nodes.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Remove, then fix imports.** Delete the tests of removed modules.
- [ ] **Step 4: Gate.** `tsc`, then the full vitest suite (the remaining tests pass), then a live smoke of 1 designer build via the eval runner (about $0.15).
- [ ] **Step 5: Commit** `refactor: designer is the only mode; remove old pipelines, gates and OpenSCAD`.

### Task 0b: Remove the old UI paths
Needs Task 0a.

**Remove:** the spec, sheet, variant and gate UI under `src/components/design/**` and the gate handling in `chat-panel.tsx`; the store fields only they used; and `print-analysis` (if it is OpenSCAD-only; verify first).

**Change:** the editor language is Python/build123d only.

**Keep:** the chat, the viewer, sliders (named dimensions with no ranges show as fixed values), the code editor and STEP download.
- [ ] **Step 1: Write the failing test** `chat renders a designer run end to end with no gate UI` (a component test with a mocked stream).
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Remove.**
- [ ] **Step 4: Gate.** `tsc`, vitest, eslint, and `next build`.
- [ ] **Step 5: Commit** `refactor(ui): remove spec, sheet and gate UI`.

## Phase A: fixes and local persistence (no database)
**Order (`K-Tasks`, `O-M11`, `G-F14`):**
- the lanes A0, {A1 → A2} and {A3} run in parallel;
- then A4 → A5 → A6 → A7;
- then A8 and A9 in parallel.

### Task A0: Owner identity (moved from Phase B; `O-H3`, `G-F1`, `K-H7`)
**Files:** create `src/proxy.ts` and `src/lib/owner.ts`. Test: `src/lib/owner.test.ts`, `src/proxy.test.ts`.

**Produces:** `ownerKeyFrom(request: Request): string | null`. It reads the cookie the proxy set on the forwarded request and returns `sha256(uuid)`.
- [ ] **Step 1: Write the failing tests:**
  - `the first request with no cookie gets a minted UUID that the same request's route can read`;
  - `a non-UUID cookie is re-minted`;
  - `x-cadai-owner is stripped`;
  - `a page load also mints`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Follow `next/dist/docs` for proxy and `NextResponse.next({ request: { headers } })`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(security): proxy-minted owner identity`.

### Task A1: Designer model text never streams (bug 2)
**Files:** `designer/run-designer.ts:153` (`tags: ['nostream']`) and `stream-bridge.ts:35` (add `designerNode`, `designerTriage` and `designerAnswer` to `STRUCTURED_NODES`). Test: `graph-no-raw-output.test.ts`.
- [ ] **Step 1: Write the failing test** `designer mode streams no designer model text`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A2: The model writes only the body (bug 3)
Runs after A1 (same file).

**Files:** `designer/{tools,prompt,run-designer}.ts`. Test: `tools.test.ts`.

**Produces:** `toBody(script)` (after the sentinel; or, with none, leading prelude lines removed via `stripPrelude`), `withGeneratedPrelude(script)` and `PRELUDE_VERSION`.
- [ ] **Step 1: Write the failing tests:**
  - `a copied prelude without a sentinel is stripped`;
  - `a modified prelude is replaced`;
  - `the model is shown the body only`;
  - `finish accepts the model's own body`;
  - `a body-only first run passes the guardrail`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Normalize the finish comparison and the `scriptBaseKey` input with `toBody`. Prompt: "Write only the design code; the tool adds the prelude. The helpers `_round` and `_bevel` are available."
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A3: Store interfaces and local implementations
**Files:** create `src/lib/persist/{types,index}.ts` and `src/lib/persist/local/*.ts`. Test: `src/lib/persist/local/*.test.ts`.

**Produces:**
- `ThreadStore`:
  - `claim(threadId, ownerKey): 'ok' | 'not_owner' | 'legacy'` (a non-UUID id is `legacy`);
  - `get`;
  - `list(ownerKey)`;
  - `archive`.
- `RunRecordStore`: `create`, `commit(...)` per the lifecycle, and `terminate(runId, status, error)` with the guard.
- `DesignStore`: `get(thread, version)`, `latest`, `list`.
- `MessageStore`: `append` (seq under the thread lock), `setKind`, `list`.
- `DesignVersion` with `baseRequest`, `edits`, `body` and `preludeVersion`.
- The local implementation uses JSONL plus a per-thread lock file under `<CADAI_RUN_DIR>/threads/<uuid>/`.
- [ ] **Step 1: Write the failing tests:**
  - `claim: ok, then not_owner for another owner, then legacy for thread-<ms>`;
  - `commit is atomic and refuses when the run is no longer running`;
  - `terminate does nothing after a commit`;
  - `concurrent appends get distinct seq`;
  - `list and get hide other owners`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A4: Triage, answers and the branch table (bug 4)
**Files:** create `designer/{triage,answer}.ts`. Modify `graph.ts` and `graph-route.ts` (`designerTriage` when a prior design exists; then a pure sync route) and `designer/node.ts` (the branch table above; remove `acceptedDesignerScript`). Test: `triage.test.ts`, `graph-designer.test.ts`.
- [ ] **Step 1: Write the failing tests:**
  - the classifier cases (`"make it 20 mm taller"`, `"can you add a cable hole?"`, `"what is this?"`, `"now make me a lamp"`, and a classifier error);
  - `a question writes only an answer message and no version`;
  - `new starts fresh with parent_version null`;
  - `a second edit builds on the first edit` (the ms1 regression).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A5: Server-owned history, the viewed version, pins and commit (bug 1)
**Files:** `api/chat/route.ts`, `graph.ts` (state `threadId`, `runId`, `ownerKey`, `priorDesign`, `designRequest`, `baseVersion`, per `G-F7`), `designer/node.ts`, `designer/prompt.ts`, and `respondToUser` (commit). Test: `graph-designer.test.ts`, `api/chat/route.test.ts`.

**Request:** `{ threadId: uuid, message, attachments?, viewingVersion?, pinnedParams?, model? }`.

**Route:**
- `claim`:
  - `not_owner` → 404;
  - `legacy` → the fixed phrase "This conversation was saved only in this browser; start a new one to continue." with no build.
- Then append the user message.
- **Loading the base:**
  - an explicit `viewingVersion` that is not found → a fixed phrase and no build (`K-H5`);
  - a store throw → a fixed retryable error.
- **Replay guard** on the loaded body.
- **History:** the server builds the history from `messages`.
- **Commit** per the lifecycle, including the labels.
- [ ] **Step 1: Write the failing tests:**
  - `an edit of v2 while v3 exists edits v2 with pins and is not stale`;
  - `a concurrent save makes the later one stale-labelled`;
  - `server history is used and client history ignored`;
  - `a failed replay guard starts fresh`;
  - `a store throw is a fixed error`;
  - `the commit precedes the result event`;
  - `legacy thread → phrase`;
  - `another owner → 404`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A6: Artifacts at designerCheck and user attachments (`K-H8`, `G-F8`)
**Files:**
- `designer/check.ts` and `runs/externalize.ts`;
- `runs/artifact-store.ts`: the owner-scoped `put(ownerKey, runId, kind, bytes)` and `get(ownerKey, id)`; random ids; `delete(ownerKey, id)`;
- `api/chat/route.ts`: attachments become artifacts with a 5 MB cap and image kinds only;
- `api/artifacts/[id]`: owner-checked.

Test: `check-artifacts.test.ts`, `artifact-store.test.ts`.
- [ ] **Step 1: Write the failing tests:**
  - `STL and STEP become owner-scoped artifacts and state holds refs only`;
  - `a failing object store fails the run with a fixed error and never inlines the mesh into run_events`;
  - `an uploaded image becomes an attachment ref`;
  - `another owner's artifact is 404`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A7: Deadline, terminal status, reaper and per-run checkpointer (`O-H5`, `O-M8`, `K-H9`, `G-F3`, `G-F12`)
**Files:** `runs/stream-run.ts`, `agent/checkpointer.ts` (the module becomes `newRunCheckpointer(): MemorySaver`, discarded at run end; delete `FileCheckpointSaver`), `graph.ts` (compile per run, or pass the checkpointer per invoke), and the route `maxDuration` exports (remove them, or set them from config). Test: `stream-run.test.ts`.
- [ ] **Step 1: Write the failing tests:**
  - `a run past CADAI_RUN_MAX_MS ends failed with a fixed message`;
  - `a stale heartbeat is reaped to failed unless committed`;
  - `the checkpointer is released after the run; heap holds no run state` (count instances);
  - `Stop before commit → cancelled; Stop after commit → done`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A8: The eval runner takes the app path (`O-L3`, `O-L6`)
**Files:** `eval/designer/runner.ts` and probe fixes in `eval/designer/sets/iterative.json`: the box divider becomes `dimensionAppears` or `reviewer`. Report sequences per step in `report.ts`. Test: `runner.test.ts`, `report.test.ts`.
- [ ] **Step 1: Write the failing tests:**
  - `each follow-up is a fresh run with only the new message and viewingVersion`;
  - `meshes are read via artifact refs`;
  - `sequence cost and time are reported per step`;
  - `a safe adversarial refusal is not a hard-check failure`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A9: Client: server threads, reconnect, Stop and versions (v2 H4, `K-H2`, `G-F4`, `G-F5`, `O-M6`, `O-M9`)
**Files:**
- `chat-panel.tsx`, `app-store.ts` and `src/lib/client/server-thread.ts`;
- the routes `GET /api/threads` (list), `GET /api/threads/:id` (messages, versions, `activeRunId`, `lastSeq`) and `DELETE /api/threads/:id` (archive).

Test: component, store and route tests.

**Behaviour:**
- New thread ids are `crypto.randomUUID()`.
- The thread list and the thread come from the server; IndexedDB is a cache, and legacy threads stay local-only with a banner.
- On load: when `activeRunId` is set, reconnect with `/api/runs/:id/events?after=<lastSeq>`; otherwise show the final state.
- A Stop button.
- A version list that sets `viewingVersion`.
- The request sends only the new contract.
- [ ] **Step 1: Write the failing tests:**
  - `a cold reload mid-build finds activeRunId and resumes after lastSeq`;
  - `reload after done shows the final design`;
  - `Stop cancels`;
  - `selecting v2 then sending edits v2`;
  - `a legacy thread shows the banner and makes no server call`;
  - `new ids are UUIDs`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

## Phase B: Postgres and object storage (host-agnostic)
Order: B1, then {B2, B3} in parallel, then B4 (`K-H7`, `G-F9`).

### Task B1: Pool, migrations and Postgres stores (`O-M1`, `K-M1`, `G-F11`)
**Files:** `db/migrations/0001_init.sql` (the schema above), `scripts/db-migrate.ts`, `src/lib/db/pool.ts` and `src/lib/persist/postgres/*.ts` (the A3 interfaces plus the `RunStore` contract). Test: gated on `DATABASE_URL_TEST`, with a schema per run.

**Behaviour:**
- **`getPool()`:**
  - lazy;
  - `max` from `PG_POOL_MAX` (default 5);
  - `connectionTimeoutMillis` 5 s, `statement_timeout` 15 s, `idle_in_transaction_session_timeout` 15 s;
  - never hold a client across a model or geo call.
- **`db-migrate`:** `pg_advisory_lock`, ordered SQL files and a migrations table. It is an explicit deploy step.
- **Polling** every 1–2 s in Postgres mode.
- [ ] **Step 1: Write the failing tests:**
  - every A3 store test, run against Postgres;
  - `commit under concurrency`;
  - `events page across instances`;
  - `the reaper`;
  - `migrate is idempotent under concurrency`;
  - `a DB timeout fails fast with the fixed error`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. The full suite stays green in local mode.
- [ ] **Step 5: Commit.**

### Task B2: S3-compatible object store
**Files:** `src/lib/storage/{object-store,s3-object-store}.ts`, with selection in `artifact-store.ts`. Test: a mocked client, plus a live test gated on `S3_TEST_BUCKET`.

**Behaviour:** object key `a/<ownerKey>/<id>.<kind>`; `put`, `get` (streamed) and `delete`; a size cap.
- [ ] **Step 1: Write the failing tests:**
  - `put/get/delete round-trip`;
  - `another owner's get is undefined`;
  - `identical bytes from two owners get distinct ids`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task B3: Generic-host streaming and shutdown (`O-M2`, `K-M1`)
**Files:** `runs/stream-run.ts` and the events route.

**Behaviour:**
- an SSE comment keep-alive every 15 s;
- `X-Accel-Buffering: no` and `Cache-Control: no-transform`;
- a client disconnect does not stop the run;
- SIGTERM stops accepting new runs, waits up to the deadline for running runs, then marks the rest failed.
- [ ] **Step 1: Write the failing tests:**
  - `keep-alives are emitted`;
  - `a disconnect leaves the run running`;
  - `SIGTERM drains`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task B4: Sweep (`K-M4`, `O-H4`, `K-H8`)
**Files:** `scripts/sweep.ts` and `src/app/api/internal/sweep/route.ts`.
- **Auth:** `Authorization: Bearer`. Compare lengths before `timingSafeEqual`, and return 401 when `SWEEP_SECRET` is unset.
- **Scheduler:** the host's. No in-request sweep.
- **Deletes** exactly the Retention list above.
- [ ] **Step 1: Write the failing tests:**
  - `referenced artifacts, including message attachments, survive`;
  - `unreferenced artifacts older than 24 h are deleted from the store and the table`;
  - `run_events go 10 min after the end`;
  - `runs are never deleted`;
  - `401 without the secret, with a wrong-length secret, and when the secret is unset`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## Execution and checks
- **Order:**
  1. Phase 0 (0a → 0b).
  2. Phase A (A0 ∥ {A1 → A2} ∥ A3, then A4 → A5 → A6 → A7, then A8 ∥ A9).
  3. Phase B (B1, then B2 ∥ B3, then B4).
- **Gate per lane:**
  - `npx tsc --noEmit`;
  - vitest `--maxWorkers=2`, once;
  - eslint on changed files.
- **End checks:**
  - **Browser smoke:**
    - build, edit, a second edit, and an edit of an older version;
    - a question and a new object;
    - refresh mid-build, and reload after done;
    - Stop before and after the commit;
    - a second tab;
    - a legacy thread.
  - **Eval:** re-run ms0 and ms1 through the app-path runner (about $3), compared with the earlier ms0/ms1.
