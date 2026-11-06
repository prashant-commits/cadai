import { NextRequest } from 'next/server';
import { getRunStore } from '@/lib/runs/run-store';
import { errorResponse } from '@/lib/runs/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/runs/:runId -> RunInfo */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const info = await getRunStore().get(runId);
  if (!info) return errorResponse('not_found', `Run ${runId} was not found.`);
  return Response.json(info);
}
