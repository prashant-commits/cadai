import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInitialThread,
  loadStoredThreads,
  saveStoredThreads,
} from './thread-storage';

describe('thread-storage', () => {
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
  });

  it('creates an initial thread with default welcome message and code', () => {
    const thread = createInitialThread();

    expect(thread.id).toBeDefined();
    expect(thread.title).toBe('Demo Rounded Box');
    expect(thread.messages.length).toBeGreaterThan(0);
    expect(thread.code).toContain('rounded_box');
    expect(thread.code).toContain('difference()');
  });

  it('saves and loads multiple threads with active thread ID', () => {
    const initial = createInitialThread();
    const secondThread = {
      ...initial,
      id: 'thread-test-2',
      title: 'Custom Gear Design',
    };

    saveStoredThreads([initial, secondThread], secondThread.id);

    const loaded = loadStoredThreads();
    expect(loaded.threads.length).toBe(2);
    expect(loaded.activeThreadId).toBe('thread-test-2');
    expect(loaded.threads[1].title).toBe('Custom Gear Design');
  });
});
