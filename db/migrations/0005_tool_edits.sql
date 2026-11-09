-- Model-first workspace, Task 11: Tool ops core and user edits.
-- messages.kind gains 'tool_edit'; kind is text, so no DDL.
alter table designs add column ops jsonb not null default '[]'::jsonb;
