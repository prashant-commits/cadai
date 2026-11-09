import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/db';
import { isValidUuid, ownerKeyFrom } from '@/lib/owner';
import { ProjectStore } from '@/lib/persist/projects';
import { StoreError } from '@/lib/persist/types';

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
  const searchParam = searchParams.get('search');
  const search = searchParam !== null && searchParam.length > 0 ? searchParam : undefined;

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
  await db.transaction(async (q) => {
    await ProjectStore.ensureDefault(q, ownerKey);
  });

  const rows = await ProjectStore.list(db, ownerKey, { search, limit, before });

  return NextResponse.json({
    projects: rows,
  });
}

export async function POST(req: NextRequest) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Invalid JSON body' } },
      { status: 400 }
    );
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).name !== 'string'
  ) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Name must be a string' } },
      { status: 400 }
    );
  }

  const name = (body as { name: string }).name;
  const db = getDb();

  try {
    const project = await ProjectStore.create(db, ownerKey, name);
    return NextResponse.json(
      {
        project: {
          id: project.id,
          name: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof StoreError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status }
      );
    }
    throw err;
  }
}
