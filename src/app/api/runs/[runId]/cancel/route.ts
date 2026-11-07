import { NextRequest } from 'next/server';
import { getRunStore, isTerminal } from '@/lib/runs/run-store';
import { abortRun } from '@/lib/runs/run-control';
import { deleteRunCheckpoint, runCheckpointKey } from '@/lib/agent/checkpointer';
import { errorResponse } from '@/lib/runs/api-error';
import type { RunInfo } from '@/lib/contract/run-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const finished = (runId: string, info: RunInfo) =>
  errorResponse('run_conflict', `Run ${runId} already ${info.status === 'done' ? 'finished' : info.status}.`);

/**
 * POST /api/runs/:runId/cancel - the Stop button.
 *
 * Paused at a gate: there is no stream, so the run is cancelled here, in one
 * atomic step that only applies while it is still paused. Running: raises the
 * store's cancel flag (only while it is still running or paused) so the
 * instance that owns the run sees it even if it is not this one, and aborts
 * the graph if it runs here; the owner's stream then ends with
 * `{ t: 'cancelled' }`. Finished (or finished meanwhile): 409 run_conflict.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const store = getRunStore();

  // A paused run can be resumed (and pause again) while we act; retry the
  // status-checked steps a few times instead of acting on a stale read.
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await store.get(runId); // also fails a run whose owner died
    if (!info) return errorResponse('not_found', `Run ${runId} was not found.`);
    if (isTerminal(info.status)) return finished(runId, info);

    if (info.status === 'paused') {
      const seq = await store.append(
        runId,
        { t: 'cancelled', at: Date.now() },
        { status: 'cancelled', error: { code: 'cancelled', message: 'The run was stopped.' }, expect: ['paused'] },
      );
      if (seq > 0) {
        await deleteRunCheckpoint(runCheckpointKey(info.threadId, runId));
        return Response.json((await store.get(runId)) ?? info);
      }
      continue; // resumed meanwhile: it is running now
    }

    if (!(await store.requestCancel(runId))) continue; // ended meanwhile: re-read for the 409
    abortRun(runId);
    const now = (await store.get(runId)) ?? info;
    // A run that paused between our read and the flag is not owned by anyone: cancel it here.
    if (now.status === 'paused') continue;
    return Response.json(now);
  }
  const last = await store.get(runId);
  if (last && isTerminal(last.status)) return finished(runId, last);
  return errorResponse('run_conflict', `Run ${runId} changed state while it was being cancelled; try again.`, { retryable: true });
}
