import { NextRequest } from 'next/server';
import { getRunStore } from '@/lib/runs/run-store';
import { abortRun } from '@/lib/runs/run-control';
import { deleteRunCheckpoint, runCheckpointKey } from '@/lib/agent/checkpointer';
import { errorResponse } from '@/lib/runs/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/runs/:runId/cancel - the Stop button.
 *
 * Running: raises the store's cancel flag (so the instance that owns the run
 * sees it even if it is not this one) and aborts the graph if it runs here; the
 * run's own stream then ends with `{ t: 'cancelled' }`. Paused at a gate: there
 * is no stream, so the run is cancelled here. Finished: 409 run_conflict.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const store = getRunStore();
  const info = await store.get(runId);
  if (!info) return errorResponse('not_found', `Run ${runId} was not found.`);
  if (info.status === 'done' || info.status === 'failed' || info.status === 'cancelled') {
    return errorResponse('run_conflict', `Run ${runId} already ${info.status === 'done' ? 'finished' : info.status}.`);
  }

  await store.requestCancel(runId);

  if (info.status === 'paused') {
    await deleteRunCheckpoint(runCheckpointKey(info.threadId, runId));
    await store.append(runId, { t: 'cancelled', at: Date.now() });
    await store.setStatus(runId, 'cancelled', { code: 'cancelled', message: 'The run was stopped.' });
  } else {
    abortRun(runId);
  }
  return Response.json((await store.get(runId)) ?? info);
}
