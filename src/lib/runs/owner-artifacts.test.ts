import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as crypto from 'crypto';
import type { Readable } from 'stream';
import { getDb, closeDb } from '@/lib/db/db';
import {
  newArtifactId,
  put,
  get,
  openStream,
  setOwnerArtifactsDeps,
} from './owner-artifacts';
import {
  LocalObjectStore,
  type ObjectStore,
} from '@/lib/storage/object-store';

describe('owner-artifacts', () => {
  const scratchDir =
    process.env.TMPDIR || '/home/claude/work/cadai/.cadai/scratch/pa/a45/tmp';
  let objectStore: LocalObjectStore;
  let testDir: string;

  beforeEach(() => {
    testDir = `${scratchDir}/art-store-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    objectStore = new LocalObjectStore(testDir);
    setOwnerArtifactsDeps({ objectStore });
  });

  afterEach(() => {
    setOwnerArtifactsDeps(undefined);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('identical bytes, two owners → distinct ids', async () => {
    const ownerA = `owner_${crypto.randomUUID()}`;
    const ownerB = `owner_${crypto.randomUUID()}`;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const idA = await put(ownerA, 'image', bytes);
    const idB = await put(ownerB, 'image', bytes);

    expect(idA).not.toBe(idB);
  });

  it('ids are 128-bit', () => {
    const id1 = newArtifactId();
    const id2 = newArtifactId();

    expect(id1).not.toBe(id2);
    expect(id1).toHaveLength(22);
    expect(id2).toHaveLength(22);

    const buf1 = Buffer.from(id1, 'base64url');
    const buf2 = Buffer.from(id2, 'base64url');

    expect(buf1.byteLength).toBe(16);
    expect(buf2.byteLength).toBe(16);
  });

  it('get from another owner → null', async () => {
    const db = getDb();
    const ownerA = `owner_${crypto.randomUUID()}`;
    const ownerB = `owner_${crypto.randomUUID()}`;
    const bytes = new Uint8Array([42]);

    const id = await put(ownerA, 'stl', bytes);

    const rowForA = await get(db, ownerA, id);
    expect(rowForA).not.toBeNull();
    expect(rowForA?.id).toBe(id);
    expect(rowForA?.ownerKey).toBe(ownerA);
    expect(rowForA?.kind).toBe('stl');
    expect(rowForA?.bytes).toBe(1);

    const rowForB = await get(db, ownerB, id);
    expect(rowForB).toBeNull();

    // Unknown or malformed ids return null
    expect(await get(db, ownerA, 'non-existent-22-chars-')).toBeNull();
    expect(await get(db, ownerA, 'short')).toBeNull();
    expect(await get(db, ownerA, '../../../etc/passwd')).toBeNull();
  });

  it('put inserts the row before writing the object', async () => {
    const owner = `owner_${crypto.randomUUID()}`;
    const bytes = new Uint8Array([7, 8, 9]);
    let rowVisibleInDbDuringPut = false;

    const fakeObjectStore: ObjectStore = {
      async put(key: string): Promise<void> {
        // key format is `${kind}/${id}`
        const id = key.split('/')[1];
        const res = await getDb().query('SELECT id FROM artifacts WHERE id = $1', [id]);
        if (res.rows.length === 1 && res.rows[0].id === id) {
          rowVisibleInDbDuringPut = true;
        }
      },
      async openStream(): Promise<Readable | null> {
        return null;
      },
      async delete(): Promise<void> {},
    };

    const id = await put(owner, 'image', bytes, undefined, { objectStore: fakeObjectStore });
    expect(id).toBeDefined();
    expect(rowVisibleInDbDuringPut).toBe(true);
  });

  it('openStream returns the bytes for the owner and null for another owner', async () => {
    const ownerA = `owner_${crypto.randomUUID()}`;
    const ownerB = `owner_${crypto.randomUUID()}`;
    const data = new Uint8Array([11, 22, 33, 44, 55]);

    const id = await put(ownerA, 'step', data);

    // Owner A can read
    const resultA = await openStream(ownerA, id);
    expect(resultA).not.toBeNull();
    expect(resultA?.row.id).toBe(id);
    expect(resultA?.row.kind).toBe('step');

    const chunks: Buffer[] = [];
    for await (const chunk of resultA!.stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(data));

    // Owner B gets null
    const resultB = await openStream(ownerB, id);
    expect(resultB).toBeNull();

    // Unknown id gets null
    const resultMissing = await openStream(ownerA, 'missing22charslongid--');
    expect(resultMissing).toBeNull();
  });

  it('put supports optional threadId and runId when thread row exists', async () => {
    const db = getDb();
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();
    const runId = `run_${crypto.randomUUID()}`;

    // Insert thread first (FK constraint)
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerKey]);

    const id = await put(ownerKey, 'stl', new Uint8Array([1]), { threadId, runId });
    const row = await get(db, ownerKey, id);
    expect(row).not.toBeNull();
    expect(row?.threadId).toBe(threadId);
    expect(row?.runId).toBe(runId);
  });
});
