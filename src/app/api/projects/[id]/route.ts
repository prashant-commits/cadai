import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/db';
import { isValidUuid, ownerKeyFrom } from '@/lib/owner';
import { ProjectStore } from '@/lib/persist/projects';
import { StoreError } from '@/lib/persist/types';
import { RUN_ACTIVE } from '@/lib/persist/phrases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
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
    const updated = await ProjectStore.rename(db, ownerKey, id, name);
    if (!updated) {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Project not found' } },
        { status: 404 }
      );
    }
    return new Response(null, { status: 204 });
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

export async function DELETE(
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

  try {
    const archived = await db.transaction(async (q) => {
      return ProjectStore.archive(q, ownerKey, id);
    });

    if (!archived) {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Project not found' } },
        { status: 404 }
      );
    }

    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof StoreError) {
      if (err.status === 409 && err.code === 'run_active') {
        return NextResponse.json(
          { error: { code: 'run_active', message: RUN_ACTIVE }, activeRunId: err.activeRunId },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status }
      );
    }
    throw err;
  }
}
