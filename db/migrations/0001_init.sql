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
