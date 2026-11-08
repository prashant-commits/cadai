import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { abortRun } from '@/lib/runs/run-control';
import { ownerKeyFrom } from '@/lib/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
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

  if (abortRun(runId)) {
    return NextResponse.json({ status: 'running' }, { status: 202 });
  }

  await db.transaction((q) => DbRunStore.terminate(q, runId, 'cancelled', 'cancelled'));

  const current = await DbRunStore.getForOwner(db, ownerKey, runId);
  return NextResponse.json({ id: runId, status: current?.status ?? 'cancelled' });
}
