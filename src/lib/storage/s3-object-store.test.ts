import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  S3ObjectStore,
  createS3ObjectStoreFromEnv,
} from './s3-object-store';
import {
  getObjectStore,
  setObjectStore,
  objectKeyFor,
  validateObjectKey,
  LocalObjectStore,
} from './object-store';
import { put, setOwnerArtifactsDeps } from '@/lib/runs/owner-artifacts';
import { getDb, closeDb } from '@/lib/db/db';

interface S3Error extends Error {
  $metadata?: { httpStatusCode?: number };
}

interface RecordedCommand {
  command: unknown;
  name: string;
  input: Record<string, unknown>;
}

class FakeS3Client {
  readonly recorded: RecordedCommand[] = [];
  readonly storage = new Map<string, Uint8Array>();
  getHandler?: (
    input: Record<string, unknown>
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;

  async send(command: {
    input?: Record<string, unknown>;
    constructor: { name: string };
  }): Promise<Record<string, unknown>> {
    const input = (command.input ?? {}) as Record<string, unknown>;
    const name = command.constructor.name;
    this.recorded.push({ command, name, input });

    if (name === 'PutObjectCommand') {
      const body = input.Body;
      let bodyBytes: Uint8Array;
      if (body instanceof Uint8Array) {
        bodyBytes = body;
      } else if (typeof body === 'string') {
        bodyBytes = Buffer.from(body);
      } else {
        bodyBytes = new Uint8Array(body as ArrayBuffer);
      }
      this.storage.set(`${String(input.Bucket)}/${String(input.Key)}`, bodyBytes);
      return {};
    }

    if (name === 'GetObjectCommand') {
      if (this.getHandler) {
        return this.getHandler(input);
      }
      const data = this.storage.get(`${String(input.Bucket)}/${String(input.Key)}`);
      if (!data) {
        const error = new Error('NoSuchKey') as S3Error;
        error.name = 'NoSuchKey';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {
        Body: Readable.from(Buffer.from(data)),
      };
    }

    if (name === 'DeleteObjectCommand') {
      this.storage.delete(`${String(input.Bucket)}/${String(input.Key)}`);
      return {};
    }

    throw new Error(`Unhandled command in FakeS3Client: ${name}`);
  }
}

describe('S3ObjectStore', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    setObjectStore(undefined);
    setOwnerArtifactsDeps(undefined);
    globalThis.__cadaiS3ObjectStore = undefined;
    globalThis.__cadaiObjectStores = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setObjectStore(undefined);
    setOwnerArtifactsDeps(undefined);
    globalThis.__cadaiS3ObjectStore = undefined;
    globalThis.__cadaiObjectStores = undefined;
  });

  afterAll(async () => {
    await closeDb();
  });

  it('s3 put/get/delete round-trip', async () => {
    const fakeClient = new FakeS3Client();
    const store = new S3ObjectStore({
      bucket: 'test-bucket',
      client: fakeClient as unknown as S3Client,
    });
    const key = objectKeyFor('owner1', 'abcdefghijklmnopqrstuv', 'stl');
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    await store.put(key, bytes);

    const stream = await store.openStream(key);
    expect(stream).not.toBeNull();
    expect(stream).toBeInstanceOf(Readable);

    const chunks: Buffer[] = [];
    for await (const chunk of stream!) {
      chunks.push(chunk as Buffer);
    }
    const readBytes = Buffer.concat(chunks);
    expect(readBytes).toEqual(Buffer.from(bytes));

    await store.delete(key);
    const streamAfterDelete = await store.openStream(key);
    expect(streamAfterDelete).toBeNull();
  });

  it('s3 keys are a/<ownerKey>/<id>.<kind>', async () => {
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const bytes = new Uint8Array([10, 20, 30]);
    const fakeClient = new FakeS3Client();
    const store = new S3ObjectStore({
      bucket: 'test-bucket',
      client: fakeClient as unknown as S3Client,
    });
    const db = getDb();
    setOwnerArtifactsDeps({ db, objectStore: store });

    const id = await put(ownerKey, 'stl', bytes);

    const putCmd = fakeClient.recorded.find((c) => c.name === 'PutObjectCommand');
    expect(putCmd).toBeDefined();
    expect(putCmd!.input.Bucket).toBe('test-bucket');
    expect(putCmd!.input.Key).toBe(`a/${ownerKey}/${id}.stl`);

    const row = await db.query<{ object_key: string }>(
      'SELECT object_key FROM artifacts WHERE id = $1',
      [id]
    );
    expect(row.rows[0].object_key).toBe(`a/${ownerKey}/${id}.stl`);
  });

  it('s3 missing object → null', async () => {
    const fakeClient = new FakeS3Client();
    fakeClient.getHandler = () => {
      const error = new Error('NoSuchKey') as S3Error;
      error.name = 'NoSuchKey';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    };
    const store = new S3ObjectStore({
      bucket: 'my-bucket',
      client: fakeClient as unknown as S3Client,
    });
    const key = objectKeyFor('owner', 'abcdefghijklmnopqrstuv', 'stl');
    expect(await store.openStream(key)).toBeNull();

    // NotFound name
    fakeClient.getHandler = () => {
      const error = new Error('NotFound');
      error.name = 'NotFound';
      throw error;
    };
    expect(await store.openStream(key)).toBeNull();

    // 404 status code without name
    fakeClient.getHandler = () => {
      const error = new Error('Something404') as S3Error;
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    };
    expect(await store.openStream(key)).toBeNull();
  });

  it('s3 other errors throw', async () => {
    const fakeClient = new FakeS3Client();
    fakeClient.getHandler = () => {
      const error = new Error('AccessDenied') as S3Error;
      error.name = 'AccessDenied';
      error.$metadata = { httpStatusCode: 403 };
      throw error;
    };
    const store = new S3ObjectStore({
      bucket: 'my-bucket',
      client: fakeClient as unknown as S3Client,
    });
    const key = objectKeyFor('owner', 'abcdefghijklmnopqrstuv', 'stl');
    await expect(store.openStream(key)).rejects.toThrow('AccessDenied');
  });

  it('s3 stream round-trip', async () => {
    const fakeClient = new FakeS3Client();
    const store = new S3ObjectStore({
      bucket: 'my-bucket',
      client: fakeClient as unknown as S3Client,
    });
    const key = objectKeyFor('owner', 'abcdefghijklmnopqrstuv', 'stl');
    const largeData = crypto.randomBytes(1024 * 1024); // 1 MiB

    await store.put(key, largeData);
    const stream = await store.openStream(key);
    expect(stream).not.toBeNull();
    expect(stream).toBeInstanceOf(Readable);

    const chunks: Buffer[] = [];
    for await (const chunk of stream!) {
      chunks.push(Buffer.from(chunk));
    }
    const full = Buffer.concat(chunks);
    expect(full.byteLength).toBe(1024 * 1024);
    expect(full.equals(largeData)).toBe(true);
  });

  it('s3 openStream wraps web ReadableStream with Readable.fromWeb', async () => {
    const fakeClient = new FakeS3Client();
    const data = Buffer.from('web stream data');
    fakeClient.getHandler = () => {
      const webStream = new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      return { Body: webStream };
    };
    const store = new S3ObjectStore({
      bucket: 'my-bucket',
      client: fakeClient as unknown as S3Client,
    });
    const key = objectKeyFor('owner', 'abcdefghijklmnopqrstuv', 'stl');
    const stream = await store.openStream(key);
    expect(stream).not.toBeNull();
    expect(stream).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });

  it('s3 rejects invalid keys', async () => {
    const fakeClient = new FakeS3Client();
    const store = new S3ObjectStore({
      bucket: 'my-bucket',
      client: fakeClient as unknown as S3Client,
    });
    const badKeys = [
      '../etc/passwd',
      '../../secret',
      'a/../../../etc/passwd',
      'a/owner/../secret',
      'a//abcdefghijklmnopqrstuv.stl',
      'a/owner/badid.stl',
      'invalid-key',
      '/a/owner/abcdefghijklmnopqrstuv.stl',
      'a/owner/abcdefghijklmnopqrstuv.stl/',
      '',
    ];
    const bytes = new Uint8Array([1, 2, 3]);

    for (const bad of badKeys) {
      await expect(store.put(bad, bytes)).rejects.toThrow(/Invalid object key/);
      await expect(store.openStream(bad)).rejects.toThrow(/Invalid object key/);
      await expect(store.delete(bad)).rejects.toThrow(/Invalid object key/);
    }
    expect(fakeClient.recorded.length).toBe(0);
  });

  it('s3 never sets an ACL', async () => {
    const fakeClient = new FakeS3Client();
    const store = new S3ObjectStore({
      bucket: 'my-bucket',
      client: fakeClient as unknown as S3Client,
    });
    const key = objectKeyFor('owner', 'abcdefghijklmnopqrstuv', 'stl');
    await store.put(key, new Uint8Array([1, 2, 3]));
    await store.openStream(key);
    await store.delete(key);

    expect(fakeClient.recorded.length).toBeGreaterThan(0);
    for (const rec of fakeClient.recorded) {
      expect(rec.input.ACL).toBeUndefined();
      expect('ACL' in rec.input).toBe(false);
    }
  });

  it('getObjectStore picks S3 when S3_BUCKET is set', () => {
    vi.stubEnv('S3_BUCKET', 'test-bucket');
    vi.stubEnv('CADAI_ARTIFACT_STORE', '');
    const store = getObjectStore();
    expect(store).toBeInstanceOf(S3ObjectStore);
    expect((store as S3ObjectStore).bucket).toBe('test-bucket');
  });

  it('CADAI_ARTIFACT_STORE=local wins over S3_BUCKET', () => {
    vi.stubEnv('CADAI_ARTIFACT_STORE', 'local');
    vi.stubEnv('S3_BUCKET', 'test-bucket');
    const store = getObjectStore();
    expect(store).toBeInstanceOf(LocalObjectStore);
  });

  it('CADAI_ARTIFACT_STORE=s3 without S3_BUCKET throws', () => {
    vi.stubEnv('CADAI_ARTIFACT_STORE', 's3');
    vi.stubEnv('S3_BUCKET', '');
    expect(() => getObjectStore()).toThrow('S3_BUCKET is required for the S3 object store.');
  });

  it('objectKeyFor builds a/<ownerKey>/<id>.<kind>', () => {
    const key = objectKeyFor('owner1', 'abcdefghijklmnopqrstuv', 'stl');
    expect(key).toBe('a/owner1/abcdefghijklmnopqrstuv.stl');

    expect(() => objectKeyFor('../owner', 'abcdefghijklmnopqrstuv', 'stl')).toThrow(
      /Invalid object key/
    );
    expect(() => objectKeyFor('owner', 'short', 'stl')).toThrow(/Invalid object key/);
    expect(() => objectKeyFor('owner', 'abcdefghijklmnopqrstuv', 'INVALID')).toThrow(
      /Invalid object key/
    );
  });

  it('legacy keys still validate', () => {
    expect(() => validateObjectKey('stl/abcdefghijklmnopqrstuv')).not.toThrow();
    expect(() => validateObjectKey('image/1234567890123456789012')).not.toThrow();
    expect(() => validateObjectKey('step/abcdefghijklmnopqrstuv')).not.toThrow();
  });

  describe.skipIf(!process.env.S3_TEST_BUCKET)('s3 live', () => {
    it('put/get/delete live', async () => {
      const store = createS3ObjectStoreFromEnv({
        ...process.env,
        S3_BUCKET: process.env.S3_TEST_BUCKET,
      });
      const key = objectKeyFor(
        `test-owner-${Date.now()}`,
        crypto.randomBytes(16).toString('base64url'),
        'stl'
      );
      const data = new Uint8Array([1, 2, 3]);
      await store.put(key, data);
      const stream = await store.openStream(key);
      expect(stream).not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(data));
      await store.delete(key);
      expect(await store.openStream(key)).toBeNull();
    });
  });
});
