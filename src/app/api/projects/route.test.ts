import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import * as crypto from 'crypto';
import { getDb, closeDb } from '@/lib/db/db';
import { CADAI_OWNER_COOKIE } from '@/lib/owner';
import { RUN_ACTIVE } from '@/lib/persist/phrases';
import { GET as listProjects, POST as createProject } from './route';
import { PATCH as patchProject, DELETE as deleteProject } from './[id]/route';
import { GET as getProjectThreads } from './[id]/threads/route';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const cookie = `${CADAI_OWNER_COOKIE}=${uuid}`;
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, cookie, key };
}

describe('Projects API Routes', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('another owner\'s project is 404 on GET, PATCH and DELETE', async () => {
    const db = getDb();
    const ownerA = makeOwner();
    const ownerB = makeOwner();
    const projectId = crypto.randomUUID();

    await db.query(
      `INSERT INTO projects (id, owner_key, name) VALUES ($1, $2, $3)`,
      [projectId, ownerA.key, 'Owner A Project']
    );

    // GET /api/projects/:id/threads with Owner B
    const reqGet = new NextRequest(
      `http://localhost:3000/api/projects/${projectId}/threads`,
      {
        method: 'GET',
        headers: { cookie: ownerB.cookie },
      }
    );
    const resGet = await getProjectThreads(reqGet, {
      params: Promise.resolve({ id: projectId }),
    });
    expect(resGet.status).toBe(404);
    const bodyGet = await resGet.json();
    expect(bodyGet).toEqual({
      error: { code: 'not_found', message: 'Project not found' },
    });

    // PATCH /api/projects/:id with Owner B
    const reqPatch = new NextRequest(
      `http://localhost:3000/api/projects/${projectId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          cookie: ownerB.cookie,
        },
        body: JSON.stringify({ name: 'Hacked Name' }),
      }
    );
    const resPatch = await patchProject(reqPatch, {
      params: Promise.resolve({ id: projectId }),
    });
    expect(resPatch.status).toBe(404);
    const bodyPatch = await resPatch.json();
    expect(bodyPatch).toEqual({
      error: { code: 'not_found', message: 'Project not found' },
    });

    // DELETE /api/projects/:id with Owner B
    const reqDelete = new NextRequest(
      `http://localhost:3000/api/projects/${projectId}`,
      {
        method: 'DELETE',
        headers: { cookie: ownerB.cookie },
      }
    );
    const resDelete = await deleteProject(reqDelete, {
      params: Promise.resolve({ id: projectId }),
    });
    expect(resDelete.status).toBe(404);
    const bodyDelete = await resDelete.json();
    expect(bodyDelete).toEqual({
      error: { code: 'not_found', message: 'Project not found' },
    });

    // Assert the project still exists and keeps its name for the real owner afterwards
    const row = (
      await db.query(
        `SELECT name, archived_at FROM projects WHERE id = $1 AND owner_key = $2`,
        [projectId, ownerA.key]
      )
    ).rows[0];
    expect(row).toBeDefined();
    expect(row.name).toBe('Owner A Project');
    expect(row.archived_at).toBeNull();
  });

  it('POST /api/projects creates a project with 201', async () => {
    const owner = makeOwner();
    const req = new NextRequest('http://localhost:3000/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: owner.cookie,
      },
      body: JSON.stringify({ name: 'Fresh Project' }),
    });
    const res = await createProject(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project).toBeDefined();
    expect(body.project.name).toBe('Fresh Project');
    expect(typeof body.project.id).toBe('string');
  });

  it('GET /api/projects lists projects and supports search', async () => {
    const db = getDb();
    const owner = makeOwner();
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    await db.query(
      `INSERT INTO projects (id, owner_key, name) VALUES ($1, $2, 'Delta Wing'), ($3, $4, 'Motor Mount')`,
      [p1, owner.key, p2, owner.key]
    );

    const req = new NextRequest('http://localhost:3000/api/projects?search=wing', {
      method: 'GET',
      headers: { cookie: owner.cookie },
    });
    const res = await listProjects(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].name).toBe('Delta Wing');
  });

  it('DELETE /api/projects/:id returns 409 when thread has active run', async () => {
    const db = getDb();
    const owner = makeOwner();
    const projectId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const activeRunId = `run_${crypto.randomUUID()}`;

    await db.query(
      `INSERT INTO projects (id, owner_key, name) VALUES ($1, $2, $3)`,
      [projectId, owner.key, 'Active Run Project']
    );
    await db.query(
      `INSERT INTO threads (id, owner_key, project_id, active_run_id) VALUES ($1, $2, $3, $4)`,
      [threadId, owner.key, projectId, activeRunId]
    );
    await db.query(
      `INSERT INTO runs (id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '15 minutes')`,
      [activeRunId, threadId]
    );

    const req = new NextRequest(`http://localhost:3000/api/projects/${projectId}`, {
      method: 'DELETE',
      headers: { cookie: owner.cookie },
    });
    const res = await deleteProject(req, {
      params: Promise.resolve({ id: projectId }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'run_active', message: RUN_ACTIVE },
      activeRunId,
    });
  });
});
