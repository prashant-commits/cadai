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
  BUSY,
  BUDGET_USED,
} from '@/lib/persist/phrases';
import { StoreError } from '@/lib/persist/types';
import { put as putArtifact } from '@/lib/runs/owner-artifacts';
import * as graphMod from '@/lib/agent/designer/graph';
import { coerceRouteModel } from '@/lib/agent/models';
import { graphRecursionLimit } from '@/lib/agent/run-limits';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';

const langfuseHandlerMock = vi.fn<(...args: unknown[]) => unknown>(() => null);
const langfuseProcessorMock = vi.fn<() => unknown>(() => null);
vi.mock('@/lib/tracing/langfuse', () => ({
  getLangfuseCallbackHandler: (...args: unknown[]) => langfuseHandlerMock(...args),
  getLangfuseSpanProcessor: () => langfuseProcessorMock(),
}));

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

import { POST as chatRoute, runtime, dynamic } from './route';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const cookie = `${CADAI_OWNER_COOKIE}=${uuid}`;
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, cookie, key };
}

const rawChat = (owner: { cookie?: string }, rawBody: string) =>
  chatRoute(
    new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(owner.cookie ? { cookie: owner.cookie } : {}),
      },
      body: rawBody,
    })
  );

const callChat = (owner: { cookie?: string }, body: unknown) =>
  rawChat(owner, JSON.stringify(body));

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
    expect(body).toEqual({ error: { code: 'internal', message: 'Internal server error' } });

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
      kind: 'reference',
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

  it('chat: 429 busy and budget bodies use the fixed phrases', async () => {
    const startSpy = vi.spyOn(DbRunStore, 'start');
    try {
      const owner = makeOwner();
      const threadId = crypto.randomUUID();
      const clientMessageId = crypto.randomUUID();

      startSpy.mockRejectedValueOnce(
        new StoreError(429, 'busy', BUSY)
      );

      const resBusy = await callChat(owner, {
        threadId,
        clientMessageId,
        text: 'hi',
        viewingVersion: null,
      });
      expect(resBusy.status).toBe(429);
      expect(await resBusy.json()).toEqual({
        error: { code: 'busy', message: BUSY },
      });

      startSpy.mockRejectedValueOnce(
        new StoreError(429, 'budget', BUDGET_USED)
      );

      const resBudget = await callChat(owner, {
        threadId,
        clientMessageId: crypto.randomUUID(),
        text: 'hi',
        viewingVersion: null,
      });
      expect(resBudget.status).toBe(429);
      expect(await resBudget.json()).toEqual({
        error: { code: 'budget', message: BUDGET_USED },
      });
    } finally {
      startSpy.mockRestore();
    }
  });

  describe('request validation and forwarding', () => {
    const seedDesign = async (ownerKey: string, threadId: string, body: string) => {
      const db = getDb();
      await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);
      await db.query(
        `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, body, prelude_version, summary)
         VALUES ($1, 1, null, 'designer', 'make box', $2, '1', 'Box')`,
        [threadId, body]
      );
    };
    const PIN_BODY = 'w = 40  # [0:100] W\nh = 10';

    it('RT1: the route segment config is nodejs and force-dynamic', () => {
      expect(runtime).toBe('nodejs');
      expect(dynamic).toBe('force-dynamic');
    });

    it('RT2: no owner cookie, or an invalid one, is 401', async () => {
      const startSpy = vi.spyOn(DbRunStore, 'start');
      try {
        const base = {
          threadId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          text: 'hi',
          viewingVersion: null,
        };
        for (const owner of [{}, { cookie: `${CADAI_OWNER_COOKIE}=not-a-uuid` }]) {
          const res = await callChat(owner, base);
          expect(res.status).toBe(401);
          expect(await res.json()).toEqual({
            error: { code: 'unauthorized', message: 'Unauthorized' },
          });
        }
        expect(startSpy).not.toHaveBeenCalled();
      } finally {
        startSpy.mockRestore();
      }
    });

    it('RT3: invalid JSON is 400', async () => {
      const res = await rawChat(makeOwner(), '{not json');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_request', message: 'Invalid JSON' },
      });
    });

    it.each([['null'], ['[]'], ['"x"'], ['42']])('RT4: body %s must be an object', async (raw) => {
      const res = await rawChat(makeOwner(), raw);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_request', message: 'Request body must be an object' },
      });
    });

    it('RT5: text must be a string', async () => {
      const owner = makeOwner();
      const ids = { threadId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() };
      for (const body of [{ ...ids, text: 5 }, { ...ids }]) {
        const res = await callChat(owner, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: { code: 'bad_request', message: 'text must be a string' },
        });
      }
    });

    const REJECTED: {
      name: string;
      patch?: Record<string, unknown>;
      raw?: [string, string];
      code: string;
      message: string;
    }[] = [
      { name: 'threadId wrapped in an array', patch: { threadId: [crypto.randomUUID()] }, code: 'legacy', message: LEGACY },
      { name: 'clientMessageId not a uuid', patch: { clientMessageId: 'not-a-uuid' }, code: 'stale_client', message: STALE_CLIENT },
      { name: 'clientMessageId wrapped in an array', patch: { clientMessageId: [crypto.randomUUID()] }, code: 'stale_client', message: STALE_CLIENT },
      { name: 'viewingVersion 1.5', patch: { viewingVersion: 1.5 }, code: 'stale_client', message: STALE_CLIENT },
      { name: 'viewingVersion string', patch: { viewingVersion: 'abc' }, code: 'stale_client', message: STALE_CLIENT },
      { name: 'viewingVersion object', patch: { viewingVersion: {} }, code: 'stale_client', message: STALE_CLIENT },
      { name: 'attachmentIds with a non-string among strings', patch: { attachmentIds: ['a'.repeat(22), 7] }, code: 'bad_attachment', message: BAD_ATTACHMENT },
      { name: 'attachmentIds with only a number', patch: { attachmentIds: [7] }, code: 'bad_attachment', message: BAD_ATTACHMENT },
      { name: 'pinnedParams empty array', patch: { pinnedParams: [] }, code: 'bad_pin', message: BAD_PIN },
      { name: 'pinnedParams number', patch: { pinnedParams: 5 }, code: 'bad_pin', message: BAD_PIN },
      { name: 'pinnedParams string value', patch: { pinnedParams: { w: 'x' } }, code: 'bad_pin', message: BAD_PIN },
      { name: 'pinnedParams 1e999', raw: ['pinnedParams', '{"w":1e999}'], code: 'bad_pin', message: BAD_PIN },
      { name: 'editedBody number', patch: { editedBody: 5 }, code: 'bad_edit', message: BAD_EDIT },
      { name: 'editedBody object', patch: { editedBody: {} }, code: 'bad_edit', message: BAD_EDIT },
    ];

    it.each(REJECTED)('RT6: $name is rejected before the store', async (row) => {
      const startSpy = vi.spyOn(DbRunStore, 'start');
      try {
        const base: Record<string, unknown> = {
          threadId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          text: 'hi',
          viewingVersion: null,
          ...row.patch,
        };
        let raw: string;
        if (row.raw) {
          raw = JSON.stringify({ ...base, [row.raw[0]]: '__RAW__' }).replace('"__RAW__"', row.raw[1]);
        } else {
          raw = JSON.stringify(base);
        }
        const res = await rawChat(makeOwner(), raw);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: { code: row.code, message: row.message } });
        expect(startSpy).not.toHaveBeenCalled();
      } finally {
        startSpy.mockRestore();
      }
    });

    it('RT7: omitted viewingVersion and null optional fields are accepted', async () => {
      const res = await callChat(makeOwner(), {
        threadId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        text: 'build a box',
        attachmentIds: null,
        pinnedParams: null,
        editedBody: null,
      });
      expect(res.status).toBe(200);
      await res.text();
    });

    it('RT8: exactly four attachments are accepted', async () => {
      const db = getDb();
      const owner = makeOwner();
      const threadId = crypto.randomUUID();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(await putArtifact(owner.key, 'image', Buffer.from(`IMG-${i}`)));
      }
      const res = await callChat(owner, {
        threadId,
        clientMessageId: crypto.randomUUID(),
        text: 'four refs',
        viewingVersion: null,
        attachmentIds: ids,
      });
      expect(res.status).toBe(200);
      await res.text();
      const cnt = await db.query(
        `SELECT count(*)::int AS c FROM message_attachments ma
         JOIN messages m ON m.id = ma.message_id WHERE m.thread_id = $1`,
        [threadId]
      );
      expect(cnt.rows[0].c).toBe(4);
    });

    it('RT9: pinnedParams and editedBody are forwarded to the store', async () => {
      const db = getDb();
      const owner = makeOwner();

      // (i) sliders
      const t1 = crypto.randomUUID();
      await seedDesign(owner.key, t1, PIN_BODY);
      const res1 = await callChat(owner, {
        threadId: t1,
        clientMessageId: crypto.randomUUID(),
        text: 'slide it',
        viewingVersion: 1,
        pinnedParams: { w: 60 },
      });
      expect(res1.status).toBe(200);
      await res1.text();
      const v2a = (await db.query(`SELECT origin, body FROM designs WHERE thread_id = $1 AND version = 2`, [t1])).rows[0];
      expect(v2a.origin).toBe('user_edit');
      expect(v2a.body).toBe('w = 60  # [0:100] W\nh = 10');

      // (ii) code edit
      const t2 = crypto.randomUUID();
      await seedDesign(owner.key, t2, PIN_BODY);
      runDesignerMock.mockClear();
      const edited = 'w = 40  # [0:100] W\nh = 12';
      const res2 = await callChat(owner, {
        threadId: t2,
        clientMessageId: crypto.randomUUID(),
        text: 'edit code',
        viewingVersion: 1,
        editedBody: edited,
      });
      expect(res2.status).toBe(200);
      await res2.text();
      const v2b = (await db.query(`SELECT origin, body FROM designs WHERE thread_id = $1 AND version = 2`, [t2])).rows[0];
      expect(v2b.origin).toBe('user_edit');
      expect(v2b.body).toBe(edited);
      expect(runDesignerMock.mock.calls[0][0].priorScript).toBe(edited);
    });

    it('RT10: the model is stored on the run; a non-string model is ignored', async () => {
      const db = getDb();
      const owner = makeOwner();
      const t1 = crypto.randomUUID();
      const res1 = await callChat(owner, {
        threadId: t1,
        clientMessageId: crypto.randomUUID(),
        text: 'hi',
        viewingVersion: null,
        model: 'claude-test-model',
      });
      expect(res1.status).toBe(200);
      await res1.text();
      expect((await db.query(`SELECT model FROM runs WHERE thread_id = $1`, [t1])).rows[0].model).toBe(
        'claude-test-model'
      );

      const t2 = crypto.randomUUID();
      const res2 = await callChat(owner, {
        threadId: t2,
        clientMessageId: crypto.randomUUID(),
        text: 'hi',
        viewingVersion: null,
        model: 5,
      });
      expect(res2.status).toBe(200);
      await res2.text();
      expect((await db.query(`SELECT model FROM runs WHERE thread_id = $1`, [t2])).rows[0].model).toBeNull();
    });

    it('RT11: a non-store error from start propagates', async () => {
      const startSpy = vi
        .spyOn(DbRunStore, 'start')
        .mockRejectedValueOnce(new Error('db down'));
      try {
        await expect(
          callChat(makeOwner(), {
            threadId: crypto.randomUUID(),
            clientMessageId: crypto.randomUUID(),
            text: 'hi',
            viewingVersion: null,
          })
        ).rejects.toThrow('db down');
      } finally {
        startSpy.mockRestore();
      }
    });

    it('RT12: another owner\'s thread is a 404 with the not_found body', async () => {
      const db = getDb();
      const a = makeOwner();
      const b = makeOwner();
      const threadId = crypto.randomUUID();
      await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, a.key]);
      const res = await callChat(b, {
        threadId,
        clientMessageId: crypto.randomUUID(),
        text: 'hi',
        viewingVersion: null,
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: 'not_found', message: 'Not found.' },
      });
    });

    it('RT13: the graph gets the thread history, config, tracing handler, and is flushed', async () => {
      const db = getDb();
      const owner = makeOwner();
      const threadId = crypto.randomUUID();

      // Turn 1 completes, so the history holds an assistant reply.
      const res1 = await callChat(owner, {
        threadId,
        clientMessageId: crypto.randomUUID(),
        text: 'first message',
        viewingVersion: null,
      });
      expect(res1.status).toBe(200);
      await res1.text();

      interface Captured {
        input: { messages: BaseMessage[] };
        config: {
          configurable: unknown;
          recursionLimit: number;
          streamMode: string[];
          callbacks: unknown[];
          signal: AbortSignal;
        };
      }
      const captured: Captured[] = [];
      const realCreate = graphMod.createDesignerAgent;
      const createSpy = vi.spyOn(graphMod, 'createDesignerAgent').mockImplementation(((
        ...args: Parameters<typeof realCreate>
      ) => {
        const agent = realCreate(...args);
        const origStream = agent.stream.bind(agent) as (i: unknown, c: unknown) => unknown;
        (agent as unknown as { stream: unknown }).stream = (input: unknown, config: unknown) => {
          captured.push({ input, config } as Captured);
          return origStream(input, config);
        };
        return agent;
      }) as typeof realCreate);

      class TestHandler extends BaseCallbackHandler {
        name = 'route-test-handler';
      }
      const handler = new TestHandler();
      const forceFlush = vi.fn().mockResolvedValue(undefined);
      langfuseHandlerMock.mockClear();
      langfuseHandlerMock.mockReturnValue(handler);
      langfuseProcessorMock.mockReturnValue({ forceFlush });

      try {
        const res2 = await callChat(owner, {
          threadId,
          clientMessageId: crypto.randomUUID(),
          text: 'second message',
          viewingVersion: 1,
        });
        expect(res2.status).toBe(200);
        const runId = res2.headers.get('X-Run-Id');
        await res2.text();

        expect(captured).toHaveLength(1);
        const { input, config } = captured[0];

        const assistantContent = (
          await db.query(`SELECT content FROM messages WHERE thread_id = $1 AND role = 'assistant'`, [threadId])
        ).rows[0].content as string;
        expect(assistantContent.length).toBeGreaterThan(0);
        expect(input.messages).toHaveLength(3);
        expect(input.messages[0]).toBeInstanceOf(HumanMessage);
        expect(input.messages[0].content).toBe('first message');
        expect(input.messages[1]).toBeInstanceOf(AIMessage);
        expect(input.messages[1].content).toBe(assistantContent);
        expect(input.messages[2]).toBeInstanceOf(HumanMessage);
        expect(input.messages[2].content).toBe('second message');

        const model = coerceRouteModel(undefined);
        expect(langfuseHandlerMock).toHaveBeenCalledWith({
          sessionId: threadId,
          tags: ['cadai', model],
          metadata: { model },
        });
        expect(config.configurable).toEqual({
          ownerKey: owner.key,
          threadId,
          runId,
          deadlineAt: expect.any(Number),
        });
        expect(config.recursionLimit).toBe(graphRecursionLimit());
        expect(config.streamMode).toEqual(['updates', 'messages', 'custom', 'tasks', 'values']);
        expect(config.callbacks).toEqual([handler]);
        expect(config.signal).toBeInstanceOf(AbortSignal);
        expect(forceFlush).toHaveBeenCalledTimes(1);
      } finally {
        createSpy.mockRestore();
        langfuseHandlerMock.mockReset();
        langfuseHandlerMock.mockReturnValue(null);
        langfuseProcessorMock.mockReset();
        langfuseProcessorMock.mockReturnValue(null);
      }
    });

    it('the route accepts attachments [{id, kind}]', async () => {
      const owner = makeOwner();
      const threadId = crypto.randomUUID();
      const artId = await putArtifact(owner.key, 'image', Buffer.from('TEST-ATTACHMENT'));

      const res = await callChat(owner, {
        threadId,
        clientMessageId: crypto.randomUUID(),
        text: 'hello with attachment',
        viewingVersion: null,
        attachments: [{ id: artId, kind: 'markup' }],
      });
      expect(res.status).toBe(200);
      await res.text();
    });

    it('the route rejects a bad kind with 400', async () => {
      const owner = makeOwner();
      const threadId = crypto.randomUUID();

      const res = await callChat(owner, {
        threadId,
        clientMessageId: crypto.randomUUID(),
        text: 'bad kind',
        viewingVersion: null,
        attachments: [{ id: 'art-1', kind: 'invalid-kind' as never }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({
        error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
      });

      // Both attachmentIds and attachments -> 400
      const resBoth = await callChat(owner, {
        threadId,
        clientMessageId: crypto.randomUUID(),
        text: 'both',
        viewingVersion: null,
        attachmentIds: ['art-1'],
        attachments: [{ id: 'art-2', kind: 'reference' }],
      });
      expect(resBoth.status).toBe(400);
      expect(await resBoth.json()).toEqual({
        error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
      });
    });
  });
});
