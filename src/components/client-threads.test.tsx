import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '@/store/app-store';
import { __resetDbForTests, upsertThread, loadAllThreads } from '@/lib/storage/thread-storage';
import { DB_NAME } from '@/lib/storage/db-schema';
import { DEADLINE, LEGACY, STALE_CLIENT, STOPPED } from '@/lib/persist/phrases';
import { ChatPanel } from './chat/chat-panel';
import type { StreamEvent } from '@/lib/agent/stream-events';

const VALID_ASCII_STL = `solid box
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 40 0 0
      vertex 40 60 0
    endloop
  endfacet
endsolid box`;

const origUseSyncExternalStore = React.useSyncExternalStore;

function createSseStream(events: StreamEvent[], options?: { delayFirstEventMs?: number }): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      if (options?.delayFirstEventMs) {
        await new Promise((r) => setTimeout(r, options.delayFirstEventMs));
      }
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

describe('client threads and reconnect', () => {
  beforeEach(async () => {
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    await __resetDbForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });

    useAppStore.setState({
      threads: [],
      activeThreadId: '',
      messages: [],
      code: '',
      params: [],
      geometry: null,
      stlContent: null,
      modelInfo: null,
      compileStatus: 'idle',
      compileError: null,
      isGenerating: false,
      generatingThreadId: null,
      editorView: 'design',
    });
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    vi.unstubAllGlobals();
  });

  it('cold reload mid-build resumes', async () => {
    const threadId = crypto.randomUUID();
    const fetchedUrls: string[] = [];

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);

      if (url === '/api/threads') {
        return new Response(
          JSON.stringify({
            threads: [{ id: threadId, title: 'Mid-build Gear', updatedAt: 1000, activeRunId: 'r1' }],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/threads/${threadId}`) {
        // First getThread call mid-build returns activeRun
        if (!fetchedUrls.includes(`/api/runs/r1/events?after=0`)) {
          return new Response(
            JSON.stringify({
              id: threadId,
              title: 'Mid-build Gear',
              activeRun: { id: 'r1', status: 'running', lastSeq: 0 },
              messages: [
                { id: 'm1', seq: 1, role: 'user', kind: 'request', markdown: 'Make a gear', attachments: [] },
              ],
              versions: [],
            }),
            { status: 200 }
          );
        }
        // Subsequent getThread call after end returns the committed design
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Mid-build Gear',
            activeRun: null,
            messages: [
              { id: 'm1', seq: 1, role: 'user', kind: 'request', markdown: 'Make a gear', attachments: [] },
              { id: 'm2', seq: 2, role: 'assistant', kind: 'result', markdown: 'Here is your gear.', designVersion: 1, attachments: [] },
            ],
            versions: [
              {
                version: 1,
                parentVersion: null,
                origin: 'designer',
                summary: 'Gear',
                flags: [],
                body: 'gear = Cylinder(10, 5)',
                preludeVersion: '1',
                stl: 'stl-gear',
                step: null,
                createdAt: 1000,
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/runs/r1/events?after=0') {
        const stream = createSseStream([
          { t: 'section', id: 'designerNode', label: 'designerNode', state: 'open' },
          { t: 'delta', text: 'Modeling gear...' },
          { t: 'section', id: 'designerNode', state: 'close', status: 'ok' },
          {
            t: 'end',
            seq: 2,
            status: 'done',
            reply: {
              messageId: 'm2',
              kind: 'result',
              markdown: 'Here is your gear.',
            },
            designVersion: 1,
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      if (url === '/api/artifacts/stl-gear') {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    // Initialize store
    await useAppStore.getState().initializeFromStorage();

    // Give asynchronous stream consumption time to complete
    const deadline = Date.now() + 5000;
    while (useAppStore.getState().isGenerating) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for run to complete');
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify events tail was called
    expect(fetchedUrls).toContain('/api/runs/r1/events?after=0');

    // Verify rendered reply and code
    const state = useAppStore.getState();
    const assistantMsg = state.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Here is your gear.');
    expect(state.code).toBe('gear = Cylinder(10, 5)');
    expect(state.stlContent).toBe(VALID_ASCII_STL);

    const markup = renderToStaticMarkup(<ChatPanel />);
    expect(markup).toContain('Here is your gear.');
  });

  it('reload after done', async () => {
    const threadId = crypto.randomUUID();
    const fetchedUrls: string[] = [];

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);

      if (url === '/api/threads') {
        return new Response(
          JSON.stringify({
            threads: [{ id: threadId, title: 'Done Cylinder', updatedAt: 2000, activeRunId: null }],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Done Cylinder',
            activeRun: null,
            messages: [
              { id: 'm1', seq: 1, role: 'user', kind: 'request', markdown: 'Make a cylinder', attachments: [] },
              { id: 'm2', seq: 2, role: 'assistant', kind: 'result', markdown: 'Here is your cylinder.', designVersion: 1, attachments: [] },
            ],
            versions: [
              {
                version: 1,
                parentVersion: null,
                origin: 'designer',
                summary: 'Cylinder',
                flags: [],
                body: 'cylinder = Cylinder(5, 10)',
                preludeVersion: '1',
                stl: 'S1',
                step: null,
                createdAt: 2000,
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/artifacts/S1') {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    await useAppStore.getState().initializeFromStorage();

    // Verify messages and artifact
    const state = useAppStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].content).toBe('Make a cylinder');
    expect(state.messages[1].content).toBe('Here is your cylinder.');
    expect(state.code).toBe('cylinder = Cylinder(5, 10)');
    expect(state.stlContent).toBe(VALID_ASCII_STL);
    expect(state.geometry).toBeDefined();

    // Verify no events request was made
    const eventsCalls = fetchedUrls.filter((u) => u.includes('/events'));
    expect(eventsCalls).toHaveLength(0);

    const markup = renderToStaticMarkup(<ChatPanel />);
    expect(markup).toContain('Make a cylinder');
    expect(markup).toContain('Here is your cylinder.');
  });

  it('the open tab shows the committed version after end', async () => {
    const threadId = crypto.randomUUID();
    let threadGetCount = 0;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/threads') {
        return new Response(JSON.stringify({ threads: [{ id: threadId, title: 'Design', updatedAt: 1000, activeRunId: null }] }), { status: 200 });
      }

      if (url === `/api/threads/${threadId}`) {
        threadGetCount++;
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Design',
            activeRun: null,
            messages: [
              { id: 'm1', seq: 1, role: 'user', kind: 'request', markdown: 'Make version 2', attachments: [] },
              { id: 'm2', seq: 2, role: 'assistant', kind: 'result', markdown: 'Committed version 2', designVersion: 2, attachments: [] },
            ],
            versions: [
              {
                version: 1,
                parentVersion: null,
                origin: 'designer',
                summary: 'v1',
                flags: [],
                body: 'box = Box(10, 10, 10)',
                preludeVersion: '1',
                stl: 'stl-1',
                step: null,
                createdAt: 1000,
              },
              {
                version: 2,
                parentVersion: 1,
                origin: 'designer',
                summary: 'v2',
                flags: [],
                body: 'box = Box(20, 20, 20)',
                preludeVersion: '1',
                stl: 'stl-2',
                step: null,
                createdAt: 2000,
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            reply: {
              messageId: 'm2',
              kind: 'result',
              markdown: 'Committed version 2',
            },
            designVersion: 2,
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'X-Run-Id': 'r2',
          },
        });
      }

      if (url === '/api/artifacts/stl-2') {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    await useAppStore.getState().initializeFromStorage();
    expect(threadGetCount).toBe(1);

    // Send chat message
    await useAppStore.getState().sendMessage('Make version 2');

    // Wait until generation finishes
    const deadline = Date.now() + 5000;
    while (useAppStore.getState().isGenerating) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for run to complete');
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify thread was re-fetched and version 2 is displayed
    expect(threadGetCount).toBeGreaterThanOrEqual(2);
    const state = useAppStore.getState();
    expect(state.code).toBe('box = Box(20, 20, 20)');
    expect(state.stlContent).toBe(VALID_ASCII_STL);
  });

  it('a tail closed without end reloads the thread', async () => {
    const threadId = crypto.randomUUID();
    let threadGetCount = 0;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/threads') {
        return new Response(JSON.stringify({ threads: [{ id: threadId, title: 'Tail Test', updatedAt: 1000, activeRunId: 'r4' }] }), { status: 200 });
      }

      if (url === `/api/threads/${threadId}`) {
        threadGetCount++;
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Tail Test',
            activeRun: threadGetCount === 1 ? { id: 'r4', status: 'running', lastSeq: 0 } : null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/runs/r4/events?after=0') {
        // Stream closes immediately without an end event
        const stream = createSseStream([
          { t: 'delta', text: 'Processing...' },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    await useAppStore.getState().initializeFromStorage();

    // Give time to finish tail and re-fetch
    const deadline = Date.now() + 5000;
    while (useAppStore.getState().isGenerating) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for tail close handling');
      await new Promise((r) => setTimeout(r, 20));
    }

    // GET /api/threads/:id was called a second time
    expect(threadGetCount).toBe(2);
  });

  it('Stop before the first event', async () => {
    const threadId = crypto.randomUUID();
    let cancelCalled = false;

    // Stream that blocks until cancel is called
    let resumeStream: () => void = () => {};
    const streamPromise = new Promise<void>((r) => {
      resumeStream = r;
    });

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        // Wait until Stop is pressed
        await streamPromise;
        const endEvent: StreamEvent = {
          t: 'end',
          seq: 1,
          status: 'cancelled',
          reply: {
            messageId: 'm-stopped',
            kind: 'cancelled',
            markdown: STOPPED,
          },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(endEvent)}\n\n`));
        controller.close();
      },
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/threads') {
        return new Response(JSON.stringify({ threads: [{ id: threadId, title: 'Stop Test', updatedAt: 1000, activeRunId: null }] }), { status: 200 });
      }

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Stop Test',
            activeRun: null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'X-Run-Id': 'r9',
          },
        });
      }

      if (url === '/api/runs/r9/cancel' && init?.method === 'POST') {
        cancelCalled = true;
        resumeStream();
        return new Response(JSON.stringify({ status: 'running' }), { status: 202 });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    await useAppStore.getState().initializeFromStorage();

    // Send chat (asynchronous in background)
    void useAppStore.getState().sendMessage('Please stop this');

    // Wait until inFlightRunId is set to 'r9'
    const deadline1 = Date.now() + 3000;
    while (useAppStore.getState().inFlightRunId !== 'r9') {
      if (Date.now() > deadline1) throw new Error('Timed out waiting for run to start');
      await new Promise((r) => setTimeout(r, 10));
    }

    // Assert Stop button is available in UI
    const markupDuringRun = renderToStaticMarkup(<ChatPanel />);
    expect(markupDuringRun).toMatch(/Stop/);

    // Press Stop
    await useAppStore.getState().stopCurrentRun();
    expect(cancelCalled).toBe(true);

    // Wait until stream finishes
    const deadline2 = Date.now() + 5000;
    while (useAppStore.getState().isGenerating) {
      if (Date.now() > deadline2) throw new Error('Timed out waiting for stopped run to end');
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify assistant rendered STOPPED reply
    const state = useAppStore.getState();
    const assistantMsg = state.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe(STOPPED);

    const markupAfterStop = renderToStaticMarkup(<ChatPanel />);
    expect(markupAfterStop).toContain(STOPPED);
  });

  it('409 attaches to the active run', async () => {
    const threadId = crypto.randomUUID();
    const fetchedUrls: string[] = [];

    // Case 1: 409 run_active + activeRunId:'r2'
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);

      if (url === '/api/threads') {
        return new Response(JSON.stringify({ threads: [{ id: threadId, title: '409 Test', updatedAt: 1000, activeRunId: null }] }), { status: 200 });
      }

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: '409 Test',
            activeRun: null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        return new Response(
          JSON.stringify({
            error: { code: 'run_active', message: 'A design is still being built in this thread.' },
            activeRunId: 'r2',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url === '/api/runs/r2/events?after=0') {
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            reply: {
              messageId: 'm-att-1',
              kind: 'result',
              markdown: 'Attached to r2',
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    await useAppStore.getState().initializeFromStorage();
    await useAppStore.getState().sendMessage('Message 1');

    while (useAppStore.getState().isGenerating) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(fetchedUrls).toContain('/api/runs/r2/events?after=0');
    let state = useAppStore.getState();
    let assistantMsg = state.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Attached to r2');

    // Case 2: 409 duplicate_message + runId:'r3'
    fetchedUrls.length = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: '409 Test',
            activeRun: null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        return new Response(
          JSON.stringify({
            error: { code: 'duplicate_message' },
            runId: 'r3',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url === '/api/runs/r3/events?after=0') {
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            reply: {
              messageId: 'm-att-2',
              kind: 'result',
              markdown: 'Attached to r3',
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    await useAppStore.getState().sendMessage('Message 2 duplicate');

    while (useAppStore.getState().isGenerating) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(fetchedUrls).toContain('/api/runs/r3/events?after=0');
    state = useAppStore.getState();
    assistantMsg = state.messages.find((m) => m.content === 'Attached to r3');
    expect(assistantMsg).toBeDefined();

    // No error message shown in either case
    const errorMessages = state.messages.filter((m) => m.status === 'error');
    expect(errorMessages).toHaveLength(0);
  });

  it('legacy banner', async () => {
    const legacyThreadId = 'thread-abc';
    await upsertThread({
      id: legacyThreadId,
      title: 'Old Thread',
      createdAt: 1000,
      updatedAt: 1000,
      code: 'cube(10);',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'Hello legacy',
          timestamp: 1000,
        },
      ],
    });

    let chatCalled = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/threads') {
        // Server has no threads
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      if (url === '/api/chat') {
        chatCalled = true;
        return new Response('{}', { status: 200 });
      }
      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    await useAppStore.getState().initializeFromStorage();

    const state = useAppStore.getState();
    expect(state.activeThreadId).toBe(legacyThreadId);

    // Verify banner and disabled input in UI
    const markup = renderToStaticMarkup(<ChatPanel />);
    expect(markup).toContain(LEGACY);
    expect(markup).toContain('disabled');

    // Attempting to send never calls /api/chat
    await useAppStore.getState().sendMessage('Try sending in legacy');
    expect(chatCalled).toBe(false);
  });

  it('a thread GET 404 after end removes the thread', async () => {
    const threadId = crypto.randomUUID();

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/threads') {
        return new Response(JSON.stringify({ threads: [{ id: threadId, title: 'To Delete', updatedAt: 1000, activeRunId: null }] }), { status: 200 });
      }

      if (url === `/api/threads/${threadId}`) {
        // Thread deleted on server right after end
        return new Response('Not Found', { status: 404 });
      }

      if (url === '/api/chat') {
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            reply: {
              messageId: 'm-del',
              kind: 'result',
              markdown: 'Done right before deletion',
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'X-Run-Id': 'r-del',
          },
        });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    // Manually add thread to store
    useAppStore.setState({
      threads: [
        {
          id: threadId,
          title: 'To Delete',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
        },
      ],
      activeThreadId: threadId,
    });

    // Send chat
    await useAppStore.getState().sendMessage('Delete me soon');

    // Wait for end handling
    const deadline = Date.now() + 5000;
    while (useAppStore.getState().isGenerating) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for run to complete');
      await new Promise((r) => setTimeout(r, 20));
    }

    // Thread is gone from the list
    const state = useAppStore.getState();
    expect(state.threads.find((t) => t.id === threadId)).toBeUndefined();
  });

  it('New does not add a thread until the first send', async () => {
    let getThreadCalled = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/threads/')) {
        getThreadCalled = true;
      }
      return new Response('Not Found', { status: 404 });
    });

    const initialThreads = useAppStore.getState().threads;
    const initialThreadCount = initialThreads.length;

    const draftId = useAppStore.getState().createNewThread();

    // threads in store is unchanged
    expect(useAppStore.getState().threads.length).toBe(initialThreadCount);
    expect(useAppStore.getState().threads.some((t) => t.id === draftId)).toBe(false);
    expect(useAppStore.getState().activeThreadId).toBe(draftId);

    // IndexedDB has no new thread row
    const persisted = await loadAllThreads();
    expect(persisted.threads.some((t) => t.id === draftId)).toBe(false);

    // GET /api/threads/:id is never called for the draft
    expect(getThreadCalled).toBe(false);
  });

  it('the first send adds the thread to the list', async () => {
    const draftId = useAppStore.getState().createNewThread();
    let threadReloaded = false;
    // The thread must be listed as soon as the send streams, before the reload after end adds it.
    let listedBeforeReload = false;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/chat') {
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            reply: {
              messageId: 'm-first',
              kind: 'result',
              markdown: 'Done building gear!',
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'X-Run-Id': 'r-first',
          },
        });
      }

      if (url === `/api/threads/${draftId}`) {
        threadReloaded = true;
        listedBeforeReload = useAppStore.getState().threads.some((t) => t.id === draftId);
        return new Response(
          JSON.stringify({
            id: draftId,
            title: 'Design a 20-tooth GT2 pulley',
            activeRun: null,
            messages: [
              {
                id: 'm-first',
                seq: 1,
                role: 'assistant',
                kind: 'result',
                markdown: 'Done building gear!',
              },
            ],
            versions: [],
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    await useAppStore
      .getState()
      .sendMessage('Design a 20-tooth GT2 pulley\nwith 5mm center bore');

    // Wait for stream to finish
    const deadline = Date.now() + 5000;
    while (useAppStore.getState().isGenerating) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for run to complete');
      await new Promise((r) => setTimeout(r, 20));
    }

    // Thread is now in threads with the message's first line as its title
    const thread = useAppStore.getState().threads.find((t) => t.id === draftId);
    expect(thread).toBeDefined();
    expect(thread?.title).toBe('Design a 20-tooth GT2 pulley');
    expect(threadReloaded).toBe(true);
    expect(listedBeforeReload).toBe(true);
  });

  it('a send that fails leaves a draft', async () => {
    const draftId = useAppStore.getState().createNewThread();
    const countBefore = useAppStore.getState().threads.length;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/chat') {
        return new Response(
          JSON.stringify({
            error: {
              code: 'stale_client',
              message: STALE_CLIENT,
            },
          }),
          { status: 400 }
        );
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    await useAppStore.getState().sendMessage('Invalid chat request');

    // threads is unchanged
    expect(useAppStore.getState().threads.length).toBe(countBefore);
    expect(useAppStore.getState().threads.some((t) => t.id === draftId)).toBe(false);

    // Active thread is still the draft
    expect(useAppStore.getState().activeThreadId).toBe(draftId);

    // Error is shown in messages
    const msgs = useAppStore.getState().messages;
    const errorMsg = msgs.find((m) => m.status === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg?.content).toContain(STALE_CLIENT);
  });

  it('a failed end reloads the thread', async () => {
    const threadId = crypto.randomUUID();
    let threadReloaded = false;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/threads') {
        return new Response(JSON.stringify({ threads: [{ id: threadId, title: 'Failed Run', updatedAt: 1000, activeRunId: null }] }), { status: 200 });
      }

      if (url === `/api/threads/${threadId}`) {
        threadReloaded = true;
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Failed Run',
            activeRun: null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'failed',
            reply: {
              messageId: 'm-fail',
              kind: 'error',
              markdown: DEADLINE,
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'X-Run-Id': 'r-fail',
          },
        });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    useAppStore.setState({
      threads: [
        {
          id: threadId,
          title: 'Failed Run',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
        },
      ],
      activeThreadId: threadId,
    });

    await useAppStore.getState().sendMessage('Cause a deadline failure');

    const deadline = Date.now() + 5000;
    while (useAppStore.getState().isGenerating) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for run to complete');
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(threadReloaded).toBe(true);
    expect(useAppStore.getState().isGenerating).toBe(false);
  });
});
