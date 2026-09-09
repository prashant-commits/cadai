import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCheckpointSaver } from './checkpointer';

// A fresh temp dir per test run - this is the on-disk store /api/chat/resume's
// cancel path deletes from directly, without invoking the graph at all.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-checkpointer-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeCheckpoint(id: string) {
  return {
    v: 1,
    id,
    ts: new Date().toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  } as any;
}

describe('FileCheckpointSaver', () => {
  it('persists a checkpoint to disk and reloads it in a fresh instance', async () => {
    const threadId = 'thread-persist';
    const saverA = new FileCheckpointSaver(tmpDir);
    await saverA.put(
      { configurable: { thread_id: threadId } },
      fakeCheckpoint('cp-1'),
      { source: 'update', step: 0, parents: {} } as any,
      {}
    );

    // flush() debounces at 100ms - the write must have landed before a
    // second instance tries to read it back.
    await new Promise((r) => setTimeout(r, 200));

    const saverB = new FileCheckpointSaver(tmpDir);
    const tuple = await saverB.getTuple({ configurable: { thread_id: threadId } });
    expect(tuple).toBeDefined();
    expect(tuple?.checkpoint.id).toBe('cp-1');
  });

  it('deleteThread removes a thread so a fresh instance no longer finds it', async () => {
    const threadId = 'thread-to-cancel';
    const saver = new FileCheckpointSaver(tmpDir);
    await saver.put(
      { configurable: { thread_id: threadId } },
      fakeCheckpoint('cp-cancel'),
      { source: 'update', step: 0, parents: {} } as any,
      {}
    );
    await new Promise((r) => setTimeout(r, 200));

    let tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
    expect(tuple).toBeDefined();

    // This is exactly what /api/chat/resume's cancel path calls - it must
    // not require invoking the graph at all.
    await saver.deleteThread(threadId);
    await new Promise((r) => setTimeout(r, 200));

    tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
    expect(tuple).toBeUndefined();

    // And the deletion is durable, not just in-memory on this instance.
    const freshSaver = new FileCheckpointSaver(tmpDir);
    const freshTuple = await freshSaver.getTuple({ configurable: { thread_id: threadId } });
    expect(freshTuple).toBeUndefined();
  });

  it('deleteThread on an unknown thread is a no-op, not a throw', async () => {
    const saver = new FileCheckpointSaver(tmpDir);
    await expect(saver.deleteThread('never-existed')).resolves.not.toThrow();
  });
});
