import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '@/store/app-store';
import { ChatInput } from './chat-input';

describe('Fix 3: upload on attach flow', () => {
  const origUseSyncExternalStore = React.useSyncExternalStore;

  beforeEach(() => {
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    useAppStore.setState({
      threads: [
        {
          id: '00000000-0000-0000-0000-000000000001',
          title: 'Thread 1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          code: '',
          messages: [],
        },
      ],
      activeThreadId: '00000000-0000-0000-0000-000000000001',
      pendingAttachment: null,
      isGenerating: false,
      runsByThread: {},
    });
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    vi.unstubAllGlobals();
  });

  it('upload starts on attach', async () => {
    let uploadCalled = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/attachments') {
        uploadCalled = true;
        return new Response(JSON.stringify({ artifactId: 'art-123' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    useAppStore.getState().attachImage(fakeDataUrl, 'markup');

    expect(uploadCalled).toBe(true);
    expect(useAppStore.getState().pendingAttachment?.status).toBe('uploading');

    // Wait a tick for upload promise
    await new Promise((r) => setTimeout(r, 10));
    expect(useAppStore.getState().pendingAttachment?.status).toBe('ready');
    expect(useAppStore.getState().pendingAttachment?.id).toBe('art-123');
  });

  it('send is disabled while uploading', () => {
    useAppStore.setState({
      pendingAttachment: {
        localUrl: 'data:image/png;base64,...',
        kind: 'markup',
        status: 'uploading',
      },
    });

    const isSendButtonDisabled = (html: string): boolean => {
      const match = html.match(/<button[^>]*aria-label="Send prompt"[^>]*>/);
      if (!match) throw new Error('Send prompt button not found in markup');
      return /\bdisabled(?:="")?(?=[ >])/.test(match[0]);
    };

    const renderChatInputWithText = (text: string) => {
      return renderToStaticMarkup(<ChatInput initialText={text} onSendMessage={() => {}} />);
    };

    // 1. With uploading attachment and text: chip shows Uploading…, send button is disabled
    const uploadingMarkup = renderChatInputWithText('some text');
    expect(uploadingMarkup).toContain('Uploading…');
    expect(isSendButtonDisabled(uploadingMarkup)).toBe(true);

    // 2. With ready attachment and text: send button is enabled
    useAppStore.setState({
      pendingAttachment: {
        localUrl: 'data:image/png;base64,...',
        kind: 'markup',
        status: 'ready',
        id: 'art-ready-1',
      },
    });
    const readyMarkup = renderChatInputWithText('some text');
    expect(isSendButtonDisabled(readyMarkup)).toBe(false);
  });

  it('a failed upload never sends', async () => {
    let chatCalled = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/attachments') {
        return new Response(JSON.stringify({ error: 'Failed' }), { status: 500 });
      }
      if (url === '/api/chat') {
        chatCalled = true;
        return new Response('ok');
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    useAppStore.getState().attachImage('data:image/png;base64,...', 'markup');
    await new Promise((r) => setTimeout(r, 10));

    expect(useAppStore.getState().pendingAttachment?.status).toBe('failed');

    const markup = renderToStaticMarkup(<ChatInput onSendMessage={() => {}} />);
    expect(markup).toContain('Upload failed');
    expect(markup).toContain('Retry');
    expect(markup).toContain('disabled=""');
    expect(chatCalled).toBe(false);
  });

  it('removing the chip sends no id', async () => {
    let capturedReq: unknown = null;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/attachments') {
        // Delayed upload
        await new Promise((r) => setTimeout(r, 50));
        return new Response(JSON.stringify({ artifactId: 'late-art-999' }), { status: 200 });
      }
      if (url === '/api/chat') {
        capturedReq = JSON.parse(String(init?.body));
        return new Response('stream', {
          status: 200,
          headers: { 'X-Run-Id': 'r-test' },
        });
      }
      if (url.startsWith('/api/threads/')) {
        return new Response(JSON.stringify({ id: '00000000-0000-0000-0000-000000000001', messages: [], versions: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    // Start attach
    useAppStore.getState().attachImage(fakeDataUrl, 'markup');
    expect(useAppStore.getState().pendingAttachment?.status).toBe('uploading');

    // Remove chip during upload
    useAppStore.getState().removeAttachment();
    expect(useAppStore.getState().pendingAttachment).toBeNull();

    // Wait for the background upload to finish
    await new Promise((r) => setTimeout(r, 70));

    // An upload that resolves after removal must not set pendingAttachment
    expect(useAppStore.getState().pendingAttachment).toBeNull();

    // Send text passing current store pendingAttachment (as ChatInput does)
    const att = useAppStore.getState().pendingAttachment;
    await useAppStore.getState().sendMessage(
      'Hello without attachment',
      att && att.status === 'ready' && att.id
        ? { id: att.id, kind: att.kind, localUrl: att.localUrl }
        : undefined
    );

    expect(capturedReq).not.toBeNull();
    const req = capturedReq as { attachments?: unknown[]; attachmentIds?: unknown[] };
    expect(req.attachments).toBeUndefined();
    expect(req.attachmentIds).toBeUndefined();
  });
});
