import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '@/store/app-store';
import { __resetDbForTests, upsertThread, loadAllThreads, getDraft } from '@/lib/storage/thread-storage';
import { DB_NAME } from '@/lib/storage/db-schema';
import { ChatPanel } from './chat/chat-panel';
import { CodeEditorPanel, PRELUDE_NOTE, compileEditorCode } from './editor/code-editor-panel';
import { downloadStep } from './viewport/viewport-toolbar';
import { applyParamMove } from './design/design-panel';
import * as stlExporter from '@/lib/export/stl-exporter';
import { PRELUDE_SENTINEL, withGeneratedPrelude } from '@/lib/brep/prelude';
import type { StreamEvent } from '@/lib/agent/stream-events';
import type { ServerThreadVersion } from '@/lib/client/server-thread';

const origUseSyncExternalStore = React.useSyncExternalStore;

const VALID_ASCII_STL = `solid box
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 40 0 0
      vertex 40 60 0
    endloop
  endfacet
endsolid box`;

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

describe('client versions, sliders and editor', () => {
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
      step: null,
      compileStatus: 'idle',
      compileError: null,
      isGenerating: false,
      generatingThreadId: null,
      inFlightRunId: null,
      viewingVersion: null,
      editorView: 'design',
    });
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    vi.unstubAllGlobals();
  });

  it('v2 selected → edit v2', async () => {
    const threadId = crypto.randomUUID();
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'v1 summary',
        flags: [],
        body: 'width = 10\nbox = Box(width, 10, 10)',
        preludeVersion: '1',
        stl: 'stl-1',
        step: 'step-1',
        createdAt: 1000,
      },
      {
        version: 2,
        parentVersion: 1,
        origin: 'designer',
        summary: 'v2 summary',
        flags: [],
        body: 'width = 20\nbox = Box(width, 10, 10)',
        preludeVersion: '1',
        stl: 'stl-2',
        step: 'step-2',
        createdAt: 2000,
      },
      {
        version: 3,
        parentVersion: 2,
        origin: 'designer',
        summary: 'v3 summary',
        flags: [],
        body: 'width = 30\nbox = Box(width, 10, 10)',
        preludeVersion: '1',
        stl: 'stl-3',
        step: 'step-3',
        createdAt: 3000,
      },
    ];

    let chatRequestBody: Record<string, unknown> | null = null;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Versioned Design',
            activeRun: null,
            messages: [],
            versions,
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/artifacts/')) {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      if (url === '/api/chat') {
        chatRequestBody = JSON.parse(init?.body as string);
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            designVersion: 4,
            reply: {
              messageId: 'm-reply',
              kind: 'result',
              markdown: 'Updated design to v4',
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'X-Run-Id': 'r-new', 'Content-Type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Versioned Design',
          createdAt: 1000,
          updatedAt: 3000,
          code: '',
          messages: [],
          versions,
        },
      ],
    });

    // Load thread (default picks latest: 3)
    await useAppStore.getState().loadServerThread(threadId);
    expect(useAppStore.getState().viewingVersion).toBe(3);
    expect(useAppStore.getState().code).toBe(versions[2].body);

    // Select version 2
    await useAppStore.getState().selectVersion(2);
    expect(useAppStore.getState().viewingVersion).toBe(2);
    expect(useAppStore.getState().code).toBe(versions[1].body);

    // Send a message
    await useAppStore.getState().sendMessage('make it wider');
    expect(chatRequestBody).toBeTruthy();
    expect((chatRequestBody as Record<string, unknown> | null)?.viewingVersion).toBe(2);
  });

  it('slider move then edit sends pins once', async () => {
    const threadId = crypto.randomUUID();
    const v1Body = 'width = 40  # [20:80] Box Width\nbox = Box(width, 10, 10)';
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'v1 box',
        flags: [],
        body: v1Body,
        preludeVersion: '1',
        stl: 'stl-1',
        step: 'step-1',
        createdAt: 1000,
      },
    ];

    const chatRequests: Array<Record<string, unknown>> = [];

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Parametric Box',
            activeRun: null,
            messages: [],
            versions,
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/artifacts/')) {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      if (url === '/api/compile') {
        return new Response(
          JSON.stringify({
            success: true,
            stl: VALID_ASCII_STL,
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        const reqBody = JSON.parse(init?.body as string);
        chatRequests.push(reqBody);

        if (chatRequests.length === 1) {
          // First send finishes and creates v2
          versions.push({
            version: 2,
            parentVersion: 1,
            origin: 'designer',
            summary: 'v2 box with width 55',
            flags: [],
            body: 'width = 55  # [20:80] Box Width\nbox = Box(width, 10, 10)',
            preludeVersion: '1',
            stl: 'stl-2',
            step: 'step-2',
            createdAt: 2000,
          });

          const stream = createSseStream([
            {
              t: 'end',
              seq: 1,
              status: 'done',
              designVersion: 2,
              reply: {
                messageId: 'm-v2',
                kind: 'result',
                markdown: 'Created v2 with width 55',
              },
            },
          ]);
          return new Response(stream, {
            status: 200,
            headers: { 'X-Run-Id': 'r-1', 'Content-Type': 'text/event-stream' },
          });
        } else {
          // Second send
          const stream = createSseStream([
            {
              t: 'end',
              seq: 2,
              status: 'done',
              reply: {
                messageId: 'm-v2-answer',
                kind: 'answer',
                markdown: 'Answer without design change',
              },
            },
          ]);
          return new Response(stream, {
            status: 200,
            headers: { 'X-Run-Id': 'r-2', 'Content-Type': 'text/event-stream' },
          });
        }
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Parametric Box',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
          versions,
        },
      ],
    });

    await useAppStore.getState().loadServerThread(threadId);
    expect(useAppStore.getState().viewingVersion).toBe(1);

    // Move slider width to 55 via the panel's handler
    applyParamMove('width', 55);

    // First send
    await useAppStore.getState().sendMessage('make it 55');
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0].pinnedParams).toEqual({ width: 55 });
    expect(chatRequests[0].editedBody).toBeUndefined();

    // After run ends with designVersion 2, viewingVersion should be 2
    expect(useAppStore.getState().viewingVersion).toBe(2);

    // Second send
    await useAppStore.getState().sendMessage('next question');
    expect(chatRequests).toHaveLength(2);
    expect(chatRequests[1].pinnedParams).toBeUndefined();
    expect(chatRequests[1].editedBody).toBeUndefined();
  });

  it('editor change then edit sends editedBody', async () => {
    const threadId = crypto.randomUUID();
    const v1Body = 'box = Box(10, 10, 10)';
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'v1 cube',
        flags: [],
        body: v1Body,
        preludeVersion: '1',
        stl: 'stl-1',
        step: 'step-1',
        createdAt: 1000,
      },
    ];

    const chatRequests: Array<Record<string, unknown>> = [];

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Cube',
            activeRun: null,
            messages: [],
            versions,
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/artifacts/')) {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      if (url === '/api/chat') {
        const reqBody = JSON.parse(init?.body as string);
        chatRequests.push(reqBody);

        if (chatRequests.length === 1) {
          versions.push({
            version: 2,
            parentVersion: 1,
            origin: 'designer',
            summary: 'v2 modified cube',
            flags: [],
            body: 'box = Box(15, 15, 15)',
            preludeVersion: '1',
            stl: 'stl-2',
            step: 'step-2',
            createdAt: 2000,
          });

          const stream = createSseStream([
            {
              t: 'end',
              seq: 1,
              status: 'done',
              designVersion: 2,
              reply: {
                messageId: 'm-v2',
                kind: 'result',
                markdown: 'Created v2',
              },
            },
          ]);
          return new Response(stream, {
            status: 200,
            headers: { 'X-Run-Id': 'r-1', 'Content-Type': 'text/event-stream' },
          });
        } else {
          const stream = createSseStream([
            {
              t: 'end',
              seq: 2,
              status: 'done',
              reply: {
                messageId: 'm-v2-answer',
                kind: 'answer',
                markdown: 'Answer without changes',
              },
            },
          ]);
          return new Response(stream, {
            status: 200,
            headers: { 'X-Run-Id': 'r-2', 'Content-Type': 'text/event-stream' },
          });
        }
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Cube',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
          versions,
        },
      ],
    });

    await useAppStore.getState().loadServerThread(threadId);

    // Edit code in editor
    const edited = 'box = Box(12, 12, 12)';
    useAppStore.getState().setCode(edited, undefined, 'user');

    // First send sends editedBody
    await useAppStore.getState().sendMessage('save this change');
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0].editedBody).toBe(edited);
    expect(chatRequests[0].pinnedParams).toBeUndefined();

    // Second send with no edit has neither key
    await useAppStore.getState().sendMessage('no edit now');
    expect(chatRequests).toHaveLength(2);
    expect(chatRequests[1].editedBody).toBeUndefined();
    expect(chatRequests[1].pinnedParams).toBeUndefined();
  });

  it('edits on a thread without a design are not sent', async () => {
    const threadId = crypto.randomUUID();
    let chatRequestBody: Record<string, unknown> | null = null;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Empty Design Thread',
            activeRun: null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        chatRequestBody = JSON.parse(init?.body as string);
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            reply: {
              messageId: 'm-resp',
              kind: 'answer',
              markdown: 'Response to first prompt',
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'X-Run-Id': 'r-1', 'Content-Type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Empty Design Thread',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
          versions: [],
        },
      ],
      viewingVersion: null,
    });

    // Edit the code on this new thread without a design
    useAppStore.getState().setCode('box = Box(10, 10, 10)', undefined, 'user');

    // Send a message
    await useAppStore.getState().sendMessage('make something');

    expect(chatRequestBody).toBeTruthy();
    expect((chatRequestBody as Record<string, unknown> | null)?.editedBody).toBeUndefined();
    expect((chatRequestBody as Record<string, unknown> | null)?.pinnedParams).toBeUndefined();
  });

  it('an agent result is never re-pinned', async () => {
    const threadId = crypto.randomUUID();
    const v1Body = 'width = 40  # [20:80] width\nbox = Box(width, 10, 10)';
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'v1 box',
        flags: [],
        body: v1Body,
        preludeVersion: '1',
        stl: 'stl-1',
        step: 'step-1',
        createdAt: 1000,
      },
    ];

    const chatRequests: Array<Record<string, unknown>> = [];

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Parametric Box',
            activeRun: null,
            messages: [],
            versions,
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/artifacts/')) {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      if (url === '/api/compile') {
        return new Response(
          JSON.stringify({
            success: true,
            stl: VALID_ASCII_STL,
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        const reqBody = JSON.parse(init?.body as string);
        chatRequests.push(reqBody);

        versions.push({
          version: 2,
          parentVersion: 1,
          origin: 'designer',
          summary: 'v2 box with width 70',
          flags: [],
          body: 'width = 70  # [20:80] width\nbox = Box(width, 10, 10)',
          preludeVersion: '1',
          stl: 'stl-2',
          step: 'step-2',
          createdAt: 2000,
        });

        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            designVersion: 2,
            reply: {
              messageId: 'm-v2',
              kind: 'result',
              markdown: 'Agent set width to 70',
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'X-Run-Id': 'r-1', 'Content-Type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Parametric Box',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
          versions,
        },
      ],
    });

    await useAppStore.getState().loadServerThread(threadId);

    // Pin width to 55 on v1 and send
    useAppStore.getState().pinParam('width', 55);
    await useAppStore.getState().sendMessage('try 55');

    // Run ends with v2 whose server body has width = 70
    expect(useAppStore.getState().viewingVersion).toBe(2);
    expect(useAppStore.getState().code).toBe('width = 70  # [20:80] width\nbox = Box(width, 10, 10)');

    // The next send has no pinnedParams
    await useAppStore.getState().sendMessage('follow up');
    expect(chatRequests).toHaveLength(2);
    expect(chatRequests[1].pinnedParams).toBeUndefined();
  });

  it('a typed value beats an earlier pin', async () => {
    const threadId = crypto.randomUUID();
    const v1Body = 'width = 40  # [20:80] width\nbox = Box(width, 10, 10)';
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'v1 box',
        flags: [],
        body: v1Body,
        preludeVersion: '1',
        stl: 'stl-1',
        step: 'step-1',
        createdAt: 1000,
      },
    ];

    let chatRequestBody: Record<string, unknown> | null = null;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Parametric Box',
            activeRun: null,
            messages: [],
            versions,
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/artifacts/')) {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      if (url === '/api/compile') {
        return new Response(
          JSON.stringify({
            success: true,
            stl: VALID_ASCII_STL,
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        chatRequestBody = JSON.parse(init?.body as string);
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            designVersion: 2,
            reply: {
              messageId: 'm-resp',
              kind: 'result',
              markdown: 'Done',
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'X-Run-Id': 'r-1', 'Content-Type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Parametric Box',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
          versions,
        },
      ],
    });

    await useAppStore.getState().loadServerThread(threadId);

    // 1. Move slider to 55
    applyParamMove('width', 55);

    // 2. Type width = 99 in the editor
    const typedBody = 'width = 99  # [20:80] width\nbox = Box(width, 10, 10)';
    useAppStore.getState().setCode(typedBody, undefined, 'user');

    // 3. Send
    await useAppStore.getState().sendMessage('build with 99');

    expect(chatRequestBody).toBeTruthy();
    const req = chatRequestBody as unknown as Record<string, unknown>;
    expect(req.editedBody).toContain('width = 99');
    // pinnedParams is absent or { width: 99 }, but never 55
    if (req.pinnedParams) {
      expect((req.pinnedParams as Record<string, number>).width).toBe(99);
      expect((req.pinnedParams as Record<string, number>).width).not.toBe(55);
    }
  });

  it('a draft survives reload', async () => {
    const projId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const v1Body = 'width = 40  # [20:80] width\nbox = Box(width, 10, 10)';
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'v1 box',
        flags: [],
        body: v1Body,
        preludeVersion: '1',
        stl: 'stl-1',
        step: 'step-1',
        createdAt: 1000,
      },
    ];

    let chatRequestBody: Record<string, unknown> | null = null;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/projects' || url.startsWith('/api/projects?')) {
        return new Response(
          JSON.stringify({
            projects: [
              {
                id: projId,
                name: 'My designs',
                updatedAt: 1000,
                threadCount: 1,
                thumbnailArtifactId: null,
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (
        url === `/api/projects/${projId}/threads` ||
        url.startsWith(`/api/projects/${projId}/threads?`)
      ) {
        return new Response(
          JSON.stringify({
            threads: [
              { id: threadId, title: 'Parametric Box', updatedAt: 1000, activeRunId: null },
            ],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/threads') {
        return new Response(
          JSON.stringify({
            threads: [{ id: threadId, title: 'Parametric Box', updatedAt: 1000, activeRunId: null }],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Parametric Box',
            activeRun: null,
            messages: [],
            versions,
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/artifacts/')) {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      if (url === '/api/compile') {
        return new Response(
          JSON.stringify({
            success: true,
            stl: VALID_ASCII_STL,
          }),
          { status: 200 }
        );
      }

      if (url === '/api/chat') {
        chatRequestBody = JSON.parse(init?.body as string);
        const stream = createSseStream([
          {
            t: 'end',
            seq: 1,
            status: 'done',
            reply: {
              messageId: 'm-1',
              kind: 'result',
              markdown: 'Done',
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'X-Run-Id': 'r-1', 'Content-Type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeProjectId: projId,
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Parametric Box',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
          versions,
        },
      ],
    });

    await useAppStore.getState().loadServerThread(threadId);

    // Pin a slider and edit the code on v1, do not send
    useAppStore.getState().pinParam('width', 55);
    const editedBody = 'width = 55  # [20:80] width\nheight = 20\nbox = Box(width, 10, height)';
    useAppStore.getState().setCode(editedBody, undefined, 'user');

    // Give IndexedDB debounce / write time to settle
    await new Promise((r) => setTimeout(r, 100));

    // Simulate a reload: reset zustand store to initial state, keep IndexedDB, call initializeFromStorage
    useAppStore.setState({
      activeProjectId: projId,
      threads: [],
      activeThreadId: '',
      messages: [],
      code: '',
      params: [],
      geometry: null,
      stlContent: null,
      modelInfo: null,
      step: null,
      compileStatus: 'idle',
      compileError: null,
      isGenerating: false,
      generatingThreadId: null,
      inFlightRunId: null,
      viewingVersion: null,
    });

    await useAppStore.getState().initializeFromStorage();

    // The code shows the draft
    expect(useAppStore.getState().code).toContain('height = 20');
    expect(useAppStore.getState().code).toContain('width = 55');

    // The next send carries the same editedBody and pinnedParams
    await useAppStore.getState().sendMessage('send the draft');
    expect(chatRequestBody).toBeTruthy();
    expect((chatRequestBody as Record<string, unknown> | null)?.viewingVersion).toBe(1);
    expect((chatRequestBody as Record<string, unknown> | null)?.editedBody).toBe(editedBody);
    expect((chatRequestBody as Record<string, unknown> | null)?.pinnedParams).toEqual({ width: 55 });
  });

  it('a version without an STL compiles on view', async () => {
    const threadId = crypto.randomUUID();
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'v1 clean',
        flags: [],
        body: 'box = Box(10, 10, 10)',
        preludeVersion: '1',
        stl: 'stl-1',
        step: 'step-1',
        createdAt: 1000,
      },
      {
        version: 2,
        parentVersion: 1,
        origin: 'user_edit',
        summary: 'v2 user edit without stl',
        flags: [],
        body: 'box = Box(25, 25, 25)',
        preludeVersion: '1',
        stl: null,
        step: null,
        createdAt: 2000,
      },
    ];

    const compileRequests: Array<Record<string, unknown>> = [];
    const artifactRequests: string[] = [];

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({
            id: threadId,
            title: 'Thread',
            activeRun: null,
            messages: [],
            versions,
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/artifacts/')) {
        artifactRequests.push(url);
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      if (url === '/api/compile') {
        const body = JSON.parse(init?.body as string);
        compileRequests.push(body);
        return new Response(
          JSON.stringify({
            success: true,
            stl: VALID_ASCII_STL,
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Thread',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
          versions,
        },
      ],
    });

    await useAppStore.getState().loadServerThread(threadId);

    // Clear recorded requests from initial load of v2 (or selectVersion(2))
    compileRequests.length = 0;
    artifactRequests.length = 0;

    await useAppStore.getState().selectVersion(2);

    expect(compileRequests).toHaveLength(1);
    expect(compileRequests[0].code).toBe(versions[1].body);
    expect(compileRequests[0].preludeVersion).toBe('1');
    expect(artifactRequests).toHaveLength(0);
  });

  it('the editor shows the body only and compiles with preludeVersion', async () => {
    const threadId = crypto.randomUUID();
    const version: ServerThreadVersion = {
      version: 1,
      parentVersion: null,
      origin: 'designer',
      summary: 'v1 design',
      flags: [],
      body: 'box = Box(10, 10, 10)',
      preludeVersion: '1',
      stl: 'stl-1',
      step: 'step-1',
      createdAt: 1000,
    };

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Thread',
          createdAt: 1000,
          updatedAt: 1000,
          code: version.body,
          messages: [],
          versions: [version],
        },
      ],
      viewingVersion: 1,
      code: version.body,
    });

    // 1. The rendered editor note is the exact constant (escaped by renderToStaticMarkup)
    const markup = renderToStaticMarkup(<CodeEditorPanel />);
    expect(markup).toContain(PRELUDE_NOTE.replace(/'/g, '&#x27;'));
    expect(PRELUDE_NOTE).toBe("Helpers like _round and _bevel come from the tool's prelude; edit only the design code.");

    // 2. The store code has no prelude sentinel even when a cached full script was loaded
    const fullScriptWithPrelude = withGeneratedPrelude('result = Cylinder(5, 20)', '1');
    await upsertThread({
      id: 'legacy-full-script',
      title: 'Cached',
      createdAt: 500,
      updatedAt: 500,
      code: fullScriptWithPrelude,
      messages: [],
    });
    const cached = await loadAllThreads();
    const cachedThread = cached.threads.find((t) => t.id === 'legacy-full-script');
    expect(cachedThread?.code).toBe('result = Cylinder(5, 20)');
    useAppStore.getState().setCode(fullScriptWithPrelude);
    expect(useAppStore.getState().code).not.toContain(PRELUDE_SENTINEL);
    expect(useAppStore.getState().code).toBe('result = Cylinder(5, 20)');

    // 3. An editor compile POSTs preludeVersion
    let compileBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/compile') {
        compileBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            success: true,
            stl: VALID_ASCII_STL,
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    // The editor's own compile path (Compile button and debounced edits)
    await compileEditorCode(useAppStore.getState().code);
    expect(compileBody).toBeTruthy();
    expect((compileBody as Record<string, unknown> | null)?.preludeVersion).toBe('1');
    expect((compileBody as Record<string, unknown> | null)?.code).toBe('result = Cylinder(5, 20)');
  });

  it('STEP download uses the version\'s artifact', async () => {
    const threadId = crypto.randomUUID();
    const version: ServerThreadVersion = {
      version: 1,
      parentVersion: null,
      origin: 'designer',
      summary: 'v1 design',
      flags: [],
      body: 'box = Box(10, 10, 10)',
      preludeVersion: '1',
      stl: 'stl-1',
      step: 'P2',
      createdAt: 1000,
    };

    const fetchedArtifacts: string[] = [];
    const artifactText = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;';
    const exportStepSpy = vi.spyOn(stlExporter, 'exportStep');

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/artifacts/P2') {
        fetchedArtifacts.push(url);
        return new Response(artifactText, {
          status: 200,
          headers: { 'Content-Type': 'model/step' },
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Download Thread',
          createdAt: 1000,
          updatedAt: 1000,
          code: version.body,
          messages: [],
          versions: [version],
        },
      ],
      viewingVersion: 1,
      step: null,
    });

    await downloadStep();
    expect(fetchedArtifacts).toContain('/api/artifacts/P2');
    expect(exportStepSpy).toHaveBeenCalledWith(artifactText, 'Download Thread.step', 'text');
  });

  it('switching back to a running thread restores Stop', async () => {
    const threadA = crypto.randomUUID();
    const threadB = crypto.randomUUID();

    let cancelledRunId: string | null = null;
    let tailCount = 0;
    let isRunActive = true;

    let resumeStream: () => void = () => {};
    const streamPromise = new Promise<void>((r) => {
      resumeStream = r;
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === `/api/threads/${threadA}`) {
        return new Response(
          JSON.stringify({
            id: threadA,
            title: 'Thread A',
            activeRun: isRunActive ? { id: 'run-A', status: 'running', lastSeq: 0 } : null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/threads/${threadB}`) {
        return new Response(
          JSON.stringify({
            id: threadB,
            title: 'Thread B',
            activeRun: null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/runs/run-A/events')) {
        tailCount++;
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            await streamPromise;
            const endEvent: StreamEvent = {
              t: 'end',
              seq: 1,
              status: 'cancelled',
              reply: {
                messageId: 'm-stopped',
                kind: 'cancelled',
                markdown: 'Stopped.',
              },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(endEvent)}\n\n`));
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      if (url === '/api/runs/run-A/cancel') {
        cancelledRunId = 'run-A';
        isRunActive = false;
        resumeStream();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({
      activeThreadId: threadA,
      threads: [
        {
          id: threadA,
          title: 'Thread A',
          createdAt: 1000,
          updatedAt: 1000,
          code: '',
          messages: [],
          activeRunId: 'run-A',
        },
      ],
    });

    // 1. Thread A loads and begins tailing run-A
    await useAppStore.getState().loadServerThread(threadA);
    expect(tailCount).toBe(1);

    // In Thread A, Stop is available
    const markupA1 = renderToStaticMarkup(<ChatPanel />);
    expect(markupA1).toContain('Stop');

    // 2. Press New: creates a new thread
    const newThreadId = useAppStore.getState().createNewThread();
    expect(useAppStore.getState().activeThreadId).toBe(newThreadId);

    // In New thread, Stop is not rendered
    const markupNew = renderToStaticMarkup(<ChatPanel />);
    expect(markupNew).not.toContain('Stop');

    // 3. Switch back to Thread A
    useAppStore.getState().switchThread(threadA);
    expect(useAppStore.getState().activeThreadId).toBe(threadA);

    // Stop renders again!
    const markupA2 = renderToStaticMarkup(<ChatPanel />);
    expect(markupA2).toContain('Stop');

    // A reload of the thread while its run is being read opens no second tail
    await useAppStore.getState().loadServerThread(threadA);
    expect(tailCount).toBe(1);

    // Calling stopCurrentRun posts to /api/runs/<id>/cancel
    await useAppStore.getState().stopCurrentRun();
    expect(cancelledRunId).toBe('run-A');

    // Only one events tail was opened for that run
    expect(tailCount).toBe(1);
  });
  function editThreadFixture(threadId: string, v1Body: string) {
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'v1',
        flags: [],
        body: v1Body,
        preludeVersion: '1',
        stl: 'stl-1',
        step: null,
        createdAt: 1000,
      },
    ];
    const chatRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `/api/threads/${threadId}`) {
        return new Response(
          JSON.stringify({ id: threadId, title: 'T', activeRun: null, messages: [], versions }),
          { status: 200 }
        );
      }
      if (url.startsWith('/api/artifacts/')) return new Response(VALID_ASCII_STL, { status: 200 });
      if (url === '/api/compile') {
        return new Response(JSON.stringify({ success: true, stl: VALID_ASCII_STL }), { status: 200 });
      }
      if (url === '/api/chat') {
        chatRequests.push(JSON.parse(init?.body as string));
        const n = chatRequests.length;
        const stream = createSseStream([
          {
            t: 'end',
            seq: n,
            status: 'done',
            reply: { messageId: `m-${n}`, kind: 'answer', markdown: 'An answer.' },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'X-Run-Id': `r-${n}`, 'Content-Type': 'text/event-stream' },
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        { id: threadId, title: 'T', createdAt: 1000, updatedAt: 1000, code: '', messages: [], versions },
      ],
    });
    return { chatRequests };
  }

  it('edits that match the viewed version are not sent', async () => {
    const threadId = crypto.randomUUID();
    const v1Body = 'width = 40  # [20:80] Box Width\nbox = Box(width, 10, 10)';
    const { chatRequests } = editThreadFixture(threadId, v1Body);
    await useAppStore.getState().loadServerThread(threadId);

    // A slider moved away and back, and the editor holding exactly v1's body
    applyParamMove('width', 55);
    applyParamMove('width', 40);
    useAppStore.getState().setCode(v1Body, undefined, 'user');
    expect(useAppStore.getState().activeDraft?.editedBody).toBe(v1Body);
    expect(useAppStore.getState().activeDraft?.pinnedParams).toEqual({ width: 40 });

    await useAppStore.getState().sendMessage('what is the width?');
    expect(chatRequests).toHaveLength(1);
    expect('editedBody' in chatRequests[0]).toBe(false);
    expect('pinnedParams' in chatRequests[0]).toBe(false);
  });

  it('the draft is cleared after a send', async () => {
    const threadId = crypto.randomUUID();
    const v1Body = 'width = 40  # [20:80] Box Width\nbox = Box(width, 10, 10)';
    const { chatRequests } = editThreadFixture(threadId, v1Body);
    await useAppStore.getState().loadServerThread(threadId);

    applyParamMove('width', 55);
    await useAppStore.getState().sendMessage('make it 55');
    expect(chatRequests[0].pinnedParams).toEqual({ width: 55 });

    // The run answered without a new version: the view stays on v1, and the pin went with the send
    expect(useAppStore.getState().viewingVersion).toBe(1);
    expect(await getDraft(threadId, 1)).toBeNull();

    await useAppStore.getState().sendMessage('and now?');
    expect(chatRequests).toHaveLength(2);
    expect('pinnedParams' in chatRequests[1]).toBe(false);
    expect('editedBody' in chatRequests[1]).toBe(false);
  });
});
