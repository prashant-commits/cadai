import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { useAppStore } from '@/store/app-store';
import { ChatPanel } from './chat-panel';
import { ChatInput } from './chat-input';
import { MessageBubble } from './message-bubble';
import { ThreadsMenuList, createThreadsMenuActions } from './threads-menu';

const origUseSyncExternalStore = React.useSyncExternalStore;

describe('ChatPanel and related components', () => {
  beforeEach(() => {
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    useAppStore.setState({
      threads: [],
      activeThreadId: '',
      messages: [],
      runsByThread: {},
      isGenerating: false,
      generatingThreadId: null,
      highlightedVersion: null,
      pendingAttachment: null,
    });
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    vi.unstubAllGlobals();
  });

  it('the input box contains the image button, the model selector and Send', () => {
    const html = renderToStaticMarkup(<ChatInput onSendMessage={() => {}} />);
    const boxStart = html.indexOf('data-slot="chat-input"');
    const sendBtnIndex = html.indexOf('data-slot="send-button"');

    expect(boxStart).toBeGreaterThan(-1);
    expect(sendBtnIndex).toBeGreaterThan(boxStart);

    const slice = html.substring(boxStart, sendBtnIndex);
    expect(slice).toContain('data-slot="image-button"');
    expect(slice).toContain('data-slot="model-select"');
  });

  it('there is exactly one Stop control while a run streams', () => {
    const threadId = 'thread-generating-1';
    useAppStore.setState({
      threads: [
        {
          id: threadId,
          title: 'Active Thread',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          code: '',
          messages: [],
        },
      ],
      activeThreadId: threadId,
      isGenerating: true,
      generatingThreadId: threadId,
      runsByThread: { [threadId]: 'run-123' },
    });

    const html = renderToStaticMarkup(<ChatPanel />);
    const stopLabels = html.match(/aria-label="Stop"/g) || [];
    expect(stopLabels.length).toBe(1);

    const stopTexts = html.match(/>\s*Stop\s*</gi) || [];
    expect(stopTexts.length).toBe(0);
  });

  it("the threads menu lists the project's threads and New thread", () => {
    useAppStore.setState({
      threads: [
        {
          id: 't1',
          title: 'Design Alpha',
          createdAt: 1,
          updatedAt: 1,
          code: '',
          messages: [],
        },
        {
          id: 't2',
          title: 'Design Beta',
          createdAt: 2,
          updatedAt: 2,
          code: '',
          messages: [],
        },
      ],
      activeThreadId: 't1',
    });

    const html = renderToStaticMarkup(<ThreadsMenuList />);
    expect(html).toContain('Design Alpha');
    expect(html).toContain('Design Beta');
    expect(html).toContain('New thread');

    // The active one is marked
    expect(html).toMatch(/data-thread-id="t1"[^>]*data-active="true"/);
    expect(html).not.toMatch(/data-thread-id="t2"[^>]*data-active="true"/);
  });

  it('deleting a thread asks for confirmation first', async () => {
    const deleteThread = vi.fn();
    const setConfirmOpen = vi.fn();
    const toastError = vi.fn();

    const actions = createThreadsMenuActions({
      deleteThread,
      setConfirmOpen,
      toastError,
    });

    actions.requestDelete('t1');
    expect(setConfirmOpen).toHaveBeenCalledWith(true);
    expect(deleteThread).not.toHaveBeenCalled();

    await actions.confirmDelete();
    expect(deleteThread).toHaveBeenCalledTimes(1);
    expect(deleteThread).toHaveBeenCalledWith('t1');

    // Caught throwing delete
    const failingDelete = vi.fn().mockRejectedValue(new Error('delete failed'));
    const failingActions = createThreadsMenuActions({
      deleteThread: failingDelete,
      setConfirmOpen,
      toastError,
    });
    failingActions.requestDelete('t2');
    await failingActions.confirmDelete();
    expect(toastError).toHaveBeenCalledWith(
      'The thread could not be deleted. Try again.'
    );
  });

  it('there is no version list in the chat panel', () => {
    const threadId = 't-versions';
    useAppStore.setState({
      threads: [
        {
          id: threadId,
          title: 'Thread With Versions',
          createdAt: 1,
          updatedAt: 2,
          code: '',
          messages: [],
          versions: [
            {
              version: 1,
              parentVersion: null,
              origin: 'designer',
              summary: 'Initial draft',
              flags: [],
              body: '',
              preludeVersion: '1',
              stl: null,
              step: null,
              createdAt: 1,
            },
            {
              version: 2,
              parentVersion: 1,
              origin: 'designer',
              summary: 'Second revision',
              flags: [],
              body: '',
              preludeVersion: '1',
              stl: null,
              step: null,
              createdAt: 2,
            },
          ],
        },
      ],
      activeThreadId: threadId,
    });

    const html = renderToStaticMarkup(<ChatPanel />);
    expect(html).not.toContain('data-slot="version-list"');
    expect(html).not.toContain('Initial draft');
    expect(html).not.toContain('Second revision');

    const versionListPath = path.resolve(__dirname, './version-list.tsx');
    expect(fs.existsSync(versionListPath)).toBe(false);
  });

  it('a tool_edit message renders as an inline line', () => {
    const msg = {
      id: 'm-tool',
      role: 'assistant' as const,
      kind: 'tool_edit' as const,
      content: 'You added Hole Ø5',
      designVersion: 4,
      timestamp: Date.now(),
    };

    const html = renderToStaticMarkup(<MessageBubble message={msg} />);
    expect(html).toContain('data-kind="tool_edit"');
    expect(html).toContain('You added Hole Ø5');
    expect(html).toContain('v4');
    expect(html).not.toContain('rounded-2xl');
    expect(html).not.toContain('Copy message');
  });

  it('a highlighted version marks its message', () => {
    const threadId = 't-highlight';
    useAppStore.setState({
      threads: [
        {
          id: threadId,
          title: 'Highlight Thread',
          createdAt: 1,
          updatedAt: 2,
          code: '',
          messages: [],
        },
      ],
      activeThreadId: threadId,
      highlightedVersion: 2,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Version 1 ready',
          timestamp: 1000,
          designVersion: 1,
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Version 2 ready',
          timestamp: 2000,
          designVersion: 2,
        },
      ],
    });

    const html = renderToStaticMarkup(<ChatPanel />);
    expect(html).toContain('data-design-version="1"');
    expect(html).toContain('data-design-version="2"');
    expect(html).toMatch(/data-design-version="2"[^>]*data-highlighted="true"/);
    expect(html).not.toMatch(/data-design-version="1"[^>]*data-highlighted="true"/);
  });
});
