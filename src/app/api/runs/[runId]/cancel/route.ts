import { NextRequest } from 'next/server';
import { getRunStore, isTerminal } from '@/lib/runs/run-store';
import { abortRun } from '@/lib/runs/run-control';
import { errorResponse } from '@/lib/runs/api-error';
import { safeDeleteForRun } from '@/lib/runs/artifact-store';
import type { RunInfo } from '@/lib/contract/run-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** How long Stop waits for the run's owner to acknowledge before ending the run itself. */
function ackMs(): number {
  const n = Number(process.env.CADAI_CANCEL_ACK_MS ?? 5000);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether the run's current segment (since its last `run` event) already stored its result. */
async function resultIsOut(runId: string): Promise<boolean> {
  const events = await getRunStore().events(runId, 0);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].t === 'result') return true;
    if (events[i].t === 'run') return false;
  }
  return false;
}

const finished = (runId: string, info: RunInfo) =>
  errorResponse('run_conflict', `Run ${runId} already ${info.status === 'done' ? 'finished' : info.status}.`);

/**
 * POST /api/runs/:runId/cancel - the Stop button.
 *
 * Raises the store's cancel flag (only while it is still running) so the
 * instance that owns the run sees it even if it is not this one, and aborts
 * the graph if it runs here; the owner's stream then ends with
 * `{ t: 'cancelled' }`. The owner polls the flag every CADAI_CANCEL_POLL_MS;
 * if it has not ended the run within CADAI_CANCEL_ACK_MS, its instance is
 * presumed gone (or stuck), and the run is cancelled here - atomically, only
 * while still running, so a late owner just finds it ended. A Stop therefore
 * always ends as `cancelled`, never as "run lost". Finished (or finished
 * meanwhile): 409 run_conflict.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const store = getRunStore();

  const info = await store.get(runId); // also fails a run whose owner died
  if (!info) return errorResponse('not_found', `Run ${runId} was not found.`);
  if (isTerminal(info.status)) return finished(runId, info);

  if (!(await store.requestCancel(runId))) {
    const current = await store.get(runId);
    if (current && isTerminal(current.status)) return finished(runId, current);
    return errorResponse('run_conflict', `Run ${runId} changed state while it was being cancelled; try again.`, { retryable: true });
  }
  abortRun(runId);

  const deadline = Date.now() + ackMs();
  let now = (await store.get(runId)) ?? info;
  while (now.status === 'running' && Date.now() < deadline) {
    await sleep(50);
    now = (await store.get(runId)) ?? now;
  }

  if (now.status === 'running') {
    if (await resultIsOut(runId)) {
      // The work finished before the Stop: `done` wins, as it does in the owner.
      await store.setStatus(runId, 'done', undefined, { expect: ['running'] });
    } else {
      const seq = await store.append(
        runId,
        { t: 'cancelled', at: Date.now() },
        { status: 'cancelled', error: { code: 'cancelled', message: 'The run was stopped.' }, expect: ['running'] },
      );
      if (seq > 0) {
        await safeDeleteForRun(runId);
      }
    }
    now = (await store.get(runId)) ?? now;
  }
  return Response.json(now);
}
