import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from './app-store';
import { DB_NAME } from '@/lib/storage/db-schema';
import { __resetDbForTests, loadAllThreads } from '@/lib/storage/thread-storage';

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
      contractDiff: null,
      isGenerating: false,
      generatingThreadId: null,
      activeProgress: null,
      progressHistory: [],
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

  it('clears progress history properly when clearProgress is called', () => {
    const store = useAppStore.getState();

    store.addProgressUpdate({
      id: 'step-1',
      type: 'thinking',
      message: 'Analyzing...',
      timestamp: Date.now(),
    });

    expect(useAppStore.getState().progressHistory.length).toBe(1);
    expect(useAppStore.getState().activeProgress?.message).toBe('Analyzing...');

    store.clearProgress();

    expect(useAppStore.getState().progressHistory.length).toBe(0);
    expect(useAppStore.getState().activeProgress).toBeNull();
  });

  it('changes editorView state', () => {
    const store = useAppStore.getState();
    expect(store.editorView).toBe('design');

    store.setEditorView('code');
    expect(useAppStore.getState().editorView).toBe('code');
  });

  describe('Contract and Pins', () => {
    it('pinParam updates code and contract together', () => {
      const store = useAppStore.getState();
      store.setCode('w = 10;\ncube(w);'); // set code first to parse params
      
      useAppStore.getState().pinParam('w', 55);
      
      const updated = useAppStore.getState();
      expect(updated.code).toBe('w = 55;\ncube(w);');
      
      const activeThread = updated.threads.find(t => t.id === updated.activeThreadId);
      expect(activeThread?.designContract?.pinnedParams['w'].value).toBe(55);
      expect(activeThread?.designContract?.pinnedParams['w'].supersededValue).toBe(10);
    });

    it('unpinParam restores supersededValue', () => {
      const store = useAppStore.getState();
      store.switchThread('thread-2'); // active code is 'w = 10; cube(w);' with pin w=20, superseded=10
      // the initial code is 'w = 10; cube(w);'. wait, if w is pinned to 20, the code in state is 'w = 10...' 
      // let's just make it right.
      useAppStore.getState().setCode('w = 20;\ncube(w);'); // sync it
      
      useAppStore.getState().unpinParam('w');
      
      const updated = useAppStore.getState();
      expect(updated.code).toBe('w = 10;\ncube(w);');
      
      const activeThread = updated.threads.find(t => t.id === updated.activeThreadId);
      expect(activeThread?.designContract?.pinnedParams['w']).toBeUndefined();
    });

    it('pins are thread-scoped and do not leak across switchThread', () => {
      const store = useAppStore.getState();
      store.setCode('w = 10; cube(w);');
      store.pinParam('w', 42);
      
      store.switchThread('thread-2');
      const t2State = useAppStore.getState();
      // thread-2 has its own contract defined in beforeEach
      const activeThread = t2State.threads.find(t => t.id === t2State.activeThreadId);
      expect(activeThread?.designContract?.pinnedParams['w'].value).toBe(20);
      
      store.switchThread('thread-1');
      const t1State = useAppStore.getState();
      const t1Thread = t1State.threads.find(t => t.id === t1State.activeThreadId);
      expect(t1Thread?.designContract?.pinnedParams['w'].value).toBe(42);
    });

    it('regeneration into a background thread merges against the correct contract', () => {
      const store = useAppStore.getState();
      // Active thread is thread-1. thread-2 has a pin for w=20.
      
      // Simulate regeneration writing to thread-2
      store.setCode('w = 99;\ncube(w);', 'thread-2');
      
      const updated = useAppStore.getState();
      const t2 = updated.threads.find(t => t.id === 'thread-2');
      
      // The pin in thread-2 forces w back to 20
      expect(t2?.code).toBe('w = 20;\ncube(w);');
      
      // And the active thread is completely unaffected
      expect(updated.code).toBe('cube(10);');
    });

    it('manual edits to a pinned parameter update the pin instead of reverting', () => {
      const store = useAppStore.getState();
      store.setCode('w = 10;\ncube(w);');
      store.pinParam('w', 42); // Pin is now 42
      
      // Simulate user typing w = 99 in the editor (source = 'user')
      useAppStore.getState().setCode('w = 99;\ncube(w);', undefined, 'user');
      
      const updated = useAppStore.getState();
      expect(updated.code).toBe('w = 99;\ncube(w);'); // Code stays what user typed
      
      const activeThread = updated.threads.find(t => t.id === updated.activeThreadId);
      expect(activeThread?.designContract?.pinnedParams['w'].value).toBe(99); // Pin updated to 99
      expect(activeThread?.designContract?.pinnedParams['w'].supersededValue).toBe(10); // supersededValue unchanged
    });
  });

  describe('IndexedDB persistence', () => {
    it('persists an added message', async () => {
      const threadId = useAppStore.getState().createNewThread('Persisted');
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
      const threadId = useAppStore.getState().createNewThread('Persisted');
      useAppStore.getState().setCode('cube(42);', threadId);

      await flushWrites();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await flushWrites();

      const { threads } = await loadAllThreads();
      expect(threads.find((t) => t.id === threadId)?.code).toBe('cube(42);');
    });

    it('removes a deleted thread and its messages', async () => {
      const threadId = useAppStore.getState().createNewThread('Doomed');
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
  });
});
