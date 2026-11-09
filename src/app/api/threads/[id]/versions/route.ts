import { NextRequest, NextResponse } from 'next/server';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { getDb } from '@/lib/db/db';
import { isValidUuid, ownerKeyFrom } from '@/lib/owner';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { DesignStore } from '@/lib/persist/designs';
import { checkPythonScript } from '@/lib/brep/body-check';
import { withGeneratedPrelude, PRELUDE_VERSION } from '@/lib/brep/prelude';
import { runBrep } from '@/lib/engine/brep-runner';
import { put as putArtifact } from '@/lib/runs/owner-artifacts';
import { RUN_ACTIVE, BAD_EDIT, COMPILE_FAILED } from '@/lib/persist/phrases';
import { UNKNOWN_BASE_VERSION, BAD_OP, BAD_BODY } from '@/lib/tools/phrases';
import { validateToolOp, parseOpBlocks } from '@/lib/tools/ops';
import { StoreError } from '@/lib/persist/types';

const gzip = promisify(zlib.gzip);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 1. Owner check
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const { id } = await params;
  if (!isValidUuid(id)) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Thread not found' } },
      { status: 404 }
    );
  }

  // Parse and validate request JSON
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Invalid JSON' } },
      { status: 400 }
    );
  }

  if (!bodyJson || typeof bodyJson !== 'object' || Array.isArray(bodyJson)) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Request body must be an object' } },
      { status: 400 }
    );
  }

  const b = bodyJson as Record<string, unknown>;

  if (typeof b.clientMessageId !== 'string' || !isValidUuid(b.clientMessageId)) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'clientMessageId must be a valid UUID' } },
      { status: 400 }
    );
  }

  if (typeof b.baseVersion !== 'number' || !Number.isInteger(b.baseVersion)) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'baseVersion must be an integer' } },
      { status: 400 }
    );
  }

  if (typeof b.body !== 'string' || b.body.trim().length === 0) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: BAD_BODY } },
      { status: 400 }
    );
  }

  const rawOp = b.op;
  if (!validateToolOp(rawOp)) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: BAD_OP } },
      { status: 400 }
    );
  }

  const clientMessageId = b.clientMessageId;
  const baseVersion = b.baseVersion;
  const designBody = b.body;

  const db = getDb();

  // 2. Fast pre-checks: thread existence, ownership, active run, duplicate message, base design
  const threadRes = await db.query(
    `SELECT owner_key, archived_at, active_run_id FROM threads WHERE id = $1`,
    [id]
  );
  if (threadRes.rows.length === 0) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Thread not found' } },
      { status: 404 }
    );
  }

  const threadRow = threadRes.rows[0];
  if (threadRow.owner_key !== ownerKey || threadRow.archived_at !== null) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Thread not found' } },
      { status: 404 }
    );
  }

  if (threadRow.active_run_id) {
    const activeRunId = String(threadRow.active_run_id);
    const runRes = await db.query(`SELECT status FROM runs WHERE id = $1`, [activeRunId]);
    if (runRes.rows.length > 0 && runRes.rows[0].status === 'running') {
      return NextResponse.json(
        { error: { code: 'run_active', message: RUN_ACTIVE }, activeRunId },
        { status: 409 }
      );
    }
  }

  const dupRes = await db.query(
    `SELECT id FROM messages WHERE thread_id = $1 AND client_message_id = $2`,
    [id, clientMessageId]
  );
  if (dupRes.rows.length > 0) {
    return NextResponse.json(
      { error: { code: 'duplicate_message' } },
      { status: 409 }
    );
  }

  const baseDesign = await DesignStore.get(db, ownerKey, id, baseVersion);
  if (!baseDesign) {
    return NextResponse.json(
      { error: { code: 'not_found', message: UNKNOWN_BASE_VERSION } },
      { status: 404 }
    );
  }

  const parsedOps = parseOpBlocks(designBody);
  const matchingParsed = parsedOps.find((p) => p.op.id === rawOp.id);
  if (!matchingParsed) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: BAD_OP } },
      { status: 400 }
    );
  }
  const op = matchingParsed.op;

  // 5. checkPythonScript
  const preludeVersion = baseDesign.preludeVersion || PRELUDE_VERSION;
  let fullScript: string;
  try {
    fullScript = withGeneratedPrelude(designBody, preludeVersion);
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_edit', message: BAD_EDIT } },
      { status: 422 }
    );
  }

  const check = checkPythonScript(fullScript);
  if (!check.ok) {
    return NextResponse.json(
      { error: { code: 'bad_edit', message: BAD_EDIT } },
      { status: 422 }
    );
  }

  // 6. runBrep (outside transaction lock)
  const result = await runBrep(fullScript, { topology: true, partMeshes: true });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'compile_failed',
          message: COMPILE_FAILED,
          detail: result.error,
        },
      },
      { status: 422 }
    );
  }

  // 7. Store artifacts
  let stlArtifact: string | null = null;
  if (result.stl) {
    const stlBytes = result.stl.startsWith('solid ')
      ? Buffer.from(result.stl, 'utf8')
      : Buffer.from(result.stl, 'base64');
    stlArtifact = await putArtifact(ownerKey, 'stl', stlBytes, { threadId: id }, { db });
  }

  let stepArtifact: string | null = null;
  if (result.step) {
    const stepBytes = result.step.startsWith('ISO-10303-21')
      ? Buffer.from(result.step, 'utf8')
      : Buffer.from(result.step, 'base64');
    stepArtifact = await putArtifact(ownerKey, 'step', stepBytes, { threadId: id }, { db });
  }

  let topoArtifact: string | null = null;
  if (result.topology) {
    const topoBytes = await gzip(Buffer.from(JSON.stringify(result.topology), 'utf8'));
    topoArtifact = await putArtifact(ownerKey, 'topo', topoBytes, { threadId: id }, { db });
  }

  // 8–9. Re-lock thread and commitUserEdit inside ONE transaction
  let commitRes: { version: number };
  try {
    commitRes = await db.transaction((q) =>
      DbRunStore.commitUserEdit(q, {
        ownerKey,
        threadId: id,
        baseVersion,
        body: designBody,
        op,
        clientMessageId,
        stlArtifact,
        stepArtifact,
        topoArtifact,
        parts: result.parts,
      })
    );
  } catch (err) {
    if (err instanceof StoreError) {
      if (err.status === 409 && err.code === 'run_active') {
        return NextResponse.json(
          { error: { code: 'run_active', message: RUN_ACTIVE }, activeRunId: err.activeRunId },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status }
      );
    }
    throw err;
  }

  return NextResponse.json({ version: commitRes.version }, { status: 201 });
}
