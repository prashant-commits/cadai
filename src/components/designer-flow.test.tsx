import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { POST as compileRoutePOST } from '@/app/api/compile/route';
import { runBrep } from '@/lib/engine/brep-runner';
import { withGeneratedPrelude, toBody } from '@/lib/brep/prelude';
import { useAppStore } from '@/store/app-store';
import { DB_NAME } from '@/lib/storage/db-schema';
import { __resetDbForTests, getDraft } from '@/lib/storage/thread-storage';
import type { StreamEvent } from '@/lib/agent/stream-events';
import { PropertiesSection } from './inspector/properties-section';
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
  const compileBodies: Array<{ code?: unknown; language?: unknown; preludeVersion?: unknown }> = [];

  beforeEach(async () => {
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
      isGenerating: false,
      generatingThreadId: null,
      viewingVersion: null,
      activeDraft: null,
      editorView: 'design',
    });
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    vi.unstubAllGlobals();
  });

  it('a designer run renders end to end, and slider moves recompile through /api/compile', async () => {
    const targetThreadId = crypto.randomUUID();
    const sampleBody = toBody(SAMPLE_BUILD123D_CODE);

    // Fake fetch routing for /api/chat, /api/threads/:id, /api/artifacts/:id, and /api/compile
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/api/chat')) {
        const events: StreamEvent[] = [
          { t: 'section', id: 'designerNode', label: 'designerNode', state: 'open', index: 0, startedAt: Date.now(), attempt: 1 },
          { t: 'delta', text: 'Generating parametric box with width and depth...' },
          { t: 'section', id: 'designerNode', state: 'close', status: 'ok', endedAt: Date.now() + 50, durationMs: 50, attempt: 1 },
          {
            t: 'end',
            seq: 2,
            status: 'done',
            designVersion: 1,
            reply: {
              messageId: 'm1',
              kind: 'result',
              markdown: 'A parametric box with customizable width and depth.',
            },
          },
        ];
        const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
        return new Response(new Blob([body]).stream(), {
          status: 200,
          headers: { 'X-Run-Id': 'r1', 'Content-Type': 'text/event-stream' },
        });
      }

      if (url === `/api/threads/${targetThreadId}`) {
        return new Response(
          JSON.stringify({
            id: targetThreadId,
            title: 'Parametric Box',
            activeRun: null,
            messages: [
              {
                id: 'm1',
                seq: 1,
                role: 'assistant',
                kind: 'result',
                markdown: 'A parametric box with customizable width and depth.',
                designVersion: 1,
                attachments: [],
              },
            ],
            versions: [
              {
                version: 1,
                parentVersion: null,
                origin: 'designer',
                summary: 'A parametric box with customizable width and depth.',
                flags: [],
                body: sampleBody,
                preludeVersion: '1',
                stl: 'art-stl-1',
                step: 'art-step-1',
                createdAt: 1000,
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url === '/api/artifacts/art-stl-1') {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }

      if (url.endsWith('/api/compile')) {
        const reqBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        compileBodies.push(reqBody);

        const nextReq = new NextRequest('http://localhost:3000/api/compile', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            cookie: 'cadai_owner=550e8400-e29b-41d4-a716-446655440000',
          },
          body: JSON.stringify(reqBody),
        });
        return await compileRoutePOST(nextReq);
      }

      throw new Error(`Unhandled fake fetch URL: ${url}`);
    });

    // 1. Create a thread in the store
    useAppStore.setState({
      threads: [
        {
          id: targetThreadId,
          title: 'Parametric Box',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          code: '',
          messages: [],
        },
      ],
      activeThreadId: targetThreadId,
    });
    expect(targetThreadId).toBeTruthy();

    // 2. Drive run through store sendMessage
    await useAppStore.getState().sendMessage('Create a parametric box');

    // 3. Assert the run rendered in store
    const stateAfterRun = useAppStore.getState();
    expect(stateAfterRun.code).toBe(sampleBody);
    expect(stateAfterRun.compileStatus).toBe('idle');
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
    const completedMsg = targetThread?.messages.find((m) => m.id === 'm1');
    expect(completedMsg?.status).toBe('complete');
    expect(completedMsg?.content).toBe('A parametric box with customizable width and depth.');

    // Render <PropertiesSection /> with react-dom/server renderToStaticMarkup
    const designMarkup = renderToStaticMarkup(<PropertiesSection />);
    expect(designMarkup).toContain('role="slider"');
    expect(designMarkup).toMatch(/role="slider"[\s\S]*aria-valuemin="20"[\s\S]*aria-valuemax="80"/);
    expect(designMarkup).toMatch(/role="slider"[\s\S]*aria-valuemin="30"[\s\S]*aria-valuemax="100"/);
    expect(designMarkup).toContain('Box Width');
    expect(designMarkup).toContain('Box Depth');
    expect(designMarkup).toMatch(/min="20"[\s\S]*max="80"/);
    expect(designMarkup).toMatch(/min="30"[\s\S]*max="100"/);

    // Render <MessageBubble /> and assert summary text appears
    const bubbleMarkup = renderToStaticMarkup(<MessageBubble message={completedMsg!} />);
    expect(bubbleMarkup).toContain('A parametric box with customizable width and depth.');

    // 4. Assert a slider move recompiles through /api/compile with preludeVersion
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

    // Call store pinParam
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
    const compileBody = compileBodies[0] as { code: string; language: string; preludeVersion?: string };
    expect(compileBody.language).toBe('build123d');
    expect(compileBody.preludeVersion).toBe('1');
    expect(compileBody.code).toContain('width = 55');
    expect(compileBody.code).toContain('depth = 60');

    // Mocked runBrep received the updated code with prelude
    expect(runBrep).toHaveBeenCalledTimes(1);
    expect(runBrep).toHaveBeenCalledWith(withGeneratedPrelude(toBody(compileBody.code), '1'));

    // Store has new compile status and recompiled mesh reached stlContent/geometry
    const finalState = useAppStore.getState();
    expect(finalState.compileStatus).toBe('success');
    expect(finalState.compileError).toBeNull();
    expect(finalState.stlContent).toBe(RECOMPILED_ASCII_STL);
    expect(finalState.stlContent).not.toBe(stateAfterRun.stlContent);
    expect(finalState.geometry).toBeDefined();
    expect(finalState.geometry).not.toBe(stateAfterRun.geometry);

    // Pins are now stored on the draft
    const draft = await getDraft(targetThreadId, 1);
    expect(draft?.pinnedParams?.width).toBe(55);

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
