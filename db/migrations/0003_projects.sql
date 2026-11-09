create table projects (
  id uuid primary key default gen_random_uuid(),
  owner_key text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index on projects(owner_key, updated_at desc) where archived_at is null;
alter table threads add column project_id uuid references projects(id);
create index on threads(project_id, updated_at desc);
