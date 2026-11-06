import { NextRequest } from 'next/server';
import { getRunStore } from '@/lib/runs/run-store';
import { errorResponse } from '@/lib/runs/api-error';
import { SSE_HEADERS, sse } from '@/lib/runs/stream-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function pollMs(): number {
  const n = Number(process.env.CADAI_TAIL_POLL_MS ?? 150);
  return Number.isFinite(n) && n > 0 ? n : 150;
}

/**
 * GET /api/runs/:runId/events?after=N - reconnect.
 *
 * Replays stored events with seq > N, then tails the log until the run is no
 * longer `running` (paused at a gate, done, failed, cancelled). The first event
 * is always `run`: when N > 0 that is a synthetic one (seq 0, not stored) with
 * the run's current status and resumed: true; with N = 0 it is the stored first
 * event.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const rawAfter = req.nextUrl.searchParams.get('after');
  const after = rawAfter === null || rawAfter === '' ? 0 : Number(rawAfter);
  if (!Number.isInteger(after) || after < 0) {
    return errorResponse('bad_request', '`after` must be a non-negative integer.');
  }

  const store = getRunStore();
  const first = await store.get(runId);
  if (!first) return errorResponse('not_found', `Run ${runId} was not found.`);

  const encoder = new TextEncoder();
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(sse(event)));
      const stop = () => {
        stopped = true;
      };
      req.signal.addEventListener('abort', stop);
      try {
        if (after > 0) {
          send({ t: 'run', runId, threadId: first.threadId, status: first.status, resumed: true, seq: 0, ts: Date.now() });
        }
        let cursor = after;
        while (!stopped) {
          // Status first, then drain: anything appended before a non-running
          // status was set is in this drain, so ending after it loses nothing.
          const info = await store.get(runId);
          for (const event of await store.events(runId, cursor)) {
            send(event);
            cursor = event.seq;
          }
          if (!info || info.status !== 'running') break;
          await new Promise((r) => setTimeout(r, pollMs()));
        }
      } catch (e) {
        console.error('Run event tail failed:', e);
      } finally {
        req.signal.removeEventListener('abort', stop);
        try {
          controller.close();
        } catch {
          // already closed by a client disconnect
        }
      }
    },
    cancel() {
      stopped = true;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
