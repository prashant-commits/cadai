import { describe, it, expect, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type Db } from '@/lib/db/db';
import { CADAI_OWNER_COOKIE } from '@/lib/owner';
import { streamRun } from '@/lib/runs/stream-run';
import type { RunOutcome } from '@/lib/persist/types';
import { GET as getArtifact } from '../artifacts/[id]/route';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const cookie = `${CADAI_OWNER_COOKIE}=${uuid}`;
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, cookie, key };
}

async function createTestRun(db: Db, ownerKey: string) {
  const threadId = crypto.randomUUID();
  const runId = `run_${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, $3)`,
    [threadId, ownerKey, runId]
  );
  await db.query(
    `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '15 minutes')`,
    [runId, threadId]
  );
  return { threadId, runId };
}

const reqArtifact = (id: string, cookie?: string) =>
  getArtifact(
    new NextRequest(`http://localhost/api/artifacts/${id}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ id }) }
  );

describe('artifacts-run', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('a completed design run creates STL and STEP artifacts accessible to the owner', async () => {
    const db = getDb();
    const owner = makeOwner();
    const { threadId, runId } = await createTestRun(db, owner.key);

    const STL_TEXT = 'solid cube\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid cube';
    const STEP_TEXT = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';
    const STEP_BASE64 = Buffer.from(STEP_TEXT).toString('base64');

    const outcome: RunOutcome = {
      replyKind: 'result',
      replyMarkdown: 'Cube created',
      userKind: 'request',
      design: {
        parentVersion: null,
        origin: 'designer',
        baseRequest: 'cube',
        edits: [],
        body: 'cube = Box(10, 10, 10)',
        preludeVersion: '1',
        summary: 'Cube',
        facts: null,
        flags: [],
        stl: STL_TEXT,
        step: STEP_BASE64,
      },
      costUsd: 0.05,
      wallMs: 150,
      turns: 1,
    };

    const res = streamRun({
      runId,
      threadId,
      ownerKey: owner.key,
      deadlineAt: Date.now() + 900_000,
      invoke: async () =>
        (async function* () {
          yield ['values', { outcome }];
        })(),
    });

    const raw = await res.text();
    expect(raw).toContain('"t":"end"');

    // Verify designs row has stl_artifact and step_artifact
    const designRes = await db.query(
      `SELECT stl_artifact, step_artifact FROM designs WHERE thread_id = $1 AND version = 1`,
      [threadId]
    );
    expect(designRes.rows).toHaveLength(1);
    const stlArtId = String(designRes.rows[0].stl_artifact);
    const stepArtId = String(designRes.rows[0].step_artifact);
    expect(stlArtId).toBeTruthy();
    expect(stepArtId).toBeTruthy();

    // Verify artifact rows
    const artRows = await db.query(
      `SELECT id, kind, bytes, run_id, thread_id FROM artifacts WHERE id IN ($1, $2)`,
      [stlArtId, stepArtId]
    );
    expect(artRows.rows).toHaveLength(2);
    for (const r of artRows.rows) {
      expect(r.run_id).toBe(runId);
      expect(r.thread_id).toBe(threadId);
    }

    // Download via /api/artifacts/:id as the owner
    const stlRes = await reqArtifact(stlArtId, owner.cookie);
    expect(stlRes.status).toBe(200);
    expect(stlRes.headers.get('content-type')).toBe('model/stl');
    expect(await stlRes.text()).toBe(STL_TEXT);

    const stepRes = await reqArtifact(stepArtId, owner.cookie);
    expect(stepRes.status).toBe(200);
    expect(stepRes.headers.get('content-type')).toBe('model/step');
    expect(await stepRes.text()).toBe(STEP_TEXT);

    // Another owner gets 404
    const otherOwner = makeOwner();
    const otherRes = await reqArtifact(stlArtId, otherOwner.cookie);
    expect(otherRes.status).toBe(404);
  });
});
