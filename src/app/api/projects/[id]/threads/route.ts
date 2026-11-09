import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/db';
import { isValidUuid, ownerKeyFrom } from '@/lib/owner';
import { ProjectStore } from '@/lib/persist/projects';
import { ThreadStore } from '@/lib/persist/threads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
      { error: { code: 'not_found', message: 'Project not found' } },
      { status: 404 }
    );
  }

  const db = getDb();
  const project = await ProjectStore.get(db, ownerKey, id);
  if (!project) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Project not found' } },
      { status: 404 }
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
    const cursorId = beforeParam.slice(colonIdx + 1);
    if (!Number.isFinite(updatedAt) || !isValidUuid(cursorId)) {
      return NextResponse.json(
        { error: { code: 'bad_request', message: 'Invalid cursor' } },
        { status: 400 }
      );
    }
    before = { updatedAt, id: cursorId };
  }

  const rows = await ThreadStore.list(db, ownerKey, { limit, before, projectId: id });

  return NextResponse.json({
    threads: rows.map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      activeRunId: t.activeRunId,
    })),
  });
}
