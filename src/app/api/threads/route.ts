import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/db';
import { isValidUuid, ownerKeyFrom } from '@/lib/owner';
import { ThreadStore } from '@/lib/persist/threads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const { searchParams } = req.nextUrl;
  let limit: number | undefined;
  const limitParam = searchParams.get('limit');
  if (limitParam !== null) {
    const parsed = parseInt(limitParam, 10);
    if (Number.isFinite(parsed)) {
      limit = parsed;
    }
  }

  let before: { updatedAt: number; id: string } | undefined;
  const beforeParam = searchParams.get('before');
  if (beforeParam !== null) {
    const colonIdx = beforeParam.indexOf(':');
    if (colonIdx === -1) {
      return NextResponse.json(
        { error: { code: 'bad_request', message: 'Invalid cursor' } },
        { status: 400 }
      );
    }
    const updatedAt = Number(beforeParam.slice(0, colonIdx));
    const id = beforeParam.slice(colonIdx + 1);
    if (!Number.isFinite(updatedAt) || !isValidUuid(id)) {
      return NextResponse.json(
        { error: { code: 'bad_request', message: 'Invalid cursor' } },
        { status: 400 }
      );
    }
    before = { updatedAt, id };
  }

  const db = getDb();
  const rows = await ThreadStore.list(db, ownerKey, { limit, before });

  return NextResponse.json({
    threads: rows.map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      activeRunId: t.activeRunId,
    })),
  });
}
