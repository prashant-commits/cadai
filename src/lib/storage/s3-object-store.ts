import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { validateObjectKey, type ObjectStore } from './object-store';

function toNodeReadable(body: unknown): Readable | null {
  if (!body) {
    return null;
  }
  if (body instanceof Readable) {
    return body;
  }
  if (typeof (body as { getReader?: unknown }).getReader === 'function') {
    return Readable.fromWeb(body as WebReadableStream);
  }
  return body as Readable;
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.$metadata?.httpStatusCode === 404
  );
}

export class S3ObjectStore implements ObjectStore {
  readonly bucket: string;
  readonly client: S3Client;

  constructor({ bucket, client }: { bucket: string; client: S3Client }) {
    this.bucket = bucket;
    this.client = client;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    validateObjectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'application/octet-stream',
      })
    );
  }

  async openStream(key: string): Promise<Readable | null> {
    validateObjectKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return toNodeReadable(res.Body);
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    validateObjectKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
    } catch (err) {
      if (isNotFound(err)) {
        return;
      }
      throw err;
    }
  }
}

export function createS3ObjectStoreFromEnv(
  env: Record<string, string | undefined> = process.env
): S3ObjectStore {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) {
    throw new Error('S3_BUCKET is required for the S3 object store.');
  }

  const forcePathStyle =
    env.S3_FORCE_PATH_STYLE === '1' || env.S3_FORCE_PATH_STYLE === 'true';

  const client = new S3Client({
    region: env.S3_REGION || undefined,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle,
  });

  return new S3ObjectStore({ bucket, client });
}
