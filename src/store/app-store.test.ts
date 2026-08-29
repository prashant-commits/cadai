import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from './app-store';

describe('useAppStore thread scoping & progress isolation', () => {
  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, val: string) => {
        mockStorage[key] = val;
      },
      clear: () => {
        mockStorage = {};
      },
    });

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
          code: 'sphere(10);',
        },
      ],
      activeThreadId: 'thread-1',
      messages: [],
      code: 'cube(10);',
      isGenerating: false,
      generatingThreadId: null,
      activeProgress: null,
      progressHistory: [],
      isAnalysisCollapsed: false,
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

    // Active thread is thread-1 with code 'cube(10);'
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

  it('toggles analysis panel collapsed state', () => {
    const store = useAppStore.getState();
    expect(store.isAnalysisCollapsed).toBe(false);

    store.toggleAnalysisCollapsed();
    expect(useAppStore.getState().isAnalysisCollapsed).toBe(true);

    store.toggleAnalysisCollapsed();
    expect(useAppStore.getState().isAnalysisCollapsed).toBe(false);
  });
});
