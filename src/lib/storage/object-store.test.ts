import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import {
  LocalObjectStore,
  getObjectStore,
  setObjectStore,
} from './object-store';
import { RUN_DIR_NOT_WRITABLE } from '@/lib/runs/config';

describe('LocalObjectStore', () => {
  const scratchDir = path.join(
    process.env.TMPDIR || '/home/claude/work/cadai/.cadai/scratch/pa/a45/tmp',
    'test-object-store'
  );
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(scratchDir, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    setObjectStore(undefined);
    globalThis.__cadaiS3ObjectStore = undefined;
    globalThis.__cadaiObjectStores = undefined;
  });

  afterEach(() => {
    setObjectStore(undefined);
    globalThis.__cadaiS3ObjectStore = undefined;
    globalThis.__cadaiObjectStores = undefined;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('object keys reject path traversal', async () => {
    const store = new LocalObjectStore(testDir);
    const badKeys = [
      '../etc/passwd',
      '../../secret',
      'image/../../../etc/passwd',
      'stl/../../shadow',
      'image/..',
      'image/.',
      '/etc/passwd',
      'image/validid/extra',
      'IMAGE/abcdefghijklmnopqrstuv',
      'img/abc',
      'image/',
      'image',
      '',
    ];

    const bytes = new Uint8Array([1, 2, 3]);

    for (const bad of badKeys) {
      await expect(store.put(bad, bytes)).rejects.toThrow(/Invalid object key/);
      await expect(store.openStream(bad)).rejects.toThrow(/Invalid object key/);
      await expect(store.delete(bad)).rejects.toThrow(/Invalid object key/);
    }
  });

  it('puts, reads stream, and deletes object', async () => {
    const store = new LocalObjectStore(testDir);
    const key = 'image/abcdefghijklmnopqrstuv'; // exactly 22 base64url chars
    const data = new Uint8Array([10, 20, 30, 40, 50]);

    await store.put(key, data);

    const stream = await store.openStream(key);
    expect(stream).not.toBeNull();
    expect(stream).toBeInstanceOf(Readable);

    const chunks: Buffer[] = [];
    for await (const chunk of stream!) {
      chunks.push(chunk as Buffer);
    }
    const readBytes = Buffer.concat(chunks);
    expect(readBytes).toEqual(Buffer.from(data));

    // Delete
    await store.delete(key);
    const streamAfterDelete = await store.openStream(key);
    expect(streamAfterDelete).toBeNull();
  });

  it('openStream returns null when missing', async () => {
    const store = new LocalObjectStore(testDir);
    const key = 'image/abcdefghijklmnopqrstuv';
    const stream = await store.openStream(key);
    expect(stream).toBeNull();
  });

  it('delete on missing key does not throw', async () => {
    const store = new LocalObjectStore(testDir);
    const key = 'image/abcdefghijklmnopqrstuv';
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('an unwritable directory throws RUN_DIR_NOT_WRITABLE', () => {
    const blocker = path.join(testDir, 'file.txt');
    fs.writeFileSync(blocker, 'not a dir');
    const unwritablePath = path.join(blocker, 'sub');
    expect(() => new LocalObjectStore(unwritablePath)).toThrow(
      RUN_DIR_NOT_WRITABLE
    );
  });

  it('getObjectStore defaults to LocalObjectStore and respects CADAI_ARTIFACT_STORE', () => {
    const prevEnv = process.env.CADAI_ARTIFACT_STORE;
    try {
      delete process.env.CADAI_ARTIFACT_STORE;
      const store = getObjectStore();
      expect(store).toBeInstanceOf(LocalObjectStore);

      process.env.CADAI_ARTIFACT_STORE = 'local';
      expect(getObjectStore()).toBeInstanceOf(LocalObjectStore);

      process.env.CADAI_ARTIFACT_STORE = 'unsupported';
      expect(() => getObjectStore()).toThrow(/Unsupported CADAI_ARTIFACT_STORE/);
    } finally {
      if (prevEnv !== undefined) {
        process.env.CADAI_ARTIFACT_STORE = prevEnv;
      } else {
        delete process.env.CADAI_ARTIFACT_STORE;
      }
    }
  });

  it('getObjectStore returns the same instance for the same dir', () => {
    const prevEnv = process.env.CADAI_RUN_DIR;
    try {
      process.env.CADAI_RUN_DIR = testDir;
      const store1 = getObjectStore();
      const store2 = getObjectStore();
      expect(store1).toBe(store2);
    } finally {
      if (prevEnv !== undefined) {
        process.env.CADAI_RUN_DIR = prevEnv;
      } else {
        delete process.env.CADAI_RUN_DIR;
      }
    }
  });

  it('LocalObjectStore.put unlinks tmp file if write or rename fails', async () => {
    const store = new LocalObjectStore(testDir);
    const key = 'image/abcdefghijklmnopqrstuv';

    // Mock rename to fail
    const originalRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('rename failed'));

    await expect(store.put(key, new Uint8Array([1, 2, 3]))).rejects.toThrow('rename failed');

    // Verify no tmp files left in directory
    const files = fs.readdirSync(path.join(testDir, 'image'));
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
    expect(tmpFiles).toHaveLength(0);

    vi.spyOn(fs.promises, 'rename').mockImplementation(originalRename);
  });
});
