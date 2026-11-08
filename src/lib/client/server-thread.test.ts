import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildChatRequest,
  sendChat,
  listThreads,
  getThread,
  renameThread,
  deleteThread,
  uploadAttachment,
  tailRun,
  stopRun,
  fetchArtifactText,
  isServerThreadId,
  getLatestViewingVersion,
} from './server-thread';
import { RUN_ACTIVE, STALE_CLIENT } from '@/lib/persist/phrases';

describe('server-thread', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('every send is a ChatRequest with a UUID clientMessageId', async () => {
    const threadId = crypto.randomUUID();

    // 1. Thread with no design -> viewingVersion is null
    const reqNoDesign = buildChatRequest({
      threadId,
      text: 'Create a box',
      viewingVersion: getLatestViewingVersion([]),
    });

    expect(Object.keys(reqNoDesign).sort()).toEqual(
      ['clientMessageId', 'text', 'threadId', 'viewingVersion'].sort()
    );
    expect(reqNoDesign.threadId).toBe(threadId);
    expect(isServerThreadId(reqNoDesign.clientMessageId)).toBe(true);
    expect(reqNoDesign.text).toBe('Create a box');
    expect(reqNoDesign.viewingVersion).toBeNull();
    expect(reqNoDesign).not.toHaveProperty('pinnedParams');
    expect(reqNoDesign).not.toHaveProperty('editedBody');

    // 2. Thread with design versions -> viewingVersion is latest version number
    const versions = [
      { version: 1 },
      { version: 3 },
      { version: 2 },
    ];
    const reqWithDesign = buildChatRequest({
      threadId,
      text: 'Make it wider',
      viewingVersion: getLatestViewingVersion(versions),
      attachmentIds: ['art-1'],
      model: 'claude-sonnet-5.5',
    });

    expect(Object.keys(reqWithDesign).sort()).toEqual(
      ['attachmentIds', 'clientMessageId', 'model', 'text', 'threadId', 'viewingVersion'].sort()
    );
    expect(reqWithDesign.viewingVersion).toBe(3);
    expect(reqWithDesign.attachmentIds).toEqual(['art-1']);
    expect(reqWithDesign.model).toBe('claude-sonnet-5.5');
    expect(isServerThreadId(reqWithDesign.clientMessageId)).toBe(true);
    expect(reqWithDesign).not.toHaveProperty('pinnedParams');
    expect(reqWithDesign).not.toHaveProperty('editedBody');

    // 3. Verify sent over wire matches exactly
    let capturedBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response('', {
        status: 200,
        headers: { 'X-Run-Id': 'run-123' },
      });
    });

    const sendRes = await sendChat(reqWithDesign);
    expect(sendRes.kind).toBe('stream');
    if (sendRes.kind === 'stream') {
      expect(sendRes.runId).toBe('run-123');
    }
    expect(capturedBody).not.toBeNull();
    expect(Object.keys(capturedBody!).sort()).toEqual(
      ['attachmentIds', 'clientMessageId', 'model', 'text', 'threadId', 'viewingVersion'].sort()
    );
    expect(capturedBody!.viewingVersion).toBe(3);
    expect(isServerThreadId(capturedBody!.clientMessageId as string)).toBe(true);
  });

  it('sendChat maps 409 run_active and duplicate_message to attach', async () => {
    const threadId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();

    // Case 1: 409 run_active with activeRunId: 'r2'
    vi.stubGlobal('fetch', async () => {
      return new Response(
        JSON.stringify({
          error: { code: 'run_active', message: RUN_ACTIVE },
          activeRunId: 'r2',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const resRunActive = await sendChat({
      threadId,
      clientMessageId,
      text: 'Test message',
      viewingVersion: null,
    });

    expect(resRunActive).toEqual({
      kind: 'attach',
      runId: 'r2',
    });

    // Case 2: 409 duplicate_message with runId: 'r3'
    vi.stubGlobal('fetch', async () => {
      return new Response(
        JSON.stringify({
          error: { code: 'duplicate_message' },
          runId: 'r3',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const resDuplicate = await sendChat({
      threadId,
      clientMessageId,
      text: 'Test message duplicate',
      viewingVersion: null,
    });

    expect(resDuplicate).toEqual({
      kind: 'attach',
      runId: 'r3',
    });

    // Error case: server error with fixed phrase message
    vi.stubGlobal('fetch', async () => {
      return new Response(
        JSON.stringify({
          error: { code: 'bad_request', message: 'Specific server error' },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const resError = await sendChat({
      threadId,
      clientMessageId,
      text: 'Broken message',
      viewingVersion: null,
    });

    expect(resError).toEqual({
      kind: 'error',
      message: 'Specific server error',
    });

    // Fallback when error.message is not present
    vi.stubGlobal('fetch', async () => {
      return new Response('internal error', { status: 500 });
    });

    const resFallback = await sendChat({
      threadId,
      clientMessageId,
      text: 'Crash message',
      viewingVersion: null,
    });

    expect(resFallback).toEqual({
      kind: 'error',
      message: STALE_CLIENT,
    });
  });

  it('validates UUIDs correctly with isServerThreadId', () => {
    expect(isServerThreadId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isServerThreadId(crypto.randomUUID())).toBe(true);
    expect(isServerThreadId('thread-abc')).toBe(false);
    expect(isServerThreadId('thread-1731111111111')).toBe(false);
    expect(isServerThreadId('')).toBe(false);
  });

  it('listThreads, getThread, renameThread, deleteThread call endpoints correctly', async () => {
    const threadId = crypto.randomUUID();

    let calledUrl = '';
    let calledMethod = '';
    let calledBody: Record<string, unknown> | null = null;

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledMethod = init?.method ?? 'GET';
      calledBody = init?.body ? JSON.parse(init.body as string) : null;

      if (url === '/api/threads') {
        return new Response(JSON.stringify({ threads: [{ id: threadId, title: 'Test', updatedAt: 1000, activeRunId: null }] }), { status: 200 });
      }
      if (url === `/api/threads/${threadId}`) {
        return new Response(JSON.stringify({ id: threadId, title: 'Test', activeRun: null, messages: [], versions: [] }), { status: 200 });
      }
      if (url === '/api/threads/missing') {
        return new Response('Not Found', { status: 404 });
      }
      if (url.startsWith('/api/threads/') && init?.method === 'PATCH') {
        return new Response(null, { status: 204 });
      }
      if (url.startsWith('/api/threads/') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response('ok', { status: 200 });
    });

    const list = await listThreads();
    expect(calledUrl).toBe('/api/threads');
    expect(list).toEqual([{ id: threadId, title: 'Test', updatedAt: 1000, activeRunId: null }]);

    const thread = await getThread(threadId);
    expect(calledUrl).toBe(`/api/threads/${threadId}`);
    expect(thread?.id).toBe(threadId);

    const missing = await getThread('missing');
    expect(missing).toBeNull();

    const renamed = await renameThread(threadId, 'New Title');
    expect(renamed).toBe(true);
    expect(calledMethod).toBe('PATCH');
    expect(calledBody).toEqual({ title: 'New Title' });

    const deleted = await deleteThread(threadId);
    expect(deleted).toBe(true);
    expect(calledMethod).toBe('DELETE');
  });

  it('tailRun, stopRun, and fetchArtifactText call endpoints correctly', async () => {
    let calledUrl = '';
    let calledMethod = '';

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledMethod = init?.method ?? 'GET';
      if (url === '/api/artifacts/art-123') {
        return new Response('solid test\nendsolid', { status: 200 });
      }
      return new Response('ok', { status: 200 });
    });

    await tailRun('run-99', 5);
    expect(calledUrl).toBe('/api/runs/run-99/events?after=5');
    expect(calledMethod).toBe('GET');

    await stopRun('run-99');
    expect(calledUrl).toBe('/api/runs/run-99/cancel');
    expect(calledMethod).toBe('POST');

    const stl = await fetchArtifactText('art-123');
    expect(stl).toBe('solid test\nendsolid');
  });

  it('uploadAttachment posts formData and returns artifactId', async () => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/attachments');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ artifactId: 'art-uploaded-1' }), { status: 200 });
    });

    const blob = new Blob(['fake image bytes'], { type: 'image/png' });
    const id = await uploadAttachment(blob);
    expect(id).toBe('art-uploaded-1');
  });
});
