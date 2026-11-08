# Designer-only app with server-side persistence: implementation plan (v6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Designer mode (designer + live reviewer) is the only mode.
- A follow-up edits exactly what the user sees: the viewed version plus their slider and code edits.
- Threads, messages, runs, designs and artifacts live in Postgres and an object store. The browser reconnects, stops and reloads from server state.
- The backend is host-agnostic. task/dz becomes the new main.

**Architecture:**
- **Graph** (no checkpointer, nothing pauses):
  - `START → designerTriage → designerAnswer → END`;
  - `designerTriage → designerNode → designerCheck → END`;
  - `designerCheck → designerNode` once, when the first check fails.
  - The graph never writes the database's terminal state and never emits a terminal event. It ends with a `CommitPlan` in state.
- **`streamRun` owns the end of every run.** It drains its event chain, then runs exactly one of `store.commit(plan)` or `store.terminate(...)`, then forwards that transaction's `end` event to the live client.
- **One database layer, two engines:** `Db` with PGlite (embedded Postgres) for local dev, tests and evals, and `pg` for servers. The schema, SQL and store code are the same for both.
- **One run store (`DbRunStore`):** it replaces `LocalRunStore` and owns run status and events.
- **Object store:** local filesystem or S3-compatible.

**Tech stack:**
- Next.js 16 (read `node_modules/next/dist/docs/` before proxy, route or streaming code);
- LangGraph JS 1.4;
- new dependencies: `@electric-sql/pglite`, `pg` and `@aws-sdk/client-s3`, plus `embedded-postgres` as a dev dependency;
- `sharp`, which is already a dependency;
- the build123d geo service;
- Anthropic API only.

**Spec:**
- **User decisions, 2026-11-08:**
  - designer-only, and task/dz becomes main;
  - Postgres plus an object store, with the full schema;
  - `run_events` is a reconnect buffer;
  - persist before done;
  - blob retention follows the design;
  - not on Vercel; host-agnostic;
  - no accept gate; no floor rule; slider ranges parked;
  - PGlite for local and tests;
  - label model output, don't drop it.
- **Reviews folded in:**
  - v1 to v4 reviews in `.cadai/tasks/reviews/`;
  - the v5 council: `.cadai/scratch/council-v5/answer.md` in the main checkout. It is cited `5O`/`5K`/`5G` (Opus, Grok, Gemini) plus the finding id, and `C#n` for synthesis item n.

**Bugs this fixes:**
1. follow-ups lose the design, and a second edit reverts the first;
2. designer model text streams into the chat;
3. the model rewrites the prelude;
4. questions start new designs;
5. attachments never reach the model.

## Global Constraints
- **UI text.** The UI shows only fixed phrases or server-rendered markdown. Never raw model text, code, JSON or tracebacks (the R2 tests).
  - `designerNode`, `designerCheck`, `designerTriage` and `designerAnswer` go in `STRUCTURED_NODES` (`src/lib/agent/stream-bridge.ts:35`), and their model calls are tagged `nostream`.
- **Fixed phrases** (exact text, one module `src/lib/persist/phrases.ts`):
  - `RUN_ACTIVE`: "A design is still being built in this thread."
  - `LEGACY`: "This conversation was saved before server history. Start a new conversation to keep editing."
  - `REFUSAL`: "I can't help with that request."
  - `FAILED_CHECKS`: "Built, but it failed checks:", followed by a rendered list.
  - `STOPPED`: "Stopped."
  - `RUN_LOST`: "The build stopped unexpectedly. Please send your message again."
  - `DEADLINE`: "The build ran out of time. Try a simpler request or send it again."
  - `SAVE_FAILED`: "Something went wrong while saving this design. Reload to see the latest state."
  - `BAD_ATTACHMENT`: "Only PNG, JPEG or WebP images up to 5 MB, at most 4 per message."
  - `BAD_EDIT`: "The edited code uses something that isn't allowed, so it wasn't saved."
  - `BAD_PIN`: "A slider value isn't a valid number, so it wasn't applied."
- **Config:**
  - `CADAI_DB=pglite|postgres` (default `pglite`; the data dir is `<CADAI_RUN_DIR>/pglite`);
  - `DATABASE_URL`, `DATABASE_URL_MIGRATE`, `DATABASE_URL_TEST`, `PG_POOL_MAX` (default 10);
  - `CADAI_ARTIFACT_STORE=local|s3`, `S3_*`;
  - `CADAI_RUN_MAX_MS` (default 900 000);
  - `CADAI_ACCESS_TOKEN`, `CADAI_MAX_RUNNING` and `CADAI_DAILY_COST_USD` (B4).
  - Never print secrets.
  - Startup fails with a fixed message when `CADAI_RUN_DIR` is not writable. There is no `os.tmpdir()` fallback: remove those in `run-store.ts:131-148`, `artifact-store.ts:42-57` and `config.ts:27` (`5K-L2`, `5O-H3`).
- **Anthropic API only.** No `temperature`. Use JSON-schema output, never forced `tool_choice`. A model refusal becomes `REFUSAL`.
- **Owner:**
  - `src/proxy.ts` mints a `cadai_owner` cookie with `crypto.randomUUID()` when it is missing or not a UUID.
  - It sets the cookie on the response AND on the forwarded request (`NextResponse.next({ request: { headers } })`), and strips any incoming `x-cadai-owner`.
  - Cookie attributes: `HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000`, plus `Secure` when the request is https. The proxy refreshes `Max-Age` on page loads.
  - The matcher skips `_next/static`, `_next/image` and paths with a file extension.
  - The proxy never opens the database (`5K-M3`, `5O-M10`).
  - `ownerKeyFrom(request)` returns `sha256(cookie)`, or `null` → 401.
  - The owner lives on `threads` and `artifacts`.
- **Route matrix.** Every route resolves its object to the caller's owner. A mismatch is 404.

  | Route | Owner check | Task |
  | --- | --- | --- |
  | `POST /api/chat` | thread | A6 |
  | `GET /api/runs/:id`, `GET /api/runs/:id/events`, `POST /api/runs/:id/cancel` | the run's thread | A0b, A7 |
  | `GET /api/threads`, `GET\|PATCH\|DELETE /api/threads/:id` | thread | A8 |
  | `POST /api/attachments`, `GET /api/artifacts/:id` | artifact | A5 |
  | `POST /api/compile` | owner present; not persisted | A2, A5 |

  `/api/mcp` and `/api/chat/resume` are deleted in 0b.
- **Ids:** server threads are UUIDs. A non-UUID thread id is legacy: the route returns `LEGACY` and does not build.
- **Security:**
  - `checkPythonScript` runs before every `runBrep`. Stored bodies are re-checked on load and framed as data.
  - Pins:
    - the name must match an existing `name = <number>` line in the body (`parseBuild123dParams` on the body);
    - the value must be finite with `|v| ≤ 1e6`;
    - it is written as a fixed-point decimal with at most 6 places and no exponent, by line substitution (fixes `src/lib/design/write-params.ts:14-17`, `5O-M10`).
  - Attachments:
    - PNG, JPEG or WebP, sniffed by magic bytes;
    - at most 5 MB each and 4 per message;
    - decoded with sharp `limitInputPixels: 40_000_000`, then re-encoded as PNG with the long side at most 1568 px, which strips metadata.
- **No model or geo call inside any database transaction.** Transactions are short and local.
- **No floor rule.** Slider ranges stay parked.
- **Machine:** 7.6 GB RAM and 2 CPUs. `--maxWorkers=2`, one vitest at a time, nothing in /tmp.

## Review Focus
1. **Stop in the last second.** Stop pressed while the commit runs gives either a saved design with `done`, or `cancelled` with no design. It never gives a lost design, a 500 or a stuck thread. Pinned by A3 `commit vs terminate on two connections`.
2. **Double submit and two tabs.** One run starts, the second request gets 409 with `activeRunId` or the same run back, and nothing is written twice. Pinned by A3 `two starts on two connections` and A6 `a replayed clientMessageId returns the first run`.
3. **A killed server, then the user sends again.** A run whose heartbeat is stale is ended with `RUN_LOST` inside the new start, and the new message builds (no 409 for 90 s+). Pinned by A3 `start reaps a stale active run`.
4. **A long, silent model call.** A multi-minute `nostream` call with no events is not reaped, because the heartbeat runs until the terminal transaction returns. Pinned by A7 `a 3-minute silent designer call is not reaped`.
5. **A reload while the end is written.** A tail that connects as the commit lands always delivers the `end` event before it closes. Pinned by A7 `the events tail never ends before the end event`.

## Schema (`db/migrations/0001_init.sql`; runs on PGlite and Postgres alike; additive-only afterwards)
```sql
create table threads   (id uuid primary key, owner_key text not null, title text,
                        active_run_id text,                                 -- cleared only WHERE active_run_id = $run
                        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
                        archived_at timestamptz);
create index on threads(owner_key, updated_at desc) where archived_at is null;
create table runs      (id text primary key, thread_id uuid not null references threads(id),
                        status text not null,                -- running | done | failed | cancelled
                        model text, base_version int,        -- the version this run started from
                        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
                        heartbeat_at timestamptz not null default now(), deadline_at timestamptz not null,
                        last_seq int not null default 0, cancel_requested boolean not null default false,
                        error jsonb,                         -- { code: cancelled|run_lost|deadline|internal }
                        cost_usd numeric(10,4) not null default 0, wall_ms int, turns int,
                        design_version int, follow_up_kind text, ended_at timestamptz);
create unique index runs_one_active on runs(thread_id) where status = 'running';   -- fail-closed backstop (5K-H1)
create index on runs(thread_id, created_at desc);
create index on runs(status, heartbeat_at) where status = 'running';
create table run_events(run_id text not null references runs(id), seq int not null,
                        ts timestamptz not null default now(), type text not null, payload jsonb not null,
                        primary key(run_id, seq));
create table messages  (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id),
                        seq int not null, role text not null, kind text not null,
                        -- user: request|edit|question|unknown ; assistant: result|answer|error|cancelled|nochange
                        content text not null, run_id text references runs(id), design_version int,
                        client_message_id uuid,              -- user messages; idempotent send (5O-M11)
                        created_at timestamptz not null default now(),
                        unique(thread_id, seq), unique(thread_id, client_message_id));
create table message_attachments(message_id uuid not null references messages(id),
                        artifact_id text not null, primary key(message_id, artifact_id));  -- owner checked at insert
create table designs   (thread_id uuid not null references threads(id), version int not null, parent_version int,
                        origin text not null,                -- designer | user_edit
                        run_id text references runs(id),     -- null for user_edit versions
                        base_request text not null, edits jsonb not null default '[]',
                        body text not null, prelude_version text not null,
                        summary text not null, facts jsonb, flags jsonb not null default '[]',  -- e.g. ["failed_checks"]
                        stl_artifact text, step_artifact text, created_at timestamptz not null default now(),
                        primary key(thread_id, version));
create index on designs(run_id);
create table artifacts (owner_key text not null, id text not null, thread_id uuid references threads(id),
                        run_id text, kind text not null, bytes int not null, object_key text not null,
                        created_at timestamptz not null default now(), primary key(owner_key, id));
create index on artifacts(thread_id);
create index on artifacts(created_at);
create table pending_deletes(object_key text primary key, created_at timestamptz not null default now());
```

## Database engine rules (normative; `5O-H3`, `5O-M3`, `5K-H5`, C#7)
- **Interface:** `Db { query(sql, params), transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>, close() }`.
  - `Queryable` has only `query`.
  - Every store method takes a `Queryable` as its first argument, so callers compose methods inside one transaction.
  - An `AsyncLocalStorage` guard makes `db.query` throw `Error('db.query inside a transaction')` while a transaction is open in the same async context. Without it, PGlite hangs on its own mutex and `pg` silently runs the call outside the transaction.
  - Retry the whole `transaction(fn)` up to 3 times on SQLSTATE `40P01` and `40001`.
- **Row mapping in `Db`:** `numeric` → number; `int8` → number; `timestamptz` → epoch ms (`ts` in events).
- **PGlite:**
  - one instance on `globalThis.__cadaiPglite`, opened lazily on the first query, never at import, in `register()` or in the proxy;
  - an exclusive lockfile `<dir>/.cadai-lock` (`O_EXCL`, holding the pid; a stale pid is broken), so a second process fails fast with "The local database is already open in another process (pid N).";
  - refused when `NODE_ENV=production`, unless `CADAI_DB_SINGLE_PROCESS=1`;
  - vitest and evals use `memory://` or a private dir;
  - add `@electric-sql/pglite` to `serverExternalPackages` in `next.config.ts`.
- **`pg`:** a `Pool` of `PG_POOL_MAX` with `connectionTimeoutMillis` 5 s and `statement_timeout`, `idle_in_transaction_session_timeout` and `lock_timeout` each 15 s.
- **`migrate()`:** runs the numbered SQL files in a table `schema_migrations`.
  - On `pg` it holds `pg_advisory_xact_lock` on a dedicated client.
  - On PGlite the lockfile already makes it single-process.
  - It is applied lazily before the first PGlite query, and as a deploy step (`DATABASE_URL_MIGRATE`) for Postgres.

## Run lifecycle (normative; every task follows it)
**Lock order.** Every transaction that touches a thread and its run locks `threads` first (`SELECT … FOR UPDATE`), then `runs`. `append` and `heartbeat` touch only `runs`.

**Start** (`store.start(q, input)` in one transaction; the route validates first, with no writes):
- **Before the transaction:**
  - legacy id → `LEGACY`;
  - attachments over the caps → 400 `BAD_ATTACHMENT`;
  - `editedBody` failing `checkPythonScript` → 400 `BAD_EDIT`;
  - a pin failing the pin rules → 400 `BAD_PIN`.
- **In the transaction:**
  1. `INSERT INTO threads(id, owner_key) VALUES … ON CONFLICT DO NOTHING`, then `SELECT owner_key, archived_at, active_run_id FROM threads WHERE id=$t FOR UPDATE`. Another owner or archived → 404.
  2. Idempotency. A user message with the same `client_message_id` exists → return `{ replay: true, runId }`. The route answers 409 `{ error: { code: 'duplicate_message' }, runId }`.
  3. Active run:
     - When `active_run_id` points at a `running` run, terminate it in this transaction if it is stale (`heartbeat_at < now() - 90 s` or `deadline_at <= now()`), with code `run_lost` or `deadline` (`5G-11`).
     - Otherwise return 409 `{ error: { code: 'run_active', message: RUN_ACTIVE }, activeRunId }` (`5O-M11`).
  4. Each attachment id must exist in `artifacts` with `owner_key` = the caller and kind `image`; else 404 (`5K-H7`).
  5. User edits (below).
  6. Insert the run (`base_version`, `deadline_at = now() + CADAI_RUN_MAX_MS`). Set `active_run_id`.
  7. Insert the user message: `kind='unknown'`, `seq = max+1`, `client_message_id`, plus its attachment rows.
- **Nothing is written before the 404/409 checks.**
- **After the transaction commits,** any throw before `streamRun` starts calls `terminate(runId, 'failed', 'internal')` (`5O-L3`).

**User edits** (in the start transaction; `5K-M1`, `5G-6`, `5O-M6`):
- When the request carries `editedBody` or `pinnedParams` that differ from the viewed version, insert a `user_edit` version. Pins apply to `editedBody` when both are present, otherwise to the viewed version's body.
- Its fields:
  - `origin='user_edit'`;
  - `parent_version` = the viewed version;
  - `run_id` null;
  - `base_request` copied from the parent;
  - `edits` = the parent's;
  - `body` = the edited body;
  - `prelude_version` = the parent's;
  - `summary`: "Your edit (sliders)", "Your edit (code)" or "Your edit (code and sliders)";
  - `stl_artifact` and `step_artifact` null. The client compiles a version without an STL on view.
- `base_version` becomes that version.
- It is written whatever triage later decides. A `new` run does not parent it, and a question reads it.
- Triage never runs inside this transaction.

**Branches** (the graph produces a `CommitPlan`; `streamRun` commits it):

| Triage | Base | Graph path | `CommitPlan` |
| --- | --- | --- | --- |
| first message | — | designer → check | version + reply `result` |
| `edit` | `base_version` | designer (edit) → check | version + reply `result`; when the body equals the base body: reply `nochange`, no version |
| `new` | none | designer (fresh) → check | version (`parent_version` null) + reply `result` |
| `question` | `base_version` (read-only) | answer → END (skips check) | reply `answer`, no version |
| check fails twice (one retry as an edit carrying the failures) | as above | designer → check → designer → check | the final attempt has a mesh: version with `flags: ['failed_checks', …]` + reply `error` (`FAILED_CHECKS` + list) carrying `design_version`. No mesh: reply `error`, no version (`5O-M2`, label, don't drop) |
| refusal / unusable model output | — | — | reply `error` (`REFUSAL`), no version |
| triage error | — | treat as `edit` | — |

`CommitPlan` = `{ replyKind, replyMarkdown, userKind, followUpKind, design?: { parentVersion, origin: 'designer', baseRequest, edits, body, preludeVersion, summary, facts, flags, stlArtifact, stepArtifact }, costUsd, wallMs, turns }`.

**Commit** (`store.commit(q, runId, plan)`, one transaction, called only by `streamRun`):
1. Read the run's `thread_id` with no lock. `SELECT … FROM threads WHERE id=$t FOR UPDATE`.
2. `UPDATE runs SET status='done', design_version=…, cost_usd, wall_ms, turns, follow_up_kind, ended_at=now(), updated_at=now(), last_seq=last_seq+1 WHERE id=$r AND status='running' RETURNING last_seq`. If 0 rows, roll back and return `{ committed: false }`: Stop, the deadline or the reaper got there first.
3. When the plan carries a design, insert it with `version = max+1` under the thread lock.
4. Insert the assistant reply (`seq = max+1`) and set the user message's `kind`.
5. Insert the `end` event at the returned `last_seq`.
6. `UPDATE threads SET active_run_id=null, updated_at=now() WHERE id=$t AND active_run_id=$r`.

**Terminate** (`store.terminate(q, runId, status, code)`; status `cancelled` or `failed`): the same steps 1 and 2 (status, `error`, `ended_at`), then a reply (`STOPPED`, `RUN_LOST`, `DEADLINE` or `SAVE_FAILED`), the `end` event and the conditional clear. 0 rows → no-op.

**The `end` event** (the only terminal event; C#6): `{ t: 'end', seq, status, reply: { messageId, kind, markdown }, designVersion? }`. The client renders only `reply.markdown`, then reloads `GET /api/threads/:id`.

**Append** (one transaction, run row only):
- `UPDATE runs SET last_seq=last_seq+1, heartbeat_at=now() WHERE id=$r AND status='running' RETURNING last_seq`, then `INSERT run_events`.
- 0 rows → return `0`: the run already ended.

**Heartbeat:**
- `streamRun` runs `UPDATE runs SET heartbeat_at=now() WHERE id=$r AND status='running'` every 15 s.
- The timer starts before the graph and stops only after `commit`/`terminate` returns, including across `nostream` model and geo calls (`5K-H4`).

**Reaper:**
- One loop per process, started from `src/instrumentation.ts` under `NEXT_RUNTIME === 'nodejs'` and held on `globalThis.__cadaiReaper` so dev recompiles do not stack it.
- At start and every 60 s it selects `id FROM runs WHERE status='running' AND (heartbeat_at < now() - interval '90 seconds' OR deadline_at <= now())` with no lock, then calls `terminate` once per id, each in its own transaction.
- `get()` never reaps.

**Cancel:**
- `POST /api/runs/:id/cancel` sets `cancel_requested`, then returns the run's status.
- When the run is stale by the reaper's rule, the route calls `terminate('cancelled')` itself.
- The owner sees the flag (its existing poll), aborts the graph, and `streamRun` calls `terminate('cancelled')`. A Stop that arrives after the commit is a no-op: the status stays `done`.

**Streaming:**
- `streamRun` writes each event to the live client after `append` returns its seq.
- `append` returns 0, or `commit` returns `{ committed: false }`: abort the graph if it is still running, replay `eventsSince(lastSeq)` (which holds the winner's `end` event) to the client, and close.
- `append` throws: retry 3 times with backoff, then abort the graph and try `terminate('failed', 'internal')`. If that also fails, send `SAVE_FAILED` (unstored, no seq) and close. The reaper writes the stored reply later.
- The events tail reads the status, then drains, then stops when the status is not `running` (`events/route.ts:62-71`). This is correct because the `end` event and the status commit together.
- After done, `GET /api/threads/:id` returns everything, so missing events never lose the result.

**Retention:**
- The sweep runs in the reaper loop every 10 min.
- It deletes `run_events` of runs that ended more than 10 min ago.
- It deletes unreferenced artifacts older than 24 h with one `DELETE … WHERE NOT EXISTS (…) RETURNING object_key`, and inserts those keys into `pending_deletes` in the same transaction. Referenced means `designs.stl_artifact`, `designs.step_artifact` and `message_attachments`.
- `pending_deletes` objects are deleted from the object store, and their rows removed after success.
- Runs and messages are kept while their thread lives.
- `DELETE /api/threads/:id` terminates an active run, then archives the thread.
- 30 days after archiving, ONE transaction purges rows in foreign-key order (run_events → message_attachments → messages → designs → artifacts → runs → threads) and inserts the artifacts' object keys into `pending_deletes`.

**Deadline and budgets:**
- The designer's wall budget = `min(MAX_WALL_MS, remaining − 30 s − 120 s check reserve)`.
- A retry gets what remains, minus the same reserves.
- No retry starts with less than 60 s left: the run commits the failed attempt per the branch table.

## Phase 0: designer-only cleanup
### Task 0a: Import map and keep list (the user gives go/no-go)
**Files:** create `docs/superpowers/plans/2026-11-08-phase0-import-map.md`. Read only otherwise.

**Method (`5K-M5`, `5O-L7`, `5G-7`):**
- `npx dependency-cruiser` via npx, with no dependency added.
  - Use `--ts-config tsconfig.json` so the `@/` paths resolve, and `tsPreCompilationDeps: true` so dynamic imports are seen (`page.tsx:7`, `designer/node.ts`).
  - Report type-only edges separately. Type-only edges through `src/types/index.ts:2-3` (`assembly-spec`, `spec-audit`) and `AgentStateType` from `graph.ts` (`designer/node.ts:2`, `designer/check.ts:2`) do not make a module KEEP. They go to EXTRACT.
- **Entries:**
  - `src/app/api/{chat,compile,runs,artifacts}/**`;
  - `src/app/page.tsx`;
  - `src/proxy.ts`, if present;
  - `src/instrumentation.ts`;
  - `eval/designer/**`;
  - every `*.test.ts(x)`.
- **Consumers outside the import graph:**
  - `package.json` scripts (including `mcp` and `eval:*`);
  - `next.config.ts`, the vitest config and setup;
  - the env flags `CADAI_PIPELINE` and `CADAI_KERNEL`;
  - the geo service endpoints;
  - files read by path: `eval/designer/sets/*.json` (`runner.ts:110-114`) and `src/lib/brep/cheatsheet.md`.
- **Lists:**
  1. KEEP: modules reachable from the designer path, the viewer, compile, sliders, pins, the print panel and STEP.
  2. EXTRACT: symbols to move out of modules being removed, each with its source, its target, and the importers that change. At least:
     - the shared types from `src/types/index.ts` → `src/types/designer.ts`;
     - `AgentStateType` for designer nodes → `src/lib/agent/designer/state.ts`;
     - `applyParameterOverrides` and `estimateCostUsd` from `nodes/brep-agent-build.ts` (`run-designer.ts:7`);
     - the build123d compile path out of `openscad-bridge`, which the viewer, editor, chat panel, message bubble and store import.
  3. SIMPLIFY: KEEP modules with dead branches, and the lines to delete. Examples:
     - `paused`/`gate` in `stream-run.ts`, the cancel route and `run-contract.ts`;
     - the checkpointer calls;
     - the `resume` fetch in `chat-panel.tsx`;
     - `DesignContract.spec`;
     - the `openscad` default in `compile/route.ts:69`.
  4. KEEP-BY-PATH: the files read by path (above).
  5. SPLIT: mixed test files (for example `graph-route.test.ts`), with the cases to keep.
  6. REMOVE: listed module by module, never "the rest".
  7. `package.json` scripts and dependencies to drop: `openscad-wasm` only after EXTRACT, and the dead eval scripts.
- [ ] **Step 1: Produce the map.**
- [ ] **Step 2: Stop and ask the user to approve the lists.**

### Task 0b: Extract, simplify, rewire, remove (server)
Needs 0a approved.

**Interfaces:**
- **Produces:**
  - the designer graph in `src/lib/agent/designer/graph.ts`, with its own state annotation in `designer/state.ts`;
  - `RunStatus = 'running' | 'done' | 'failed' | 'cancelled'`.
- **Until Phase A:** the run still ends through the existing `respondToUser` and `LocalRunStore`, so the app works between phases.

- [ ] **Step 1: Move the EXTRACT symbols.** Gate: tsc + vitest.
- [ ] **Step 2: Rewire the graph to the designer path only, compiled without a checkpointer.**
  - The path is `designerNode → designerCheck → (designerNode once) → respondToUser → END`.
  - `routeAfterDesignerCheck` (`graph-route.ts:155-159`) returns `designerNode` or `respondToUser`, never `acceptGate`.
- [ ] **Step 3: Fix the eval runner.** It must not use the checkpointer or `Command`: delete `runner.ts:28,35,161,207,266`. It invokes the graph directly and reads the final state from the stream's last values (`5O-H6`, `5K-H6`).
- [ ] **Step 4: Apply SIMPLIFY.** `RunStatus` loses `paused`, and the gate append branch in `stream-run.ts:149-157` goes.
- [ ] **Step 5: Delete REMOVE and split SPLIT.** Delete `/api/chat/resume`, `/api/mcp` and `src/lib/agent/checkpointer.ts`.
- [ ] **Step 6: Gate.**
  - tsc, vitest, `next build`;
  - one live designer build and one follow-up edit via the runner (about $1): `eval/designer/runner.ts --set iterative --limit 1 --arm reviewer`;
  - expected: both steps have a mesh, no error.
- [ ] **Step 7: Commit** `refactor: designer is the only mode`.

### Task 0c: Remove the old UI paths
Needs 0b.
- Remove the spec, sheet, variant and gate UI.
- Move the viewer, editor, chat panel, message bubble and store onto the build123d compile path (EXTRACT). `compile/route.ts` accepts build123d only. Then drop `openscad-wasm`.
- KEEP the viewer, compile, sliders, pins, the print panel and STEP.
- [ ] **Step 1: Write the failing test** `a designer run renders end to end, and slider moves recompile through /api/compile` (a component test).
- [ ] **Step 2: Remove.**
- [ ] **Step 3: Gate:** tsc, vitest, eslint, `next build`.
- [ ] **Step 4: Commit** `refactor(ui): remove spec, sheet, gate and OpenSCAD UI`.

## Phase A: features on PGlite (the full lifecycle, locally)
**Order:** see "Execution and checks". Tasks that run in parallel touch disjoint files.

### Task A0a: Owner cookie and proxy
**Files:** `src/proxy.ts` and `src/lib/owner.ts`. Tests: `proxy.test.ts`, `owner.test.ts`.

**Produces:** `ownerKeyFrom(request: Request): string | null`.
- [ ] **Step 1: Write the failing tests:**
  - `the first request without a cookie: its own route reads the minted owner`;
  - `a non-UUID cookie is re-minted`;
  - `x-cadai-owner is stripped`;
  - `no owner → 401`;
  - `cookie attributes: HttpOnly, SameSite=Lax, Path=/, Max-Age; Secure only on https`;
  - `static assets get no Set-Cookie (matcher)`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A1: Designer model text never streams (bug 2)
**Files:** `designer/run-designer.ts:153` (`tags: ['nostream']`) and `stream-bridge.ts:35` (add `designerNode`, `designerCheck`, `designerTriage`, `designerAnswer`).
- [ ] **Step 1: Write the failing test** `no designer model text in deltas`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A2: The model writes only the body; the prelude is versioned (bug 3)
After A1 (same file).

**Files:** `src/lib/brep/prelude.ts`, `designer/{run-designer,prompt}.ts`, `src/app/api/compile/route.ts`, and the slider parsing call site.

**Produces:**
- `PRELUDES: Record<string, string>` (a registry; an entry is never edited, only added);
- `PRELUDE_VERSION`;
- `toBody(script): string`;
- `withGeneratedPrelude(body, version = PRELUDE_VERSION): string`;
- `hasPreludeSentinel(script): boolean`.

- **Tests:**
  - a copied prelude without a sentinel is stripped;
  - a modified prelude is replaced;
  - the model is shown the body only;
  - finish accepts its own body;
  - a body-only first run passes;
  - `/api/compile` prepends the prelude when the sentinel is absent and the version is given;
  - sliders parse the body only.
- **Prompt:** "Write only the design code; the tool adds the prelude; `_round`/`_bevel` are available."
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task A3: Database layer, stores and lifecycle transactions
**Files:**
- `src/lib/db/{db,pglite,pg,migrate,map}.ts` and `db/migrations/0001_init.sql`;
- `src/lib/persist/{types,phrases,threads,designs,messages,artifacts-rows}.ts`;
- `src/lib/runs/db-run-store.ts`, replacing `run-store.ts`;
- `next.config.ts` (`serverExternalPackages`);
- `vitest.pg-setup.ts`: a globalSetup that starts `embedded-postgres` under `<repo>/.cadai/pg-test` when `DATABASE_URL_TEST` is unset.

Tests: `*.test.ts` on in-memory PGlite, and `*.pg.test.ts` on real Postgres.

**Produces:**
- `Db`, `Queryable`, `getDb()`;
- `ThreadStore` (`get`, `list`, `rename`, `archive`);
- `DesignStore` (`get`, `latest`, `list`);
- `MessageStore` (`list`);
- `DbRunStore` (`start`, `commit`, `terminate`, `append`, `eventsSince(runId, afterSeq, limit)`, `heartbeat`, `requestCancel`, `isCancelled`, `reap`, `get`);
- `CommitPlan` and `StartInput` in `persist/types.ts`;
- `sweep(q, now)` and `purgeArchived(q, now)`.
- Nothing else from the old `RunStore` contract: no `create`, `setStatus`, `paused`, `expiresAt`, reap-on-get or byte cursor (`5K-H5`).

- [ ] **Step 0: Check `embedded-postgres` starts on this machine.** If it cannot, stop and report to the user; the `*.pg.test.ts` files must not be skipped silently.
- [ ] **Step 1: Write the failing tests.**
  - On PGlite:
    - `start refuses a second active run with 409 and writes nothing`;
    - `start reaps a stale active run`;
    - `a replayed clientMessageId returns the first run`;
    - `an attachment of another owner → 404`;
    - `user_edit fields`;
    - `commit is atomic and refused after terminate`;
    - `terminate does nothing after commit`;
    - `exactly one end event per run`;
    - `the reaper terminates stale runs with a reply`;
    - `sweep keeps referenced artifacts and queues object keys`;
    - `purge in FK order`;
    - `stores hide other owners`;
    - `db.query inside a transaction throws`;
    - `numeric/int8/timestamptz map the same on both engines`;
    - `a second PGlite process on the same dir fails fast`.
  - On real Postgres:
    - `two starts on two connections: one run, one 409`;
    - `commit vs terminate on two connections: no deadlock, one winner`;
    - `reaper vs commit on two connections`;
    - `concurrent message seq`;
    - `migrate twice concurrently`;
    - `the unique index rejects a second running run when the lock is skipped`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** per "Database engine rules" and "Run lifecycle".
- [ ] **Step 4: Run them.** Expected: PASS on both engines. A4 does not start until the real-Postgres tests pass.
- [ ] **Step 5: Commit.**

### Task A0b: Owner checks on the runs routes
After A3. **Files:** `src/app/api/runs/[runId]/{route,events/route,cancel/route}.ts` (owner check only; A7 rewrites cancel).
- [ ] **Step 1: Write the failing test** `another owner's run is 404 on status, events and cancel`.
- [ ] **Steps 2–5:** see it fail, implement, see it pass, commit.

### Task A4: Triage, answers and the branch table (bug 4)
After 0b, A2 and A3.

**Files:** `designer/{triage,answer,node,graph,state}.ts`.

**Interfaces:**
- **Consumes:** `CommitPlan` (A3).
- **Produces:** the graph state field `commitPlan: CommitPlan`, set on every path that reaches END, and `designerAnswer`. `respondToUser` is no longer on the designer path.

- [ ] **Step 1: Write the failing tests:**
  - the classifier cases: taller, cable hole, what is this, new lamp, error → edit;
  - `a question goes to designerAnswer and never through designerCheck`;
  - `a question plans only an answer`;
  - `new plans parent_version null`;
  - `a second edit builds on the first` (the ms1 regression);
  - `check fails twice with a mesh → a failed_checks version and an error reply`;
  - `check fails twice without a mesh → an error reply, no version`;
  - `an unchanged body → nochange, no version`;
  - `a refusal → REFUSAL`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Delete `acceptedDesignerScript`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A5: Owner-scoped artifacts, the object store and uploads
After A3; in parallel with A4 (disjoint files).

**Files:**
- `src/lib/storage/object-store.ts` (the interface plus the local filesystem store);
- `runs/artifact-store.ts`: `put(q, ownerKey, kind, bytes, { threadId?, runId? })` → a random id over `[A-Za-z0-9_-]`, with the row inserted before the object; `get(q, ownerKey, id)`;
- `runs/externalize.ts`: never inlines on failure;
- `designer/check.ts`: reads `ownerKey`, `threadId` and `runId` from `config.configurable`, not from graph state;
- `src/app/api/attachments/route.ts`: multipart `file` → `{ artifactId }`, with 400/413 → `BAD_ATTACHMENT`;
- `src/app/api/artifacts/[id]/route.ts`: owner-scoped; `Cache-Control: private, no-store`; streams the bytes;
- `src/app/api/compile/route.ts`: returns the mesh inline and writes no artifact row.

- [ ] **Step 1: Write the failing tests:**
  - `STL and STEP become owner-scoped refs at designerCheck`;
  - `an object-store failure → SAVE_FAILED path, never an inline mesh`;
  - `identical bytes, two owners → distinct ids`;
  - `another owner's artifact → 404`;
  - `upload: magic bytes, 5 MB cap, a pixel bomb rejected, re-encoded to ≤1568 px PNG`;
  - `compile writes no artifact row`;
  - `artifact responses are private, no-store`.
- [ ] **Steps 2–5:** see them fail, implement, see them pass, commit.

### Task A6: Chat route on the lifecycle; attachments reach the designer and the reviewer
After A4 and A5.

**Files:**
- `api/chat/route.ts`;
- `designer/types.ts` (`DesignerInput.attachments?: { mediaType: 'image/png'; base64: string }[]`, `5K-H7`);
- `designer/run-designer.ts:97-99`: the first `HumanMessage` is the image blocks, then the text;
- `designer/prompt.ts`;
- `designer/reviewer.ts`: the user's images are added as labeled reference images;
- `stream-run.ts`: passes `configurable: { ownerKey, threadId, runId }`.

**Request:** `{ threadId, clientMessageId, message, attachments?: artifactId[], viewingVersion?, pinnedParams?, editedBody?, model? }`. The server builds the history from `messages` and the base from `designs`.

- [ ] **Step 1: Write the failing tests:**
  - `an edit while viewing v2 (v3 exists) edits v2`;
  - `pins create a user_edit version that the designer then edits`;
  - `pins apply to editedBody when both are sent`;
  - `an editor body failing the guardrail → 400 BAD_EDIT, no run`;
  - `a pin with an unknown name or 1e21 → 400 BAD_PIN`;
  - `server history only`;
  - `an attachment reaches the designer and the reviewer as an image block`;
  - `409 carries activeRunId`;
  - `a legacy id → LEGACY`.
- [ ] **Steps 2–5:** see them fail, implement, see them pass, commit.

### Task A7: One writer ends the run; heartbeat, cancel and deadline
After A6.

**Files:**
- `runs/stream-run.ts`:
  - drain → commit/terminate → forward the `end` event;
  - delete `storeBroken`, `sendUnstored`, `localSeq` and `finish(…, 'done')` (`stream-run.ts:103-224, 311-314`);
  - the heartbeat timer per the lifecycle.
- `graph.ts` `respondToUser`: delete the designer `result` emission (`graph.ts:2175`).
- `api/runs/[runId]/cancel/route.ts`: `requestCancel`, plus terminate when the run is stale. Delete `resultIsOut` and `setStatus` (`cancel/route.ts:21-90`).
- `api/runs/[runId]/events/route.ts`: a seq cursor.
- `src/lib/stream-events.ts` and `src/lib/stream-reader.ts`: the `end` event replaces `result`/`error` on this path, and has `cancelled`.
- `designer/run-designer.ts`: budgets from the remaining deadline. Remove the route `maxDuration` exports.

- [ ] **Step 1: Write the failing tests:**
  - `every event is stored before the end event; exactly one end event`;
  - `the events tail never ends before the end event`;
  - `a 3-minute silent designer call is not reaped` (fake timers);
  - `Stop before commit → cancelled with STOPPED; Stop after commit → done`;
  - `Stop on a dead owner terminates via the route`;
  - `deadline → failed with DEADLINE`;
  - `append failing 3 times → SAVE_FAILED and the run is ended`;
  - `the designer budget fits inside the remaining deadline`;
  - `a retry never starts with under 60 s left`.
- [ ] **Steps 2–5:** see them fail, implement, see them pass, commit.

### Task A8: Threads routes, the reaper and sweep loop
After A3 and A5; in parallel with A6 and A7 (disjoint files).

**Files:**
- `src/app/api/threads/route.ts` and `src/app/api/threads/[id]/route.ts`;
- `src/lib/persist/loop.ts`;
- `src/instrumentation.ts`.

**Response shapes:**
- `GET /api/threads` → `{ threads: [{ id, title, updatedAt, activeRunId }] }`.
- `GET /api/threads/:id` → `{ id, title, activeRun: { id, status, lastSeq } | null, messages: [{ id, seq, role, kind, markdown, designVersion?, attachments: string[] }], versions: [{ version, parentVersion, origin, summary, flags, body, preludeVersion, stl, step, createdAt }] }`.
- `PATCH /api/threads/:id` with `{ title }` (at most 120 chars) → 204 (`5G-9`).
- `DELETE /api/threads/:id` terminates the active run, then archives → 204. Archived threads are 404 everywhere.

- [ ] **Step 1: Write the failing tests:**
  - `the thread GET shape`;
  - `another owner → 404`;
  - `rename`;
  - `delete during a run terminates it, then archives`;
  - `the loop starts once across two register() calls`;
  - `the loop reaps and sweeps`;
  - `pending_deletes are retried until the object is gone`.
- [ ] **Steps 2–5:** see them fail, implement, see them pass, commit.

### Task A9: The eval runner takes the app path
After A7. **Files:** `eval/designer/{runner,report}.ts` and `sets/iterative.json`.

**Changes:**
- the runner calls the app's start/`streamRun` path on a private PGlite dir, with `clientMessageId`, `viewingVersion` and attachments;
- the box-divider probe changes;
- the report gives per-step cost and time for sequences;
- a safe refusal is not a hard-check failure.
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task A10: Client
After A7 and A8. Split into A10a (threads and reconnect) then A10b (versions, pins and editor).

**Files:** `chat-panel.tsx`, `app-store.ts`, `src/lib/client/server-thread.ts` and `code-editor-panel.tsx`.

**Behaviour:**
- UUID thread ids, and a `clientMessageId` per send.
- The thread list and thread come from the server. IndexedDB is a cache.
- Legacy threads stay local and read-only, with a banner.
- On load, with `activeRun`, reconnect at `/api/runs/:id/events?after=<lastSeq>`.
- On `end`: render `reply.markdown`, then reload the thread and show `designVersion`.
- 409 `run_active` → attach to `activeRunId`; `duplicate_message` → attach to `runId`.
- Stop and rename.
- A version list sets `viewingVersion`. A version without an STL is compiled on view.
- The editor shows the body only, with a fixed note that the prelude helpers come from the tool.
- Send `pinnedParams` and `editedBody` only when they differ from the viewed version.
- Unsent slider and editor edits are kept as a local draft per (thread, version).
- Delete `applyContract` and the sticky `designContract` pin re-application (`app-store.ts:15, 303-367, 421-470`, `5O-M6`).

- [ ] **Step 1: Write the failing tests:**
  - A10a:
    - `cold reload mid-build resumes`;
    - `reload after done`;
    - `the open tab shows the committed version after end`;
    - `Stop`;
    - `409 attaches to the active run`;
    - `legacy banner`.
  - A10b:
    - `v2 selected → edit v2`;
    - `slider move then edit sends pins once`;
    - `editor change then edit sends editedBody`;
    - `an agent result is never re-pinned`;
    - `a draft survives reload`;
    - `a failed_checks version is labeled`.
- [ ] **Steps 2–5:** see them fail, implement, see them pass, commit.

## Phase B: server engines (host-agnostic)
### Task B1: `pg` in production shape, and the tail fan-out
**Files:**
- `src/lib/db/pg.ts` (the pool settings in "Database engine rules");
- the `DATABASE_URL_MIGRATE` deploy step (`scripts/migrate.ts`);
- `src/lib/runs/tail-hub.ts`: one in-process poller per active run (every 300 ms), fanned out to all local tails of that run. It works behind any pooler, and LISTEN/NOTIFY is not used (`5O-M9`).

**Tests:**
- every A3 test on real Postgres;
- `20 tails of one run use one poller`;
- `a tail that joins late gets the backlog, then live events`.
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task B2: S3-compatible object store
**Files:** `src/lib/storage/s3-object-store.ts`.
- keys `a/<ownerKey>/<id>.<kind>`;
- put, get (streamed) and delete;
- a private bucket; the app streams the bytes and never hands out object URLs.

**Tests:** a mocked client, plus a live test gated on `S3_TEST_BUCKET`.
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task B3: Streaming on a generic host
- an SSE comment keep-alive every 15 s;
- `X-Accel-Buffering: no` and `Cache-Control: no-transform`;
- a client disconnect never stops the run.

**Tests:** keep-alives are emitted, and a disconnect leaves the run running.
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

### Task B4: Access gate and caps (required before any public host; `5O-M8`)
- **Access gate.** When `CADAI_ACCESS_TOKEN` is set, the proxy requires it once (a `cadai_access` cookie set from `?access=`), and every route returns 401 without it.
- **Running-runs cap.** At most `CADAI_MAX_RUNNING` runs (default 4) may be `running` across all owners. Start returns 429 "The server is busy. Try again in a minute."
- **Concurrent geo cap.** At most 2 concurrent `runBrep` calls per process, queued.
- **Daily cost ceiling.** When `sum(cost_usd)` over runs created today reaches `CADAI_DAILY_COST_USD`, start returns 429 "Today's build budget is used up."

**Tests:** each limit, plus 401 without the token.
- [ ] **Steps:** write the tests, see them fail, implement, see them pass, commit.

## Parked (not in this plan)
- slider ranges;
- continuing a legacy thread on the server;
- multi-host realtime beyond polling.

---

## Execution and checks
- **Order:**
  1. 0a, then the user's go/no-go, then 0b → 0c.
  2. A0a ∥ {A1 → A2} ∥ A3. A3's real-Postgres tests must pass before step 3.
  3. A0b ∥ A4 ∥ A5.
  4. A6 ∥ A8.
  5. A7.
  6. A9 ∥ A10a, then A10b.
  7. B1 ∥ B2 ∥ B3, then B4. B4 lands before any public host.
- **Gate per lane:**
  - tsc;
  - vitest `--maxWorkers=2`, once, and one lane at a time;
  - eslint on changed files.
- **End checks:**
  - **Browser smoke:**
    - build, edit, a second edit;
    - an edit of an older version, slider moves then an edit, a code edit then an edit;
    - a question, a new object, an attachment;
    - refresh mid-build, reload after done;
    - Stop before and after the commit;
    - a second tab (it attaches, with no second run);
    - kill the server mid-run, restart and send again;
    - a legacy thread.
  - **Eval:** re-run ms0 + ms1 through the app-path runner (about $3).
