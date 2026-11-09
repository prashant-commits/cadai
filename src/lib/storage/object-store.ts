import * as fs from 'fs';
import * as path from 'path';
import type { Readable } from 'stream';
import { runStoreDir, RUN_DIR_NOT_WRITABLE } from '@/lib/runs/config';
import { S3ObjectStore, createS3ObjectStoreFromEnv } from './s3-object-store';

export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  openStream(key: string): Promise<Readable | null>;
  delete(key: string): Promise<void>;
}

export const NEW_OBJECT_KEY_REGEX = /^a\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{22}\.[a-z]+$/;
export const LEGACY_OBJECT_KEY_REGEX = /^[a-z]+\/[A-Za-z0-9_-]{22}$/;
export const OBJECT_KEY_REGEX =
  /^(?:a\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{22}\.[a-z]+|[a-z]+\/[A-Za-z0-9_-]{22})$/;

export function validateObjectKey(key: string): void {
  if (typeof key !== 'string' || !OBJECT_KEY_REGEX.test(key)) {
    throw new Error(`Invalid object key "${key}".`);
  }
}

export function objectKeyFor(ownerKey: string, id: string, kind: string): string {
  const key = `a/${ownerKey}/${id}.${kind}`;
  validateObjectKey(key);
  return key;
}

function assertDirWritable(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    const probe = path.join(
      /*turbopackIgnore: true*/ dir,
      `.probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.writeFileSync(probe, 'probe', 'utf8');
    fs.unlinkSync(probe);
  } catch {
    throw new Error(`${RUN_DIR_NOT_WRITABLE} (${dir})`);
  }
}

export class LocalObjectStore implements ObjectStore {
  readonly dir: string;

  constructor(dir: string) {
    assertDirWritable(dir);
    this.dir = dir;
  }

  private resolvePath(key: string): string {
    validateObjectKey(key);
    return path.join(/*turbopackIgnore: true*/ this.dir, ...key.split('/'));
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const targetPath = this.resolvePath(key);
    const targetDir = path.dirname(/*turbopackIgnore: true*/ targetPath);
    await fs.promises.mkdir(targetDir, { recursive: true });

    const tmpPath = path.join(
      /*turbopackIgnore: true*/ targetDir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );

    try {
      await fs.promises.writeFile(tmpPath, bytes);
      await fs.promises.rename(tmpPath, targetPath);
    } catch (err) {
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // ignore errors
      }
      throw err;
    }
  }

  async openStream(key: string): Promise<Readable | null> {
    const targetPath = this.resolvePath(key);
    try {
      const handle = await fs.promises.open(targetPath, 'r');
      return handle.createReadStream();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const targetPath = this.resolvePath(key);
    try {
      await fs.promises.unlink(targetPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

declare global {
  var __cadaiObjectStores: Map<string, LocalObjectStore> | undefined;
  var __cadaiDefaultObjectStore: ObjectStore | undefined;
  var __cadaiS3ObjectStore: S3ObjectStore | undefined;
}

const storeCache = (globalThis.__cadaiObjectStores ??= new Map<string, LocalObjectStore>());

export function setObjectStore(store: ObjectStore | undefined): void {
  globalThis.__cadaiDefaultObjectStore = store;
}

export function getObjectStore(): ObjectStore {
  if (globalThis.__cadaiDefaultObjectStore) {
    return globalThis.__cadaiDefaultObjectStore;
  }

  const raw = (process.env.CADAI_ARTIFACT_STORE ?? '').trim().toLowerCase();
  const hasS3Bucket = Boolean(process.env.S3_BUCKET && process.env.S3_BUCKET.trim() !== '');

  if (raw === 'local') {
    const dir = path.join(/*turbopackIgnore: true*/ runStoreDir(), 'objects');
    let store = storeCache.get(dir);
    if (!store) {
      store = new LocalObjectStore(dir);
      storeCache.set(dir, store);
    }
    return store;
  }

  if (raw === 's3' || (raw === '' && hasS3Bucket)) {
    let store = globalThis.__cadaiS3ObjectStore;
    if (!store) {
      store = createS3ObjectStoreFromEnv();
      globalThis.__cadaiS3ObjectStore = store;
    }
    return store;
  }

  if (raw === '') {
    const dir = path.join(/*turbopackIgnore: true*/ runStoreDir(), 'objects');
    let store = storeCache.get(dir);
    if (!store) {
      store = new LocalObjectStore(dir);
      storeCache.set(dir, store);
    }
    return store;
  }

  throw new Error(`Unsupported CADAI_ARTIFACT_STORE "${raw}". Only "local" or "s3" is implemented.`);
}
