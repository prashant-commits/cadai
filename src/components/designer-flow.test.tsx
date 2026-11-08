import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { POST as compileRoutePOST } from '@/app/api/compile/route';
import { runBrep } from '@/lib/engine/brep-runner';
import { withGeneratedPrelude, toBody } from '@/lib/brep/prelude';
import { useAppStore } from '@/store/app-store';
import { DB_NAME } from '@/lib/storage/db-schema';
import { __resetDbForTests } from '@/lib/storage/thread-storage';
import { readStream } from '@/lib/stream-reader';
import type { StreamEvent } from '@/lib/agent/stream-events';
import type { ChatMessage } from '@/types';
import { applyStreamResult } from './chat/apply-stream-result';
import { DesignPanel } from './design/design-panel';
import { MessageBubble } from './chat/message-bubble';

vi.mock('@/lib/engine/brep-runner', () => ({
  runBrep: vi.fn(),
}));

const VALID_ASCII_STL = `solid box
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 40 0 0
      vertex 40 60 0
    endloop
  endfacet
endsolid box`;

const RECOMPILED_ASCII_STL = `solid box
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 55 0 0
      vertex 55 60 0
    endloop
  endfacet
endsolid box`;

const SAMPLE_BUILD123D_CODE = `from build123d import *

width = 40  # [20:80] Box Width
depth = 60  # [30:100] Box Depth

box = Box(width, depth, 20)
box.label = "main_body"
result = box
`;

const origUseSyncExternalStore = React.useSyncExternalStore;

describe('0c component test: designer run and slider recompilation', () => {
  const compileBodies: Array<{ code?: unknown; language?: unknown }> = [];

  beforeEach(async () => {
    // In node environment without DOM, renderToStaticMarkup acts as SSR and calls
    // getServerSnapshot (which zustand binds to getInitialState). Patch useSyncExternalStore
    // so server-rendered component markup reflects the updated store state.
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    compileBodies.length = 0;
    vi.clearAllMocks();

    (runBrep as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      stl: Buffer.from(VALID_ASCII_STL).toString('base64'),
      step: '',
      parts: [
        {
          label: 'main_body',
          valid: true,
          volume: 48000,
          min: [0, 0, 0],
          max: [40, 60, 20],
        },
      ],
    });

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
      contractDiff: null,
      isGenerating: false,
      generatingThreadId: null,
      editorView: 'design',
    });

    // Fake fetch routing for /api/chat and /api/compile
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/api/chat')) {
        const events: StreamEvent[] = [
          { t: 'section', id: 'designerNode', label: 'designerNode', state: 'open', index: 0, startedAt: Date.now(), attempt: 1 },
          { t: 'delta', text: 'Generating parametric box with width and depth...' },
          { t: 'section', id: 'designerNode', state: 'close', status: 'ok', endedAt: Date.now() + 50, durationMs: 50, attempt: 1 },
          {
            t: 'result',
            summary: 'A parametric box with customizable width and depth.',
            code: SAMPLE_BUILD123D_CODE,
            stl: VALID_ASCII_STL,
            language: 'build123d',
            designContract: {
              standing: { maxSizeMm: [100, 100, 100], minWallMm: 1.6 },
              pinnedParams: {},
            },
          },
        ];
        const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
        return new Response(new Blob([body]).stream(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      if (url.endsWith('/api/compile')) {
        const reqBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        compileBodies.push(reqBody);

        const nextReq = new NextRequest('http://localhost:3000/api/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
        });
        return await compileRoutePOST(nextReq);
      }

      throw new Error(`Unhandled fake fetch URL: ${url}`);
    });
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    vi.unstubAllGlobals();
  });

  it('a designer run renders end to end, and slider moves recompile through /api/compile', async () => {
    // 1. Create a thread in the store
    const store = useAppStore.getState();
    store.createNewThread('Parametric Box');
    const targetThreadId = useAppStore.getState().activeThreadId;
    expect(targetThreadId).toBeTruthy();

    const assistantMsgId = 'assistant-wire-1';
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      transcript: '',
      status: 'streaming',
      timestamp: Date.now(),
    };
    useAppStore.getState().addMessage(assistantMsg, targetThreadId);

    // 2. Fetch /api/chat and drive stream through applyStreamResult
    const chatRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: targetThreadId }),
    });
    expect(chatRes.ok).toBe(true);

    await readStream(chatRes, {
      onUpdate: () => {},
      onDone: async (state) => {
        await applyStreamResult(state, targetThreadId, assistantMsgId);
      },
    });

    // 3. Assert the run rendered in store
    const stateAfterRun = useAppStore.getState();
    expect(stateAfterRun.code).toBe(SAMPLE_BUILD123D_CODE);
    expect(stateAfterRun.compileStatus).toBe('success');
    expect(stateAfterRun.compileError).toBeNull();
    expect(stateAfterRun.geometry).toBeDefined();
    expect(stateAfterRun.modelInfo).toBeDefined();
    expect(stateAfterRun.stlContent).toBe(VALID_ASCII_STL);

    // Verify params parsed
    expect(stateAfterRun.params).toHaveLength(2);
    expect(stateAfterRun.params[0]).toMatchObject({
      name: 'width',
      kind: 'range',
      min: 20,
      max: 80,
      value: 40,
    });
    expect(stateAfterRun.params[1]).toMatchObject({
      name: 'depth',
      kind: 'range',
      min: 30,
      max: 100,
      value: 60,
    });

    // Assistant message got summary as content with status complete
    const targetThread = stateAfterRun.threads.find((t) => t.id === targetThreadId);
    const completedMsg = targetThread?.messages.find((m) => m.id === assistantMsgId);
    expect(completedMsg?.status).toBe('complete');
    expect(completedMsg?.content).toBe('A parametric box with customizable width and depth.');

    // Render <DesignPanel /> with react-dom/server renderToStaticMarkup
    const designMarkup = renderToStaticMarkup(<DesignPanel />);
    expect(designMarkup).toContain('type="range"');
    expect(designMarkup).toContain('Box Width');
    expect(designMarkup).toContain('Box Depth');
    expect(designMarkup).toMatch(/min="20"[\s\S]*max="80"/);
    expect(designMarkup).toMatch(/min="30"[\s\S]*max="100"/);

    // Render <MessageBubble /> and assert summary text appears
    const bubbleMarkup = renderToStaticMarkup(<MessageBubble message={completedMsg!} />);
    expect(bubbleMarkup).toContain('A parametric box with customizable width and depth.');

    // 4. Assert a slider move recompiles through /api/compile
    compileBodies.length = 0;
    (runBrep as unknown as ReturnType<typeof vi.fn>).mockClear();
    (runBrep as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      stl: Buffer.from(RECOMPILED_ASCII_STL).toString('base64'),
      step: '',
      parts: [
        {
          label: 'main_body',
          valid: true,
          volume: 66000,
          min: [0, 0, 0],
          max: [55, 60, 20],
        },
      ],
    });

    // Call the same store action slider's onChange + onPin calls
    useAppStore.getState().pinParam('width', 55);

    // Wait until compileModel completes and compileStatus leaves 'compiling' (bounded to 5s)
    const deadline = Date.now() + 5000;
    while (useAppStore.getState().compileStatus === 'compiling') {
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for compileStatus to leave "compiling"');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Exactly one /api/compile request
    expect(compileBodies).toHaveLength(1);
    const compileBody = compileBodies[0] as { code: string; language: string };
    expect(compileBody.language).toBe('build123d');
    expect(compileBody.code).toContain('width = 55');
    expect(compileBody.code).toContain('depth = 60');

    // Mocked runBrep received the updated code
    expect(runBrep).toHaveBeenCalledTimes(1);
    expect(runBrep).toHaveBeenCalledWith(withGeneratedPrelude(toBody(compileBody.code)));

    // Store has new compile status and recompiled mesh reached stlContent/geometry
    const finalState = useAppStore.getState();
    expect(finalState.compileStatus).toBe('success');
    expect(finalState.compileError).toBeNull();
    expect(finalState.stlContent).toBe(RECOMPILED_ASCII_STL);
    expect(finalState.stlContent).not.toBe(stateAfterRun.stlContent);
    expect(finalState.geometry).toBeDefined();
    expect(finalState.geometry).not.toBe(stateAfterRun.geometry);

    const finalThread = finalState.threads.find((t) => t.id === targetThreadId);
    expect(finalThread?.designContract?.pinnedParams?.width).toMatchObject({
      value: 55,
      supersededValue: 40,
      pinnedAt: expect.any(Number),
    });

    // 5. Assert the OpenSCAD path is gone: language 'openscad' returns 400 and runBrep is not called
    (runBrep as unknown as ReturnType<typeof vi.fn>).mockClear();
    const openscadRes = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'cube(10);', language: 'openscad' }),
    });
    expect(openscadRes.status).toBe(400);
    const errBody = (await openscadRes.json()) as { error?: string };
    expect(errBody.error).toBe('Only build123d scripts are supported.');
    expect(runBrep).not.toHaveBeenCalled();
  });
});
