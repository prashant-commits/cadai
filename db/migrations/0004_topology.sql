-- Model-first workspace, Task 10: B-Rep topology per design version.
-- artifacts.kind gains 'topo' (gzipped JSON: per-triangle face ids, faces, edges); kind is text, so no DDL.
alter table designs add column topo_artifact text references artifacts(id);
