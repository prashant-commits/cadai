import { describe, it, expect, vi, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import * as crypto from 'crypto';
import { getDb, closeDb } from '@/lib/db/db';
import { CADAI_OWNER_COOKIE } from '@/lib/owner';
import { STOPPED } from '@/lib/persist/phrases';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { GET as listThreads } from './route';
import {
  GET as getThread,
  PATCH as patchThread,
  DELETE as deleteThread,
} from './[id]/route';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const cookie = `${CADAI_OWNER_COOKIE}=${uuid}`;
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, cookie, key };
}

describe('Threads API Routes', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('the thread GET shape', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const runId = `run_${crypto.randomUUID()}`;
    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const userArtId = crypto.randomBytes(16).toString('base64url');
    const stlArtId = crypto.randomBytes(16).toString('base64url');
    const stepArtId = crypto.randomBytes(16).toString('base64url');

    // 1. Thread with active_run_id
    await db.query(
      `INSERT INTO threads (id, owner_key, title, active_run_id, created_at, updated_at)
       VALUES ($1, $2, 'Box Thread', $3, now(), now())`,
      [threadId, owner.key, runId]
    );

    // 2. Running run
    await db.query(
      `INSERT INTO runs (id, thread_id, status, last_seq, deadline_at, heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, 'running', 5, now() + interval '15 minutes', now(), now(), now())`,
      [runId, threadId]
    );

    // 3. Artifacts: user attachment, STL, STEP
    await db.query(
      `INSERT INTO artifacts (id, owner_key, thread_id, run_id, kind, bytes, object_key, created_at)
       VALUES ($1, $2, $3, $4, 'image', 100, 'img_key', now()),
              ($5, $2, $3, $4, 'stl', 200, 'stl_key', now()),
              ($6, $2, $3, $4, 'step', 300, 'step_key', now())`,
      [userArtId, owner.key, threadId, runId, stlArtId, stepArtId]
    );

    // 4. Messages
    await db.query(
      `INSERT INTO messages (id, thread_id, seq, role, kind, content, run_id, design_version, created_at)
       VALUES ($1, $2, 1, 'user', 'request', 'Create a 10mm box', null, null, now())`,
      [userMsgId, threadId]
    );
    await db.query(
      `INSERT INTO message_attachments (message_id, artifact_id) VALUES ($1, $2)`,
      [userMsgId, userArtId]
    );

    await db.query(
      `INSERT INTO messages (id, thread_id, seq, role, kind, content, run_id, design_version, created_at)
       VALUES ($1, $2, 2, 'assistant', 'result', 'Here is the box design', $3, 1, now())`,
      [assistantMsgId, threadId, runId]
    );

    // 5. Design
    await db.query(
      `INSERT INTO designs (thread_id, version, parent_version, origin, run_id, base_request, edits, body, prelude_version, summary, facts, flags, stl_artifact, step_artifact, created_at)
       VALUES ($1, 1, null, 'designer', $2, 'Create a 10mm box', '[]', 'box = Box(10, 10, 10)', 'v1', 'Box 10mm', null, '["passed"]', $3, $4, now())`,
      [threadId, runId, stlArtId, stepArtId]
    );

    // GET /api/threads/:id
    const req = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'GET',
      headers: { cookie: owner.cookie },
    });
    const res = await getThread(req, { params: Promise.resolve({ id: threadId }) });
    expect(res.status).toBe(200);

    const data = await res.json();

    // Assert every field of the plan's shape
    expect(data.id).toBe(threadId);
    expect(data.title).toBe('Box Thread');
    expect(data.activeRun).toEqual({
      id: runId,
      status: 'running',
      lastSeq: 5,
    });

    // Messages assertion
    expect(data.messages).toHaveLength(2);

    expect(data.messages[0]).toEqual({
      id: userMsgId,
      seq: 1,
      role: 'user',
      kind: 'request',
      markdown: 'Create a 10mm box',
      attachments: [{ id: userArtId, kind: 'reference' }],
    });
    expect('designVersion' in data.messages[0]).toBe(false);
    expect('steps' in data.messages[0]).toBe(false);

    expect(data.messages[1]).toEqual({
      id: assistantMsgId,
      seq: 2,
      role: 'assistant',
      kind: 'result',
      markdown: 'Here is the box design',
      designVersion: 1,
      attachments: [],
      steps: [],
    });

    // Versions assertion
    expect(data.versions).toHaveLength(1);
    expect(data.versions[0]).toEqual({
      version: 1,
      parentVersion: null,
      origin: 'designer',
      summary: 'Box 10mm',
      flags: ['passed'],
      body: 'box = Box(10, 10, 10)',
      preludeVersion: 'v1',
      stl: stlArtId,
      step: stepArtId,
      topo: null,
      createdAt: expect.any(Number),
      partLabels: [],
    });
  });

  it('GET thread returns partLabels from facts and handles malformed facts', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();

    await db.query(
      `INSERT INTO threads (id, owner_key, title, created_at, updated_at)
       VALUES ($1, $2, 'Parts Thread', now(), now())`,
      [threadId, owner.key]
    );

    await db.query(
      `INSERT INTO designs (thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags, created_at)
       VALUES ($1, 1, null, 'designer', 'Req', '[]', 'body', 'v1', 'sum', $2, '[]', now())`,
      [threadId, JSON.stringify({ parts: [{ label: 'base' }, { label: 'arm' }] })]
    );

    await db.query(
      `INSERT INTO designs (thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags, created_at)
       VALUES ($1, 2, 1, 'designer', 'Req', '[]', 'body', 'v1', 'sum', $2, '[]', now())`,
      [threadId, JSON.stringify('malformed-string')]
    );

    const req = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'GET',
      headers: { cookie: owner.cookie },
    });
    const res = await getThread(req, { params: Promise.resolve({ id: threadId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    const v1 = data.versions.find((v: { version: number }) => v.version === 1);
    const v2 = data.versions.find((v: { version: number }) => v.version === 2);
    expect(v1.partLabels).toEqual(['base', 'arm']);
    expect(v2.partLabels).toEqual([]);
  });

  it('GET thread returns per-message steps', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    await db.query(
      `INSERT INTO threads (id, owner_key, title, created_at, updated_at)
       VALUES ($1, $2, 'Steps Thread', now(), now())`,
      [threadId, owner.key]
    );

    const stepsData = [
      { kind: 'section', id: 'planner', label: 'Planner', status: 'ok', body: 'Plan text' },
    ];

    await db.query(
      `INSERT INTO messages (id, thread_id, seq, role, kind, content, steps)
       VALUES ($1, $2, 1, 'assistant', 'result', 'Reply text', $3)`,
      [assistantMsgId, threadId, JSON.stringify(stepsData)]
    );

    const req = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'GET',
      headers: { cookie: owner.cookie },
    });
    const res = await getThread(req, { params: Promise.resolve({ id: threadId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].steps).toEqual(stepsData);
  });

  it('GET thread returns attachments with id and kind', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const userMsgId = crypto.randomUUID();
    const artId1 = `art_${crypto.randomUUID()}`;
    const artId2 = `art_${crypto.randomUUID()}`;

    await db.query(
      `INSERT INTO threads (id, owner_key, title, created_at, updated_at)
       VALUES ($1, $2, 'Atts Thread', now(), now())`,
      [threadId, owner.key]
    );
    await db.query(
      `INSERT INTO artifacts (id, owner_key, kind, bytes, object_key)
       VALUES ($1, $2, 'image', 10, 'k1'), ($3, $4, 'image', 20, 'k2')`,
      [artId1, owner.key, artId2, owner.key]
    );
    await db.query(
      `INSERT INTO messages (id, thread_id, seq, role, kind, content)
       VALUES ($1, $2, 1, 'user', 'request', 'User message')`,
      [userMsgId, threadId]
    );
    await db.query(
      `INSERT INTO message_attachments (message_id, artifact_id, kind)
       VALUES ($1, $2, 'markup'), ($1, $3, 'reference')`,
      [userMsgId, artId1, artId2]
    );

    const req = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'GET',
      headers: { cookie: owner.cookie },
    });
    const res = await getThread(req, { params: Promise.resolve({ id: threadId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    const expected = [
      { id: artId1, kind: 'markup' },
      { id: artId2, kind: 'reference' },
    ].sort((a, b) => a.id.localeCompare(b.id));
    expect(data.messages[0].attachments).toEqual(expected);
  });

  it('another owner → 404', async () => {
    const db = getDb();
    const ownerA = makeOwner();
    const ownerB = makeOwner();
    const threadId = crypto.randomUUID();

    await db.query(
      `INSERT INTO threads (id, owner_key, title, created_at, updated_at)
       VALUES ($1, $2, 'Owner A Thread', now(), now())`,
      [threadId, ownerA.key]
    );

    // 1. GET with another owner's cookie -> 404
    const getOtherReq = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'GET',
      headers: { cookie: ownerB.cookie },
    });
    const getOtherRes = await getThread(getOtherReq, {
      params: Promise.resolve({ id: threadId }),
    });
    expect(getOtherRes.status).toBe(404);

    // 2. PATCH with another owner's cookie -> 404 and changes nothing
    const patchOtherReq = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { cookie: ownerB.cookie },
      body: JSON.stringify({ title: 'Hacked' }),
    });
    const patchOtherRes = await patchThread(patchOtherReq, {
      params: Promise.resolve({ id: threadId }),
    });
    expect(patchOtherRes.status).toBe(404);

    const checkThread1 = await db.query(`SELECT title, archived_at FROM threads WHERE id = $1`, [threadId]);
    expect(checkThread1.rows[0].title).toBe('Owner A Thread');
    expect(checkThread1.rows[0].archived_at).toBeNull();

    // 3. DELETE with another owner's cookie -> 404 and changes nothing
    const delOtherReq = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'DELETE',
      headers: { cookie: ownerB.cookie },
    });
    const delOtherRes = await deleteThread(delOtherReq, {
      params: Promise.resolve({ id: threadId }),
    });
    expect(delOtherRes.status).toBe(404);

    const checkThread2 = await db.query(`SELECT archived_at FROM threads WHERE id = $1`, [threadId]);
    expect(checkThread2.rows[0].archived_at).toBeNull();

    // 4. No cookie -> 401 on GET /api/threads, GET /api/threads/:id, PATCH, DELETE
    const listNoCookie = new NextRequest('http://localhost:3000/api/threads', { method: 'GET' });
    expect((await listThreads(listNoCookie)).status).toBe(401);

    const getNoCookie = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, { method: 'GET' });
    expect((await getThread(getNoCookie, { params: Promise.resolve({ id: threadId }) })).status).toBe(401);

    const patchNoCookie = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'No auth' }),
    });
    expect((await patchThread(patchNoCookie, { params: Promise.resolve({ id: threadId }) })).status).toBe(401);

    const delNoCookie = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, { method: 'DELETE' });
    expect((await deleteThread(delNoCookie, { params: Promise.resolve({ id: threadId }) })).status).toBe(401);

    // 5. Non-UUID id -> 404
    const nonUuid = 'not-a-valid-uuid';
    const getNonUuid = new NextRequest(`http://localhost:3000/api/threads/${nonUuid}`, {
      headers: { cookie: ownerA.cookie },
    });
    expect((await getThread(getNonUuid, { params: Promise.resolve({ id: nonUuid }) })).status).toBe(404);

    const patchNonUuid = new NextRequest(`http://localhost:3000/api/threads/${nonUuid}`, {
      method: 'PATCH',
      headers: { cookie: ownerA.cookie },
      body: JSON.stringify({ title: 'Non-UUID' }),
    });
    expect((await patchThread(patchNonUuid, { params: Promise.resolve({ id: nonUuid }) })).status).toBe(404);

    const delNonUuid = new NextRequest(`http://localhost:3000/api/threads/${nonUuid}`, {
      headers: { cookie: ownerA.cookie },
    });
    expect((await deleteThread(delNonUuid, { params: Promise.resolve({ id: nonUuid }) })).status).toBe(404);

    // 6. Archive Owner A's thread
    const delReq = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'DELETE',
      headers: { cookie: ownerA.cookie },
    });
    const delRes = await deleteThread(delReq, { params: Promise.resolve({ id: threadId }) });
    expect(delRes.status).toBe(204);

    // An archived thread is 404 on GET/PATCH/DELETE
    const getArchived = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      headers: { cookie: ownerA.cookie },
    });
    expect((await getThread(getArchived, { params: Promise.resolve({ id: threadId }) })).status).toBe(404);

    const patchArchived = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { cookie: ownerA.cookie },
      body: JSON.stringify({ title: 'Archived update' }),
    });
    expect((await patchThread(patchArchived, { params: Promise.resolve({ id: threadId }) })).status).toBe(404);

    const delArchived = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      headers: { cookie: ownerA.cookie },
    });
    expect((await deleteThread(delArchived, { params: Promise.resolve({ id: threadId }) })).status).toBe(404);

    // Absent from GET /api/threads
    const listReq = new NextRequest('http://localhost:3000/api/threads', {
      headers: { cookie: ownerA.cookie },
    });
    const listRes = await listThreads(listReq);
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.threads.find((t: { id: string }) => t.id === threadId)).toBeUndefined();
  });

  it('rename', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();

    await db.query(
      `INSERT INTO threads (id, owner_key, title, created_at, updated_at)
       VALUES ($1, $2, 'Original Title', now(), now())`,
      [threadId, owner.key]
    );

    // 1. PATCH valid title -> 204 and persisted
    const patchReq = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { cookie: owner.cookie },
      body: JSON.stringify({ title: 'Updated Title' }),
    });
    const patchRes = await patchThread(patchReq, { params: Promise.resolve({ id: threadId }) });
    expect(patchRes.status).toBe(204);

    const check1 = await db.query(`SELECT title FROM threads WHERE id = $1`, [threadId]);
    expect(check1.rows[0].title).toBe('Updated Title');

    // 2. 200-char title stored as 120 chars
    const longTitle = 'b'.repeat(200);
    const patchLongReq = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { cookie: owner.cookie },
      body: JSON.stringify({ title: longTitle }),
    });
    const patchLongRes = await patchThread(patchLongReq, { params: Promise.resolve({ id: threadId }) });
    expect(patchLongRes.status).toBe(204);

    const check2 = await db.query<{ title: string }>(`SELECT title FROM threads WHERE id = $1`, [threadId]);
    expect(check2.rows[0].title).toBe('b'.repeat(120));
    expect(check2.rows[0].title.length).toBe(120);

    // 3. Non-string title -> 400
    const patchBadReq1 = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { cookie: owner.cookie },
      body: JSON.stringify({ title: 12345 }),
    });
    expect((await patchThread(patchBadReq1, { params: Promise.resolve({ id: threadId }) })).status).toBe(400);

    const patchBadReq2 = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { cookie: owner.cookie },
      body: JSON.stringify({}),
    });
    expect((await patchThread(patchBadReq2, { params: Promise.resolve({ id: threadId }) })).status).toBe(400);
  });

  it('delete during a run ends it and archives, atomically', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const runId = `run_${crypto.randomUUID()}`;

    // Seed thread and running run
    await db.query(
      `INSERT INTO threads (id, owner_key, title, active_run_id, created_at, updated_at)
       VALUES ($1, $2, 'Thread With Run', $3, now(), now())`,
      [threadId, owner.key, runId]
    );
    await db.query(
      `INSERT INTO runs (id, thread_id, status, last_seq, deadline_at, heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, 'running', 2, now() + interval '15 minutes', now(), now(), now())`,
      [runId, threadId]
    );

    // Normal delete during run -> 204
    const delReq = new NextRequest(`http://localhost:3000/api/threads/${threadId}`, {
      method: 'DELETE',
      headers: { cookie: owner.cookie },
    });
    const delRes = await deleteThread(delReq, { params: Promise.resolve({ id: threadId }) });
    expect(delRes.status).toBe(204);

    // Run ends 'cancelled'
    const runCheck = await db.query(`SELECT status, ended_at FROM runs WHERE id = $1`, [runId]);
    expect(runCheck.rows[0].status).toBe('cancelled');
    expect(runCheck.rows[0].ended_at).not.toBeNull();

    // STOPPED reply in messages
    const msgCheck = await db.query(
      `SELECT role, kind, content FROM messages WHERE thread_id = $1 AND role = 'assistant'`,
      [threadId]
    );
    expect(msgCheck.rows).toHaveLength(1);
    expect(msgCheck.rows[0].kind).toBe('cancelled');
    expect(msgCheck.rows[0].content).toBe(STOPPED);

    // 'end' event in run_events
    const eventCheck = await db.query(
      `SELECT type, payload FROM run_events WHERE run_id = $1 AND type = 'end'`,
      [runId]
    );
    expect(eventCheck.rows).toHaveLength(1);
    const endPayload = typeof eventCheck.rows[0].payload === 'string'
      ? JSON.parse(eventCheck.rows[0].payload)
      : eventCheck.rows[0].payload;
    expect(endPayload.status).toBe('cancelled');
    expect(endPayload.reply.markdown).toBe(STOPPED);

    // active_run_id is cleared and archived_at is set
    const threadCheck = await db.query(
      `SELECT active_run_id, archived_at FROM threads WHERE id = $1`,
      [threadId]
    );
    expect(threadCheck.rows[0].active_run_id).toBeNull();
    expect(threadCheck.rows[0].archived_at).not.toBeNull();

    // --- Inject failure test: atomic rollback ---
    const threadId2 = crypto.randomUUID();
    const runId2 = `run_${crypto.randomUUID()}`;

    await db.query(
      `INSERT INTO threads (id, owner_key, title, active_run_id, created_at, updated_at)
       VALUES ($1, $2, 'Atomic Thread', $3, now(), now())`,
      [threadId2, owner.key, runId2]
    );
    await db.query(
      `INSERT INTO runs (id, thread_id, status, last_seq, deadline_at, heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, 'running', 1, now() + interval '15 minutes', now(), now(), now())`,
      [runId2, threadId2]
    );

    // Inject failure after DbRunStore.terminate runs inside ThreadStore.archive
    const origTerminate = DbRunStore.terminate;
    const terminateSpy = vi.spyOn(DbRunStore, 'terminate').mockImplementation(async (...args) => {
      await origTerminate.apply(DbRunStore, args);
      throw new Error('Injected failure after terminate');
    });

    try {
      const failingDelReq = new NextRequest(`http://localhost:3000/api/threads/${threadId2}`, {
        method: 'DELETE',
        headers: { cookie: owner.cookie },
      });
      await expect(
        deleteThread(failingDelReq, { params: Promise.resolve({ id: threadId2 }) })
      ).rejects.toThrow('Injected failure after terminate');
    } finally {
      terminateSpy.mockRestore();
    }

    // Verify neither change is visible: run is still running, thread is not archived, active_run_id still set
    const runCheck2 = await db.query(`SELECT status, ended_at FROM runs WHERE id = $1`, [runId2]);
    expect(runCheck2.rows[0].status).toBe('running');
    expect(runCheck2.rows[0].ended_at).toBeNull();

    const threadCheck2 = await db.query(`SELECT active_run_id, archived_at FROM threads WHERE id = $1`, [threadId2]);
    expect(threadCheck2.rows[0].active_run_id).toBe(runId2);
    expect(threadCheck2.rows[0].archived_at).toBeNull();

    const msgCheck2 = await db.query(`SELECT id FROM messages WHERE thread_id = $1`, [threadId2]);
    expect(msgCheck2.rows).toHaveLength(0);

    const eventCheck2 = await db.query(`SELECT seq FROM run_events WHERE run_id = $1`, [runId2]);
    expect(eventCheck2.rows).toHaveLength(0);
  });

  it('GET /api/threads pagination and keyset cursor', async () => {
    const db = getDb();
    const owner = makeOwner();
    const id1 = '10000000-0000-4000-8000-000000000001';
    const id2 = '10000000-0000-4000-8000-000000000002';
    const id3 = '10000000-0000-4000-8000-000000000003';

    await db.query(
      `INSERT INTO threads (id, owner_key, title, updated_at) VALUES
       ($1, $4, 'Thread 1', '2026-05-01T10:00:00Z'),
       ($2, $4, 'Thread 2', '2026-05-01T11:00:00Z'),
       ($3, $4, 'Thread 3', '2026-05-01T12:00:00Z')`,
      [id1, id2, id3, owner.key]
    );

    // Page 1, limit 2
    const req1 = new NextRequest('http://localhost:3000/api/threads?limit=2', {
      headers: { cookie: owner.cookie },
    });
    const res1 = await listThreads(req1);
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.threads).toHaveLength(2);
    expect(body1.threads[0].id).toBe(id3);
    expect(body1.threads[1].id).toBe(id2);

    // Page 2 using keyset cursor ?before=<updatedAt>:<id>
    const cursor = `${body1.threads[1].updatedAt}:${body1.threads[1].id}`;
    const req2 = new NextRequest(`http://localhost:3000/api/threads?limit=2&before=${cursor}`, {
      headers: { cookie: owner.cookie },
    });
    const res2 = await listThreads(req2);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.threads).toHaveLength(1);
    expect(body2.threads[0].id).toBe(id1);
  });

  it('a malformed cursor → 400', async () => {
    const owner = makeOwner();

    // 1. Non-UUID id (e.g. ?before=1700000000000:abc)
    const reqNonUuid = new NextRequest(
      'http://localhost:3000/api/threads?before=1700000000000:abc',
      { headers: { cookie: owner.cookie } }
    );
    const resNonUuid = await listThreads(reqNonUuid);
    expect(resNonUuid.status).toBe(400);
    expect(await resNonUuid.json()).toEqual({
      error: { code: 'bad_request', message: 'Invalid cursor' },
    });

    // 2. No colon (e.g. ?before=invalid)
    const reqNoColon = new NextRequest(
      'http://localhost:3000/api/threads?before=invalid',
      { headers: { cookie: owner.cookie } }
    );
    const resNoColon = await listThreads(reqNoColon);
    expect(resNoColon.status).toBe(400);
    expect(await resNoColon.json()).toEqual({
      error: { code: 'bad_request', message: 'Invalid cursor' },
    });

    // 3. Non-finite number (e.g. ?before=nan:10000000-0000-4000-8000-000000000001)
    const reqNonFinite = new NextRequest(
      'http://localhost:3000/api/threads?before=nan:10000000-0000-4000-8000-000000000001',
      { headers: { cookie: owner.cookie } }
    );
    const resNonFinite = await listThreads(reqNonFinite);
    expect(resNonFinite.status).toBe(400);
    expect(await resNonFinite.json()).toEqual({
      error: { code: 'bad_request', message: 'Invalid cursor' },
    });
  });
});
