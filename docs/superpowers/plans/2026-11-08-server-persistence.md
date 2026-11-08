# Designer-only app with server-side persistence: implementation plan (v5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Designer mode (designer + live reviewer) is the only mode.
- A follow-up edits exactly what the user sees: the viewed version plus their slider and code edits.
- Threads, messages, runs, designs and artifacts live in Postgres and an object store. The browser reconnects, stops and reloads from server state.
- The backend is host-agnostic. task/dz becomes the new main.

**Architecture:**
- **Graph:** `START → designerTriage? → designerNode | designerAnswer → designerCheck → commit`.
  - The graph is compiled WITHOUT a checkpointer, because nothing pauses.
- **One database layer, two engines:** `Db` with PGlite (embedded Postgres) for local dev, tests and evals, and `pg` for servers. The schema, SQL and store code are the same for both.
- **One run store:** it replaces `LocalRunStore` and owns run status and events.
- **One commit transaction per run** writes the version, the reply, the result event and the status. Every terminal path writes a reply.
- **Object store:** local filesystem or S3-compatible.

**Tech stack:**
- Next.js 16 (read `node_modules/next/dist/docs/` before proxy, route or streaming code);
- LangGraph JS 1.4;
- `@electric-sql/pglite`, `pg`, `@aws-sdk/client-s3` (all new dependencies);
- the build123d geo service;
- Anthropic API only.

**Spec:**
- **User decisions, 2026-11-08:**
  - designer-only, task/dz becomes main;
  - Postgres plus an object store, the full schema;
  - `run_events` is a reconnect buffer;
  - persist before done;
  - blob retention follows the design;
  - not on Vercel; host-agnostic;
  - no accept gate; no floor rule; slider ranges parked;
  - PGlite for local and tests (accepted from review).
- **Reviews folded in:**
  - v1 and v2 (Opus);
  - v3 and v4 (Opus, Gemini, Grok, in `.cadai/tasks/reviews/`), cited `4O`/`4G`/`4K` + id for v4.

**Bugs this fixes:**
1. follow-ups lose the design, and a second edit reverts the first;
2. designer model text streams into the chat;
3. the model rewrites the prelude;
4. questions start new designs.

## Global Constraints
- **UI text:** fixed phrases or server-rendered markdown only. Never raw model text, code, JSON or tracebacks (the R2 tests). Designer nodes go in `STRUCTURED_NODES` and are tagged `nostream`.
- **Config:**
  - `CADAI_DB=pglite|postgres` (default `pglite`, data dir `<CADAI_RUN_DIR>/pglite`);
  - `DATABASE_URL`, `DATABASE_URL_MIGRATE`, `PG_POOL_MAX` (default 10);
  - `CADAI_ARTIFACT_STORE=local|s3`;
  - `S3_*`;
  - `SWEEP_SECRET`;
  - `CADAI_RUN_MAX_MS` (default 900 000; it must exceed the designer budget plus one retry plus check; `4O-M1`).
  - Never print secrets.
- **Anthropic API only.** No `temperature`. Use JSON-schema output, never forced `tool_choice`. A model refusal becomes the fixed reply "I can't help with that request." (`4O-M14`).
- **Owner:**
  - `proxy.ts` mints a UUID `cadai_owner` cookie on page loads and `/api/*`;
  - it sets the cookie on the response AND on the forwarded request (`NextResponse.next({ request: { headers } })`) and strips `x-cadai-owner`;
  - `ownerKeyFrom(request)` returns `sha256(cookie)`, or `null` → 401;
  - the owner lives on `threads` only.
  - **Route matrix (`4G-F4`, `4O-H7`, `4K-M2`):**
    - every route resolves its object to a thread and checks `owner_key`; a mismatch is 404;
    - the routes: `POST /api/chat`, `GET /api/runs/:id`, `GET /api/runs/:id/events`, `POST /api/runs/:id/cancel`, `GET /api/threads`, `GET|DELETE /api/threads/:id`, `GET /api/artifacts/:id`, `POST /api/compile` (owner-scoped, not persisted);
    - `/api/mcp` and `/api/chat/resume` are deleted.
- **Ids:** server threads are UUIDs. A non-UUID thread id is legacy, which means a fixed phrase and no build.
- **Security:**
  - `checkPythonScript` runs before every `runBrep`;
  - stored bodies are re-checked on load and framed as data;
  - pins are numeric only and written by safe substitution of existing `name = <number>` lines, never by string interpolation (`4O-M7`);
  - attachments: PNG/JPEG/WebP, sniffed by magic bytes, at most 5 MB each and 4 per message (`4K-M7`).
- **No floor rule.** Slider ranges stay parked.
- **Machine:** 7.6 GB RAM and 2 CPUs. `--maxWorkers=2`, one vitest at a time, nothing in /tmp.

## Schema (`db/migrations/0001_init.sql`, run on PGlite and Postgres alike; additive-only afterwards)
```sql
create table threads   (id uuid primary key, owner_key text not null, title text,
                        active_run_id text,                               -- one active run per thread (4*-concurrency)
                        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
                        archived_at timestamptz);
create index on threads(owner_key, updated_at desc) where archived_at is null;
create table runs      (id text primary key, thread_id uuid not null references threads(id),
                        status text not null,                -- running | done | failed | cancelled
                        model text, base_version int,        -- the version this run started from (staleParent)
                        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
                        heartbeat_at timestamptz not null default now(), deadline_at timestamptz not null,
                        last_seq int not null default 0, cancel_requested boolean not null default false,
                        error jsonb, cost_usd numeric(10,4) not null default 0, wall_ms int, turns int,
                        design_version int, follow_up_kind text, ended_at timestamptz);
create index on runs(thread_id, created_at desc);
create index on runs(status, heartbeat_at) where status = 'running';
create table run_events(run_id text not null references runs(id), seq int not null,
                        ts timestamptz not null default now(), type text not null, payload jsonb not null,
                        primary key(run_id, seq));
create table messages  (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id),
                        seq int not null, role text not null, kind text not null,
                        -- user: request|edit|question|unknown ; assistant: result|answer|error|cancelled|nochange
                        content text not null, run_id text references runs(id), design_version int,
                        created_at timestamptz not null default now(), unique(thread_id, seq));
create table message_attachments(message_id uuid not null references messages(id), owner_key text not null,
                        artifact_id text not null, primary key(message_id, artifact_id));    -- indexed, no JSONB scan (4G-F9)
create table designs   (thread_id uuid not null references threads(id), version int not null, parent_version int,
                        origin text not null,                -- designer | user_edit
                        run_id text references runs(id),     -- null for user_edit versions
                        base_request text not null, edits jsonb not null default '[]',
                        body text not null, prelude_version text not null,
                        summary text not null, facts jsonb, flags jsonb not null default '[]',
                        stl_artifact text, step_artifact text, created_at timestamptz not null default now(),
                        primary key(thread_id, version));
create index on designs(run_id);
create table artifacts (owner_key text not null, id text not null, thread_id uuid references threads(id),
                        run_id text, kind text not null, bytes int not null, object_key text not null,
                        created_at timestamptz not null default now(), primary key(owner_key, id));
create index on artifacts(thread_id);
create index on artifacts(created_at);
```

## Run lifecycle (normative; every task follows it)
**Start (one transaction):**
- `claim`: create the thread for this owner if absent; another owner → 404; legacy id → phrase.
- If `threads.active_run_id` points at a `running` run, return 409 with the fixed phrase "A design is still being built in this thread." (`4O-M5`, `4G-F8`, `4K-M8`).
- Insert the run, with `base_version` = the viewed version or latest, and `deadline_at`.
- Set `active_run_id`.
- Append the user message with `kind='unknown'`; triage updates it.
- Nothing is written before the 404/409 checks (`4O-M14`).

**User edits first (`4O-H6`, `4K-M4`):**
- If the request carries `editedBody` (a code-editor edit) or `pinnedParams` that differ from the viewed version, the server saves a `user_edit` version (parent = viewed, re-checked by the guardrail, pins applied by safe substitution) in the start transaction.
- `base_version` becomes that version.

**Branches:**
| Triage | Base | Graph path | Commit writes |
| --- | --- | --- | --- |
| first message | — | designer → check | version + reply `result` |
| `edit` | `base_version` | designer (edit) → check | version + reply `result`; reply `nochange` when the body is unchanged |
| `new` | none | designer (fresh) → check | version (`parent_version` null) + reply `result` |
| `question` | `base_version` (read-only) | answer | reply `answer` only |
| check fails twice (one retry as an edit with the failures, `4O-M2`, `4K-M1`) | — | — | reply `error` ("Built, but it failed checks: …"), no version |
| refusal / unusable model output | — | — | reply `error` (fixed phrase), no version |
| triage error | — | treat as `edit` (`4K-M6`) | — |

**Commit (one transaction, `4O-H3`, `4K-H2`, `4G-F6`):**
1. Lock the thread row.
2. `UPDATE runs SET status='done', design_version=…, ended_at=now(), last_seq=last_seq+1 WHERE id=$r AND status='running' RETURNING last_seq`. 0 rows → roll back and stop; Stop, the deadline or the reaper got there first.
3. Insert the design version (when there is one): `version = max+1`, `staleParent` = `max(version) > runs.base_version` measured inside this transaction (`4O-M4`, `4K-H3`).
4. Insert the assistant reply.
5. Insert the `result` run_event at the returned `last_seq`, carrying `designVersion`.
6. Clear `threads.active_run_id`.

**Terminal (one transaction, same guard `status='running'`), for Stop, an error, the deadline or the reaper:**
- set `cancelled` or `failed`;
- insert a reply (`cancelled` or `error`, fixed phrase);
- insert the terminal event;
- clear `active_run_id` (`4O-H4`).

**Reaper:** at startup and every 60 s it terminates `running` runs whose `heartbeat_at` is older than 90 s or whose `deadline_at` has passed. This is the guarantee on any host; SIGTERM handling is best-effort (`4O-M9`, `4K-H5`).

**Streaming:** live events are appended through the run store. A reconnecting client reads `run_events` after its cursor, then follows. After done, `GET /api/threads/:id` returns the messages and versions, so missing events never lose the result.

**Retention (`4O-H5`, `4G-F3`, `4K-H4`, `4O-M11`):**
- `run_events` of runs ended more than 10 min ago are deleted.
- Unreferenced artifacts older than 24 h are deleted. Referenced means `designs.stl_artifact`, `designs.step_artifact` and `message_attachments`.
- Runs and messages are kept while their thread lives.
- A `DELETE` thread archives it.
- 30 days after archiving, ONE transaction purges in foreign-key order: run_events → message_attachments → messages → designs → artifacts (rows, then objects after commit) → runs → threads.
- The local run TTL that deletes runs and artifacts today is removed.

## Phase 0: designer-only cleanup
### Task 0a: Import map and keep list (the user gives go/no-go)
**Files:** create `docs/superpowers/plans/2026-11-08-phase0-import-map.md`.

**Method:**
- Run `npx dependency-cruiser` or `madge`, via npx with no dependency added, from these entries:
  - `src/app/api/chat/route.ts`;
  - `src/app/api/compile/route.ts`;
  - `src/app/api/runs/**`;
  - `src/app/api/artifacts/**`;
  - `src/app/page.tsx` and every component it renders;
  - `eval/designer/**`.
- Restrict the server graph to the designer path, then list:
  1. KEEP: everything reachable from the designer path, the viewer, the compile path, sliders, pins, the print panel and STEP;
  2. EXTRACT: kept modules that import a module to be removed (for example `measurements.ts` and `llm-schemas.ts` importing `assembly-spec`, `4G-F2`), with the exact symbols to move;
  3. REMOVE: the rest;
  4. the `package.json` scripts and deps to drop (`openscad-wasm`, dead eval scripts, `4G-F11`).
- [ ] **Step 1: Produce the map.**
- [ ] **Step 2: Stop and ask the user to approve the KEEP, EXTRACT and REMOVE lists.**

### Task 0b: Extract, then remove server paths
Needs 0a approved.
- [ ] **Step 1: Move the EXTRACT symbols** into designer- or domain-named modules. Gate with `tsc` + vitest.
- [ ] **Step 2: Rewire the graph** to the designer path only, compiled without a checkpointer.
- [ ] **Step 3: Delete** the REMOVE list and its tests; delete `/api/chat/resume` and `/api/mcp`.
- [ ] **Step 4: Gate:** tsc, vitest, `next build`, and 1 live designer build via the eval runner.
- [ ] **Step 5: Commit** `refactor: designer is the only mode`.

### Task 0c: Remove the old UI paths
Needs 0b.

Remove the spec, sheet, variant and gate UI. KEEP the viewer, compile, sliders, pins, the print panel and STEP, as the map says (`4O-H1`, `4K-H1`).
- [ ] **Step 1: Write the failing test** `a designer run renders end to end, and slider moves recompile through /api/compile` (a component test).
- [ ] **Step 2: Remove.**
- [ ] **Step 3: Gate:** tsc, vitest, eslint, `next build`.
- [ ] **Step 4: Commit** `refactor(ui): remove spec, sheet and gate UI`.

## Phase A: features on PGlite (the full lifecycle, locally)
**Order:**
- A0 ∥ {A1 → A2} ∥ A3;
- then A4 → A5 → A6;
- then A7 ∥ A8 ∥ A9.

### Task A0: Owner identity and the route matrix
**Files:** `src/proxy.ts` and `src/lib/owner.ts`, plus owner checks on every existing route in the matrix. Test: `proxy.test.ts`, `owner.test.ts`, route tests.
- [ ] **Step 1: Write the failing tests:**
  - `the first request without a cookie: its own route reads the minted owner`;
  - `a non-UUID cookie is re-minted`;
  - `x-cadai-owner is stripped`;
  - `no owner → 401`;
  - `another owner's run is 404 on status, events and cancel, and the same for artifacts`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A1: Designer model text never streams (bug 2)
`run-designer.ts:153` gets `tags: ['nostream']`; `STRUCTURED_NODES` gets the designer nodes.
- [ ] **Step 1: Write the failing test** `no designer model text in deltas`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A2: The model writes only the body (bug 3)
After A1 (same file).
- **Produces:** `toBody`, `withGeneratedPrelude` and `PRELUDE_VERSION`.
- **Tests:**
  - a copied prelude without a sentinel is stripped;
  - a modified prelude is replaced;
  - the model is shown the body only;
  - finish accepts its own body;
  - a body-only first run passes.
- **Prompt:** "Write only the design code; the tool adds the prelude; `_round`/`_bevel` are available."
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task A3: Database layer and stores (`4O-M12`)
**Files:** `src/lib/db/{db,pglite,pg,migrate}.ts`, `db/migrations/0001_init.sql`, `src/lib/persist/*.ts`, and `src/lib/runs/run-store.ts` (replace `LocalRunStore` with `DbRunStore` implementing the existing `RunStore` contract, plus the lifecycle methods). Test: everything on in-memory PGlite.

**Produces:**
- `Db { query, transaction(fn) }`;
- `ThreadStore` (`claim`, `get`, `list`, `archive`);
- `DesignStore` (`get`, `latest`, `list`, `saveUserEdit`);
- `MessageStore` (`list`, `setKind`);
- `DbRunStore` (`start`, `commit`, `terminate`, `append`, `eventsSince`, `heartbeat`, `reap`, plus the existing contract);
- `migrate()` uses an advisory lock, applied at boot for PGlite and as a deploy step for Postgres.
- [ ] **Step 1: Write the failing tests:**
  - `start refuses a second active run with 409`;
  - `commit is atomic and refused after terminate`;
  - `terminate does nothing after commit`;
  - `concurrent message seq`;
  - `staleParent inside the transaction`;
  - `the reaper terminates stale runs with a reply`;
  - `purge in FK order`;
  - `stores hide other owners`;
  - `migrate twice concurrently`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A4: Triage, answers and the branch table (bug 4)
**Files:** `designer/{triage,answer}.ts`, the graph routing, and `designer/node.ts` (the branch table; `acceptedDesignerScript` removed).
- [ ] **Step 1: Write the failing tests:**
  - the classifier cases (taller, cable hole, what is this, new lamp, error → edit);
  - `a question writes only an answer`;
  - `new has parent_version null`;
  - `a second edit builds on the first` (the ms1 regression);
  - `a retry then failure → error reply, no version`;
  - `a refusal → fixed reply`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A5: Chat route on the lifecycle: server history, viewed version, user edits, attachments to the model
**Files:** `api/chat/route.ts`, the graph state (`threadId`, `runId`, `ownerKey`, `baseVersion`, `designRequest`, `attachments`), `designer/prompt.ts` and `stream-events.ts` (`designVersion` on `result`, `4G-F10`).

**Request:** `{ threadId, message, attachments?, viewingVersion?, pinnedParams?, editedBody?, model? }`. The server builds the history from `messages`. Attachment images go into the designer's first message as image blocks (`4K-H6`).
- [ ] **Step 1: Write the failing tests:**
  - `an edit while viewing v2 (v3 exists) edits v2 and is not stale`;
  - `pins create a user_edit version that the designer then edits`;
  - `an editor body is guarded and saved as user_edit`;
  - `a malicious pin value is rejected`;
  - `server history only`;
  - `an attachment reaches the designer as an image`;
  - `a 409 while a run is active`;
  - `a legacy id → phrase`;
  - `the result event carries designVersion`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A6: Artifacts, owner-scoped (local object store now)
**Files:** `designer/check.ts`, `runs/externalize.ts`, `runs/artifact-store.ts` (`put(ownerKey, …)`, `get(ownerKey, id)`, `delete`; random ids), `src/lib/storage/object-store.ts` (interface + local filesystem), and attachments upload.
- [ ] **Step 1: Write the failing tests:**
  - `STL and STEP become owner-scoped refs at designerCheck`;
  - `an object-store failure → fixed error, never inlines the mesh`;
  - `identical bytes, two owners → distinct ids`;
  - `attachment type sniffing and size cap`;
  - `compile results are not persisted` (`4O-M8`).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A7: Deadline and budgets
**Files:** `runs/stream-run.ts` and `designer/run-designer.ts` (budgets derived from the remaining deadline). Remove the route `maxDuration` exports.
- [ ] **Step 1: Write the failing tests:**
  - `the designer budget fits inside the remaining deadline`;
  - `deadline → failed with a reply`;
  - `Stop before commit → cancelled with a reply; Stop after commit → done`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A8: The eval runner takes the app path
**Files:** `eval/designer/{runner,report}.ts` and `sets/iterative.json`.

**Changes:**
- the runner uses PGlite and the app's request contract;
- the box-divider probe changes;
- the report gives per-step cost and time for sequences;
- a safe refusal is not a hard-check failure (`4O-M3`).
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task A9: Client
**Files:** `chat-panel.tsx`, `app-store.ts` and `src/lib/client/server-thread.ts`. This is a large task, so split it into A9a (threads and reconnect) and A9b (versions, pins and editor) (`4O-M13`).

**Behaviour:**
- UUID ids;
- the thread list and thread come from the server, with IndexedDB as a cache and legacy threads kept local with a banner;
- on load, with `activeRunId`, reconnect at `/api/runs/:id/events?after=<lastSeq>`;
- Stop;
- a version list sets `viewingVersion`;
- send `pinnedParams` and `editedBody` when they differ from the viewed version;
- 409 → the fixed phrase.
- [ ] **Step 1: Write the failing tests:**
  - `cold reload mid-build resumes`;
  - `reload after done`;
  - `Stop`;
  - `v2 selected → edit v2`;
  - `slider move then edit sends pins`;
  - `editor change then edit sends editedBody`;
  - `409 phrase`;
  - `legacy banner`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

## Phase B: server engines (host-agnostic)
### Task B1: The `pg` engine
`src/lib/db/pg.ts`:
- a pool of `PG_POOL_MAX` with `connectionTimeoutMillis` 5 s and `statement_timeout`, `idle_in_transaction_session_timeout` and `lock_timeout` each 15 s;
- a client is never held across a model or geo call;
- event tailing uses LISTEN/NOTIFY with one listener connection per process, instead of polling per client (`4O-M10`).

**Tests:** every A3 test, run on real Postgres (gated on `DATABASE_URL_TEST`), plus `100 tailing clients use at most 2 connections`.
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task B2: S3-compatible object store
`src/lib/storage/s3-object-store.ts` (keys `a/<ownerKey>/<id>.<kind>`; put, get streamed, delete). **Tests:** a mocked client, plus a live test gated on `S3_TEST_BUCKET`.
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task B3: Streaming on a generic host
- an SSE comment keep-alive every 15 s;
- `X-Accel-Buffering: no` and `Cache-Control: no-transform`;
- a client disconnect never stops the run.

**Tests:** keep-alives are emitted, and a disconnect leaves the run running.
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task B4: Sweep
`scripts/sweep.ts` plus `POST /api/internal/sweep`:
- Bearer auth; compare lengths before `timingSafeEqual`; 401 when the secret is unset;
- the host's scheduler runs it;
- it executes the Retention section exactly.

**Tests:**
- referenced artifacts (designs and attachments) survive;
- orphans are deleted after 24 h;
- run_events are deleted after 10 min;
- the archive purge runs in FK order;
- 401 cases.
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

---

## Execution and checks
- **Order:**
  1. 0a, then the user's go/no-go, then 0b → 0c.
  2. A0 ∥ {A1 → A2} ∥ A3.
  3. A4 → A5 → A6.
  4. A7 ∥ A8 ∥ A9.
  5. B1 ∥ B2 ∥ B3, then B4.
- **Gate per lane:**
  - tsc;
  - vitest `--maxWorkers=2`, once;
  - eslint on changed files.
- **End checks:**
  - **Browser smoke:**
    - build, edit, a second edit;
    - an edit of an older version, slider moves then an edit, a code edit then an edit;
    - a question, a new object;
    - refresh mid-build, reload after done;
    - Stop before and after the commit;
    - a second tab (409);
    - a legacy thread;
    - an attachment.
  - **Eval:** re-run ms0 + ms1 through the app-path runner (about $3).
