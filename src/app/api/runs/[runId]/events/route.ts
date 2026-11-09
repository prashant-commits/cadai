import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { ownerKeyFrom } from '@/lib/owner';
import { SSE_HEADERS, SSE_KEEPALIVE_MS, KEEPALIVE, sse, toWire } from '@/lib/runs/stream-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function pollMs(): number {
  const n = Number(process.env.CADAI_TAIL_POLL_MS ?? 150);
  return Number.isFinite(n) && n > 0 ? n : 150;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const { runId } = await params;
  const rawAfter = req.nextUrl.searchParams.get('after');
  const after = rawAfter === null || rawAfter === '' ? 0 : Number(rawAfter);
  if (!Number.isInteger(after) || after < 0) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: '`after` must be a non-negative integer.' } },
      { status: 400 }
    );
  }

  const db = getDb();
  const initialRun = await DbRunStore.getForOwner(db, ownerKey, runId);
  if (!initialRun) {
    return NextResponse.json(
      { error: { code: 'not_found', message: `Run ${runId} was not found.` } },
      { status: 404 }
    );
  }

  const encoder = new TextEncoder();
  let stopped = false;
  let keepAliveTimer: NodeJS.Timeout | undefined;

  const stream = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const stop = () => {
          stopped = true;
          if (keepAliveTimer) clearInterval(keepAliveTimer);
        };
        req.signal.addEventListener('abort', stop);

        const keepAliveBytes = encoder.encode(KEEPALIVE);
        keepAliveTimer = setInterval(() => {
          if (stopped) return;
          try {
            controller.enqueue(keepAliveBytes);
          } catch {
            stopped = true;
            if (keepAliveTimer) clearInterval(keepAliveTimer);
          }
        }, SSE_KEEPALIVE_MS);

        const send = async (event: Record<string, unknown>) => {
          while (!stopped && (controller.desiredSize ?? 1) <= 0) {
            await sleep(10);
          }
          if (!stopped) {
            controller.enqueue(encoder.encode(sse(event)));
          }
        };

        try {
          if (after > 0) {
            await send({
              t: 'run',
              runId,
              threadId: initialRun.threadId,
              status: initialRun.status,
              resumed: true,
              seq: 0,
              ts: Date.now(),
            });
          }

          let cursor = after;
          while (!stopped) {
            const current = await DbRunStore.getForOwner(db, ownerKey, runId);
            const statusBeforeDrain = current?.status;

            while (!stopped) {
              const page = await DbRunStore.eventsSince(db, runId, cursor, 200);
              for (const row of page) {
                cursor = row.seq;
                await send(toWire(row));
              }
              if (page.length < 200 || stopped) {
                break;
              }
            }

            if (!current || statusBeforeDrain !== 'running') {
              break;
            }
            await sleep(pollMs());
          }
        } catch (e) {
          console.error('Run event tail failed:', e);
        } finally {
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          req.signal.removeEventListener('abort', stop);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        stopped = true;
        if (keepAliveTimer) clearInterval(keepAliveTimer);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 })
  );

  return new Response(stream, { headers: SSE_HEADERS });
}
