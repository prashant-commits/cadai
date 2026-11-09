import { describe, it, expect, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { getDb, closeDb } from '@/lib/db/db';
import { ProjectStore } from './projects';
import { ThreadStore } from './threads';
import { StoreError } from './types';
import { RUN_ACTIVE } from './phrases';

describe('ProjectStore', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('create then list returns the project with threadCount 0', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const created = await ProjectStore.create(db, ownerKey, 'Project Alpha');
    expect(created.id).toBeTruthy();
    expect(created.ownerKey).toBe(ownerKey);
    expect(created.name).toBe('Project Alpha');
    expect(typeof created.createdAt).toBe('number');
    expect(typeof created.updatedAt).toBe('number');
    expect(created.archivedAt).toBeNull();

    const list = await ProjectStore.list(db, ownerKey);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: created.id,
      name: 'Project Alpha',
      updatedAt: created.updatedAt,
      threadCount: 0,
      thumbnailArtifactId: null,
    });
  });

  it('list filters by a case-insensitive search on name', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    await ProjectStore.create(db, ownerKey, 'Mechanical Bracket');
    await ProjectStore.create(db, ownerKey, 'ELECTRONICS BOX');
    await ProjectStore.create(db, ownerKey, 'Corner 100% Bracket');
    await ProjectStore.create(db, ownerKey, 'Other Gadget');

    const brackets = await ProjectStore.list(db, ownerKey, { search: 'bracket' });
    expect(brackets.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Mechanical Bracket', 'Corner 100% Bracket'])
    );
    expect(brackets).toHaveLength(2);

    const boxes = await ProjectStore.list(db, ownerKey, { search: 'box' });
    expect(boxes).toHaveLength(1);
    expect(boxes[0].name).toBe('ELECTRONICS BOX');

    const percents = await ProjectStore.list(db, ownerKey, { search: '100%' });
    expect(percents).toHaveLength(1);
    expect(percents[0].name).toBe('Corner 100% Bracket');
  });

  it('ensureDefault moves null-project threads into one "My designs" project and is idempotent', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();

    await db.query(
      `INSERT INTO threads(id, owner_key) VALUES ($1, $2), ($3, $4)`,
      [t1, ownerKey, t2, ownerKey]
    );

    const id1 = await db.transaction((q) => ProjectStore.ensureDefault(q, ownerKey));
    const id2 = await db.transaction((q) => ProjectStore.ensureDefault(q, ownerKey));

    expect(id1).toBeTruthy();
    expect(id1).toBe(id2);

    const projects = await ProjectStore.list(db, ownerKey);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(id1);
    expect(projects[0].name).toBe('My designs');
    expect(projects[0].threadCount).toBe(2);

    const thread1 = await ThreadStore.get(db, ownerKey, t1);
    const thread2 = await ThreadStore.get(db, ownerKey, t2);
    expect(thread1?.projectId).toBe(id1);
    expect(thread2?.projectId).toBe(id1);
  });

  it('ensureDefault creates nothing for an owner without legacy threads', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;

    const res = await db.transaction((q) => ProjectStore.ensureDefault(q, ownerKey));
    expect(res).toBeNull();

    const projects = await ProjectStore.list(db, ownerKey);
    expect(projects).toEqual([]);
  });

  it('archive archives the project\'s threads', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const project = await ProjectStore.create(db, ownerKey, 'Project to Archive');
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();

    await db.query(
      `INSERT INTO threads(id, owner_key, project_id) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [t1, ownerKey, project.id, t2, ownerKey, project.id]
    );

    const ok = await db.transaction((q) => ProjectStore.archive(q, ownerKey, project.id));
    expect(ok).toBe(true);

    const list = await ProjectStore.list(db, ownerKey);
    expect(list.find((p) => p.id === project.id)).toBeUndefined();

    const threads = await ThreadStore.list(db, ownerKey);
    expect(threads.find((t) => t.id === t1 || t.id === t2)).toBeUndefined();

    const projRow = (
      await db.query(`SELECT archived_at FROM projects WHERE id = $1`, [project.id])
    ).rows[0];
    expect(projRow.archived_at).not.toBeNull();

    const threadRows = (
      await db.query(`SELECT archived_at FROM threads WHERE id IN ($1, $2)`, [t1, t2])
    ).rows;
    expect(threadRows[0].archived_at).not.toBeNull();
    expect(threadRows[1].archived_at).not.toBeNull();
  });

  it('archive refuses while a thread has an active run (409 RUN_ACTIVE)', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const project = await ProjectStore.create(db, ownerKey, 'Active Run Project');
    const threadId = crypto.randomUUID();
    const activeRunId = `run_${crypto.randomUUID()}`;

    await db.query(
      `INSERT INTO threads(id, owner_key, project_id, active_run_id) VALUES ($1, $2, $3, $4)`,
      [threadId, ownerKey, project.id, activeRunId]
    );
    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '15 minutes')`,
      [activeRunId, threadId]
    );

    let caught: StoreError | null = null;
    try {
      await db.transaction((q) => ProjectStore.archive(q, ownerKey, project.id));
    } catch (err) {
      if (err instanceof StoreError) {
        caught = err;
      }
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(409);
    expect(caught?.code).toBe('run_active');
    expect(caught?.message).toBe(RUN_ACTIVE);
    expect(caught?.activeRunId).toBe(activeRunId);

    // Assert project and thread are NOT archived
    const projAfter = await ProjectStore.get(db, ownerKey, project.id);
    expect(projAfter).not.toBeNull();
    expect(projAfter?.archivedAt).toBeNull();

    const threadAfter = await ThreadStore.get(db, ownerKey, threadId);
    expect(threadAfter).not.toBeNull();
    expect(threadAfter?.archivedAt).toBeNull();
  });
});
