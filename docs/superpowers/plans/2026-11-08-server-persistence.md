# Designer-only app with server-side persistence: implementation plan (v8)

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
  - The graph never writes to the database and never emits a terminal event. It ends with a `RunOutcome` in state.
- **`streamRun` owns the end of every run.** It drains its event chain. It then either uploads the outcome's mesh and calls `store.commit(plan)`, or calls `store.terminate(...)`. Finally it forwards that transaction's `end` event to the live client.
- **One database layer, two engines:** `Db` with PGlite (embedded Postgres) for local dev, tests and evals, and `pg` for servers. The schema, SQL and store code are the same for both.
- **One run store (`DbRunStore`):** it is built beside `LocalRunStore` and replaces it in a single cutover task (C1).
- **Object store:** local filesystem or S3-compatible.

**Tech stack:**
- Next.js 16 (read `node_modules/next/dist/docs/` before proxy, route or streaming code);
- LangGraph JS 1.4;
- new dependencies: `@electric-sql/pglite`, `pg` and `@aws-sdk/client-s3`, plus `embedded-postgres` as a dev dependency;
- `sharp` (already a dependency);
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
  - v1–v4 reviews (`.cadai/tasks/reviews/`);
  - council v5 (`.cadai/scratch/council-v5/answer.md`, main checkout);
  - council v6 (`.cadai/scratch/council-v6/answer.md`), cited `6#n` for synthesis item n, or `6O`/`6K`/`6G` plus the finding id;
  - council v7 (`.cadai/scratch/council-v7/answer.md`), cited `7#n`.

**Bugs this fixes:**
1. follow-ups lose the design, and a second edit reverts the first;
2. designer model text streams into the chat;
3. the model rewrites the prelude;
4. questions start new designs;
5. attachments never reach the model.

## Global Constraints
- **UI text.** The UI shows only fixed phrases or server-rendered markdown. Never raw model text, code, JSON, compiler errors or tracebacks (the R2 tests).
  - `designerNode`, `designerCheck`, `designerTriage` and `designerAnswer` go in `STRUCTURED_NODES` (`src/lib/agent/stream-bridge.ts`), and their model calls are tagged `nostream`.
- **Fixed phrases** (exact text; one module, `src/lib/persist/phrases.ts`):
  - `RUN_ACTIVE`: "A design is still being built in this thread."
  - `LEGACY`: "This conversation was saved before server history. Start a new conversation to keep editing."
  - `REFUSAL`: "I can't help with that request."
  - `FAILED_CHECKS`: "Built, but it failed checks:" followed by a list of the fixed check sentences (below).
  - `COMPILE_FAILED`: "The script did not compile." This is a list item, and the raw error stays in server logs (`6#6`).
  - `STOPPED`: "Stopped."
  - `NO_CHANGE`: "No changes were needed."
  - `RUN_LOST`: "The build stopped unexpectedly. Please send your message again."
  - `DEADLINE`: "The build ran out of time. Try a simpler request or send it again."
  - `BUILD_FAILED`: "The build failed. Please send your message again." (graph exceptions and unusable model output, `6#4`, `7#7`)
  - `SAVE_FAILED`: "Something went wrong while saving this design. Reload to see the latest state."
  - `STALE_CLIENT`: "Reload the page and try again." (missing `clientMessageId` or `viewingVersion`)
  - `BAD_ATTACHMENT`: "Only PNG, JPEG or WebP images up to 5 MB, at most 4 per message."
  - `BAD_EDIT`: "The edited code uses something that isn't allowed, so it wasn't saved."
  - `BAD_PIN`: "A slider value isn't a valid number, so it wasn't applied."
  - **Fixed check sentences:** the sentences `designer/check.ts` already builds for empty, invalid, disconnected and interfering parts, plus `COMPILE_FAILED`. Part labels and volumes inside them are escaped inline code of at most 40 chars. A guardrail failure is reported as `COMPILE_FAILED` (`7#7`).
- **Config:**
  - `CADAI_DB=pglite|postgres` (default `pglite`; data dir `<CADAI_RUN_DIR>/pglite`);
  - `DATABASE_URL`, `DATABASE_URL_MIGRATE`, `DATABASE_URL_TEST`, `PG_POOL_MAX` (default 10);
  - `CADAI_ARTIFACT_STORE=local|s3`, `S3_*`;
  - `CADAI_RUN_MAX_MS` (default 900 000);
  - `CADAI_HEARTBEAT_MS` (default 15 000) and `CADAI_STALE_MS` (default 90 000);
  - `CADAI_TRUST_PROXY` (default unset);
  - `CADAI_ACCESS_TOKEN`, `CADAI_MAX_RUNNING`, `CADAI_DAILY_COST_USD` (B4).
  - Never print secrets.
  - Startup fails with a fixed message when `CADAI_RUN_DIR` is not writable. There is no `os.tmpdir()` fallback anywhere. Owners: A3 (`runs/config.ts`, including its `VERCEL` branch, and `run-store.ts`) and A5 (`artifact-store.ts`) (`6#7`).
- **Anthropic API only.** No `temperature`. JSON-schema output, never forced `tool_choice`. A model refusal becomes `REFUSAL`.
- **Owner:**
  - `src/proxy.ts` mints a `cadai_owner` cookie with `crypto.randomUUID()` when it is missing or not a UUID.
  - It sets the cookie on the response AND on the forwarded request (`NextResponse.next({ request: { headers } })`), and strips any incoming `x-cadai-owner`.
  - Cookie attributes: `HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000`, and `Secure` when the request is https. Https is read from `x-forwarded-proto` only when `CADAI_TRUST_PROXY=1`, and from `nextUrl.protocol` otherwise.
  - Page loads refresh `Max-Age`.
  - The matcher skips `_next/static`, `_next/image` and paths with a file extension.
  - The proxy never opens the database.
  - `ownerKeyFrom(request)` returns `sha256(cookie)` as lowercase hex, or `null` → 401.
  - The owner lives on `threads` and `artifacts`.
- **Route matrix.** Every route resolves its object to the caller's owner; a mismatch is 404.

  | Route | Owner check | Task |
  | --- | --- | --- |
  | `POST /api/chat` | thread | C1 |
  | `GET /api/runs/:id`, `GET /api/runs/:id/events`, `POST /api/runs/:id/cancel` | the run's thread | C1 |
  | `GET /api/threads`, `GET\|PATCH\|DELETE /api/threads/:id` | thread | A8 |
  | `POST /api/attachments` | owner present | A5 |
  | `GET /api/artifacts/:id` | artifact | C1 |
  | `POST /api/compile` | owner present; not persisted | A2, A5 |

  `/api/mcp`, `/api/chat/resume`, `src/mcp-server.ts` and `src/lib/mcp/**` are deleted in 0b.
- **Ids:** server threads are UUIDs. A non-UUID thread id is legacy: return `LEGACY` and do not build.
- **Security:**
  - `checkPythonScript` runs before every `runBrep`. Stored bodies are re-checked on load and framed as data.
  - **Pins:**
    - names are matched with `parseParams` (the export of `src/lib/design/parse-params.ts`) on the body the pins are written into;
    - the value must be finite with `|v| ≤ 1e6`;
    - it is written as fixed-point with at most 6 decimals and no exponent, by line substitution, replacing the raw interpolation in `write-params.ts`.
  - **Attachments:**
    - PNG, JPEG or WebP, sniffed by magic bytes;
    - at most 5 MB each and 4 per message;
    - one file per upload request; a request whose `Content-Length` is over 5 MB + 64 KB is rejected before parsing;
    - any multipart or sharp failure → `BAD_ATTACHMENT`;
    - decode with sharp `limitInputPixels: 40_000_000`, then re-encode as PNG with the long side at most 1568 px;
    - `next.config.ts` sets `experimental.proxyClientMaxBodySize: '6mb'`, because the proxy otherwise truncates bodies silently.
  - **Artifact ids** are 128 bits from `crypto.randomBytes`, base64url.
- **No model, geo or object-store call inside any database transaction.**
- **No floor rule.** Slider ranges stay parked.
- **Machine:** 7.6 GB RAM and 2 CPUs. `--maxWorkers=2`, one vitest at a time, nothing in /tmp.

## Review Focus
1. **Stop in the last second.** A Stop that lands while the graph finishes or the commit runs ends in one of two states: a saved design with `done`, or `cancelled` with no design. Never a lost design, a 500 or a stuck thread. Pinned by A3 `commit vs terminate on two connections` and C1 `completed wins over a late local abort`.
2. **Double submit and two tabs.** One run starts. The second request gets 409 with `activeRunId`, or the same run back, and nothing is written twice. Pinned by A3 `two starts on two connections` and A3 `a replayed clientMessageId returns the first run`.
3. **A killed server, then the user sends again.** On PGlite the restarted process ends the old run at boot. On Postgres the old run is ended once it is stale, inside the new start. The new message then builds. Pinned by A3 `start reaps a stale active run` and A8 `the PGlite boot sweep ends only runs created before the process started`.
4. **A long, silent model call.** A multi-minute `nostream` call with no events is not reaped, because the heartbeat runs until `streamRun` exits. Pinned by C1 `a silent designer call outlives the stale threshold` (real time, small scale).
5. **A reload while the end is written.** A tail that connects as the commit lands always delivers the `end` event before it closes. A tail past retention makes the client reload the thread. Pinned by C1 `the events tail never ends before the end event` and A10a `a tail closed without end reloads the thread`.

## Schema (`db/migrations/0001_init.sql`; runs on PGlite and Postgres alike; additive-only afterwards)
```sql
create table threads   (id uuid primary key, owner_key text not null, title text,
                        active_run_id text,                                 -- cleared only WHERE active_run_id = $run
                        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
                        archived_at timestamptz);
create index on threads(owner_key, updated_at desc) where archived_at is null;
create table runs      (id text primary key, thread_id uuid not null references threads(id),
                        status text not null,                -- running | done | failed | cancelled
                        model text, base_version int,
                        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
                        heartbeat_at timestamptz not null default now(), deadline_at timestamptz not null,
                        last_seq int not null default 0,
                        error jsonb,                         -- { code: cancelled|run_lost|deadline|graph|internal }
                        cost_usd numeric(10,4) not null default 0, wall_ms int, turns int,
                        design_version int, ended_at timestamptz);
create unique index runs_one_active on runs(thread_id) where status = 'running';
create index on runs(thread_id, created_at desc);
create index on runs(status, heartbeat_at) where status = 'running';
create table run_events(run_id text not null references runs(id), seq int not null,
                        ts timestamptz not null default now(), type text not null, payload jsonb not null,
                        primary key(run_id, seq));
create table artifacts (id text primary key, owner_key text not null, thread_id uuid references threads(id),
                        run_id text, kind text not null,     -- stl | step | image
                        bytes int not null, object_key text not null,
                        created_at timestamptz not null default now());
create index on artifacts(owner_key);
create index on artifacts(thread_id);
create index on artifacts(created_at);
create table messages  (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id),
                        seq int not null, role text not null, kind text not null,
                        -- user: request|edit|question|unknown ; assistant: result|answer|error|cancelled|nochange
                        content text not null, run_id text references runs(id), design_version int,
                        client_message_id uuid,              -- required on user messages (route enforces)
                        created_at timestamptz not null default now(),
                        unique(thread_id, seq), unique(thread_id, client_message_id));
create table message_attachments(message_id uuid not null references messages(id),
                        artifact_id text not null references artifacts(id),
                        primary key(message_id, artifact_id));
create table designs   (thread_id uuid not null references threads(id), version int not null, parent_version int,
                        origin text not null,                -- designer | user_edit
                        run_id text references runs(id),     -- null for user_edit versions
                        base_request text not null, edits jsonb not null default '[]',
                        body text not null, prelude_version text not null,
                        summary text not null, facts jsonb, flags jsonb not null default '[]',  -- e.g. ["failed_checks"]
                        stl_artifact text references artifacts(id), step_artifact text references artifacts(id),
                        created_at timestamptz not null default now(),
                        primary key(thread_id, version));
create index on designs(run_id);
create table pending_deletes(object_key text primary key, created_at timestamptz not null default now());
```

## Database engine rules (normative; `6#8`)
- **Interface:** `Db { query(sql, params), transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>, close() }`.
  - `Queryable` has only `query`.
  - Every store method takes a `Queryable` first, so callers compose methods inside one transaction.
- **Guard:**
  - `transaction` runs `fn` inside `AsyncLocalStorage` with a store `{ open: true }`, and sets `open = false` in `finally`.
  - `db.query` throws `Error('db.query inside a transaction')` only while the current store is `open`. Timers and promises that outlive `fn` see `open: false` and do not throw.
- **Retries:** retry the whole `transaction(fn)` up to 3 times on SQLSTATE `40P01`. READ COMMITTED does not raise `40001`.
- **Row mapping in `Db`:** `numeric` → number; `int8` → number; `timestamptz` → epoch ms.
- **PGlite:**
  - one instance on `globalThis.__cadaiPglite`, opened lazily on the first query; never at import or in the proxy. The only database work in `register()` is the PGlite boot sweep (see Reaper);
  - an exclusive lockfile `<dir>/.cadai-lock`:
    - created with `O_EXCL`, holding the pid, then re-read to confirm it holds this pid;
    - a lock whose pid is dead, or equal to `process.pid`, is stale and is broken;
    - a live other pid fails fast with "The local database is already open in another process (pid N).";
  - `close()` on SIGINT/SIGTERM;
  - refused under `NODE_ENV=production` unless `CADAI_DB_SINGLE_PROCESS=1`;
  - under `VITEST`, `getDb()` uses `memory://` unless `CADAI_PGLITE_DIR` is set (the lockfile test sets it); the eval runner uses a private dir;
  - `next.config.ts` lists `@electric-sql/pglite` in `serverExternalPackages`.
- **`pg`:** a `Pool` of `PG_POOL_MAX` with `connectionTimeoutMillis` 5 s and `statement_timeout`, `idle_in_transaction_session_timeout` and `lock_timeout` each 15 s.
- **`migrate()`:** applies the numbered SQL files and records them in `schema_migrations`.
  - On `pg` it holds `pg_advisory_xact_lock` on a dedicated client.
  - On PGlite the lockfile already makes it single-process.
  - It runs lazily before the first PGlite query, and as a deploy step (`DATABASE_URL_MIGRATE`) for Postgres.

## Run lifecycle (normative; every task follows it)
**Lock order.** Every transaction that touches a thread and its run locks `threads` first (`SELECT … FOR UPDATE`), then `runs`. `append` and `heartbeat` touch only `runs`.

**Stale.** A `running` run is stale when `heartbeat_at < now() - CADAI_STALE_MS` or `deadline_at + 60 s <= now()`.

**Start** (`store.start(q, input)`, one transaction). The route first validates what needs no database:
- legacy id → `LEGACY`;
- missing `clientMessageId` → 400 `STALE_CLIENT`;
- attachment caps → 400 `BAD_ATTACHMENT`;
- `editedBody` failing `checkPythonScript` → 400 `BAD_EDIT`.

Then, in the transaction:
1. `INSERT INTO threads(id, owner_key) VALUES … ON CONFLICT DO NOTHING`, then `SELECT owner_key, archived_at, active_run_id FROM threads WHERE id=$t FOR UPDATE`. Another owner or archived → 404.
2. **Idempotency.** A user message with this `client_message_id` already exists → return `{ replay: true, runId }`, and the route answers 409 `{ error: { code: 'duplicate_message' }, runId }`.
3. **Active run.** If `active_run_id` points at a `running` run, call `reap(q, runId)` (see Reaper). When it ends the run (it was stale), continue. When it returns false (the run is live) → 409 `{ error: { code: 'run_active', message: RUN_ACTIVE }, activeRunId }`.
4. **Base.**
   - The thread has a design and `viewingVersion` is missing → 400 `STALE_CLIENT`.
   - `viewingVersion` is not in this thread → 404.
   - Otherwise `base_version = viewingVersion` (null for a thread with no design).
5. **Pins.** They are validated here, after the owner check, so a 400 never reveals another owner's thread. A failure throws a typed error that rolls back → 400 `BAD_PIN`.
6. **Attachments.** Each attachment id must exist in `artifacts` with `owner_key` = the caller and kind `image`; else 404.
7. **User edits** (below).
8. Insert the run (`base_version`, `deadline_at = now() + CADAI_RUN_MAX_MS`), and set `active_run_id`. When `title` is null, set it to the first line of the message, at most 80 chars.
9. Insert the user message (`kind='unknown'`, `seq = max+1`, `client_message_id`) and its attachment rows.

Nothing is written before the 404/409 checks. If anything throws after the transaction commits but before `streamRun` starts, the route calls `terminate(runId, 'failed', 'internal')`.

**User edits** (in the start transaction):
- When the request carries `editedBody` or `pinnedParams` that differ from the base version, insert a `user_edit` version. Pins apply to `editedBody` when both are present, otherwise to the base body.
- Fields:
  - `origin='user_edit'`;
  - `parent_version` = the base;
  - `run_id` null;
  - `base_request`, `edits` and `prelude_version` copied from the parent;
  - `body` = the edited body;
  - `summary`: "Your edit (sliders)", "Your edit (code)" or "Your edit (code and sliders)";
  - `stl_artifact` and `step_artifact` null; the client compiles a version without an STL on view.
- `base_version` becomes this version.
- It is written whatever triage later decides: `new` does not parent it, and `question` reads it.
- Triage never runs inside a transaction.

**Branches** (the graph sets `outcome: RunOutcome` on every path that reaches END):

| Case | Graph path | `RunOutcome` |
| --- | --- | --- |
| no base (first message, or the thread has no design) | designer (fresh) → check | version (`parent_version` null) + reply `result` |
| the classifier throws | as `edit` when a base exists, else as no base | as that row |
| `edit` | designer (edit of the base body) → check | version + reply `result`; body equals the base body: reply `nochange` (`NO_CHANGE`), no version |
| `new` | designer (fresh) → check | version (`parent_version` null) + reply `result` |
| `question` | answer → END (skips check) | reply `answer`, no version |
| check fails twice (one retry as an edit carrying the failures) | designer → check → designer → check | the final attempt has a mesh: version with `flags: ['failed_checks', …]` + reply `error` (`FAILED_CHECKS` + fixed sentences), carrying `design_version`. No mesh: reply `error`, no version |
| refusal | — | reply `error` (`REFUSAL`), no version |
| unusable model output | — | reply `error` (`BUILD_FAILED`), no version |

**Reply text** (`7#7`):
- For `result` and for a `failed_checks` version, `replyMarkdown` is the designer's summary, then the final reviewer flags rendered by `formatFlags` (`designer/reviewer.ts`), under the fixed labels "Designer" and "Reviewer". When checks failed, `FAILED_CHECKS` and its sentences come first.
- Compiler output, scripts and tracebacks stay in the server logs.
- Terminate codes map to replies: `cancelled` → kind `cancelled`, `STOPPED`; `run_lost` → `error`, `RUN_LOST`; `deadline` → `error`, `DEADLINE`; `graph` → `error`, `BUILD_FAILED`; `internal` → `error`, `SAVE_FAILED`.

**Types** (`src/lib/persist/types.ts`):
- `RunOutcome = { replyKind, replyMarkdown, userKind, design?: DesignDraft & { stl?: string /* ASCII STL */; step?: string /* base64 */ }, costUsd, wallMs, turns }`.
- `DesignDraft = { parentVersion, origin: 'designer', baseRequest, edits, body, preludeVersion, summary, facts, flags }`.
- `CommitPlan` = `RunOutcome` with `design?: DesignDraft & { stlArtifact?: string; stepArtifact?: string }`.
- `ChatRequest` (the `POST /api/chat` body; built by A10, A9 and the tests) = `{ threadId: uuid, clientMessageId: uuid, text: string, viewingVersion: number | null, attachmentIds?: string[], pinnedParams?: Record<string, number>, editedBody?: string, model?: string }`.
- `StartInput = ChatRequest & { ownerKey: string }`.
- `GraphInput` (A4's state fields; C1 builds it with `loadRunInput` after `start` commits, outside any transaction) = `{ messages /* history + this message */, baseVersion: number | null, baseBody: string | null, baseRequest: string | null, attachments: { mediaType: 'image/png'; base64: string }[] }` (`7#2`).

**Ending a run** (normative; only `streamRun` does this, `6#4`):
1. The final graph state comes from the stream: the chat route adds `values` to its stream modes, and `streamRun` keeps the last `values` chunk. `outcome` is never forwarded to the client.
2. `await` the event chain, then settle pending appends.
3. Decide, in this order (`7#3`):
   1. **The final state has an `outcome`:** commit it, whatever else happened (completed wins). Upload `design.stl`/`design.step` with the owner store (row first, then object), then `commit(plan)`. If the upload fails → `terminate('failed', 'internal')`.
   2. **Else `signal.aborted`** (Stop or the deadline, even if the graph threw) → `terminate('cancelled')` or `terminate('failed', 'deadline')`.
   3. **Else the append window was exhausted** (a store outage) → `terminate('failed', 'internal')`.
   4. **Else the graph threw** → `terminate('failed', 'graph')`.
   5. **Else** (END without an outcome) → `terminate('failed', 'graph')`, and log it.
4. **When `commit` or a step-3 `terminate` throws,** retry the whole transaction with backoff for up to 30 s.
   - `{ committed: false }` → replay `eventsSince(lastSeq)`, which holds the winner's `end`, then close.
   - Retries exhausted → `terminate('failed', 'internal')`. If that returns 0 rows or throws, replay `eventsSince`. If that read fails, send an unstored `SAVE_FAILED` and close.
   - A design is never inserted outside the status-guarded transaction.
5. **When `append` throws,** retry for a total window of 30 s, below `CADAI_STALE_MS`. Later events queue behind it in order. When the window is exhausted, mark a store outage, abort the graph and go to step 3 (an outcome still commits).
6. **When `append` returns 0** (the run already ended elsewhere): abort the graph, replay `eventsSince(lastSeq)`, and close.
7. Forward the `end` event from the transaction to the live client.
8. A `finally` stops the heartbeat and removes the run from the local abort registry, whatever happened.

**Commit** (`store.commit(q, runId, plan)`, one transaction):
1. Read the run's `thread_id` with no lock, then `SELECT … FROM threads WHERE id=$t FOR UPDATE`.
2. When the plan has a design: `nextVersion = coalesce(max(version), 0) + 1` for the thread.
3. `UPDATE runs SET status='done', design_version=nextVersion|null, cost_usd, wall_ms, turns, ended_at=now(), updated_at=now(), last_seq=last_seq+1 WHERE id=$r AND status='running' RETURNING last_seq`. 0 rows → roll back and return `{ committed: false }`.
4. Insert the design at `nextVersion`.
5. Insert the assistant reply (`seq = max+1`), and set the user message's `kind`.
6. Insert the `end` event at the returned `last_seq`.
7. `UPDATE threads SET active_run_id=null, updated_at=now() WHERE id=$t AND active_run_id=$r`.

**Terminate** (`store.terminate(q, runId, status, code, costUsd?)`; status `cancelled` or `failed`):
- the same steps 1 and 3, setting `status`, `error`, `cost_usd` (when given), `ended_at`;
- then the reply: `STOPPED`, `RUN_LOST`, `DEADLINE`, `BUILD_FAILED` or `SAVE_FAILED`, matching the code;
- then the `end` event and the conditional clear.
- 0 rows → no-op.

**The `end` event** (the only terminal event): `{ t: 'end', seq, status, reply: { messageId, kind, markdown }, designVersion? }`. The client renders `reply.markdown`, then reloads `GET /api/threads/:id`.

**Append** (one transaction, run row only):
- `UPDATE runs SET last_seq=last_seq+1, heartbeat_at=now() WHERE id=$r AND status='running' RETURNING last_seq`, then `INSERT run_events`.
- 0 rows → return `0`.

**Heartbeat:**
- `streamRun` runs `UPDATE runs SET heartbeat_at=now(), cost_usd=$cost WHERE id=$r AND status='running'` every `CADAI_HEARTBEAT_MS`, with the cost accumulated so far.
- It starts before the graph, and stops in step 8's `finally`.
- When the UPDATE returns 0 rows, the run ended elsewhere (a remote Stop or the reaper): abort the local controller and go to step 6. Heartbeat errors are logged and never end the run (`7#4`).
- The cost comes from custom `{ t: 'cost', usd }` events (C2). `streamRun` keeps the running total and never stores or forwards those events.

**Deadline:**
- The owner arms a timer at `deadline_at` that aborts the graph. Step 3 then terminates with `deadline` if no outcome exists yet.
- The reaper only acts on `deadline_at + 60 s`, as a backstop.
- **Budgets:**
  - the designer's wall budget = `min(MAX_WALL_MS, remaining − 30 s − 120 s check reserve)`;
  - a retry gets what remains, minus the same reserves;
  - no retry starts with under 60 s left; the run commits the failed attempt per the branch table.

**Reaper** (A8):
- One loop per process, started from `src/instrumentation.ts` under `NEXT_RUNTIME === 'nodejs'`.
- It is skipped when `NEXT_PHASE === 'phase-production-build'`, when `VITEST` is set, and in the eval runner unless asked.
- It is held on `globalThis.__cadaiReaper` and its timers are `unref()`'d.
- **`reap(q, runId) → boolean`** is `terminate` with the stale predicate added to its status UPDATE (`AND (heartbeat_at < now() - CADAI_STALE_MS OR deadline_at + 60 s <= now())`), code `run_lost` or `deadline`. 0 rows means the run is alive, and nothing changes (`7#4`).
- **Every 60 s** the loop selects stale run ids with no lock, then calls `reap` for each, each in its own transaction.
- **The PGlite boot sweep:** `register()` awaits it once per process, before requests are served. It ends `running` rows with `created_at < processStartedAt` with `run_lost` (the lockfile proves their owner is gone). It does not run on Postgres. Being absent from this process's registry never makes a run stale.
- `get()` never reaps.

**Cancel** (`6#5`):
- Each process keeps a registry of the runs it owns: the existing `src/lib/runs/run-control.ts` (`registerRun`, `unregisterRun`, `abortRun`), shared by `stream-run.ts` and the cancel route.
- `POST /api/runs/:id/cancel`:
  - **The run is in this process's registry:** abort it and return 202. The owner then ends the run per "Ending a run", so a finished outcome still commits.
  - **Otherwise:** call `terminate(runId, 'cancelled')` now and return the resulting status. The owner, wherever it is, sees `append` or its heartbeat return 0 rows and stops.
- The chat response carries `X-Run-Id`, so Stop works before the first SSE event.

**Streaming:**
- `streamRun` writes each event to the live client after `append` returns its seq.
- A client disconnect only stops writes to that client. Stop and the deadline are the only aborts.
- The events tail reads the status, then drains, then stops when the status is not `running`. This is correct because the `end` event and the status commit together.
- A tail that closes without `end` (past retention) makes the client reload the thread.

**Retention** (sweep in the reaper loop, every 10 min):
- **`run_events`:** delete those of runs ended more than 10 min ago.
- **Unreferenced artifacts older than 24 h:** one transaction does `DELETE … WHERE id IN (SELECT id FROM artifacts WHERE created_at < now() - 24 h AND NOT EXISTS (designs or message_attachments reference) FOR UPDATE SKIP LOCKED) RETURNING object_key`, and inserts those keys into `pending_deletes`.
- **`pending_deletes`:** delete each object from the object store, and remove its row after success.
- Runs, messages and designs are kept while their thread lives.
- **`DELETE /api/threads/:id`** is ONE transaction: lock the thread, terminate its running run if any (`cancelled`, `STOPPED`), set `archived_at`.
- The hard purge of archived threads is parked.

## Phase 0: designer-only cleanup
### Task 0a: Import map and keep list (the user gives go/no-go)
**Files:** create `docs/superpowers/plans/2026-11-08-phase0-import-map.md`. Read only otherwise.

**Method (`6#2`):**
- `npx dependency-cruiser` (no dependency added) with `--ts-config tsconfig.json`.
  - `--ts-pre-compilation-deps` (config key `tsPreCompilationDeps`) keeps type-only imports visible, and those are reported separately. Dynamic `import()` is detected by default.
- **Entries:**
  - `src/app/api/{chat,compile,runs,artifacts}/**`;
  - `src/app/page.tsx` and `src/app/layout.tsx`;
  - `src/instrumentation.ts`;
  - `eval/designer/**`, excluding tests.
  - Test files are not entries. A **dependent pass** then marks every `*.test.ts` that imports a CUT or REMOVE module as SPLIT or REMOVE. Known: `graph-*.test.ts`, `checkpointer.test.ts`, `chat/resume/route.test.ts` (`7#5`).
- **CUT set:** compute reachability with these modules cut:
  - `src/lib/agent/graph.ts`;
  - `src/lib/agent/graph-route.ts`;
  - `src/lib/agent/checkpointer.ts`;
  - the edges `stream-bridge → checkpointer` and `stream-bridge → graph-route`.
  - Every runtime edge from a reachable module into a cut module, or into anything only the cut modules reach, goes on the EXTRACT/SIMPLIFY worklist. **That worklist is the map's main output.**
- **Known items the worklist must contain:**
  - **EXTRACT:**
    - `AgentState`/`AgentStateType` → `designer/state.ts`;
    - the designer branch of `respondToUser` and `routeAfterDesignerCheck` → `designer/graph.ts`;
    - `firstHumanText`/`latestHumanText`;
    - `estimateCostUsd`, `extractReplyUsage` and `applyParameterOverrides` out of `nodes/brep-agent-build.ts` (`reviewer.ts`, `run-designer.ts`);
    - the shared types in `src/types/index.ts` → `src/types/designer.ts`;
    - the build123d compile path out of `openscad-bridge`, which the viewer, editor, chat panel, message bubble and store import.
  - **SIMPLIFY:**
    - `stream-bridge` gets a designer-only `nextStep`, and no checkpointer TTL or gate `expiresAt`;
    - `paused`/`gate` come out of `stream-run`, the cancel route, `run-contract` and `run-store.ts` (with `checkpointTtlMs`);
    - the `resume` fetch comes out of `chat-panel`;
    - `DesignContract.spec` goes;
    - the `openscad` default in `compile/route.ts` goes.
- **Lists:**
  1. KEEP. The UI KEEP list is a manual decision, because `page.tsx` reaches every panel: keep the viewer, compile, sliders, pins, the print panel and STEP.
  2. EXTRACT and SIMPLIFY (the worklist above).
  3. KEEP-BY-PATH: `eval/designer/sets/*.json` and `src/lib/brep/cheatsheet.md`.
  4. SPLIT: test files that cover both kept and removed code (for example `graph-route.test.ts`), with the cases to keep.
  5. REMOVE: module by module, never "the rest". It includes `src/mcp-server.ts` and `src/lib/mcp/**`.
  6. `package.json` changes:
     - drop the `mcp` script and the dead eval scripts;
     - drop `openscad-wasm` only after its EXTRACT.
- [ ] **Step 1: Produce the map.**
- [ ] **Step 2: Stop and ask the user to approve the lists.**

### Task 0b: Extract, simplify, rewire, remove (server)
Needs 0a approved.

**Produces:**
- the designer graph in `src/lib/agent/designer/graph.ts`, with its state annotation in `designer/state.ts`;
- `RunStatus = 'running' | 'done' | 'failed' | 'cancelled'`.

**Until C1** the run still ends through `respondToUser` and `LocalRunStore`, so the app keeps working.

- [ ] **Step 1: Apply EXTRACT.** Gate: tsc + vitest.
- [ ] **Step 2: Rewire to the designer path only, with no checkpointer.** The path is `designerNode → designerCheck → (designerNode once) → respondToUser → END`.
- [ ] **Step 3: Fix the eval runner, by behavior** (`6#3`).
  - It does not use `getState`, `Command`, `runCheckpointKey` or the checkpointer.
  - It streams `['values', 'custom']`, and takes the script, mesh and check result from the last `values` chunk.
  - It seeds step k+1's input with step k's final `messages` and accepted script, so `designerNode` takes the edit branch.
  - The `runDesigner` wrapper records `StepRecord.priorScriptSha` (sha256 of `input.priorScript` on the step's first designer call; add the field to `eval/designer/types.ts`).
- [ ] **Step 4: Apply SIMPLIFY.**
- [ ] **Step 5: Delete REMOVE, and split SPLIT.** Delete `/api/chat/resume`, `/api/mcp` and `checkpointer.ts`.
- [ ] **Step 6: Gate.**
  - tsc, vitest and `next build`.
  - A live designer build plus one follow-up edit via the runner (about $1): `npx tsx eval/designer/runner.ts --set iterative --only iter_box_with_lid --arms reviewer --tag p0-gate --max-usd 3` (`7#1`).
  - Expected:
    - both steps have a mesh;
    - step 1's `priorScriptSha` equals sha256 of step 0's `script`;
    - step 1's script differs from step 0's.
- [ ] **Step 7: Commit** `refactor: designer is the only mode`.

### Task 0c: Remove the old UI paths
Needs 0b.
- Remove the spec, sheet, variant and gate UI.
- Move the viewer, editor, chat panel, message bubble and store onto the build123d compile path. `compile/route.ts` then accepts build123d only.
- Drop `openscad-wasm`.
- KEEP the viewer, compile, sliders, pins, the print panel and STEP.
- **Test:** `a designer run renders end to end, and slider moves recompile through /api/compile` (component test).
- **Gate:** tsc, vitest, eslint, `next build`.
- **Commit:** `refactor(ui): remove spec, sheet, gate and OpenSCAD UI`.

## Phase A: features beside the old run path, then one cutover
- **Before C1,** every task adds code beside the running app and gates on unit tests.
- **After C1** the server is on the new lifecycle, and the browser works end to end again after A10a.
- **TDD:** each task follows the same cycle. Write the listed tests, run them and see them fail, implement, run them and see them pass, then commit.

### Task A0a: Owner cookie and proxy
**Files:**
- `src/proxy.ts`;
- `src/lib/owner.ts`;
- `next.config.ts`, its only owner in step 2: `experimental.proxyClientMaxBodySize: '6mb'` and `serverExternalPackages: ['@electric-sql/pglite']` (`7#6`).

**Produces:** `ownerKeyFrom(request: Request): string | null`.

**Tests:**
- `the first request without a cookie: its own route reads the minted owner`;
- `a non-UUID cookie is re-minted`;
- `x-cadai-owner is stripped`;
- `no owner → 401`;
- `cookie attributes; Secure from x-forwarded-proto only with CADAI_TRUST_PROXY`;
- `static assets get no Set-Cookie`.

### Task A1: Designer model text never streams (bug 2)
**Files:**
- `designer/run-designer.ts` (the model `invoke` gets `tags: ['nostream']`);
- `stream-bridge.ts` (`STRUCTURED_NODES` gets the four designer nodes).

**Test:** `no unrendered designer model text in deltas`: a `nostream` model token and a raw reviewer sentence sent through `bridgeGraphStream` are both absent from client deltas; reviewer flags appear only as `formatFlags` output. The fixed step strings stay.

### Task A2: The model writes only the body; the prelude is versioned (bug 3)
After A1 (same file).

**Files:**
- `src/lib/brep/prelude.ts`;
- `designer/{run-designer,prompt}.ts`;
- `src/app/api/compile/route.ts`;
- `src/lib/brep/body-check.ts`: accepts any `PRELUDES[v]`, not only the current prelude;
- `src/store/app-store.ts`: the slider `parseParams` call parses the body only.

**Produces:**
- `PRELUDES: Record<string, string>`, a registry where entries are only ever added;
- `PRELUDE_VERSION`;
- `toBody(script)`;
- `withGeneratedPrelude(body, version = PRELUDE_VERSION)`;
- `hasPreludeSentinel(script)`.

**Tests:**
- a copied prelude without a sentinel is stripped;
- a modified prelude is replaced;
- the model is shown the body only;
- finish accepts its own body;
- a body-only first run passes;
- `/api/compile` prepends the prelude of the given version when the sentinel is absent;
- sliders parse the body only.

**Prompt:** "Write only the design code; the tool adds the prelude; `_round`/`_bevel` are available."

### Task A3: Database layer, stores and lifecycle transactions
**Files:**
- `src/lib/db/{db,pglite,pg,migrate,map,lockfile}.ts`;
- `db/migrations/0001_init.sql`;
- `src/lib/persist/{types,phrases,threads,designs,messages,artifact-rows}.ts`;
- `src/lib/runs/db-run-store.ts`, NEW, beside `run-store.ts` (which stays until C1);
- `runs/config.ts` (writability check, no tmpdir, no `VERCEL` branch) and the tmpdir fallback in `run-store.ts` (its F6 fallback test becomes the unwritable-dir failure);
- `src/lib/design/write-params.ts`: `formatPin(v)` (fixed-point, at most 6 decimals, no exponent), used by `setParamValue` on build123d bodies; an unknown name throws the typed `BAD_PIN` error;
- `vitest.config.mts`, edited in place, with two projects, both with `TMPDIR=<repo>/.cadai/scratch/vitest`:
  - `unit`: `CADAI_DB=pglite`, so `getDb()` uses `memory://`;
  - `pg`: `*.pg.test.ts`, with globalSetup and globalTeardown in `vitest.pg-setup.ts`.
- `package.json` (`test:pg`).

`vitest.pg-setup.ts` uses `DATABASE_URL_TEST` when it is set. Otherwise it starts `embedded-postgres` with:
- the data dir and `unix_socket_directories` under `<repo>/.cadai/pg-test`;
- port 54329;
- a stale `postmaster.pid` removed first, and the server stopped in `globalTeardown`.

`npm test` runs only `unit`.

**Produces:**
- `Db`, `Queryable`, `getDb()`;
- `ThreadStore` (`get`, `list`, `rename`, `archive`): `archive` is the one-transaction delete;
- `DesignStore` (`get`, `latest`, `list`);
- `MessageStore` (`list`);
- `DbRunStore` (`start`, `commit`, `terminate`, `append`, `eventsSince(runId, afterSeq, limit)`, `heartbeat(runId, costUsd) → rows updated`, `reap → boolean`, `get`);
- `RunOutcome`, `CommitPlan`, `ChatRequest`, `StartInput` and `GraphInput`;
- `sweep(q, now)`.

**Tests:**
- [ ] **Step 0:** `embedded-postgres` starts on this machine. If it does not, stop and report to the user. The `pg` project must not be skipped silently.
- **On PGlite (`unit`):**
  - `start refuses a second active run with 409 and writes nothing`;
  - `start reaps a stale active run`;
  - `a replayed clientMessageId returns the first run`;
  - `missing viewingVersion on a thread with a design → STALE_CLIENT`;
  - `a foreign viewingVersion → 404`;
  - `pins: unknown name or 1e21 → BAD_PIN, nothing written`;
  - `pins never write an exponent`;
  - `an attachment of another owner → 404`;
  - `user_edit fields`;
  - `start sets the title once`;
  - `commit: nextVersion, then the run, then the design`;
  - `commit is atomic and refused after terminate`;
  - `terminate does nothing after commit`;
  - `terminate records cost`;
  - `exactly one end event per run`;
  - `archive in one transaction terminates the running run`;
  - `the reaper terminates stale runs with a reply`;
  - `sweep keeps referenced artifacts, queues object keys, skips locked rows`;
  - `stores hide other owners`;
  - `db.query inside a transaction throws; a timer started inside it does not`;
  - `a second PGlite process on the same dir fails fast; a dead pid's lock is broken` (a real dir via `CADAI_PGLITE_DIR`, one child process);
  - `an unwritable CADAI_RUN_DIR fails startup`.
- **On Postgres (`pg`):**
  - `two starts on two connections: one run, one 409`;
  - `commit vs terminate on two connections: no deadlock, one winner`;
  - `reaper vs commit on two connections`;
  - `archive vs start on two connections`;
  - `reaper vs heartbeat on two connections: a fresh heartbeat wins`;
  - `pool timeouts are set`;
  - `concurrent message seq`;
  - `migrate twice concurrently`;
  - `the unique index rejects a second running run when the lock is skipped`;
  - `numeric/int8/timestamptz map the same as on PGlite`.
- A4 does not start until the `pg` project passes.

### Task A4: Triage, answers and the branch table (bug 4)
After 0b, A2 and A3.

**Files:**
- `designer/{triage,answer,node,check,graph,state,types}.ts` and the tests `check.test.ts`, `node.test.ts`, `graph-designer.test.ts`. `check.ts` is here because it writes `acceptedDesignerScript`, which this task deletes;
- `eval/designer/runner.ts` and `runner.test.ts`: step k+1 is seeded from step k's final values through the `GraphInput` fields, and the `priorScript` assertion stays (`7#2`).

**Interfaces:**
- **Consumes:** `RunOutcome` (A3).
- **Produces:**
  - the state field `outcome: RunOutcome`, set on every path that reaches END;
  - the `GraphInput` state fields. `designerNode` sets `priorScript` from `baseBody` on an edit or a check retry, and copies `attachments` onto `DesignerInput.attachments` (this task adds that optional field to `designer/types.ts`);
  - `designerTriage` and `designerAnswer`.
- **Until C1:** `respondToUser` stays the last node. It renders `outcome` as today's `result`/`error` event (code, mesh, reply text), so the file-store app keeps working.

**Tests:**
- the classifier cases: taller, cable hole, what is this, new lamp;
- `the classifier throwing → an edit of the base, or a fresh build when there is none`;
- `no base → a fresh build`;
- `a question goes to designerAnswer and never through designerCheck`;
- `a question's outcome has no design`;
- `new → parent_version null`;
- `a second edit builds on the first` (the ms1 regression);
- `check fails twice with a mesh → failed_checks version and error reply`;
- `check fails twice without a mesh → error reply, no version`;
- `a compile error lists COMPILE_FAILED, never the raw error`;
- `an unchanged body → nochange, no version`;
- `a refusal → REFUSAL`;
- `until C1, respondToUser renders each outcome kind`;
- `a follow-up edit gets priorScript from baseBody`;
- `an attachment in graph input reaches runDesigner`;
- `the runner seeds step 2 with step 1's script`.

### Task A5: Owner-scoped artifact store, object store and uploads
After A3. Runs in parallel with A4 (disjoint files).

**Files:**
- `src/lib/storage/object-store.ts`: the interface plus the local filesystem store;
- `src/lib/runs/owner-artifacts.ts`, NEW, beside `artifact-store.ts`:
  - `put(ownerKey, kind, bytes, { threadId?, runId? })` inserts the row (its own short transaction), then writes the object, and returns the id;
  - `get(q, ownerKey, id)`;
  - `openStream(ownerKey, id)`;
- `artifact-store.ts`: no tmpdir fallback;
- `src/app/api/attachments/route.ts`: multipart with exactly one `file` → `{ artifactId }`, with the attachment rules;
- `src/app/api/compile/route.ts` and `route.test.ts`: returns the mesh inline and writes no artifact.

**Tests:**
- `identical bytes, two owners → distinct ids`;
- `ids are 128-bit`;
- `get from another owner → null`;
- `upload: magic bytes, Content-Length cap, 5 MB cap, a pixel bomb rejected, re-encoded to ≤1568 px PNG`;
- `a truncated multipart body → BAD_ATTACHMENT`;
- `compile writes no artifact`.

### Task A6: Model inputs: attachments and the run input loader
After A2, A4 and A5 (it reads image bytes through the object store). Runs in parallel with A8.

**Files:**
- `designer/run-designer.ts`: the first `HumanMessage` is the image blocks, then the text;
- `designer/prompt.ts`;
- `designer/reviewer.ts`: the user's images are added as labeled reference images;
- `src/lib/persist/run-input.ts`: `loadRunInput(q, ownerKey, threadId, baseVersion, attachmentIds) → GraphInput`, reading image bytes through `owner-artifacts.ts`.
- It does not edit `designer/node.ts`, `state.ts` or `types.ts` (A4 owns them).

**Tests:**
- `an attachment reaches the designer and the reviewer as an image block`;
- `loadRunInput: history from messages only, the base body from designs`;
- `no attachments → text only`.

### Task A8: Threads routes, and the reaper and sweep loop
After A3 and A5. Runs in parallel with A6.

**Files:**
- `src/app/api/threads/route.ts`;
- `src/app/api/threads/[id]/route.ts`;
- `src/lib/persist/loop.ts`;
- `src/instrumentation.ts`.

**Response shapes:**
- `GET /api/threads` → `{ threads: [{ id, title, updatedAt, activeRunId }] }`.
- `GET /api/threads/:id` → `{ id, title, activeRun: { id, status, lastSeq } | null, messages: [{ id, seq, role, kind, markdown, designVersion?, attachments: string[] }], versions: [{ version, parentVersion, origin, summary, flags, body, preludeVersion, stl, step, createdAt }] }`.
- `PATCH /api/threads/:id` `{ title }` (at most 120 chars) → 204.
- `DELETE /api/threads/:id` → `ThreadStore.archive` (one transaction) → 204. Archived threads are 404 everywhere.

**Tests:**
- `the thread GET shape`;
- `another owner → 404`;
- `rename`;
- `delete during a run ends it and archives, atomically`;
- `the loop starts once across two register() calls, and not in build or vitest`;
- `the PGlite boot sweep, awaited in register(), ends only runs created before the process started`;
- `the loop reaps and sweeps`;
- `pending_deletes are retried until the object is gone`.

### Task C1: Cutover: the server runs on the new lifecycle
After A0a, A4, A5 and A6. Runs alone (it touches the shared run files).

**Files:**
- `api/chat/route.ts`:
  - `store.start`, then `loadRunInput` outside the transaction, passed as the graph input;
  - `X-Run-Id`;
  - stream modes gain `values`;
  - `configurable: { ownerKey, threadId, runId }`.
- `runs/stream-run.ts`: "Ending a run", the heartbeat, and the local abort registry (`run-control.ts`). Delete `storeBroken`, `sendUnstored`, `localSeq`, `finish(…, 'done')` and the gate branch.
- The designer graph: `respondToUser` is removed, and the graph ends at `END`.
- `api/runs/[runId]/{route,events/route,cancel/route}.ts`:
  - owner checks;
  - the seq cursor;
  - the cancel rule;
  - delete `resultIsOut` and the ack wait.
- `api/artifacts/[id]/route.ts`: owner-scoped through `owner-artifacts.ts`, streams the bytes, `Cache-Control: private, no-store`.
- `runs/externalize.ts`: never inlines a mesh on failure.
- `src/lib/agent/stream-events.ts` and `src/lib/stream-reader.ts`: `end` replaces `result`/`error`, and has `cancelled`.
- Deleted: `run-store.ts` (`LocalRunStore`), `artifact-store.ts` (content-addressed) and their tests.
- Rewritten against `end`: `src/app/api/runs/runs.test.ts`, `src/app/api/runs/artifacts-run.test.ts`, `src/app/api/artifacts/artifacts.test.ts`, `src/lib/stream-reader.test.ts`, and the 0c component test.
- `chat-panel.tsx`: only enough to type-check and render `end.reply.markdown`. The full client work stays in A10a.

**Tests:**
- `every event is stored before the end event; exactly one end event`;
- `completed wins over a late local abort`;
- `Stop on a run not in this process terminates it at once`;
- `Stop before the outcome → cancelled with STOPPED`;
- `the events tail never ends before the end event`;
- `a silent designer call outlives the stale threshold` (real time: heartbeat 50 ms, stale 300 ms);
- `the heartbeat stops when streamRun exits after a thrown commit`;
- `commit throws, then succeeds on retry`;
- `commit committed:false replays the winner's end`;
- `append down for under 30 s loses nothing`;
- `append down for over 30 s with an outcome → the design still commits`;
- `append down for over 30 s without an outcome → SAVE_FAILED`;
- `a remote terminate aborts the owner within one heartbeat`;
- `a client disconnect does not abort the run`;
- `a follow-up through the chat route edits the viewed version`;
- `an attachment through the chat route reaches the designer`;
- `a graph throw → BUILD_FAILED`;
- `a mesh upload failure → SAVE_FAILED, no version`;
- `another owner's run is 404 on status, events and cancel`;
- `another owner's artifact → 404`;
- `artifact responses are private, no-store`;
- `outcome never reaches the client`.

### Task C2: Deadline, budgets and cost
After C1.

**Files:**
- `runs/stream-run.ts`: the deadline timer, and the running cost total into the heartbeat and terminate;
- `designer/run-designer.ts`: budgets from the remaining deadline, and a `{ kind: 'cost', usd }` designer event after every model or reviewer call;
- `designer/node.ts`: forwards cost events as custom `{ t: 'cost', usd }`;
- remove the route `maxDuration` exports.

**Tests:**
- `the designer budget fits inside the remaining deadline`;
- `a retry never starts with under 60 s left`;
- `deadline → the owner aborts and terminates with DEADLINE`;
- `the reaper waits deadline_at + 60 s`;
- `a cancelled run records its cost`.

### Task A9: The eval runner takes the app path
After C2.

**Files:** `eval/designer/{runner,report}.ts` and `sets/iterative.json`.

**Changes:**
- the runner calls `store.start` and `streamRun` on a private PGlite dir, with `clientMessageId`, `viewingVersion` and attachments;
- the report gives per-step cost and time for sequences;
- a safe refusal is not a hard-check failure.

### Task A10: Client
A10a comes after C1 and A8. A10b comes after A10a.

**Files:**
- `chat-panel.tsx`;
- `app-store.ts`;
- `src/lib/client/server-thread.ts`;
- `code-editor-panel.tsx`.

**Behaviour:**
- **Ids:** UUID thread ids, and a `clientMessageId` per send. The request body is `ChatRequest`.
- **Thread data:** the thread list and thread come from the server, with IndexedDB as a cache.
- **Legacy threads** stay local and read-only, with a banner.
- **Reconnect:**
  - on load, with `activeRun`, reconnect at `/api/runs/:id/events?after=0` (events are kept while the run is running);
  - a thread GET that returns 404 after `end` (deleted elsewhere) removes the thread from the list;
  - a tail closed without `end` → reload the thread.
- **On `end`:** render `reply.markdown`, then reload the thread and show `designVersion`.
- **409:** `run_active` → attach to `activeRunId`; `duplicate_message` → attach to `runId`.
- **Stop** (using `X-Run-Id`) and rename.
- **Versions:**
  - the version list sets `viewingVersion`, which is always sent once the thread has a design;
  - a version without an STL is compiled on view;
  - a `failed_checks` version is labeled.
- **Editor:** shows the body only, with a fixed note that the prelude helpers come from the tool.
- **Edits:**
  - `pinnedParams` and `editedBody` are sent only when they differ from the viewed version;
  - unsent slider and editor edits are kept as a local draft per (thread, version).
- **Delete** `applyContract` and the sticky `designContract` pin re-application in `app-store.ts`.

**Tests:**
- **A10a:**
  - `cold reload mid-build resumes`;
  - `reload after done`;
  - `the open tab shows the committed version after end`;
  - `a tail closed without end reloads the thread`;
  - `Stop before the first event`;
  - `409 attaches to the active run`;
  - `legacy banner`.
- **A10b:**
  - `v2 selected → edit v2`;
  - `slider move then edit sends pins once`;
  - `editor change then edit sends editedBody`;
  - `an agent result is never re-pinned`;
  - `a draft survives reload`;
  - `a failed_checks version is labeled`.

## Phase B: server engines (host-agnostic)
### Task B1: Deploy-time migrations
**Files:** `scripts/migrate.ts` (the `DATABASE_URL_MIGRATE` deploy step). The pool and its tests are in A3.

**Tests:** `migrate.ts applies pending files once` against a `DATABASE_URL_TEST` Postgres.

### Task B2: S3-compatible object store
**Files:** `src/lib/storage/s3-object-store.ts`.
- keys are `a/<ownerKey>/<id>.<kind>`;
- put, get (streamed) and delete;
- the bucket is private; the app streams the bytes and never hands out object URLs.

**Tests:** a mocked client, plus a live test gated on `S3_TEST_BUCKET`.

### Task B3: Streaming on a generic host
After B1. **Files:** `src/app/api/chat/route.ts` and `src/app/api/runs/[runId]/events/route.ts`.
- an SSE comment keep-alive every 15 s;
- `X-Accel-Buffering: no` and `Cache-Control: no-transform`;
- a client disconnect never stops the run.

**Tests:** keep-alives are emitted, and a disconnect leaves the run running.

### Task B4: Access gate and caps (before any public host)
**Files:** `src/proxy.ts`, `src/lib/runs/db-run-store.ts` (`start`) and `src/lib/engine/brep-runner.ts` (the geo queue). The cost term uses `MAX_COST_USD` from `designer/run-designer.ts`.

- **Access gate.** When `CADAI_ACCESS_TOKEN` is set:
  - the proxy accepts `?access=` once, compares it in constant time, sets a `cadai_access` cookie, and redirects to the same URL without the parameter;
  - every route returns 401 without the cookie.
- **Running runs.** At most `CADAI_MAX_RUNNING` (default 4) runs may be running in total.
  - `start` takes `pg_advisory_xact_lock(<const>)` after the thread lock, while the cap is on, and counts inside it.
  - Over the cap → 429 "The server is busy. Try again in a minute."
- **Geo calls.** At most 2 concurrent `runBrep` calls per process; further calls queue.
- **Daily cost ceiling.** Reject with 429 "Today's build budget is used up." when committed `cost_usd` today (UTC) + `CADAI_MAX_RUNNING × MAX_COST_USD` would reach `CADAI_DAILY_COST_USD`.

**Tests:** each limit, `two starts at the cap on two connections`, and 401 without the token.

## Parked (not in this plan)
- slider ranges;
- continuing a legacy thread on the server;
- the hard purge of archived threads;
- a tail fan-out hub (polling per tail stays until it is measured as a problem);
- multi-host realtime.

---

## Execution and checks
- **Order:**
  1. 0a, then the user's go/no-go, then 0b → 0c.
  2. A0a ∥ {A1 → A2} ∥ A3. A3's `pg` project must pass before step 3.
  3. A4 ∥ A5.
  4. A6 (needs A2, A4 and A5) ∥ A8 (needs A5).
  5. C1, alone, after A0a, A4, A5 and A6.
  6. C2 ∥ A10a (A10a needs A8).
  7. A9 ∥ A10b.
  8. B1 ∥ B2, then B3, then B4. B4 lands before any public host.
- The numbered order is the only order; a task header's "after" lines repeat it.
- **Gate per lane:**
  - tsc;
  - vitest `--maxWorkers=2` (`unit`, plus `pg` for A3, C1 and B1), once, one lane at a time;
  - eslint on changed files.
- **End checks:**
  - **Browser smoke:**
    - build, edit, a second edit;
    - an edit of an older version;
    - slider moves then an edit;
    - a code edit then an edit;
    - a question, a new object, an attachment;
    - refresh mid-build, reload after done;
    - Stop before and after the outcome;
    - a second tab (it attaches);
    - kill the server mid-run, restart and send again;
    - delete a thread during a build;
    - a legacy thread.
  - **Eval:** re-run ms0 + ms1 through the app-path runner (about $3).
