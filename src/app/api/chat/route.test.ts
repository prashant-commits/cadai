import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { NextRequest } from 'next/server';
import { getDb, closeDb } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { CADAI_OWNER_COOKIE } from '@/lib/owner';
import {
  BAD_ATTACHMENT,
  BAD_EDIT,
  BAD_PIN,
  LEGACY,
  RUN_ACTIVE,
  STALE_CLIENT,
} from '@/lib/persist/phrases';
import { put as putArtifact } from '@/lib/runs/owner-artifacts';

const runDesignerMock = vi.fn();
vi.mock('@/lib/agent/designer/run-designer', () => ({
  runDesigner: (...args: unknown[]) => runDesignerMock(...args),
  formatFlags: vi.fn().mockReturnValue(''),
}));

vi.mock('@/lib/engine/brep-runner', () => ({
  runBrep: vi.fn().mockResolvedValue({
    ok: true,
    parts: [{ label: 'box', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
    solids: 1,
    stl: Buffer.from('solid box\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid box').toString('base64'),
    step: 'STEP-DATA',
    ms: 50,
    disconnected: [],
    interferences: [],
  }),
}));

vi.mock('@/lib/agent/model-provider', () => ({
  getChatModel: vi.fn(() => ({
    withStructuredOutput: vi.fn(() => ({
      withConfig: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue({ parsed: { label: 'edit' }, raw: {} }),
    })),
  })),
  isAbortOrTimeout: vi.fn(() => false),
}));

import { POST as chatRoute } from './route';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const cookie = `${CADAI_OWNER_COOKIE}=${uuid}`;
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, cookie, key };
}

const callChat = (owner: { cookie: string }, body: unknown) =>
  chatRoute(
    new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: owner.cookie,
      },
      body: JSON.stringify(body),
    })
  );

describe('POST /api/chat lifecycle', () => {
  beforeEach(() => {
    runDesignerMock.mockReset();
    runDesignerMock.mockResolvedValue({
      script: 'box = Box(10, 10, 10)\n_cadai_parts = [box]',
      facts: {
        ok: true,
        parts: [{ label: 'box', size: [10, 10, 10], valid: true }],
        interferences: [],
        disconnected: [],
        dimensions: [],
      },
      summary: '10mm cube',
      reviewerFlags: [],
      turns: 1,
      costUsd: 0.01,
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it('chat: sets X-Run-Id', async () => {
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();

    const res = await callChat(owner, {
      threadId,
      clientMessageId,
      text: 'build a box',
      viewingVersion: null,
    });

    expect(res.status).toBe(200);
    const runIdHeader = res.headers.get('X-Run-Id');
    expect(runIdHeader).toBeTruthy();
    await res.text();
  });

  it('chat: 409 run_active with activeRunId', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const activeRunId = `run_${crypto.randomUUID()}`;

    await db.query(
      `INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, $3)`,
      [threadId, owner.key, activeRunId]
    );
    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '15 minutes')`,
      [activeRunId, threadId]
    );

    const res = await callChat(owner, {
      threadId,
      clientMessageId: crypto.randomUUID(),
      text: 'second message while active',
      viewingVersion: null,
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'run_active', message: RUN_ACTIVE },
      activeRunId,
    });
  });

  it('chat: 409 duplicate_message with runId', async () => {
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();

    const res1 = await callChat(owner, {
      threadId,
      clientMessageId,
      text: 'first message',
      viewingVersion: null,
    });
    expect(res1.status).toBe(200);
    const runId = res1.headers.get('X-Run-Id');
    await res1.text();

    const res2 = await callChat(owner, {
      threadId,
      clientMessageId,
      text: 'duplicate message replay',
      viewingVersion: null,
    });
    expect(res2.status).toBe(409);
    const body = await res2.json();
    expect(body).toEqual({
      error: { code: 'duplicate_message' },
      runId,
    });
  });

  it('chat: STALE_CLIENT, BAD_PIN, BAD_EDIT, BAD_ATTACHMENT and LEGACY are 400', async () => {
    const db = getDb();
    const owner = makeOwner();
    const validThreadId = crypto.randomUUID();

    // 1. LEGACY: non-UUID threadId
    const resLegacy = await callChat(owner, {
      threadId: 'legacy-thread-123',
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(resLegacy.status).toBe(400);
    expect(await resLegacy.json()).toEqual({
      error: { code: 'legacy', message: LEGACY },
    });

    // 2. STALE_CLIENT: missing or invalid clientMessageId
    const resStaleClient1 = await callChat(owner, {
      threadId: validThreadId,
      text: 'hi',
    });
    expect(resStaleClient1.status).toBe(400);
    expect(await resStaleClient1.json()).toEqual({
      error: { code: 'stale_client', message: STALE_CLIENT },
    });

    // 3. STALE_CLIENT: thread has a design and viewingVersion is missing
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [validThreadId, owner.key]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, body, prelude_version, summary)
       VALUES ($1, 1, null, 'designer', 'make box', 'box = Box(10, 10, 10)', '1', 'Box')`,
      [validThreadId]
    );

    const resStaleClient2 = await callChat(owner, {
      threadId: validThreadId,
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(resStaleClient2.status).toBe(400);
    expect(await resStaleClient2.json()).toEqual({
      error: { code: 'stale_client', message: STALE_CLIENT },
    });

    // 4. BAD_ATTACHMENT: > 4 attachments or non-string
    const resBadAtt = await callChat(owner, {
      threadId: validThreadId,
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
      viewingVersion: 1,
      attachmentIds: ['1', '2', '3', '4', '5'],
    });
    expect(resBadAtt.status).toBe(400);
    expect(await resBadAtt.json()).toEqual({
      error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
    });

    // 5. BAD_PIN: pinnedParams not record of numbers
    const resBadPin = await callChat(owner, {
      threadId: validThreadId,
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
      viewingVersion: 1,
      pinnedParams: { size: 'not-a-number' as never },
    });
    expect(resBadPin.status).toBe(400);
    expect(await resBadPin.json()).toEqual({
      error: { code: 'bad_pin', message: BAD_PIN },
    });

    // 6. BAD_EDIT: editedBody failing checkPythonScript
    const resBadEdit = await callChat(owner, {
      threadId: validThreadId,
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
      viewingVersion: 1,
      editedBody: 'import os; os.system("rm -rf /")',
    });
    expect(resBadEdit.status).toBe(400);
    expect(await resBadEdit.json()).toEqual({
      error: { code: 'bad_edit', message: BAD_EDIT },
    });
  });

  it('chat: a throw after start terminates the run with internal', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();

    const runInputMod = await import('@/lib/persist/run-input');
    vi.spyOn(runInputMod, 'loadRunInput').mockRejectedValueOnce(
      new Error('Simulated failure after start')
    );

    const res = await callChat(owner, {
      threadId,
      clientMessageId,
      text: 'hi',
      viewingVersion: null,
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal');

    // Confirm the run was terminated with internal
    const runRes = await db.query(
      `SELECT status, error FROM runs WHERE thread_id = $1`,
      [threadId]
    );
    expect(runRes.rows).toHaveLength(1);
    expect(runRes.rows[0].status).toBe('failed');
    const errObj = typeof runRes.rows[0].error === 'string'
      ? JSON.parse(runRes.rows[0].error)
      : runRes.rows[0].error;
    expect(errObj).toEqual({ code: 'internal' });
  });

  it('a follow-up through the chat route edits the viewed version', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, owner.key]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, body, prelude_version, summary)
       VALUES ($1, 1, null, 'designer', 'make box', 'box = Box(10, 10, 10)', '1', 'Initial Box'),
              ($1, 2, 1,    'designer', 'make box', 'box = Box(10, 10, 20)', '1', 'Taller Box')`,
      [threadId]
    );

    const res = await callChat(owner, {
      threadId,
      clientMessageId: crypto.randomUUID(),
      text: 'make it taller',
      viewingVersion: 1,
    });

    expect(res.status).toBe(200);
    await res.text();

    // Verify the designer received v1's body as priorScript
    expect(runDesignerMock).toHaveBeenCalled();
    const callInput = runDesignerMock.mock.calls[0][0];
    expect(callInput.priorScript).toBe('box = Box(10, 10, 10)');

    // Verify committed v3 has parentVersion: 1
    const v3Res = await db.query(
      `SELECT version, parent_version FROM designs WHERE thread_id = $1 AND version = 3`,
      [threadId]
    );
    expect(v3Res.rows).toHaveLength(1);
    expect(Number(v3Res.rows[0].parent_version)).toBe(1);
  });

  it('an attachment through the chat route reaches the designer', async () => {
    const owner = makeOwner();
    const threadId = crypto.randomUUID();

    const imgBytes = Buffer.from('TEST-IMAGE-BYTES');
    const artId = await putArtifact(owner.key, 'image', imgBytes);

    const res = await callChat(owner, {
      threadId,
      clientMessageId: crypto.randomUUID(),
      text: 'use this reference',
      viewingVersion: null,
      attachmentIds: [artId],
    });

    expect(res.status).toBe(200);
    await res.text();

    expect(runDesignerMock).toHaveBeenCalled();
    const callInput = runDesignerMock.mock.calls[0][0];
    expect(callInput.attachments).toHaveLength(1);
    expect(callInput.attachments[0]).toEqual({
      mediaType: 'image/png',
      base64: imgBytes.toString('base64'),
    });
  });

  it('a chat request abort mid-stream leaves the run running, then it commits', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();

    let designerSignalAborted = false;
    runDesignerMock.mockImplementationOnce(
      async (_args: unknown, config?: { signal?: AbortSignal }) => {
        if (config?.signal) {
          config.signal.addEventListener('abort', () => {
            designerSignalAborted = true;
          });
        }
        await new Promise((r) => setTimeout(r, 150));
        return {
          script: 'box = Box(10, 10, 10)\n_cadai_parts = [box]',
          facts: {
            ok: true,
            parts: [{ label: 'box', size: [10, 10, 10], valid: true }],
            interferences: [],
            disconnected: [],
            dimensions: [],
          },
          summary: '10mm cube',
          reviewerFlags: [],
          turns: 1,
          costUsd: 0.01,
        };
      }
    );

    const abortController = new AbortController();
    const req = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: owner.cookie,
      },
      body: JSON.stringify({
        threadId,
        clientMessageId,
        text: 'build a box',
        viewingVersion: null,
      }),
      signal: abortController.signal,
    });

    const res = await chatRoute(req);
    expect(res.status).toBe(200);
    const runId = res.headers.get('X-Run-Id')!;
    expect(runId).toBeTruthy();

    const reader = res.body!.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);

    abortController.abort();
    await reader.cancel();

    const runRightAfter = await DbRunStore.get(db, runId);
    expect(runRightAfter?.status).toBe('running');

    const start = Date.now();
    let finalRun = runRightAfter;
    while (Date.now() - start < 5000) {
      finalRun = await DbRunStore.get(db, runId);
      if (finalRun?.status === 'done') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(finalRun?.status).toBe('done');
    expect(finalRun?.designVersion).toBe(1);

    const designRes = await db.query(
      `SELECT version FROM designs WHERE thread_id = $1 AND version = 1`,
      [threadId]
    );
    expect(designRes.rows).toHaveLength(1);
    expect(designerSignalAborted).toBe(false);
  });
});
