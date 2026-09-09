import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatThread } from '@/types';
import {
  __resetDbForTests,
  clearThreadMessages,
  createInitialThread,
  deleteThreadCascade,
  loadAllThreads,
  setActiveThreadId,
  setCodeDebounced,
  upsertMessage,
  upsertThread,
} from './thread-storage';
import { DB_NAME } from './db-schema';

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    title: 'Bracket',
    createdAt: 1000,
    updatedAt: 1000,
    code: 'cube(10);',
    messages: [],
    ...overrides,
  };
}

describe('thread-storage', () => {
  beforeEach(async () => {
    await __resetDbForTests();
    await deleteDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates an initial thread with default welcome message and code', () => {
    const initial = createInitialThread();

    expect(initial.id).toBeDefined();
    expect(initial.title).toBe('Demo Rounded Box');
    expect(initial.messages.length).toBeGreaterThan(0);
    expect(initial.code).toContain('rounded_box');
    expect(initial.code).toContain('difference()');
  });

  it('bootstraps and persists an initial thread on an empty database', async () => {
    const first = await loadAllThreads();
    expect(first.threads).toHaveLength(1);
    expect(first.activeThreadId).toBe(first.threads[0].id);

    // A second load must return the same persisted thread, not a new one.
    const second = await loadAllThreads();
    expect(second.threads).toHaveLength(1);
    expect(second.threads[0].id).toBe(first.threads[0].id);
    expect(second.threads[0].messages).toHaveLength(first.threads[0].messages.length);
  });

  it('bootstraps once when two loads race (React StrictMode double-invoke)', async () => {
    const [first, second] = await Promise.all([loadAllThreads(), loadAllThreads()]);

    expect(first.threads).toHaveLength(1);
    expect(second.threads).toHaveLength(1);
    expect(first.threads[0].id).toBe(second.threads[0].id);

    const { threads } = await loadAllThreads();
    expect(threads).toHaveLength(1);
  });

  it('round-trips threads, messages and per-message code across the three stores', async () => {
    const target = thread({ id: 'thread-a', stlContent: 'solid x', selectedModel: 'gemini-3.6-flash' });
    await upsertThread(target);
    await upsertMessage('thread-a', {
      id: 'm2',
      role: 'assistant',
      content: 'Here you go',
      code: 'sphere(4);',
      timestamp: 2000,
    });
    await upsertMessage('thread-a', {
      id: 'm1',
      role: 'user',
      content: 'Make a sphere',
      image: 'data:image/png;base64,AAAA',
      timestamp: 1000,
    });
    await setActiveThreadId('thread-a');

    const { threads, activeThreadId } = await loadAllThreads();

    expect(activeThreadId).toBe('thread-a');
    expect(threads).toHaveLength(1);

    const loaded = threads[0];
    expect(loaded.title).toBe('Bracket');
    expect(loaded.stlContent).toBe('solid x');

    // Ordered by timestamp, not insertion order.
    expect(loaded.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(loaded.messages[0].image).toBe('data:image/png;base64,AAAA');
    expect(loaded.messages[0].code).toBeUndefined();
    expect(loaded.messages[1].code).toBe('sphere(4);');
  });

  it('keeps message ids that repeat across threads separate', async () => {
    await upsertThread(thread({ id: 'thread-a', createdAt: 2000 }));
    await upsertThread(thread({ id: 'thread-b', createdAt: 1000 }));
    await upsertMessage('thread-a', {
      id: 'welcome-msg',
      role: 'assistant',
      content: 'A',
      timestamp: 1,
    });
    await upsertMessage('thread-b', {
      id: 'welcome-msg',
      role: 'assistant',
      content: 'B',
      timestamp: 1,
    });

    const { threads } = await loadAllThreads();

    expect(threads.find((t) => t.id === 'thread-a')!.messages[0].content).toBe('A');
    expect(threads.find((t) => t.id === 'thread-b')!.messages[0].content).toBe('B');
  });

  it('drops a code snapshot when a message no longer carries code', async () => {
    await upsertThread(thread({ id: 'thread-a' }));
    const message = { id: 'm1', role: 'assistant' as const, content: 'x', timestamp: 1 };

    await upsertMessage('thread-a', { ...message, code: 'cube(1);' });
    await upsertMessage('thread-a', message);

    const { threads } = await loadAllThreads();
    expect(threads[0].messages[0].code).toBeUndefined();
  });

  it('cascades a delete across threads, messages and code', async () => {
    await upsertThread(thread({ id: 'thread-a', createdAt: 2000 }));
    await upsertThread(thread({ id: 'thread-b', createdAt: 1000 }));
    await upsertMessage('thread-a', {
      id: 'm1',
      role: 'assistant',
      content: 'x',
      code: 'cube(1);',
      timestamp: 1,
    });
    await upsertMessage('thread-b', {
      id: 'm1',
      role: 'assistant',
      content: 'keep me',
      code: 'cube(2);',
      timestamp: 1,
    });

    await deleteThreadCascade('thread-a');

    const { threads } = await loadAllThreads();
    expect(threads.map((t) => t.id)).toEqual(['thread-b']);
    expect(threads[0].messages[0].code).toBe('cube(2);');
  });

  it('clears a thread\'s messages while keeping the thread', async () => {
    await upsertThread(thread({ id: 'thread-a' }));
    await upsertMessage('thread-a', {
      id: 'm1',
      role: 'assistant',
      content: 'x',
      code: 'cube(1);',
      timestamp: 1,
    });

    await clearThreadMessages('thread-a');

    const { threads } = await loadAllThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].messages).toHaveLength(0);
  });

  it('falls back to the first thread when the active id no longer exists', async () => {
    await upsertThread(thread({ id: 'thread-a', createdAt: 1000 }));
    await upsertThread(thread({ id: 'thread-b', createdAt: 2000 }));
    await setActiveThreadId('thread-gone');

    const { threads, activeThreadId } = await loadAllThreads();

    // Newest first.
    expect(threads.map((t) => t.id)).toEqual(['thread-b', 'thread-a']);
    expect(activeThreadId).toBe('thread-b');
  });

  it('backfills a design contract on threads stored without one', async () => {
    await upsertThread(thread({ id: 'thread-a' }));

    const { threads } = await loadAllThreads();
    expect(threads[0].designContract).toEqual({ standing: {}, pinnedParams: {} });
  });

  describe('migration from the legacy localStorage blob', () => {
    let store: Record<string, string>;

    beforeEach(() => {
      store = {};
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
        removeItem: (key: string) => {
          delete store[key];
        },
      });
    });

    const legacyThread: ChatThread = {
      id: 'legacy-1',
      title: 'Legacy Design',
      createdAt: 500,
      updatedAt: 900,
      code: 'cylinder(r=2,h=5);',
      stlContent: 'solid legacy',
      messages: [
        { id: 'welcome-msg', role: 'assistant', content: 'Hi', code: 'cube(1);', timestamp: 100 },
        { id: 'u1', role: 'user', content: 'Make it taller', timestamp: 200 },
      ],
    };

    it('moves a v2 blob into the normalized stores and clears the old keys', async () => {
      store['cadai_threads_v2'] = JSON.stringify([legacyThread]);
      store['cadai_active_thread_id_v2'] = 'legacy-1';

      const { threads, activeThreadId } = await loadAllThreads();

      expect(activeThreadId).toBe('legacy-1');
      expect(threads).toHaveLength(1);
      expect(threads[0].title).toBe('Legacy Design');
      expect(threads[0].stlContent).toBe('solid legacy');
      expect(threads[0].messages.map((m) => m.id)).toEqual(['welcome-msg', 'u1']);
      expect(threads[0].messages[0].code).toBe('cube(1);');
      expect(threads[0].messages[1].code).toBeUndefined();

      expect(store['cadai_threads_v2']).toBeUndefined();
      expect(store['cadai_active_thread_id_v2']).toBeUndefined();
    });

    it('falls back to a v1 blob when no v2 blob exists', async () => {
      store['cadai_threads_v1'] = JSON.stringify([legacyThread]);
      store['cadai_active_thread_id_v1'] = 'legacy-1';

      const { threads } = await loadAllThreads();

      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe('legacy-1');
      expect(store['cadai_threads_v1']).toBeUndefined();
    });

    it('does not re-migrate once threads live in IndexedDB', async () => {
      store['cadai_threads_v2'] = JSON.stringify([legacyThread]);
      await loadAllThreads();

      // A stale blob reappearing must not overwrite newer IndexedDB state.
      store['cadai_threads_v2'] = JSON.stringify([
        { ...legacyThread, title: 'Should Not Win' },
      ]);

      const { threads } = await loadAllThreads();
      expect(threads[0].title).toBe('Legacy Design');
    });
  });

  describe('debounced code writes', () => {
    // fake-indexeddb drives its transactions off setImmediate, so only the
    // debounce's own setTimeout is faked here.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Lets the IndexedDB work kicked off by a fired timer actually run. */
    async function flushIdb() {
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    it('collapses rapid calls into a single write of the latest code', async () => {
      await upsertThread(thread({ id: 'thread-a', code: 'original' }));

      setCodeDebounced('thread-a', 'v1', 1001);
      setCodeDebounced('thread-a', 'v2', 1002);
      setCodeDebounced('thread-a', 'v3', 1003);

      // Nothing written yet.
      await vi.advanceTimersByTimeAsync(399);
      await flushIdb();
      let loaded = await loadAllThreads();
      expect(loaded.threads[0].code).toBe('original');

      await vi.advanceTimersByTimeAsync(1);
      await flushIdb();
      loaded = await loadAllThreads();
      expect(loaded.threads[0].code).toBe('v3');
      expect(loaded.threads[0].updatedAt).toBe(1003);
    });

    it('leaves other thread fields untouched', async () => {
      await upsertThread(thread({ id: 'thread-a', stlContent: 'solid keep', title: 'Keep Me' }));

      setCodeDebounced('thread-a', 'next', 2000);
      await vi.advanceTimersByTimeAsync(400);
      await flushIdb();

      const { threads } = await loadAllThreads();
      expect(threads[0].code).toBe('next');
      expect(threads[0].stlContent).toBe('solid keep');
      expect(threads[0].title).toBe('Keep Me');
    });

    it('is a no-op when the thread was deleted mid-debounce', async () => {
      await upsertThread(thread({ id: 'thread-a' }));

      setCodeDebounced('thread-a', 'orphan', 3000);
      await deleteThreadCascade('thread-a');
      await vi.advanceTimersByTimeAsync(400);
      await flushIdb();

      const { threads } = await loadAllThreads();
      expect(threads.some((t) => t.code === 'orphan')).toBe(false);
    });
  });
});
