import { describe, it, expect, vi, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { NextRequest } from 'next/server';
import { getDb, closeDb } from '@/lib/db/db';
import { CADAI_OWNER_COOKIE } from '@/lib/owner';
import { RUN_ACTIVE, COMPILE_FAILED } from '@/lib/persist/phrases';
import { BAD_OP } from '@/lib/tools/phrases';
import { applyOp, type ToolOp } from '@/lib/tools/ops';

vi.mock('@/lib/engine/brep-runner', () => ({
  runBrep: vi.fn().mockImplementation((script: string) => {
    if (script.includes('FAIL_COMPILE')) {
      return Promise.resolve({
        ok: false,
        error: 'SyntaxError: invalid syntax (line 42)',
        parts: [],
        solids: 0,
        ms: 10,
      });
    }
    return Promise.resolve({
      ok: true,
      parts: [{ label: 'box', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
      solids: 1,
      stl: Buffer.from('solid box\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid box').toString('base64'),
      step: 'STEP-DATA',
      ms: 50,
      topology: {
        mesh: { positions: [0, 0, 0], indices: [0], faceIds: [1] },
        faces: [],
        edges: [],
      },
    });
  }),
}));

import { POST as versionsRoute } from './route';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const cookie = `${CADAI_OWNER_COOKIE}=${uuid}`;
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, cookie, key };
}

async function callVersions(
  owner: { cookie: string },
  threadId: string,
  body: unknown,
  rawJson?: string
) {
  return versionsRoute(
    new NextRequest(`http://localhost/api/threads/${threadId}/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: owner.cookie,
      },
      body: rawJson ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: threadId }) }
  );
}

describe('versions route', () => {
  afterAll(async () => {
    await closeDb();
  });

  const sampleOp: ToolOp = {
    id: 'op_h00001',
    part: 'box',
    plane: { origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
    offset: [0, 0],
    rotationDeg: 0,
    kind: 'hole',
    size: 'M5',
    diameterMm: 5.5,
    head: 'none',
    depthMm: 5,
  };

  it('versions route: 201 creates a user_edit version and a tool_edit message', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, owner.key]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags)
       VALUES ($1, 1, null, 'designer', 'initial base request', '[]', 'box = Box(10, 10, 10)\n_cadai_parts = [box]', '1', 'v1', null, '[]')`,
      [threadId]
    );

    const clientMessageId = crypto.randomUUID();
    const newBody = `box = Box(10, 10, 10)
# cadai:op hole id=op_h00001 {"id":"op_h00001","part":"box","kind":"hole","size":"M5","diameterMm":5.5,"head":"none","depthMm":5,"offset":[0,0],"rotationDeg":0,"plane":{"origin":[0,0,10],"normal":[0,0,1],"xDir":[1,0,0]}}
op_h00001_plane_orig_x = 0.0  # plane origin x mm
op_h00001_plane_orig_y = 0.0  # plane origin y mm
op_h00001_plane_orig_z = 10.0  # plane origin z mm
op_h00001_plane_norm_x = 0.0  # plane normal x
op_h00001_plane_norm_y = 0.0  # plane normal y
op_h00001_plane_norm_z = 1.0  # plane normal z
op_h00001_plane_xdir_x = 1.0  # plane x_dir x
op_h00001_plane_xdir_y = 0.0  # plane x_dir y
op_h00001_plane_xdir_z = 0.0  # plane x_dir z
op_h00001_offset_x = 0.0  # offset x mm
op_h00001_offset_y = 0.0  # offset y mm
op_h00001_rotation = 0.0  # rotation deg
op_h00001_diameter = 5.5  # clearance mm
op_h00001_depth = 5.0  # depth mm
op_h00001_cutter = Plane(origin=(op_h00001_plane_orig_x, op_h00001_plane_orig_y, op_h00001_plane_orig_z), z_dir=(op_h00001_plane_norm_x, op_h00001_plane_norm_y, op_h00001_plane_norm_z), x_dir=(op_h00001_plane_xdir_x, op_h00001_plane_xdir_y, op_h00001_plane_xdir_z)) * Pos(op_h00001_offset_x, op_h00001_offset_y, -op_h00001_depth) * Cylinder(radius=op_h00001_diameter / 2, height=op_h00001_depth, align=(Align.CENTER, Align.CENTER, Align.MIN))
box = box - op_h00001_cutter
# cadai:end op_h00001
_cadai_parts = [box]
result = box
`;

    const res = await callVersions(owner, threadId, {
      clientMessageId,
      baseVersion: 1,
      body: newBody,
      op: sampleOp,
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ version: 2 });

    // Assert designs row
    const dRes = await db.query(
      `SELECT version, origin, parent_version, topo_artifact, ops FROM designs WHERE thread_id = $1 AND version = 2`,
      [threadId]
    );
    expect(dRes.rows).toHaveLength(1);
    const dRow = dRes.rows[0];
    expect(dRow.origin).toBe('user_edit');
    expect(dRow.parent_version).toBe(1);
    expect(dRow.topo_artifact).toBeTruthy();
    expect(Array.isArray(dRow.ops)).toBe(true);
    const opsArray = dRow.ops as Array<{ id: string }>;
    expect(opsArray).toHaveLength(1);
    expect(opsArray[0].id).toBe('op_h00001');

    // Assert messages row
    const mRes = await db.query(
      `SELECT role, kind, content, design_version, client_message_id FROM messages WHERE thread_id = $1 AND design_version = 2`,
      [threadId]
    );
    expect(mRes.rows).toHaveLength(1);
    const mRow = mRes.rows[0];
    expect(mRow.role).toBe('user');
    expect(mRow.kind).toBe('tool_edit');
    expect(mRow.content).toBe('You added Hole M5 · v2');
    expect(mRow.design_version).toBe(2);
    expect(mRow.client_message_id).toBe(clientMessageId);
  });

  it('versions route: 409 RUN_ACTIVE while a run is active', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    await db.query(`INSERT INTO threads(id, owner_key, active_run_id) VALUES ($1, $2, $3)`, [threadId, owner.key, runId]);
    await db.query(
      `INSERT INTO runs(id, thread_id, status, deadline_at) VALUES ($1, $2, 'running', now() + interval '1 hour')`,
      [runId, threadId]
    );
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags)
       VALUES ($1, 1, null, 'designer', 'req', '[]', 'box = Box(10, 10, 10)\n_cadai_parts = [box]', '1', 'v1', null, '[]')`,
      [threadId]
    );

    const initialDesigns = (await db.query(`SELECT count(*)::int as c FROM designs WHERE thread_id = $1`, [threadId])).rows[0].c;
    const initialMessages = (await db.query(`SELECT count(*)::int as c FROM messages WHERE thread_id = $1`, [threadId])).rows[0].c;

    const res = await callVersions(owner, threadId, {
      clientMessageId: crypto.randomUUID(),
      baseVersion: 1,
      body: 'box = Box(10, 10, 10)\n_cadai_parts = [box]',
      op: sampleOp,
    });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('run_active');
    expect(json.error.message).toBe(RUN_ACTIVE);
    expect(json.activeRunId).toBe(runId);

    // Assert designs and messages unchanged
    const afterDesigns = (await db.query(`SELECT count(*)::int as c FROM designs WHERE thread_id = $1`, [threadId])).rows[0].c;
    const afterMessages = (await db.query(`SELECT count(*)::int as c FROM messages WHERE thread_id = $1`, [threadId])).rows[0].c;
    expect(afterDesigns).toBe(initialDesigns);
    expect(afterMessages).toBe(initialMessages);
  });

  it('versions route: 422 with the compile error when the body fails', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, owner.key]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags)
       VALUES ($1, 1, null, 'designer', 'req', '[]', 'box = Box(10, 10, 10)\n_cadai_parts = [box]', '1', 'v1', null, '[]')`,
      [threadId]
    );

    const initialDesigns = (await db.query(`SELECT count(*)::int as c FROM designs WHERE thread_id = $1`, [threadId])).rows[0].c;
    const initialMessages = (await db.query(`SELECT count(*)::int as c FROM messages WHERE thread_id = $1`, [threadId])).rows[0].c;

    const bodyWithOp = `box = Box(10, 10, 10)  # FAIL_COMPILE
# cadai:op hole id=op_h00001 {"id":"op_h00001","part":"box","kind":"hole","size":"M5","diameterMm":5.5,"head":"none","depthMm":5,"offset":[0,0],"rotationDeg":0,"plane":{"origin":[0,0,10],"normal":[0,0,1],"xDir":[1,0,0]}}
op_h00001_diameter = 5.5
# cadai:end op_h00001
_cadai_parts = [box]`;

    const res = await callVersions(owner, threadId, {
      clientMessageId: crypto.randomUUID(),
      baseVersion: 1,
      body: bodyWithOp,
      op: sampleOp,
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe('compile_failed');
    expect(json.error.message).toBe(COMPILE_FAILED);
    expect(json.error.detail).toContain('SyntaxError');

    // Assert designs and messages unchanged
    const afterDesigns = (await db.query(`SELECT count(*)::int as c FROM designs WHERE thread_id = $1`, [threadId])).rows[0].c;
    const afterMessages = (await db.query(`SELECT count(*)::int as c FROM messages WHERE thread_id = $1`, [threadId])).rows[0].c;
    expect(afterDesigns).toBe(initialDesigns);
    expect(afterMessages).toBe(initialMessages);
  });

  it("versions route: another owner's thread is 404", async () => {
    const db = getDb();
    const ownerA = makeOwner();
    const ownerB = makeOwner();
    const threadId = crypto.randomUUID();

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, ownerA.key]);
    // v1 exists and the body carries the op block, so only the owner check can refuse this.
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags)
       VALUES ($1, 1, null, 'designer', 'req', '[]', 'box = Box(10, 10, 10)\n_cadai_parts = [box]', '1', 'v1', null, '[]')`,
      [threadId]
    );

    const res = await callVersions(ownerB, threadId, {
      clientMessageId: crypto.randomUUID(),
      baseVersion: 1,
      body: applyOp('box = Box(10, 10, 10)\n_cadai_parts = [box]', sampleOp),
      op: sampleOp,
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('not_found');
    const designs = await db.query(`SELECT version FROM designs WHERE thread_id = $1`, [threadId]);
    expect(designs.rows).toHaveLength(1);
    const msgs = await db.query(`SELECT id FROM messages WHERE thread_id = $1`, [threadId]);
    expect(msgs.rows).toHaveLength(0);
  });

  it('versions route: a duplicate clientMessageId is 409', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, owner.key]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags)
       VALUES ($1, 1, null, 'designer', 'req', '[]', 'box = Box(10, 10, 10)\n_cadai_parts = [box]', '1', 'v1', null, '[]')`,
      [threadId]
    );
    await db.query(
      `INSERT INTO messages(id, thread_id, seq, role, kind, content, client_message_id)
       VALUES (gen_random_uuid(), $1, 1, 'user', 'tool_edit', 'You added Hole M5 · v1', $2)`,
      [threadId, clientMessageId]
    );

    const res = await callVersions(owner, threadId, {
      clientMessageId,
      baseVersion: 1,
      body: 'box = Box(10, 10, 10)\n_cadai_parts = [box]',
      op: sampleOp,
    });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('duplicate_message');
  });

  it('versions route: an op whose block is not in the body is 400', async () => {
    const db = getDb();
    const owner = makeOwner();
    const threadId = crypto.randomUUID();

    await db.query(`INSERT INTO threads(id, owner_key) VALUES ($1, $2)`, [threadId, owner.key]);
    await db.query(
      `INSERT INTO designs(thread_id, version, parent_version, origin, base_request, edits, body, prelude_version, summary, facts, flags)
       VALUES ($1, 1, null, 'designer', 'req', '[]', 'box = Box(10, 10, 10)\n_cadai_parts = [box]', '1', 'v1', null, '[]')`,
      [threadId]
    );

    // Body contains no op block matching sampleOp.id
    const bodyWithoutBlock = 'box = Box(10, 10, 10)\n_cadai_parts = [box]';

    const res = await callVersions(owner, threadId, {
      clientMessageId: crypto.randomUUID(),
      baseVersion: 1,
      body: bodyWithoutBlock,
      op: sampleOp,
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('bad_request');
    expect(json.error.message).toBe(BAD_OP);
  });

  it('versions route: an op with a non-finite number is 400', async () => {
    const owner = makeOwner();
    const threadId = crypto.randomUUID();

    const invalidOp = {
      ...sampleOp,
      depthMm: 'not-a-number',
    };

    const res = await callVersions(owner, threadId, {
      clientMessageId: crypto.randomUUID(),
      baseVersion: 1,
      body: 'box = Box(10, 10, 10)\n_cadai_parts = [box]',
      op: invalidOp,
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('bad_request');
    expect(json.error.message).toBe(BAD_OP);

    // 1e999 is valid JSON and parses to Infinity: a number that is not finite.
    const raw = JSON.stringify({
      clientMessageId: crypto.randomUUID(),
      baseVersion: 1,
      body: 'box = Box(10, 10, 10)\n_cadai_parts = [box]',
      op: { ...sampleOp, depthMm: 12345 },
    }).replace('12345', '1e999');
    const resInf = await callVersions(owner, threadId, null, raw);
    expect(resInf.status).toBe(400);
    const jsonInf = await resInf.json();
    expect(jsonInf.error.code).toBe('bad_request');
    expect(jsonInf.error.message).toBe(BAD_OP);
  });
});
