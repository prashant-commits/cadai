import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from './app-store';
import { DB_NAME } from '@/lib/storage/db-schema';
import { __resetDbForTests, loadAllThreads, DEFAULT_CODE, upsertThread, getDraft } from '@/lib/storage/thread-storage';
import { PRELUDE_SENTINEL } from '@/lib/brep/prelude';

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

/** Lets the store's fire-and-forget IndexedDB writes settle. */
async function flushWrites() {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('useAppStore thread scoping & progress isolation', () => {
  beforeEach(async () => {
    await __resetDbForTests();
    await deleteDatabase();

    useAppStore.setState({
      threads: [
        {
          id: 'thread-1',
          title: 'Thread 1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
          code: 'cube(10);',
        },
        {
          id: 'thread-2',
          title: 'Thread 2',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
          code: 'w = 10;\ncube(w);',
          designContract: {
            standing: {},
            pinnedParams: {
              w: { value: 20, supersededValue: 10, pinnedAt: Date.now() }
            }
          }
        },
      ],
      activeThreadId: 'thread-1',
      messages: [],
      code: 'cube(10);',
      params: [],
      isGenerating: false,
      generatingThreadId: null,
      editorView: 'design',
    });
  });

  it('adds message to specified threadId without overriding active thread if different', () => {
    const store = useAppStore.getState();

    // Active thread is thread-1
    expect(store.activeThreadId).toBe('thread-1');

    // Add message targeting thread-2
    store.addMessage(
      {
        id: 'msg-bg',
        role: 'assistant',
        content: 'Response for thread 2',
        timestamp: Date.now(),
      },
      'thread-2'
    );

    const updated = useAppStore.getState();
    const t2 = updated.threads.find((t) => t.id === 'thread-2');
    const t1 = updated.threads.find((t) => t.id === 'thread-1');

    expect(t2?.messages.length).toBe(1);
    expect(t2?.messages[0].content).toBe('Response for thread 2');
    // Active mirrored messages (thread-1) should still be empty
    expect(updated.messages.length).toBe(0);
    expect(t1?.messages.length).toBe(0);
  });

  it('updates code for specified threadId without overriding active code if different', () => {
    const store = useAppStore.getState();
    store.setCode('cylinder(r=5, h=20);', 'thread-2');

    const updated = useAppStore.getState();
    const t2 = updated.threads.find((t) => t.id === 'thread-2');

    expect(t2?.code).toBe('cylinder(r=5, h=20);');
    expect(updated.code).toBe('cube(10);'); // active code unchanged
  });

  it('changes editorView state', () => {
    const store = useAppStore.getState();
    expect(store.editorView).toBe('design');

    store.setEditorView('code');
    expect(useAppStore.getState().editorView).toBe('code');
  });

  describe('Contract and Pins', () => {
    it('pinParam updates code and draft together', async () => {
      const store = useAppStore.getState();
      store.setCode('w = 10;\ncube(w);'); // set code first to parse params

      useAppStore.getState().pinParam('w', 55);

      const updated = useAppStore.getState();
      expect(updated.code).toBe('w = 55;\ncube(w);');
      expect(updated.activeDraft?.pinnedParams?.['w']).toBe(55);

      await flushWrites();
      const draft = await getDraft(updated.activeThreadId, updated.viewingVersion);
      expect(draft?.pinnedParams?.['w']).toBe(55);
    });

    it('unpinParam restores version value', () => {
      const version = {
        version: 1,
        parentVersion: null,
        origin: 'designer' as const,
        summary: 'v1',
        flags: [],
        body: 'w = 10;\ncube(w);',
        preludeVersion: '1',
        stl: null,
        step: null,
        createdAt: 1000,
      };

      useAppStore.setState({
        threads: [
          {
            id: 'thread-2',
            title: 'Thread 2',
            createdAt: 1000,
            updatedAt: 1000,
            messages: [],
            code: 'w = 10;\ncube(w);',
            versions: [version],
            viewingVersion: 1,
          },
        ],
        activeThreadId: 'thread-2',
        viewingVersion: 1,
        code: 'w = 10;\ncube(w);',
      });

      useAppStore.getState().pinParam('w', 55);
      expect(useAppStore.getState().code).toBe('w = 55;\ncube(w);');
      expect(useAppStore.getState().activeDraft?.pinnedParams?.['w']).toBe(55);

      useAppStore.getState().unpinParam('w');

      const updated = useAppStore.getState();
      expect(updated.code).toBe('w = 10;\ncube(w);');
      expect(updated.activeDraft?.pinnedParams?.['w']).toBeUndefined();
    });

    it('pins are thread-scoped and do not leak across switchThread', async () => {
      const store = useAppStore.getState();
      store.setCode('w = 10;\ncube(w);');
      store.pinParam('w', 42);
      expect(useAppStore.getState().activeDraft?.pinnedParams?.['w']).toBe(42);

      store.switchThread('thread-2');
      const t2State = useAppStore.getState();
      expect(t2State.activeDraft?.pinnedParams?.['w']).toBeUndefined();

      store.switchThread('thread-1');
      await flushWrites();
      const t1State = useAppStore.getState();
      expect(t1State.code).toBe('w = 42;\ncube(w);');
    });

    it('regeneration into a background thread does not apply sticky pins', () => {
      const store = useAppStore.getState();
      // Active thread is thread-1
      expect(store.activeThreadId).toBe('thread-1');

      // Simulate regeneration writing to thread-2
      store.setCode('w = 99;\ncube(w);', 'thread-2');

      const updated = useAppStore.getState();
      const t2 = updated.threads.find((t) => t.id === 'thread-2');

      // The sticky pins were deleted, so w stays 99
      expect(t2?.code).toBe('w = 99;\ncube(w);');

      // And the active thread is completely unaffected
      expect(updated.code).toBe('cube(10);');
    });

    it('manual edits to a pinned parameter update the draft editedBody', () => {
      const store = useAppStore.getState();
      store.setCode('w = 10;\ncube(w);');
      store.pinParam('w', 42); // Pin is now 42

      // Simulate user typing w = 99 in the editor (source = 'user')
      useAppStore.getState().setCode('w = 99;\ncube(w);', undefined, 'user');

      const updated = useAppStore.getState();
      expect(updated.code).toBe('w = 99;\ncube(w);');
      expect(updated.activeDraft?.editedBody).toBe('w = 99;\ncube(w);');
      expect(updated.activeDraft?.pinnedParams?.['w']).toBe(99);
    });


  });

  describe('IndexedDB persistence', () => {
    function seedPersistedThread(id = crypto.randomUUID(), title = 'Persisted') {
      const thread = {
        id,
        title,
        createdAt: 1000,
        updatedAt: 1000,
        code: DEFAULT_CODE,
        messages: [],
      };
      useAppStore.setState({
        threads: [thread],
        activeThreadId: id,
      });
      void upsertThread(thread);
      return id;
    }

    it('persists an added message', async () => {
      const threadId = seedPersistedThread();
      useAppStore.getState().addMessage(
        { id: 'msg-1', role: 'user', content: 'hello there', timestamp: 123 },
        threadId
      );

      await flushWrites();

      const { threads } = await loadAllThreads();
      const persisted = threads.find((t) => t.id === threadId);
      expect(persisted?.messages.map((m) => m.content)).toContain('hello there');
    });

    it('persists code edits once the debounce elapses', async () => {
      const threadId = seedPersistedThread();
      useAppStore.getState().setCode('cube(42);', threadId);

      await flushWrites();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await flushWrites();

      const { threads } = await loadAllThreads();
      expect(threads.find((t) => t.id === threadId)?.code).toBe('cube(42);');
    });

    it('removes a deleted thread and its messages', async () => {
      const threadId = seedPersistedThread(crypto.randomUUID(), 'Doomed');
      useAppStore.getState().addMessage(
        { id: 'msg-1', role: 'user', content: 'bye', timestamp: 123 },
        threadId
      );
      await flushWrites();

      useAppStore.getState().deleteThread(threadId);
      await flushWrites();

      const { threads } = await loadAllThreads();
      expect(threads.some((t) => t.id === threadId)).toBe(false);
    });

    it('sliders parse the body only', () => {
      const fullScript = `stray = 5  # [0:1:10] x\n\n${PRELUDE_SENTINEL}\n\nwidth = 10  # [1:1:20] w\nresult = Box(width, 10, 10)`;
      useAppStore.getState().setCode(fullScript);
      const params = useAppStore.getState().params;
      expect(params.some((p) => p.name === 'width')).toBe(true);
      expect(params.some((p) => p.name === 'stray')).toBe(false);
    });
  });
});
