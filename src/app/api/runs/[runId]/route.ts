import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { ownerKeyFrom } from '@/lib/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/runs/:runId -> RunInfo */
export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const { runId } = await params;
  const db = getDb();
  const run = await DbRunStore.getForOwner(db, ownerKey, runId);
  if (!run) {
    return NextResponse.json(
      { error: { code: 'not_found', message: `Run ${runId} was not found.` } },
      { status: 404 }
    );
  }

  return NextResponse.json({
    id: run.id,
    threadId: run.threadId,
    status: run.status,
    lastSeq: run.lastSeq,
    designVersion: run.designVersion,
    error: run.error,
  });
}
