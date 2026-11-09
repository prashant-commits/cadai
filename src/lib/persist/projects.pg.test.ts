import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { createPgDb } from '@/lib/db/pg';
import { migrate } from '@/lib/db/migrate';
import { pgTestUrl } from '@/lib/db/test-pg';
import { ProjectStore } from './projects';
import type { Db } from '@/lib/db/db';
import type { Pool } from 'pg';

describe('ProjectStore (Postgres concurrency)', () => {
  let db: Db & { pool: Pool };

  beforeAll(async () => {
    db = createPgDb(pgTestUrl(), { max: 4 });
    await migrate(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('two concurrent ensureDefault calls create one project', async () => {
    const ownerKey = `owner_${crypto.randomUUID()}`;
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();

    // seed null-project threads for a fresh owner
    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2), ($3, $4)`, [
      t1,
      ownerKey,
      t2,
      ownerKey,
    ]);

    // Force the overlap: A runs ensureDefault and holds its transaction open,
    // then B starts. Without a per-owner lock B would not see A's uncommitted
    // project and would create a second one.
    let reachedA!: () => void;
    const aReached = new Promise<void>((r) => { reachedA = r; });
    let releaseA!: () => void;
    const aHeld = new Promise<void>((r) => { releaseA = r; });

    const a = db.transaction(async (q) => {
      const id = await ProjectStore.ensureDefault(q, ownerKey);
      reachedA();
      await aHeld;
      return id;
    });
    await aReached;
    const b = db.transaction((q) => ProjectStore.ensureDefault(q, ownerKey));
    await new Promise((r) => setTimeout(r, 300));
    releaseA();
    const [id1, id2] = await Promise.all([a, b]);

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).toBe(id2);

    const projs = await db.query(
      `SELECT id, name FROM projects WHERE owner_key = $1 AND archived_at IS NULL`,
      [ownerKey]
    );
    expect(projs.rows).toHaveLength(1);
    expect(projs.rows[0].id).toBe(id1);
    expect(projs.rows[0].name).toBe('My designs');
  });
});
