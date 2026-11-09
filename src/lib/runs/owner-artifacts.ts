import * as crypto from 'crypto';
import type { Readable } from 'stream';
import { getDb, type Db, type Queryable } from '@/lib/db/db';
import { getObjectStore, objectKeyFor, type ObjectStore } from '@/lib/storage/object-store';
import { rowToArtifact, type ArtifactRow } from '@/lib/persist/types';

export type OwnerArtifactKind = 'stl' | 'step' | 'image' | 'topo';

export interface OwnerArtifactsDeps {
  db?: Db;
  objectStore?: ObjectStore;
}

declare global {
  var __cadaiOwnerArtifactDeps: OwnerArtifactsDeps | undefined;
}

export function setOwnerArtifactsDeps(deps: OwnerArtifactsDeps | undefined): void {
  globalThis.__cadaiOwnerArtifactDeps = deps;
}

export function newArtifactId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

const ARTIFACT_ID_REGEX = /^[A-Za-z0-9_-]{22}$/;

export async function put(
  ownerKey: string,
  kind: OwnerArtifactKind,
  bytes: Uint8Array,
  opts?: { threadId?: string; runId?: string },
  deps?: OwnerArtifactsDeps
): Promise<string> {
  const db = deps?.db ?? globalThis.__cadaiOwnerArtifactDeps?.db ?? getDb();
  const objectStore = deps?.objectStore ?? globalThis.__cadaiOwnerArtifactDeps?.objectStore ?? getObjectStore();

  const id = newArtifactId();
  const objectKey = objectKeyFor(ownerKey, id, kind);
  const threadId = opts?.threadId ?? null;
  const runId = opts?.runId ?? null;

  await db.transaction(async (q) => {
    await q.query(
      `INSERT INTO artifacts(id, owner_key, thread_id, run_id, kind, bytes, object_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, ownerKey, threadId, runId, kind, bytes.byteLength, objectKey]
    );
  });

  await objectStore.put(objectKey, bytes);
  return id;
}

export async function get(
  q: Queryable,
  ownerKey: string,
  id: string
): Promise<ArtifactRow | null> {
  if (!id || typeof id !== 'string' || !ARTIFACT_ID_REGEX.test(id)) {
    return null;
  }

  const res = await q.query(
    `SELECT id, owner_key, thread_id, run_id, kind, bytes, object_key, created_at
     FROM artifacts WHERE id = $1 AND owner_key = $2`,
    [id, ownerKey]
  );

  if (res.rows.length === 0) {
    return null;
  }

  return rowToArtifact(res.rows[0]);
}

export async function openStream(
  ownerKey: string,
  id: string,
  deps?: OwnerArtifactsDeps
): Promise<{ row: ArtifactRow; stream: Readable } | null> {
  const db = deps?.db ?? globalThis.__cadaiOwnerArtifactDeps?.db ?? getDb();
  const objectStore = deps?.objectStore ?? globalThis.__cadaiOwnerArtifactDeps?.objectStore ?? getObjectStore();

  const row = await get(db, ownerKey, id);
  if (!row) {
    return null;
  }

  const stream = await objectStore.openStream(row.objectKey);
  if (!stream) {
    return null;
  }

  return { row, stream };
}
